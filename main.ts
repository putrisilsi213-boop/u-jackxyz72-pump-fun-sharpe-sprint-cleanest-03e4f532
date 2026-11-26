// Sharpe Runner — entry point.
//
// Wires the strategy into the pump.fun replay harness: the vendored shim owns
// the wire (stdin/stdout, hello/batch/done), the strategy owns the decisions.

import { runBot } from './vendor/makefun-bot.ts';
import { decideOrders } from './strategy.ts';

await runBot({
  onBatch(state, batch) {
    return decideOrders(state, batch);
  },
});
