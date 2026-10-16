// The neutral contract invariants of plan §1.4 checked against the Claude
// session machine with the machine kit of @hudhudjs/test-support (plan §4.2,
// W3-T1 acceptance): every turn settles exactly once, each permission ask
// ends exactly once, no write after stdin.end, seq strictly +1 from 1,
// timers cleared before session.end, nothing after session.end, a control
// correlation settles at most once, JSON round trip, determinism, no
// mutation. Runs: 2000 when CI=true, the kit default (200) locally; the seed
// is logged (`FC_SEED` reproduces).
//
// The harness lines are built from frames quoted in research 05 / 07 (see
// session-support.ts for the provenance of each builder).
//
// Needs `@hudhudjs/test-support` among the devDependencies of this package
// (workspace-deps-declared); the kit is reached by relative path until the
// test-support barrel exports it.

import process from 'node:process';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type {
  JsonObject,
  JsonValue,
  MachineEffect,
  MachineInput,
  MachineStep,
} from '@hudhudjs/core/protocol';

import {
  assertMachineContract,
  type KitInputBody,
  type KitMachine,
} from '../../../../../tooling/test-support/src/machine-kit.js';
import {
  claudeSessionMachine,
  type ClaudeSessionConfig,
  type ClaudeSessionState,
} from '../../../src/protocol/machine/index.js';
import {
  assistant,
  canUseTool,
  cancelRequest,
  controlError,
  controlOk,
  initResponse,
  lifecycle,
  makeConfig,
  result,
  sessionState,
  systemInit,
  uuid,
} from './session-support.js';

/** Kit default runs (200) locally; plan §4.2 asks 2000 or more on CI. */
const NUM_RUNS = process.env['CI'] === 'true' ? 2000 : 200;
const TIMEOUT_MS = 600_000;

/**
 * The kit names turns `turn-<n>`; the machine takes UUIDs (the user message
 * `uuid`). This adapter renames `turn-<n>` to `uuid(n)` on the way in and
 * back on the way out, so the kit's turn bookkeeping sees its own ids. It is
 * a pure renaming: determinism, JSON stability and every invariant carry
 * over.
 */
const KIT_TURN = /^turn-(\d+)$/u;
const UUID_TURN = /^00000000-0000-4000-8000-(\d{12})$/u;

function toUuid(id: string): string {
  const match = KIT_TURN.exec(id);
  return match === null ? id : uuid(Number(match[1]));
}

function fromUuid(value: JsonValue): JsonValue {
  if (typeof value === 'string') {
    const match = UUID_TURN.exec(value);
    return match === null ? value : `turn-${String(Number(match[1]))}`;
  }
  if (Array.isArray(value)) return (value as readonly JsonValue[]).map(fromUuid);
  if (typeof value === 'object' && value !== null) {
    const renamedObject: JsonObject = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fromUuid(item)]),
    );
    return renamedObject;
  }
  return value;
}

function renameIn(input: MachineInput): MachineInput {
  if (input.type === 'cmd.send') return { ...input, turnId: toUuid(input.turnId) };
  if (input.type === 'cmd.interrupt' && input.turnId !== undefined) {
    return { ...input, turnId: toUuid(input.turnId) };
  }
  return input;
}

const renamed: KitMachine<ClaudeSessionState, ClaudeSessionConfig> = {
  initialState: (config) => claudeSessionMachine.initialState(config),
  step: (state, input): MachineStep<ClaudeSessionState> => {
    const out = claudeSessionMachine.step(state, renameIn(input));
    return {
      state: out.state,
      effects: out.effects.map(
        (effect) => fromUuid(effect as unknown as JsonValue) as unknown as MachineEffect,
      ),
    };
  },
};

// ---- harness lines ----------------------------------------------------------------

const turnUuid = fc.integer({ min: 1, max: 4 }).map(uuid);
const requestId = fc.integer({ min: 1, max: 8 }).map((n) => `hudhud_${String(n)}`);
// CLI request ids are UUIDs (05 §6) and never reused within a session; the kit
// identifies asks by id, so every generated request gets a fresh one. CLI
// cancels of a pending request are covered by the unit and sequence tests.
const permissionId = fc.uuid();

const frames: fc.Arbitrary<JsonObject> = fc.oneof(
  fc.constant(initResponse()),
  fc.constant(initResponse({ account: { apiKeySource: 'none' } })),
  // Version drift (W5 ruling 1): an untested and a listed known-broken version.
  fc.constant(initResponse({ claude_code_version: '2.1.400' })),
  fc.constant(initResponse({ claude_code_version: '2.1.297' })),
  fc.constant(controlError('hudhud_1', 'boom')),
  fc.constant(systemInit()),
  fc.constant(systemInit({ session_id: 'another-id' })),
  fc.constant(systemInit({ capabilities: ['ui_surface_v1'] })),
  turnUuid.map((id) => lifecycle(id, 'started')),
  // Research 10 §3: `completed` without `started` is a dropped message
  // (TURN_DROPPED); `queued` and `cancelled` are recorded only.
  fc
    .record({ id: turnUuid, state: fc.constantFrom('queued', 'completed', 'cancelled') })
    .map(({ id, state }) => lifecycle(id, state)),
  turnUuid.map((id) => result({ user_message_uuid: id })),
  fc.constant(result()),
  fc.constant(
    result({
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'aborted_streaming',
    }),
  ),
  fc.constant(result({ subtype: 'error_during_execution', is_error: true, num_turns: 0 })),
  fc.constant(result({ is_error: true, api_error_status: 401, terminal_reason: 'api_error' })),
  fc.constant(assistant('Failed to authenticate.', { error: 'authentication_failed' })),
  fc.constant(assistant('hello')),
  fc.constant({
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    error_status: 401,
    error: 'authentication_failed',
  }),
  fc.constant(sessionState('running')),
  fc.constant(sessionState('idle')),
  permissionId.map((id) => canUseTool(id)),
  permissionId.map(cancelRequest),
  fc
    .record({ id: requestId, uuids: fc.array(turnUuid, { maxLength: 2 }) })
    .map(({ id, uuids }) => controlOk(id, { still_queued: uuids })),
  fc
    .record({ id: requestId, uuids: fc.array(turnUuid, { maxLength: 2 }) })
    .map(({ id, uuids }) => controlOk(id, { still_queued: [], cancelled: uuids })),
  requestId.map((id) => controlOk(id)),
  requestId.map((id) => controlError(id, 'refused')),
  fc.constant({
    type: 'control_request',
    request_id: 'hook-1',
    request: { subtype: 'hook_callback' },
  }),
  fc.constant({
    type: 'control_request',
    request_id: 'dialog-1',
    request: { subtype: 'request_user_dialog' },
  }),
  fc.constant(cancelRequest('dialog-1')),
  fc.constant({ type: 'keep_alive' }),
  fc.constant({ type: 'control_request', request_id: 7 }),
  fc.constant({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }),
);

const lines: fc.Arbitrary<string> = fc.oneof(
  { weight: 12, arbitrary: frames.map((frame) => JSON.stringify(frame)) },
  { weight: 1, arbitrary: fc.constantFrom('not json', '[1]', '{"type":') },
);

const extraInputs: fc.Arbitrary<KitInputBody> = fc.oneof(
  fc.constantFrom<KitInputBody>(
    { type: 'process.started', pid: 7 },
    { type: 'process.spawn-error', code: 'ENOENT' },
  ),
  // Correlations are unique per pending request (binding contract): a UUID each.
  fc
    .record({ mode: fc.constantFrom('bypassPermissions', 'manual', 'acceptEdits'), id: fc.uuid() })
    .map(({ mode, id }): KitInputBody => ({
      type: 'cmd.set-permission-mode',
      mode,
      correlation: `m-${id}`,
    })),
);

const content: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.constant([{ type: 'text', text: 'hi' }]),
  fc.constant([{ type: 'unknown' }]),
);

const configs: fc.Arbitrary<ClaudeSessionConfig> = fc
  .record({
    mode: fc.constantFrom<ClaudeSessionConfig['mode']>('create', 'resume', 'fork'),
    onOversizedFrame: fc.constantFrom<ClaudeSessionConfig['onOversizedFrame']>('fail', 'skip'),
    onAuthFailure: fc.constantFrom<ClaudeSessionConfig['onAuthFailure']>(
      'fail-fast',
      'harness-retry',
    ),
    permissionHandler: fc.boolean(),
    allowBypassPermissions: fc.boolean(),
    platform: fc.constantFrom<ClaudeSessionConfig['platform']>('win32', 'posix'),
    probedVersion: fc.constantFrom<string | undefined>(undefined, '2.1.296'),
    allowKnownBrokenVersion: fc.boolean(),
  })
  .map(({ probedVersion, ...overrides }) =>
    makeConfig({
      ...overrides,
      ...(probedVersion === undefined
        ? {}
        : { probedVersion, knownBroken: [{ version: '2.1.297', reason: 'test listing' }] }),
    }),
  );

const finales: readonly (readonly KitInputBody[])[] = [
  [
    { type: 'cmd.abort', intent: 'abort' },
    { type: 'stdout.end' },
    { type: 'process.exit', code: null, signal: 'SIGKILL' },
    { type: 'ladder.done' },
  ],
  [{ type: 'cmd.close' }, { type: 'stdout.end' }, { type: 'process.exit', code: 0, signal: null }],
  [{ type: 'process.exit', code: 1, signal: null }],
];

describe('claude session machine through the machine kit', () => {
  for (const [index, finale] of finales.entries()) {
    it(
      `satisfies the contract invariants (finale ${String(index + 1)})`,
      () => {
        const logs: string[] = [];
        assertMachineContract(renamed, {
          config: configs,
          lines,
          inputs: extraInputs,
          content,
          finale,
          firstSeq: 1,
          numRuns: NUM_RUNS,
          maxActions: 60,
          log: (message) => {
            logs.push(message);
            // The seed must reach the CI log (plan §4.1).
            process.stdout.write(`${message}\n`);
          },
        });
        expect(logs).toHaveLength(1);
      },
      TIMEOUT_MS,
    );
  }

  it(
    'satisfies the invariants with the kit turn ids unchanged (sends refused)',
    () => {
      assertMachineContract(claudeSessionMachine, {
        config: makeConfig(),
        lines,
        firstSeq: 1,
        numRuns: NUM_RUNS,
        log: (message) => process.stdout.write(`${message}\n`),
      });
    },
    TIMEOUT_MS,
  );
});
