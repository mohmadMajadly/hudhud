import fc from 'fast-check';
import { describe, it } from 'vitest';

import { runPosixLadder } from '../../../src/process/ladder/posix.js';
import { DEFAULT_LADDER_TIMING, type InterruptOutcome } from '../../../src/process/ladder/types.js';
import { fcParams } from '../tree/support.js';
import { CLI, FakeWorld, HOST, LAUNCHER, runWithClock, SLEEP, TOOL } from './fake-os.js';

describe('runPosixLadder (property)', () => {
  it('never signals after the exit was observed, nor the host, pid 0/1 or a protected group', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.integer({ min: 0, max: 9000 }), { nil: null }),
        fc.constantFrom<InterruptOutcome>('acknowledged', 'timeout', 'not-applicable'),
        fc.constantFrom<number | null>(CLI.pid, LAUNCHER.pid, null, 999),
        fc.boolean(),
        async (exitAt, interruptOutcome, initializePid, termCleansUp) => {
          const world = FakeWorld.standard(initializePid);
          if (exitAt !== null) {
            world.clock.schedule(exitAt, () => {
              world.proc.exit();
            });
          }
          world.onSignal = ({ world: w, call }) => {
            if (termCleansUp && call.signal === 'SIGTERM') {
              for (const pid of [SLEEP.pid, TOOL.pid, CLI.pid, LAUNCHER.pid]) w.remove(pid);
              return 'sent';
            }
            return undefined;
          };
          const report = await runWithClock(
            world.clock,
            runPosixLadder(
              world.proc,
              { interrupt: () => Promise.resolve(interruptOutcome) },
              DEFAULT_LADDER_TIMING,
              { intent: 'abort', os: world.os, clock: world.clock },
            ),
          );
          const protectedGroups = [0, 1, HOST.pgid, LAUNCHER.pid, CLI.pid];
          // Only the sweep may run after the exit, and only the exit caused by our own SIGKILL.
          const spawnedKill = world.calls.findIndex(
            (call) => call.id === LAUNCHER.pid && call.signal === 'SIGKILL',
          );
          for (const [index, call] of world.calls.entries()) {
            if (call.afterExit && (spawnedKill < 0 || index <= spawnedKill)) return false;
            if (call.id === 0 || call.id === 1 || call.id === HOST.pid) return false;
            if (call.kind === 'group' && protectedGroups.includes(call.id)) return false;
          }
          // Intent always first; an exit before S1 means no signal at all.
          if (report.steps[0]?.name !== 'intent') return false;
          if (exitAt !== null && exitAt < 2000 && world.calls.length > 0) return false;
          return true;
        },
      ),
      fcParams(200),
    );
  });
});
