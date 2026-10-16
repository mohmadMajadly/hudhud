// Three ways to stop: interrupt one turn, close (drain) a session, or abort
// it with a signal or dispose.
// Guide: docs/guide/sessions.md#stopping-interrupt-close-abort-and-dispose

import { setTimeout as sleep } from 'node:timers/promises';

import { hudhud, isHudhudError } from 'hudhudjs';

// 1. Interrupt one turn; the session stays usable.
const session = await hudhud.session();
const turn = session.send('Count slowly from 1 to 500, one number per line.');
await sleep(2000);
await turn.interrupt();
const interrupted = await turn.done;
console.log(`outcome: ${interrupted.outcome}`); // 'cancelled' when the interrupt took effect

// 2. Abort a single ask() with a signal: it rejects at once with ABORTED,
//    the turn is interrupted and settles in the background.
try {
  await session.ask('Write a long essay about rivers.', { signal: AbortSignal.timeout(5000) });
} catch (error) {
  if (!isHudhudError(error, 'ABORTED')) throw error;
  console.log('ask() aborted after 5 s');
}

// 3. Close drains: queued and running turns finish (bounded by closeTimeoutMs,
//    30 s by default), then the CLI exits on end of input.
await session.close();

// 4. `await using` disposes at the end of the block, which aborts (the
//    termination ladder) instead of draining.
{
  await using scratch = await hudhud.session({ closeTimeoutMs: 10_000 });
  await scratch.ask('Say hi.');
}
