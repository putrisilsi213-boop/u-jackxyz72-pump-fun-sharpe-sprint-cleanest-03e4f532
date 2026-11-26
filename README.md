# Sharpe Runner — Pump.fun Sharpe Sprint

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/putrisilsi213-boop/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/putrisilsi213-boop/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A Sharpe-optimised confirmed-runner paper bot for the
[make.fun Pump.fun Sharpe Sprint](https://make.fun/c/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
— ranked by hourly Sharpe ratio, not raw PnL.

## Strategy

Steady small wins, tiny drawdown. The bot buys only **confirmed runners**:
a coin that has dipped 20–55% off its recent high, is trading at least 8%
below its recent volume-weighted price, and has **already turned** — price
bounced ≥13% off its recent low with buyers in 7 of the last 10 trades.
Never snipes fresh launches, never averages down, one entry per dip.

Exits are tight and fee-aware: 8% take-profit, 5% stop-loss, a trailing
give-back of 5% once up 4%, or a 300-slot max hold — whichever comes first.
Stakes are 0.25 SOL per position, max 5 open, max 1 new entry per batch.

Everything is a pure function of the batches the harness sends: no clock,
no randomness, no I/O, so the two graded executions produce byte-identical
action logs. Node 22 stdlib only; the SDK shim is vendored in `vendor/`.

## Files

- `main.ts` — entry point, wires the strategy into the harness.
- `strategy.ts` — the confirmed-runner strategy and its tuned parameters.
- `vendor/makefun-bot.ts` — vendored make.fun bot SDK shim.

## Local grading

From the competition kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver docker
```

## License

MIT — see `LICENSE`.
