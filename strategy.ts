// Sharpe Runner — confirmed-runner paper trader for the pump.fun replay harness.
//
// Buys only confirmed runners: a coin that has dipped off its recent high, trades
// below its recent volume-weighted average price, and has already turned (bounced
// off its recent low with buyers winning most of the last trades). Exits on
// take-profit, stop-loss, a trailing give-back once in profit, or a max hold.
//
// Pure function of the batches: no clock, no randomness, no I/O, fully
// deterministic — two graded runs produce byte-identical action logs.
// Node 22 standard library only.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// ---- tuned parameters ----
// The thresholds below are the specification; only the lookback windows move.
const STAKE_LAMPORTS = 250_000_000n; // 0.25 SOL per position
const MAX_POSITIONS = 5;
const MAX_ENTRIES_PER_BATCH = 1;
const TAKE_PROFIT = 0.08; // +8%
const STOP_LOSS = 0.05; // -5%
const TRAIL_ARM = 0.04; // trailing arms once up 4%
const TRAIL_GIVEBACK = 0.05; // sell after a 5% give-back from the peak
const MAX_HOLD_SLOTS = 300;
const DIP_MIN = 0.2; // dipped at least 20% off the recent high
const DIP_MAX = 0.55; // ... but no more than 55%
const VWAP_DISCOUNT = 0.08; // at least 8% below recent VWAP
const BOUNCE_MIN = 0.13; // bounced at least 13% off the recent low
const BUY_WINDOW = 10; // buyers made 7 of the last 10 trades
const BUY_MIN = 7;
const HIGH_WINDOW = 50; // recent-high lookback, in trades
const LOW_WINDOW = 50; // recent-low lookback, in trades
const VWAP_WINDOW = 50; // VWAP lookback, in trades
const MIN_TRADES = 20; // never buy a fresh launch
const SLIPPAGE_BPS = 500;

// ---- per-mint history (module state, fresh on every run) ----

interface Tick {
  price: number; // SOL per token, from post-trade virtual reserves
  sol: number; // SOL side of the trade, in lamports
  tokens: number; // token side of the trade, in base units
  buy: boolean;
  slot: number;
}

interface Coin {
  ticks: Tick[];
  createdSlot: number | null;
  complete: boolean;
  enteredDip: string | null; // high-slot key of the dip already entered, if any
}

interface OpenTrade {
  entryPrice: number; // SOL per token, from the position cost basis
  entrySlot: number; // slot the position was first seen in the account
  peak: number; // highest price seen since entry
}

const coins = new Map<string, Coin>();
const openTrades = new Map<string, OpenTrade>();
const MAX_TICKS = 512; // history cap per mint; windows above stay well inside it

function coinFor(mint: string): Coin {
  let coin = coins.get(mint);
  if (coin === undefined) {
    coin = { ticks: [], createdSlot: null, complete: false, enteredDip: null };
    coins.set(mint, coin);
  }
  return coin;
}

// ---- window helpers ----

// Price of a curve from its virtual reserves: SOL per token.
function curvePrice(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

interface WindowStats {
  high: number;
  highSlot: number;
  low: number;
  vwap: number;
}

// Recent high / low / VWAP over the last `highN` / `lowN` / `vwapN` ticks.
// VWAP is total SOL traded divided by total tokens traded in its window.
function windowStats(ticks: Tick[], highN: number, lowN: number, vwapN: number): WindowStats {
  let high = 0;
  let highSlot = -1;
  const highStart = Math.max(0, ticks.length - highN);
  for (let i = highStart; i < ticks.length; i++) {
    if (ticks[i].price > high) {
      high = ticks[i].price;
      highSlot = ticks[i].slot;
    }
  }
  let low = Number.POSITIVE_INFINITY;
  const lowStart = Math.max(0, ticks.length - lowN);
  for (let i = lowStart; i < ticks.length; i++) {
    if (ticks[i].price < low) low = ticks[i].price;
  }
  let solSum = 0;
  let tokenSum = 0;
  const vwapStart = Math.max(0, ticks.length - vwapN);
  for (let i = vwapStart; i < ticks.length; i++) {
    solSum += ticks[i].sol;
    tokenSum += ticks[i].tokens;
  }
  return { high, highSlot, low, vwap: tokenSum > 0 ? solSum / tokenSum : 0 };
}

// How many of the last `BUY_WINDOW` trades were buys.
function buyPressure(ticks: Tick[]): number {
  let buys = 0;
  const start = Math.max(0, ticks.length - BUY_WINDOW);
  for (let i = start; i < ticks.length; i++) {
    if (ticks[i].buy) buys++;
  }
  return buys;
}

// ---- entry ----

function hasPendingBuy(state: BotState, mint: string): boolean {
  for (const pending of state.pending.values()) {
    if (pending.order.side === 'buy' && pending.order.mint === mint) return true;
  }
  return false;
}

// Fold this batch's events into history, testing each trade's mint for entry
// right after its tick lands. Returns the batch's one buy order, if any.
function ingestAndEnter(state: BotState, batch: Batch): OrderInput | undefined {
  let buy: OrderInput | undefined;
  const room = state.committedPositionCount() < MAX_POSITIONS;
  for (const event of batch.events) {
    if (event.event === 'CreateEvent') {
      coinFor(event.mint).createdSlot = event.slot;
      continue;
    }
    if (event.event === 'CompleteEvent') {
      coinFor(event.mint).complete = true;
      continue;
    }
    if (event.event !== 'TradeEvent') continue;
    const coin = coinFor(event.mint);
    const price = curvePrice(BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves));
    coin.ticks.push({
      price,
      sol: Number(BigInt(event.sol_amount)),
      tokens: Number(BigInt(event.token_amount)),
      buy: event.is_buy,
      slot: event.slot,
    });
    if (coin.ticks.length > MAX_TICKS) coin.ticks.splice(0, coin.ticks.length - MAX_TICKS);
    if (buy !== undefined) continue;
    if (!room) continue;
    if (coin.complete || coin.ticks.length < MIN_TRADES) continue;
    if (state.positions.has(event.mint) || hasPendingBuy(state, event.mint)) continue;
    if (price <= 0) continue;
    const stats = windowStats(coin.ticks, HIGH_WINDOW, LOW_WINDOW, VWAP_WINDOW);
    if (stats.high <= 0 || stats.vwap <= 0 || stats.low === Number.POSITIVE_INFINITY) continue;
    const dip = (stats.high - price) / stats.high;
    if (dip < DIP_MIN || dip > DIP_MAX) continue;
    if (price > (1 - VWAP_DISCOUNT) * stats.vwap) continue;
    if (price < (1 + BOUNCE_MIN) * stats.low) continue;
    if (buyPressure(coin.ticks) < BUY_MIN) continue;
    const dipKey = String(stats.highSlot);
    if (coin.enteredDip === dipKey) continue; // at most one new entry per dip
    const cap = state.maxBuyLamports(event.mint);
    const size = cap > 0n && cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
    if (size <= 0n) continue;
    if (state.freeCashLamports() < size + state.txFeeLamports()) continue;
    coin.enteredDip = dipKey;
    buy = { side: 'buy', mint: event.mint, quote_lamports: size, max_slippage_bps: SLIPPAGE_BPS };
  }
  return buy;
}

// ---- exits ----

function hasPendingSell(state: BotState, mint: string): boolean {
  for (const pending of state.pending.values()) {
    if (pending.order.side === 'sell' && pending.order.mint === mint) return true;
  }
  return false;
}

// Take profit, stop loss, trailing give-back once in profit, or max hold —
// whichever comes first. Sells the full position.
function exits(state: BotState): OrderInput[] {
  const orders: OrderInput[] = [];
  for (const [mint, holding] of state.positions) {
    if (hasPendingSell(state, mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (!(price > 0)) continue;
    let trade = openTrades.get(mint);
    if (trade === undefined) {
      const tokens = Number(holding.token_amount);
      const entryPrice = tokens > 0 ? Number(holding.cost_lamports) / tokens : 0;
      if (!(entryPrice > 0)) continue;
      trade = { entryPrice, entrySlot: state.slot, peak: price };
      openTrades.set(mint, trade);
    }
    if (price > trade.peak) trade.peak = price;
    const ret = price / trade.entryPrice - 1;
    const held = state.slot - trade.entrySlot;
    let sell = false;
    if (ret >= TAKE_PROFIT) sell = true;
    else if (ret <= -STOP_LOSS) sell = true;
    else if (trade.peak >= (1 + TRAIL_ARM) * trade.entryPrice && price <= (1 - TRAIL_GIVEBACK) * trade.peak) sell = true;
    else if (held >= MAX_HOLD_SLOTS) sell = true;
    if (sell) {
      orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SLIPPAGE_BPS });
      openTrades.delete(mint);
    }
  }
  for (const mint of [...openTrades.keys()]) {
    if (!state.positions.has(mint)) openTrades.delete(mint);
  }
  return orders;
}

// ---- entry point for main.ts ----

// One batch, one decision: at most one new entry, plus an exit per position
// whose rule fired. Order of evaluation is the batch's own event order, so
// the result is a pure function of the batches seen so far.
export function decideOrders(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  const buy = ingestAndEnter(state, batch);
  if (buy !== undefined) orders.push(buy);
  for (const sell of exits(state)) orders.push(sell);
  return orders;
}

