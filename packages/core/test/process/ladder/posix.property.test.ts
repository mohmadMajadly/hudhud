import fc from 'fast-check';
import { describe, it } from 'vitest';

import { runPosixLadder } from '../../../src/process/ladder/posix.js';
import { DEFAULT_LADDER_TIMING, type InterruptOutcome } from '../../../src/process/ladder/types.js';
import { fcParams } from '../tree/support.js';
import { CLI, FakeWorld, HOST, LAUNCHER, runWithClock, SLEEP, TOOL } from './fake-os.js';

describe('runPosixLadder (property)', () => {
  // Review R3-1 / R8-1: the old rule ("no signal after the exit, except
  // after our own SIGKILL") forbade the sweep a CLI that exits on SIGTERM
  // needs. The rule now: after the exit only the sweep signals, and only the
  // recorded tool processes; and when S1 was taken and the sweep ran, no
  // recorded descendant survives the ladder (liveness).
  it('after the exit signals only recorded descendants, never the host, pid 0/1 or a protected group; nothing recorded survives', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.integer({ min: 0, max: 9000 }), { nil: null }),
        fc.constantFrom<InterruptOutcome>('acknowledged', 'timeout', 'not-applicable'),
        fc.constantFrom<number | null>(CLI.pid, LAUNCHER.pid, null, 999),
        fc.constantFrom('ignores', 'cleans-up', 'exits-alone'),
        fc.constantFrom('read', 'late', 'null', 'rejected', 'other-pid'),
        async (exitAt, interruptOutcome, initializePid, onTerm, identityMode) => {
          const world = FakeWorld.standard(initializePid);
          const spawned = { pid: LAUNCHER.pid, startTime: LAUNCHER.startTime };
          world.proc.identity =
            identityMode === 'read'
              ? Promise.resolve(spawned)
              : identityMode === 'late'
                ? new Promise((resolve) => {
                    world.clock.schedule(2500, () => {
                      resolve(spawned);
                    });
                  })
                : identityMode === 'null'
                  ? Promise.resolve(null)
                  : identityMode === 'rejected'
                    ? Promise.reject(new Error('read failed'))
                    : Promise.resolve({ ...spawned, pid: CLI.pid });
          if (exitAt !== null) {
            world.clock.schedule(exitAt, () => {
              world.proc.exit();
            });
          }
          world.onSignal = ({ world: w, call }) => {
            if (onTerm !== 'ignores' && call.signal === 'SIGTERM') {
              // `exits-alone`: the CLI exits and leaves its tool group running.
              const ending =
                onTerm === 'cleans-up'
                  ? [SLEEP.pid, TOOL.pid, CLI.pid, LAUNCHER.pid]
                  : [CLI.pid, LAUNCHER.pid];
              for (const pid of ending) w.remove(pid);
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
          const recorded = [CLI.pid, TOOL.pid, SLEEP.pid];
          for (const call of world.calls) {
            if (call.id === 0 || call.id === 1 || call.id === HOST.pid) return false;
            if (call.kind === 'group' && protectedGroups.includes(call.id)) return false;
            // After the exit: only SIGKILLs of the sweep, only recorded tool processes or their group.
            if (call.afterExit) {
              if (call.signal !== 'SIGKILL') return false;
              if (call.kind === 'process' && !recorded.includes(call.id)) return false;
              if (call.kind === 'group' && call.id !== TOOL.pgid) return false;
            }
          }
          // Without a verified identity only the spawned pid is signalled.
          if (!['read', 'late'].includes(identityMode)) {
            if (world.calls.some((call) => call.kind === 'group' || call.id !== LAUNCHER.pid)) {
              return false;
            }
          }
          // Intent always first; an exit before S1 means no signal from the
          // ladder (the binding's sweep after the exit covers it).
          if (report.steps[0]?.name !== 'intent') return false;
          if (exitAt !== null && exitAt < 2000 && world.calls.length > 0) return false;
          // Liveness: once S1 recorded the tree and the sweep ran, nothing recorded survives.
          const s1 = report.steps.some(
            (step) => step.name === 'snapshot-s1' && step.outcome === 'done',
          );
          const swept = report.steps.some(
            (step) => step.name === 'sweep' && step.outcome === 'done',
          );
          if (s1 && !swept) return false;
          if (swept && recorded.some((pid) => world.records.has(pid))) return false;
          return true;
        },
      ),
      fcParams(200),
    );
  });
});
