# Sharpe Runner — Pump.fun Sharpe Sprint

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/putrisilsi213-boop/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/putrisilsi213-boop/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A Sharpe-optimised confirmed-runner paper trader for the pump.fun replay
harness. It buys only coins that have already proven the dip is over, then
exits on the first rule that fires — steady, controlled gains over moonshots.

## Strategy

Entry — buy only confirmed runners. A coin qualifies only when all of these
hold: it has dipped between 20% and 55% off its recent high; it trades at
least 8% below its recent volume-weighted average price; and it has already
turned — price has bounced at least 13% off its recent low and buyers made 7
of the last 10 trades. Never buy a fresh launch, never average down, at most
one new entry per dip.

Exits — take profit at +8%, stop loss at −5%, a trailing give-back of 5% once
up 4%, or a 300-slot maximum hold, whichever comes first.

Sizing — 0.25 SOL per position, at most 5 open positions, at most 1 new entry
per batch.

The bot is a pure function of the batches: no clock, no randomness, no I/O,
fully deterministic — two graded runs produce byte-identical action logs.

## Files

- `main.ts` — entry point; wires the strategy into the harness.
- `strategy.ts` — the strategy and its tuned parameters.
- `vendor/makefun-bot.ts` — vendored SDK shim (do not touch).

## Local grading

From the competition kit directory, with the official sprint kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot /home/hatch/workspace/makefun/sharpe-entry --driver process
```

## License

MIT

