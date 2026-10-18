// The handwritten neutral types and their TypeBox schema sources accept the
// same values (type level), and the generated validators enforce the
// committed schemas (run time).

import type { Static } from 'typebox';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type * as capabilitySchemas from '../../schema-src/capabilities.js';
import * as errorSchemas from '../../schema-src/errors.js';
import * as eventSchemas from '../../schema-src/events.js';
import type * as postureSchemas from '../../schema-src/posture.js';
import type {
  Capability,
  HarnessCapabilities,
  ProcessContainment,
  SecurityPosture,
  SecurityPostureEntry,
} from '../../src/protocol/capabilities.js';
import {
  type ErrorData,
  HUDHUD_ERROR_CODES,
  type HudhudErrorCode,
} from '../../src/protocol/errors.js';
import type {
  CompatInfo,
  DiagnosticCode,
  EventBase,
  HudhudEvent,
  StopReason,
  ToolKind,
  TurnOutcome,
  TurnResult,
  UsageTotals,
} from '../../src/protocol/events/types.js';
import {
  type SchemaCheck,
  validateConformanceLine,
  validateErrorData,
  validateHarnessCapabilities,
  validateHudhudEvent,
  validateKnownHudhudEvent,
  validateSecurityPosture,
} from '../../src/protocol/generated/validators.gen.js';
import type { JsonObject, JsonValue } from '../../src/protocol/json.js';
import type { TypesEqual } from './type-equality.js';

type Event<T extends HudhudEvent['type']> = Extract<HudhudEvent, { readonly type: T }>;

describe('neutral types equal their schema sources', () => {
  it('events', () => {
    expectTypeOf<
      TypesEqual<ToolKind, Static<typeof eventSchemas.ToolKind>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<StopReason, Static<typeof eventSchemas.StopReason>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<TurnOutcome, Static<typeof eventSchemas.TurnOutcome>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<DiagnosticCode, Static<typeof eventSchemas.DiagnosticCode>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<UsageTotals, Static<typeof eventSchemas.UsageTotals>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<TurnResult, Static<typeof eventSchemas.TurnResult>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<CompatInfo, Static<typeof eventSchemas.CompatInfo>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<Event<'compat'>, Static<typeof eventSchemas.CompatEvent>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<Event<'session.started'>, Static<typeof eventSchemas.SessionStartedEvent>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<Event<'turn.queued'>, Static<typeof eventSchemas.TurnQueuedEvent>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<Event<'turn.started'>, Static<typeof eventSchemas.TurnStartedEvent>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<Event<'message.assistant'>, Static<typeof eventSchemas.MessageAssistantEvent>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<Event<'message.delta'>, Static<typeof eventSchemas.MessageDeltaEvent>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<Event<'tool.call'>, Static<typeof eventSchemas.ToolCallEvent>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<Event<'tool.result'>, Static<typeof eventSchemas.ToolResultEvent>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<
        Event<'permission.requested'>,
        Static<typeof eventSchemas.PermissionRequestedEvent>
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<Event<'permission.resolved'>, Static<typeof eventSchemas.PermissionResolvedEvent>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<Event<'permission.denied'>, Static<typeof eventSchemas.PermissionDeniedEvent>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<Event<'api.retry'>, Static<typeof eventSchemas.ApiRetryEvent>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<Event<'usage.update'>, Static<typeof eventSchemas.UsageUpdateEvent>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<Event<'turn.completed'>, Static<typeof eventSchemas.TurnCompletedEvent>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<Event<'session.state'>, Static<typeof eventSchemas.SessionStateEvent>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<Event<'background.tasks'>, Static<typeof eventSchemas.BackgroundTasksEvent>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<Event<'stalled'>, Static<typeof eventSchemas.StalledEvent>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<Event<'diagnostic'>, Static<typeof eventSchemas.DiagnosticEvent>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<Event<'gap'>, Static<typeof eventSchemas.GapEvent>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<Event<'session.terminated'>, Static<typeof eventSchemas.SessionTerminatedEvent>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<Event<'harness.frame'>, Static<typeof eventSchemas.HarnessFrameEvent>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<
        EventBase & { readonly type: string & {}; readonly raw?: JsonValue },
        Static<typeof eventSchemas.OpenHudhudEvent>
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<HudhudEvent, Static<typeof eventSchemas.HudhudEvent>>
    >().toEqualTypeOf<true>();
  });

  it('capabilities and posture', () => {
    expectTypeOf<
      TypesEqual<Capability, Static<typeof capabilitySchemas.Capability>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<ProcessContainment, Static<typeof capabilitySchemas.ProcessContainment>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<HarnessCapabilities, Static<typeof capabilitySchemas.HarnessCapabilities>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<SecurityPostureEntry, Static<typeof postureSchemas.SecurityPostureEntry>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<SecurityPosture, Static<typeof postureSchemas.SecurityPosture>>
    >().toEqualTypeOf<true>();
  });

  it('error data has an open code and JSON details', () => {
    expectTypeOf<
      TypesEqual<ErrorData, Static<typeof errorSchemas.ErrorData>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<HudhudErrorCode | (string & {}), Static<typeof errorSchemas.HudhudErrorCode>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<
        ErrorData,
        { code: string; message: string; retryable: boolean; details?: JsonObject }
      >
    >().toEqualTypeOf<true>();
    // The closed codes of the type and the known codes of the schema agree.
    expect(errorSchemas.KNOWN_ERROR_CODES).toEqual(HUDHUD_ERROR_CODES);
    expectTypeOf<
      (typeof errorSchemas.KNOWN_ERROR_CODES)[number]
    >().toEqualTypeOf<HudhudErrorCode>();
  });
});

const base = { seq: 0, ts: '2026-10-12T00:00:00.000Z', sessionId: 's-1' };

/** One valid sample of every known event arm. */
const SAMPLES: readonly HudhudEvent[] = [
  {
    ...base,
    type: 'compat',
    compat: {
      harness: 'claude-code',
      version: '2.1.296',
      minTested: '2.1.296',
      maxTested: '2.1.296',
      knownBroken: [],
      status: 'tested',
    },
  },
  { ...base, type: 'session.started', mode: 'create', pid: 10, version: '2.1.296', raw: {} },
  { ...base, type: 'turn.queued', turnId: 't' },
  {
    ...base,
    type: 'turn.started',
    turnId: 't',
    origin: 'harness',
    features: ['msg_lifecycle_v1'],
    raw: {},
  },
  { ...base, type: 'message.assistant', text: 'hi', aborted: true, raw: {} },
  { ...base, type: 'message.delta', index: 0, deltaType: 'future_delta', raw: null },
  {
    ...base,
    type: 'tool.call',
    toolUseId: 'u',
    toolName: 'Bash',
    kind: 'execute',
    status: 'pending',
    input: { command: 'echo hi' },
    raw: {},
  },
  { ...base, type: 'tool.result', toolUseId: 'u', status: 'failed', raw: {} },
  {
    ...base,
    type: 'permission.requested',
    requestId: 'r',
    toolName: 'Bash',
    toolUseId: 'u',
    raw: {},
  },
  { ...base, type: 'permission.resolved', requestId: 'r', behavior: 'cancelled', by: 'close' },
  { ...base, type: 'permission.denied', toolName: 'Bash', toolUseId: 'u', raw: {} },
  { ...base, type: 'api.retry', attempt: 1, errorStatus: 401, error: 'x', raw: {} },
  {
    ...base,
    type: 'usage.update',
    reported: { inputTokens: 1, costUsd: 0.5 },
    estimatedDelta: { outputTokens: 2, estimate: true },
  },
  {
    ...base,
    type: 'turn.completed',
    turnId: 't',
    result: {
      turnId: 't',
      sessionId: 's-1',
      outcome: 'cancelled',
      isError: true,
      stopReason: 'cancelled',
      usage: {},
      permissionDenials: [{ toolName: 'Bash', toolUseId: 'u' }],
      synthesized: false,
    },
  },
  { ...base, type: 'session.state', state: 'idle', raw: {} },
  { ...base, type: 'background.tasks', raw: [] },
  { ...base, type: 'stalled', silentForMs: 300000, pendingPermissions: 0 },
  { ...base, type: 'diagnostic', code: 'some.future-code', message: 'm', data: { k: 1 } },
  { ...base, type: 'gap', dropped: 3 },
  { ...base, type: 'session.terminated', intent: 'close', outcome: 'closed', exitCode: 0 },
  { ...base, type: 'harness.frame', frameType: 'rate_limit_event', raw: { type: 'x' } },
];

describe('generated neutral validators', () => {
  it('accept a sample of every known event arm', () => {
    const types = new Set(SAMPLES.map((event) => event.type));
    expect(types.size).toBe(SAMPLES.length);
    expect(Object.keys(eventSchemas).filter((name) => name.endsWith('Event'))).toHaveLength(
      SAMPLES.length + 3,
    );
    for (const event of SAMPLES) {
      expect(validateKnownHudhudEvent(event)).toEqual({ ok: true, value: event });
      expect(validateHudhudEvent(event).ok).toBe(true);
    }
  });

  it('accept an unknown event type only through the open arm', () => {
    const future = { ...base, type: 'future.event', extra: 1 };
    expect(validateHudhudEvent(future).ok).toBe(true);
    expect(validateKnownHudhudEvent(future).ok).toBe(false);
  });

  it('accept unknown fields (additive evolution)', () => {
    expect(validateKnownHudhudEvent({ ...base, type: 'gap', dropped: 1, later: true }).ok).toBe(
      true,
    );
  });

  it('reject a known arm with a wrong field, and report where', () => {
    expect(validateKnownHudhudEvent({ ...base, type: 'gap', dropped: -1 }).ok).toBe(false);
    expect(validateHudhudEvent({ ...base, seq: 1.5, type: 'gap', dropped: 1 })).toMatchObject({
      ok: false,
    });
    expect(validateHudhudEvent({ seq: 0, type: 'x' })).toEqual({
      ok: false,
      issue: expect.objectContaining({ keyword: 'required' }) as unknown,
    });
  });

  it('check error data with open codes', () => {
    const known: ErrorData = { code: 'SESSION_CLOSED', message: 'm', retryable: false };
    const checked = validateErrorData(known);
    expect(checked).toEqual({ ok: true, value: known });
    expectTypeOf(validateErrorData).returns.toEqualTypeOf<SchemaCheck<ErrorData>>();
    expect(
      validateErrorData({ code: 'LATER_CODE', message: 'm', retryable: true, details: {} }).ok,
    ).toBe(true);
    expect(validateErrorData({ code: 1, message: 'm', retryable: true }).ok).toBe(false);
    expect(validateErrorData({ code: 'X', message: 'm', retryable: true, details: [] }).ok).toBe(
      false,
    );
  });

  it('check capabilities and posture', () => {
    const capabilities: HarnessCapabilities = {
      multiTurn: 'supported',
      resume: 'supported',
      fork: 'supported',
      interrupt: 'supported',
      permissionsInBand: 'supported',
      workspaceTrust: { none: 'supported', context: 'unsupported', full: 'supported' },
      processContainment: 'job',
      reasons: { 'workspaceTrust.context': 'no harness support' },
    };
    expect(validateHarnessCapabilities(capabilities).ok).toBe(true);
    expect(validateHarnessCapabilities({ ...capabilities, reasons: { a: 1 } }).ok).toBe(false);
    // Open enums (ADR-0005 §6): a value a later version adds is accepted on read.
    expect(validateHarnessCapabilities({ ...capabilities, fork: 'maybe' }).ok).toBe(true);
    expect(validateHarnessCapabilities({ ...capabilities, processContainment: 'sandbox' }).ok).toBe(
      true,
    );
    expect(validateHarnessCapabilities({ ...capabilities, fork: 1 }).ok).toBe(false);
    const posture: SecurityPosture = {
      entries: [{ setting: 'env', value: 'harness', defaultValue: 'harness', deviates: false }],
    };
    expect(validateSecurityPosture(posture).ok).toBe(true);
    expect(validateSecurityPosture({ entries: [{ setting: 'env' }] }).ok).toBe(false);
  });

  it('check conformance fixture lines strictly', () => {
    expect(validateConformanceLine({ t: 0, dir: 'in', v: { type: 'x' } }).ok).toBe(true);
    expect(validateConformanceLine({ dir: 'expect', effects: [], events: [] }).ok).toBe(true);
    expect(validateConformanceLine({ t: 0, dir: 'sideways', v: 1 }).ok).toBe(false);
    expect(validateConformanceLine({ t: 0, dir: 'in', v: 1, typo: 1 }).ok).toBe(false);
    expect(validateConformanceLine({ dir: 'expect', effects: [] }).ok).toBe(false);
  });
});
