import process from 'node:process';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type {
  ClassifyExitInput,
  ExitClassification,
  ExitObservation,
  TerminationIntent,
} from '../../../src/protocol/machine/outcome.js';
import {
  TERMINATION_INTENTS,
  UNKNOWN_EXIT_CODE,
  classifyExit,
} from '../../../src/protocol/machine/outcome.js';

const seedText = process.env['FC_SEED'];
const runs = <T>(): fc.Parameters<T> => ({
  numRuns: 2000,
  ...(seedText === undefined ? {} : { seed: Number(seedText) }),
});

const PLATFORMS = ['win32', 'posix'] as const;
const code = (value: number): ExitObservation => ({ code: value, signal: null });
const signal = (name: string): ExitObservation => ({ code: null, signal: name });

type Row = readonly [
  name: string,
  input: Omit<ClassifyExitInput, 'platform'>,
  expected: ExitClassification,
];

const closed: ExitClassification = { outcome: 'closed', turnSynthesis: 'none', error: 'none' };
const unknownExited: ExitClassification = {
  outcome: 'unknown',
  turnSynthesis: 'error',
  error: 'PROCESS_EXITED',
};

/** Plan §3.3, row by row, identical on both platforms. */
const TABLE: readonly Row[] = [
  // any | 4294967295 | unknown | error (synthesized) | PROCESS_EXITED unless close/abort
  [
    '-1 exit, no intent, active turn',
    { intent: 'none', exit: code(UNKNOWN_EXIT_CODE), turnActive: true },
    unknownExited,
  ],
  [
    '-1 exit, no intent, idle',
    { intent: 'none', exit: code(UNKNOWN_EXIT_CODE), turnActive: false },
    { outcome: 'unknown', turnSynthesis: 'none', error: 'PROCESS_EXITED' },
  ],
  [
    '-1 exit, watchdog',
    { intent: 'watchdog', exit: code(UNKNOWN_EXIT_CODE), turnActive: false },
    { outcome: 'unknown', turnSynthesis: 'none', error: 'PROCESS_EXITED' },
  ],
  [
    '-1 exit, auth fail-fast',
    { intent: 'auth-fail-fast', exit: code(UNKNOWN_EXIT_CODE), turnActive: true },
    unknownExited,
  ],
  [
    '-1 exit, close',
    { intent: 'close', exit: code(UNKNOWN_EXIT_CODE), turnActive: false },
    { outcome: 'unknown', turnSynthesis: 'none', error: 'none' },
  ],
  [
    '-1 exit, close-timeout',
    { intent: 'close-timeout', exit: code(UNKNOWN_EXIT_CODE), turnActive: true },
    { outcome: 'unknown', turnSynthesis: 'error', error: 'none' },
  ],
  [
    '-1 exit, abort',
    { intent: 'abort', exit: code(UNKNOWN_EXIT_CODE), turnActive: true },
    { outcome: 'unknown', turnSynthesis: 'error', error: 'none' },
  ],
  [
    '-1 exit, dispose',
    { intent: 'dispose', exit: code(UNKNOWN_EXIT_CODE), turnActive: false },
    { outcome: 'unknown', turnSynthesis: 'none', error: 'none' },
  ],
  // abort, dispose | any | aborted | cancelled | none
  [
    'abort, signal, active',
    { intent: 'abort', exit: signal('SIGKILL'), turnActive: true },
    { outcome: 'aborted', turnSynthesis: 'cancelled', error: 'none' },
  ],
  [
    'abort, code 0, idle',
    { intent: 'abort', exit: code(0), turnActive: false },
    { outcome: 'aborted', turnSynthesis: 'none', error: 'none' },
  ],
  [
    'dispose, code 1, active',
    { intent: 'dispose', exit: code(1), turnActive: true },
    { outcome: 'aborted', turnSynthesis: 'cancelled', error: 'none' },
  ],
  // close | code 0 or 1, no active turn | closed | none | none
  ['close, code 0', { intent: 'close', exit: code(0), turnActive: false }, closed],
  ['close, code 1', { intent: 'close', exit: code(1), turnActive: false }, closed],
  [
    'close, code 1 after an error result',
    { intent: 'close', exit: code(1), turnActive: false, lastResultIsError: true },
    closed,
  ],
  // close not matching its row: classified by the `none` rows
  [
    'close, code 0, active turn',
    { intent: 'close', exit: code(0), turnActive: true },
    unknownExited,
  ],
  [
    'close, code 2',
    { intent: 'close', exit: code(2), turnActive: false },
    { outcome: 'crashed', turnSynthesis: 'none', error: 'PROCESS_EXITED' },
  ],
  [
    'close, signal',
    { intent: 'close', exit: signal('SIGTERM'), turnActive: false },
    { outcome: 'killed-externally', turnSynthesis: 'none', error: 'PROCESS_EXITED' },
  ],
  // close-timeout | any | aborted | cancelled | none
  [
    'close-timeout, signal, active',
    { intent: 'close-timeout', exit: signal('SIGKILL'), turnActive: true },
    { outcome: 'aborted', turnSynthesis: 'cancelled', error: 'none' },
  ],
  [
    'close-timeout, code 0, idle',
    { intent: 'close-timeout', exit: code(0), turnActive: false },
    { outcome: 'aborted', turnSynthesis: 'none', error: 'none' },
  ],
  // watchdog, handshake-failed | any | failed | n/a | the handshake error
  [
    'watchdog',
    { intent: 'watchdog', exit: signal('SIGKILL'), turnActive: false },
    { outcome: 'failed', turnSynthesis: 'none', error: 'recorded' },
  ],
  [
    'handshake-failed',
    { intent: 'handshake-failed', exit: code(1), turnActive: false },
    { outcome: 'failed', turnSynthesis: 'none', error: 'recorded' },
  ],
  [
    'watchdog with a turn open',
    { intent: 'watchdog', exit: code(0), turnActive: true },
    { outcome: 'failed', turnSynthesis: 'error', error: 'recorded' },
  ],
  // auth-fail-fast | any | failed | error | AUTHENTICATION_FAILED
  [
    'auth fail-fast, active',
    { intent: 'auth-fail-fast', exit: signal('SIGTERM'), turnActive: true },
    { outcome: 'failed', turnSynthesis: 'error', error: 'AUTHENTICATION_FAILED' },
  ],
  [
    'auth fail-fast, idle',
    { intent: 'auth-fail-fast', exit: code(1), turnActive: false },
    { outcome: 'failed', turnSynthesis: 'none', error: 'AUTHENTICATION_FAILED' },
  ],
  // oversized-frame | any | failed | error | OVERSIZED_FRAME
  [
    'oversized frame, active',
    { intent: 'oversized-frame', exit: code(0), turnActive: true },
    { outcome: 'failed', turnSynthesis: 'error', error: 'OVERSIZED_FRAME' },
  ],
  [
    'oversized frame, idle',
    { intent: 'oversized-frame', exit: signal('SIGKILL'), turnActive: false },
    { outcome: 'failed', turnSynthesis: 'none', error: 'OVERSIZED_FRAME' },
  ],
  // none | code 0, no active turn, last result not error | closed
  ['none, code 0, idle', { intent: 'none', exit: code(0), turnActive: false }, closed],
  [
    'none, code 0, idle, last result ok',
    { intent: 'none', exit: code(0), turnActive: false, lastResultIsError: false },
    closed,
  ],
  // none | code 1, last result is_error | closed | settled from the result
  [
    'none, code 1 after an error result',
    { intent: 'none', exit: code(1), turnActive: false, lastResultIsError: true },
    closed,
  ],
  // none | code 0 with an active turn and no result (K22) | unknown | turn fails | PROCESS_EXITED
  [
    'none, code 0, active turn (terminal Ctrl+C, job close)',
    { intent: 'none', exit: code(0), turnActive: true },
    unknownExited,
  ],
  [
    'none, code 0, active turn after an error result',
    { intent: 'none', exit: code(0), turnActive: true, lastResultIsError: true },
    unknownExited,
  ],
  [
    'none, code 1 after an error result, active turn',
    { intent: 'none', exit: code(1), turnActive: true, lastResultIsError: true },
    unknownExited,
  ],
  // none | a signal | killed-externally | turn fails | PROCESS_EXITED
  [
    'none, SIGTERM (Windows TerminateProcess), active',
    { intent: 'none', exit: signal('SIGTERM'), turnActive: true },
    { outcome: 'killed-externally', turnSynthesis: 'error', error: 'PROCESS_EXITED' },
  ],
  [
    'none, SIGKILL, idle',
    { intent: 'none', exit: signal('SIGKILL'), turnActive: false },
    { outcome: 'killed-externally', turnSynthesis: 'none', error: 'PROCESS_EXITED' },
  ],
  // none | any other | crashed | turn fails | PROCESS_EXITED
  [
    'none, code 1, last result ok',
    { intent: 'none', exit: code(1), turnActive: false },
    { outcome: 'crashed', turnSynthesis: 'none', error: 'PROCESS_EXITED' },
  ],
  [
    'none, code 1, active, last result ok',
    { intent: 'none', exit: code(1), turnActive: true },
    { outcome: 'crashed', turnSynthesis: 'error', error: 'PROCESS_EXITED' },
  ],
  [
    'none, code 0, idle, last result error',
    { intent: 'none', exit: code(0), turnActive: false, lastResultIsError: true },
    { outcome: 'crashed', turnSynthesis: 'none', error: 'PROCESS_EXITED' },
  ],
  [
    'none, code 2, active',
    { intent: 'none', exit: code(2), turnActive: true },
    { outcome: 'crashed', turnSynthesis: 'error', error: 'PROCESS_EXITED' },
  ],
  [
    'none, no code and no signal',
    { intent: 'none', exit: { code: null, signal: null }, turnActive: false },
    { outcome: 'crashed', turnSynthesis: 'none', error: 'PROCESS_EXITED' },
  ],
];

describe('classifyExit (plan §3.3)', () => {
  for (const platform of PLATFORMS) {
    describe(platform, () => {
      it.each(TABLE)('%s', (_name, input, expected) => {
        expect(classifyExit({ ...input, platform })).toEqual(expected);
      });
    });
  }

  describe('codes 143 and 129 (POSIX signal exits)', () => {
    it.each([143, 129])('code %i is killed-externally on POSIX', (value) => {
      expect(
        classifyExit({ intent: 'none', exit: code(value), turnActive: true, platform: 'posix' }),
      ).toEqual({
        outcome: 'killed-externally',
        turnSynthesis: 'error',
        error: 'PROCESS_EXITED',
      });
    });

    it.each([143, 129])('code %i is an ordinary crash code on Windows', (value) => {
      expect(
        classifyExit({ intent: 'none', exit: code(value), turnActive: false, platform: 'win32' }),
      ).toEqual({
        outcome: 'crashed',
        turnSynthesis: 'none',
        error: 'PROCESS_EXITED',
      });
    });

    it('a close that ends with 143 on POSIX was not graceful', () => {
      expect(
        classifyExit({ intent: 'close', exit: code(143), turnActive: false, platform: 'posix' })
          .outcome,
      ).toBe('killed-externally');
    });
  });

  it('lists every intent once', () => {
    expect(new Set(TERMINATION_INTENTS).size).toBe(9);
    const all: Record<TerminationIntent, true> = {
      none: true,
      close: true,
      'close-timeout': true,
      abort: true,
      dispose: true,
      watchdog: true,
      'auth-fail-fast': true,
      'oversized-frame': true,
      'handshake-failed': true,
    };
    expect([...TERMINATION_INTENTS].sort()).toEqual(Object.keys(all).sort());
  });

  describe('properties over intents x representative exits', () => {
    const exits = fc.oneof(
      fc.constantFrom<ExitObservation>(
        code(0),
        code(1),
        code(2),
        code(129),
        code(143),
        code(255),
        code(UNKNOWN_EXIT_CODE),
        { code: null, signal: null },
        signal('SIGTERM'),
        signal('SIGKILL'),
        signal('SIGINT'),
        signal('SIGHUP'),
      ),
      fc.record({ code: fc.integer({ min: -(2 ** 31), max: 2 ** 32 }), signal: fc.constant(null) }),
      fc.record({ code: fc.constant(null), signal: fc.string() }),
    );
    const inputs = fc.record(
      {
        intent: fc.constantFrom(...TERMINATION_INTENTS),
        exit: exits,
        lastResultIsError: fc.boolean(),
        turnActive: fc.boolean(),
        platform: fc.constantFrom(...PLATFORMS),
      },
      { requiredKeys: ['intent', 'exit', 'turnActive', 'platform'] },
    );

    it('is total and JSON-only', () => {
      fc.assert(
        fc.property(inputs, (input) => {
          const result = classifyExit(input);
          expect(JSON.parse(JSON.stringify(result))).toEqual(result);
        }),
        runs(),
      );
    });

    it('settles an open turn and synthesizes nothing without one', () => {
      fc.assert(
        fc.property(inputs, (input) => {
          const { turnSynthesis } = classifyExit(input);
          if (input.turnActive) expect(turnSynthesis).not.toBe('none');
          else expect(turnSynthesis).toBe('none');
        }),
        runs(),
      );
    });

    it('never calls an exit closed while a turn is open, nor after a foreign signal', () => {
      fc.assert(
        fc.property(inputs, (input) => {
          const { outcome } = classifyExit(input);
          if (input.turnActive || input.exit.signal !== null) expect(outcome).not.toBe('closed');
        }),
        runs(),
      );
    });

    it('never infers success from an exit code without hudhud intent or matching result', () => {
      fc.assert(
        fc.property(inputs, (input) => {
          const { outcome, error } = classifyExit(input);
          if (outcome === 'closed') {
            expect(input.turnActive).toBe(false);
            expect(error).toBe('none');
            expect([0, 1]).toContain(input.exit.code);
          }
          if (outcome === 'aborted')
            expect(['abort', 'dispose', 'close-timeout']).toContain(input.intent);
        }),
        runs(),
      );
    });

    it('classifies the Windows -1 exit as unknown whatever the intent', () => {
      fc.assert(
        fc.property(inputs, (input) => {
          const result = classifyExit({ ...input, exit: code(UNKNOWN_EXIT_CODE) });
          expect(result.outcome).toBe('unknown');
        }),
        runs(),
      );
    });

    it('does not depend on the platform except for codes 143 and 129', () => {
      fc.assert(
        fc.property(inputs, (input) => {
          fc.pre(input.exit.code !== 143 && input.exit.code !== 129);
          expect(classifyExit({ ...input, platform: 'win32' })).toEqual(
            classifyExit({ ...input, platform: 'posix' }),
          );
        }),
        runs(),
      );
    });
  });
});
