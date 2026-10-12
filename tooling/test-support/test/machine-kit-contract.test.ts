// The machine kit against the neutral machine contract of @hudhud/core
// (plan §1.4, K3): every core HarnessMachine is a KitMachine, and the kit
// drives a machine typed with the contract itself, whose exit handling is
// classifyExit. (The kit imports the contract's input types, so the former
// mirror-equality test is gone; W2-Z ruling B.)

import type { HarnessMachine, MachineEffect, TerminationIntent } from '@hudhud/core/protocol';
import { classifyExit } from '@hudhud/core/protocol';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { KitMachine } from '../src/machine-kit.js';
import { assertMachineContract } from '../src/machine-kit.js';

describe('machine kit and the core contract', () => {
  it('accepts every core HarnessMachine', () => {
    expectTypeOf<HarnessMachine<{ n: number }, string>>().toExtend<
      KitMachine<{ n: number }, string>
    >();
  });
});

interface MiniState {
  readonly seq: number;
  readonly open: readonly string[];
  readonly intent: TerminationIntent;
  readonly stdinOpen: boolean;
  readonly ended: boolean;
}

/**
 * A minimal machine typed with the core contract: turns stay open until the
 * process exits; the exit is classified by `classifyExit`.
 */
const miniMachine: HarnessMachine<MiniState, null> = {
  initialState: () => ({ seq: 0, open: [], intent: 'none', stdinOpen: true, ended: false }),
  step: (state, input) => {
    if (state.ended) return { state, effects: [] };
    switch (input.type) {
      case 'cmd.send':
        return {
          state: { ...state, seq: state.seq + 1, open: [...state.open, input.turnId] },
          effects: [
            {
              type: 'event',
              event: {
                type: 'turn.queued',
                turnId: input.turnId,
                seq: state.seq,
                ts: input.at,
                sessionId: 's',
              },
            },
          ],
        };
      case 'cmd.abort': {
        const effects: MachineEffect[] = state.stdinOpen ? [{ type: 'stdin.end' }] : [];
        effects.push({ type: 'ladder.start', intent: input.intent });
        return { state: { ...state, intent: input.intent, stdinOpen: false }, effects };
      }
      case 'process.exit': {
        const { outcome, turnSynthesis } = classifyExit({
          intent: state.intent,
          exit: { code: input.code, signal: input.signal },
          turnActive: state.open.length > 0,
          platform: 'posix',
        });
        const effects: MachineEffect[] = state.open.map((turnId) =>
          turnSynthesis === 'cancelled'
            ? {
                type: 'turn.settle',
                turnId,
                result: {
                  turnId,
                  sessionId: 's',
                  outcome: 'cancelled',
                  isError: false,
                  permissionDenials: [],
                  synthesized: true,
                },
              }
            : {
                type: 'turn.fail',
                turnId,
                error: { code: 'PROCESS_EXITED', message: 'exited', retryable: true },
              },
        );
        effects.push({ type: 'session.end', outcome });
        return { state: { ...state, open: [], ended: true }, effects };
      }
      case 'process.started':
      case 'line':
      case 'line.oversized':
      case 'line.invalid-utf8':
      case 'stderr.line':
      case 'stdout.end':
      case 'stdin.error':
      case 'process.spawn-error':
      case 'timer':
      case 'ladder.done':
      case 'cmd.interrupt':
      case 'cmd.permission':
      case 'cmd.permission-abort':
      case 'cmd.set-permission-mode':
      case 'cmd.close':
        return { state, effects: [] };
    }
  },
};

describe('the kit drives a machine typed with the core contract', () => {
  it('passes the contract invariants', () => {
    assertMachineContract(miniMachine, { config: null, firstSeq: 0, numRuns: 300 });
  });

  it('settles open turns by the exit classification', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const sent = miniMachine.step(miniMachine.initialState(null), {
      type: 'cmd.send',
      turnId: 't',
      content: 'x',
      atMs: 0,
      at,
    });
    const exit = miniMachine.step(sent.state, {
      type: 'process.exit',
      code: 0,
      signal: null,
      atMs: 1,
      at,
    });
    expect(exit.effects.map((effect) => effect.type)).toEqual(['turn.fail', 'session.end']);
    expect(exit.effects.at(-1)).toEqual({ type: 'session.end', outcome: 'unknown' });
  });
});
