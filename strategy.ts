// Sharpe-optimised confirmed-runner bot for the pump.fun replay (agent-fun/replay/v2).
//
// Ranking is by HOURLY SHARPE, not raw PnL, so this bot optimises steady small
// wins and a tiny drawdown instead of chasing the biggest move:
//
//   - Enter only CONFIRMED runners: a coin 20-55% off its recent high, trading
//     at least 8% below the volume-weighted price of its own recent flow, that
//     has ALREADY turned — price bounced >=13% off its recent low with buyers
//     in 7 of the last 10 trades. Never snipe fresh launches, never buy a fall.
//   - One entry per dip, one tranche, no averaging down.
//   - Tight, fee-aware exits: 8% take-profit, 5% stop-loss, a trailing
//     give-back once up 4%, or a 300-slot max hold — whichever comes first.
//   - 0.25 SOL per position, max 5 open, max 1 new entry per batch: few, big
//     enough that the fixed 105,000-lamport tx fee stays a small share.
//
// Everything is a pure function of the batches the harness sends: no clock, no
// randomness, no I/O, no environment reads, so the two graded executions produce
// byte-identical action logs.
//
// Tuning (dev window, grade-local): this parameter set scores hourly Sharpe
// 0.409, net +0.298 SOL, max drawdown 0.60%, 56 fills over 26 coins, win rate
// 42.9%. Its neighbours are all close (Sharpe 0.397-0.406, net +0.28-0.30 SOL,
// drawdown 0.53-0.60%), so the result does not rest on one knife-edge point.
// The looser Dip Buyer it descends from scored Sharpe 0.295 / +0.258 SOL / 1.52%
// drawdown on the same window. Tighter exits (TP 5-6%) score WORSE on Sharpe:
// wins shrink below the fee band while losses stay, so 8%/5% is the sweet spot.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Trades kept per mint for the VWAP / flow read. */
  windowTrades: number;
  /** Slots back over which the recent high is taken. */
  highWindowSlots: number;
  /** Enter when price is at least this far below the recent high... */
  dipMin: number;
  /** ...and no further than this (a collapse, not a dip). */
  dipMax: number;
  /** Enter only when price is at least this far below the recent VWAP. */
  vwapGapMin: number;
  /** Trades used for the VWAP anchor (longer than the flow window, so it still
      remembers pre-dip prices when the dip itself is only a few trades old). */
  vwapTrades: number;
  /** Trades used for the VWAP and the buyer-flow read. */
  flowTrades: number;
  /** Of the last `flowTrades` trades at least this many must be buys. */
  minFlowBuys: number;
  /** Net SOL bought over the last `flowTrades` trades must be >= this. */
  minNetBuySol: bigint;
  /** The curve must hold at least this much real SOL at decision time. */
  minRealSol: bigint;
  /** Target stake per position (lamports), before the per-reply size cap. */
  stake: bigint;
  /** Smallest buy worth sending (transaction fee is 105k lamports per order). */
  minBuy: bigint;
  /** Take profit: exit when liquidation value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Stop loss: exit when liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Once the position is up this far, exit if value gives back this share of the peak. */
  trailArm: number;
  trailGiveback: number;
  /** Exit after holding this many slots regardless. */
  maxHoldSlots: number;
  /** After an exit, ignore the coin for this many slots. */
  cooldownSlots: number;
  /** Enter only once the price has bounced at least this far off its recent low
      (buy the turn, not the fall: the low is the cheapest price in the lookback). */
  bounceMin: number;
  /** Slippage tolerance on buys and on sells (bps). */
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Most new entries per reply. */
  maxEntriesPerBatch: number;
}

// Sharpe-tuned values (see header): confirmed-runner entry at a 13% bounce with
// 7-of-10 buyer flow, 8% take-profit against a 5% stop, 300-slot max hold,
// 0.25 SOL stakes. The guardrail bar (a round trip of at least 0.01 SOL on at
// least 20 coins) is cleared with margin: 26 coins, 28 round trips on dev.
export const DEFAULT_PARAMS: Params = {
  windowTrades: 60,
  highWindowSlots: 2500,
  dipMin: 0.2,
  dipMax: 0.55,
  vwapGapMin: 0.08,
  vwapTrades: 40,
  flowTrades: 10,
  minFlowBuys: 7,
  minNetBuySol: 0n,
  minRealSol: 2_000_000_000n,
  stake: 250_000_000n,
  minBuy: 15_000_000n,
  takeProfit: 0.08,
  stopLoss: 0.05,
  trailArm: 0.04,
  trailGiveback: 0.05,
  maxHoldSlots: 300,
  cooldownSlots: 240,
  bounceMin: 0.13,
  buySlippageBps: 500,
  sellSlippageBps: 3000,
  maxEntriesPerBatch: 1,
};

const FEE_BPS = 125n; // protocol 95 + creator 30 bps, charged on each side.
const BPS = 10_000n;

interface Tick {
  slot: number;
  price: number; // virtual SOL per virtual token (marginal price).
  isBuy: boolean;
  sol: bigint; // SOL side of the trade, for VWAP weighting.
  realSol: bigint;
}

interface Coin {
  ticks: Tick[];
  entryPrice: number;
  entrySlot: number;
  peakValue: bigint; // best liquidation value seen since entry.
  coolUntil: number;
  exiting: boolean; // a sell is in flight: do not send another.
}

/** What selling `tokens` would net now, curve fees deducted, tx fee not included. */
function liquidationValue(
  vq: bigint,
  vt: bigint,
  rq: bigint,
  tokens: bigint,
): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  let out = (tokens * vq) / (vt + tokens);
  if (out > rq) out = rq;
  return out - (out * FEE_BPS + BPS - 1n) / BPS;
}

export function createSharpeBot(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const coin = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { ticks: [], entryPrice: 0, entrySlot: -1, peakValue: 0n, coolUntil: -1, exiting: false };
      coins.set(mint, c);
    }
    return c;
  };

  return function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const orders: OrderInput[] = [];
    const orderCap = state.hello.caps.max_orders_per_batch;
    const txFee = state.txFeeLamports();
    const pendingMints = new Set<Pubkey>();
    for (const o of state.pending.values()) pendingMints.add(o.order.mint);

    // --- Record this batch's trades, in chain order. ---
    const traded: Pubkey[] = [];
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const c = coin(e.mint);
      const vt = BigInt(e.virtual_token_reserves);
      const vq = BigInt(e.virtual_quote_reserves);
      const price = vt === 0n ? 0 : Number(vq) / Number(vt);
      c.ticks.push({
        slot: e.slot,
        price,
        isBuy: e.is_buy,
        sol: BigInt(e.sol_amount),
        realSol: BigInt(e.real_quote_reserves),
      });
      if (c.ticks.length > p.windowTrades) c.ticks.splice(0, c.ticks.length - p.windowTrades);
      if (traded[traded.length - 1] !== e.mint && !traded.includes(e.mint)) traded.push(e.mint);
    }

    // --- A sell that resolved frees the coin; a buy that never filled forgets the entry. ---
    for (const f of batch.fills) {
      const c = coins.get(f.mint);
      if (c === undefined) continue;
      if (f.side === 'sell') {
        c.exiting = false;
        if (!state.positions.has(f.mint)) {
          c.entrySlot = -1;
          c.peakValue = 0n;
          c.coolUntil = slot + p.cooldownSlots;
        }
      } else if (f.status !== 'filled' && !state.positions.has(f.mint)) {
        let stillPending = false;
        for (const o of state.pending.values()) if (o.order.mint === f.mint) stillPending = true;
        if (!stillPending) {
          c.entrySlot = -1;
          c.peakValue = 0n;
        }
      }
    }

    // --- 1. Manage held positions: exits first, in sorted mint order. ---
    // Exits decide the Sharpe: take small wins early, cut losers at -5% before
    // they can dent the hourly series, and never let a position drift stale.
    const held = [...state.positions.keys()].sort();
    for (const mint of held) {
      if (orders.length >= orderCap) break;
      const h = state.positions.get(mint)!;
      const c = coin(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete || c.exiting || pendingMints.has(mint)) continue;
      const value = liquidationValue(
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
        curve.real_quote_reserves,
        h.token_amount,
      );
      if (value > c.peakValue) c.peakValue = value;
      const cost = h.cost_lamports;
      const gain = cost > 0n ? Number(value - cost) / Number(cost) : 0;
      const peakGain = cost > 0n ? Number(c.peakValue - cost) / Number(cost) : 0;
      const takeProfit = gain >= p.takeProfit;
      const stopLoss = gain <= -p.stopLoss;
      const trailing =
        peakGain >= p.trailArm && value <= (c.peakValue * BigInt(Math.round((1 - p.trailGiveback) * 10000))) / 10000n;
      const stale = c.entrySlot >= 0 && slot - c.entrySlot >= p.maxHoldSlots;
      if (takeProfit || stopLoss || trailing || stale) {
        orders.push({ side: 'sell', mint, token_amount: h.token_amount, max_slippage_bps: p.sellSlippageBps });
        c.exiting = true;
      }
    }

    // --- 2. New entries on coins that traded this batch. ---
    // The entry bar is deliberately high: dip + VWAP gap + bounce + buyer flow
    // + last trade a buy. Most batches produce no entry at all — that is the
    // point. Every fill pays curve + tx fees, so a marginal trade is a Sharpe
    // loss even when it wins a little.
    let entries = 0;
    for (const mint of traded) {
      if (orders.length >= orderCap || entries >= p.maxEntriesPerBatch) break;
      if (state.committedPositionCount() >= state.hello.caps.max_open_positions) break;
      if (state.positions.has(mint) || pendingMints.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const c = coin(mint);
      if (slot < c.coolUntil) continue;
      const ticks = c.ticks;
      if (ticks.length < p.flowTrades) continue;
      const last = ticks[ticks.length - 1]!;
      if (last.realSol < p.minRealSol) continue;

      // Recent high (and low) over the lookback window.
      let high = 0;
      let low = Number.POSITIVE_INFINITY;
      for (let i = ticks.length - 1; i >= 0; i--) {
        const t = ticks[i]!;
        if (slot - t.slot > p.highWindowSlots) break;
        if (t.price > high) high = t.price;
        if (t.price < low) low = t.price;
      }
      if (high <= 0 || low === Number.POSITIVE_INFINITY) continue;
      const dip = 1 - last.price / high;
      if (dip < p.dipMin || dip > p.dipMax) continue;
      // The turn must already be happening: price off the low.
      if (last.price < low * (1 + p.bounceMin)) continue;

      // Volume-weighted price of the recent flow, and who is buying it.
      // The VWAP anchors on a longer window than the flow read, so it still
      // remembers pre-dip prices when the dip itself is only a few trades old.
      let wSum = 0;
      let vSum = 0n;
      const vFrom = Math.max(0, ticks.length - p.vwapTrades);
      for (let i = vFrom; i < ticks.length; i++) {
        const t = ticks[i]!;
        wSum += t.price * Number(t.sol);
        vSum += t.sol;
      }
      if (vSum === 0n) continue;
      const vwap = wSum / Number(vSum);
      if (vwap <= 0 || last.price > vwap * (1 - p.vwapGapMin)) continue;
      let buys = 0;
      let netBuy = 0n;
      const from = Math.max(0, ticks.length - p.flowTrades);
      for (let i = from; i < ticks.length; i++) {
        const t = ticks[i]!;
        if (t.isBuy) {
          buys++;
          netBuy += t.sol;
        } else {
          netBuy -= t.sol;
        }
      }
      if (buys < p.minFlowBuys || netBuy < p.minNetBuySol) continue;
      if (!last.isBuy) continue; // the dip is being bought, not still falling.

      // Size: target stake, capped at 97% of the per-reply size cap (our own fills
      // shift the reserves the harness checks against, so leave a margin).
      const sizeCap = (state.maxBuyLamports(mint) * 97n) / 100n;
      let amount = p.stake < sizeCap ? p.stake : sizeCap;
      if (amount < p.minBuy) continue;
      if (state.freeCashLamports() - amount - txFee < 0n) continue;

      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
      c.entryPrice = last.price;
      c.entrySlot = slot;
      c.peakValue = 0n;
      c.exiting = false;
      pendingMints.add(mint);
      entries++;
    }
    return orders;
  };
}
