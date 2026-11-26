// Sharpe-optimised confirmed-runner bot for make.fun's Pump.fun Sharpe Sprint.
// Run by the grader as `node /bot/main.ts`; the SDK shim is vendored in vendor/.

import { runBot } from './vendor/makefun-bot.ts';
import { createSharpeBot, DEFAULT_PARAMS } from './strategy.ts';

await runBot({ onBatch: createSharpeBot(DEFAULT_PARAMS) });
