// Shared helpers of the session machine tests: a config factory, a runner
// that folds clock-stamped inputs through `stepSession`, and frame builders
// shaped like the frames quoted in research 05 / 07 (provenance in each
// builder's comment). Nothing here comes from the proprietary TypeScript SDK
// (ADR-0015).

import { Buffer } from 'node:buffer';

import type {
  CommandInput,
  JsonObject,
  JsonValue,
  MachineEffect,
  TransportInput,
} from '@hudhud/core/protocol';

import {
  claudeSessionMachine,
  type ClaudeSessionConfig,
  type ClaudeSessionState,
} from '../../../src/protocol/machine/index.js';

export const SESSION_ID = 'd6e7fffb-0000-4000-8000-000000000000';
export const SPAWNED_PID = 4242;
export const CLI_PID = 37148;

/** The n-th deterministic user message uuid (the shape 05 §7 uses). */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** The plan §1.5 defaults; tests override what they exercise. */
export function makeConfig(overrides: Partial<ClaudeSessionConfig> = {}): ClaudeSessionConfig {
  return {
    mode: 'create',
    sessionId: SESSION_ID,
    firstFrameTimeoutMs: 60_000,
    idleStallMs: 300_000,
    closeTimeoutMs: 30_000,
    interruptWaitMs: 1000,
    maxOutboundBytes: 33_554_432,
    onOversizedFrame: 'fail',
    onAuthFailure: 'fail-fast',
    authFailFastSources: ['ANTHROPIC_API_KEY'],
    permissionHandler: true,
    allowConfigWrites: false,
    allowBypassPermissions: false,
    platform: 'posix',
    initialize: {},
    ...overrides,
  };
}

export type Body = TransportInput | CommandInput;

const START_MS = Date.UTC(2026, 9, 13);

/** Folds inputs through the machine with a fake clock and records every step. */
export class SessionRun {
  state: ClaudeSessionState;
  now = START_MS;
  readonly steps: (readonly MachineEffect[])[] = [];

  constructor(config: ClaudeSessionConfig = makeConfig()) {
    this.state = claudeSessionMachine.initialState(config);
  }

  feed(...bodies: Body[]): MachineEffect[] {
    const all: MachineEffect[] = [];
    for (const body of bodies) {
      const out = claudeSessionMachine.step(this.state, {
        ...body,
        atMs: this.now,
        at: new Date(this.now).toISOString(),
      });
      this.state = out.state;
      this.steps.push(out.effects);
      all.push(...out.effects);
    }
    return all;
  }

  /** Feeds frames as stdout lines. */
  line(...frames: JsonObject[]): MachineEffect[] {
    return this.feed(...frames.map(lineOf));
  }

  advance(ms: number): this {
    this.now += ms;
    return this;
  }

  fire(name: string): MachineEffect[] {
    return this.feed({ type: 'timer', name });
  }

  /** process.started plus the initialize response: a ready session. */
  start(response: JsonObject = initResponse()): MachineEffect[] {
    return [...this.feed({ type: 'process.started', pid: SPAWNED_PID }), ...this.line(response)];
  }

  get effects(): MachineEffect[] {
    return this.steps.flat();
  }
}

export function lineOf(frame: JsonObject): Body {
  const text = JSON.stringify(frame);
  return { type: 'line', text, bytes: Buffer.byteLength(text) };
}

// ---- effect helpers --------------------------------------------------------------

export function ofType<T extends MachineEffect['type']>(
  effects: readonly MachineEffect[],
  type: T,
): Extract<MachineEffect, { type: T }>[] {
  return effects.filter(
    (effect): effect is Extract<MachineEffect, { type: T }> => effect.type === type,
  );
}

/** Events of the effects, optionally of one type, as plain records. */
export function events(
  effects: readonly MachineEffect[],
  type?: string,
): Readonly<Record<string, JsonValue>>[] {
  return ofType(effects, 'event')
    .map((effect) => effect.event as unknown as Readonly<Record<string, JsonValue>>)
    .filter((event) => type === undefined || event['type'] === type);
}

/** The written frames, parsed. */
export function writes(effects: readonly MachineEffect[]): JsonObject[] {
  return ofType(effects, 'write').map((effect) => JSON.parse(effect.line) as JsonObject);
}

/** The effect types in order, events as `event:<type>`. */
export function shape(effects: readonly MachineEffect[]): string[] {
  return effects.map((effect) =>
    effect.type === 'event' ? `event:${String(effect.event.type)}` : effect.type,
  );
}

// ---- frames ------------------------------------------------------------------------

/** The `initialize` response of 05 §5 (observed; trimmed as the report trims it). */
export function initResponse(body: JsonObject = {}, requestId = 'hudhud_1'): JsonObject {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      pending_permission_requests: [],
      pending_user_dialog_requests: [],
      response: {
        models: [{ value: 'default', resolvedModel: 'claude-opus-5-5' }],
        account: {
          tokenSource: 'none',
          apiKeySource: 'ANTHROPIC_API_KEY',
          apiProvider: 'firstParty',
        },
        pid: CLI_PID,
        claude_code_version: '2.1.296',
        current_permission_mode: 'default',
        session_state: 'idle',
        capabilities: ['ui_surface_v1'],
        ...body,
      },
    },
  };
}

/** `system/init` of 05 §5 (observed; trimmed). */
export function systemInit(extra: JsonObject = {}): JsonObject {
  return {
    type: 'system',
    subtype: 'init',
    session_id: SESSION_ID,
    model: 'claude-opus-5-5',
    permissionMode: 'default',
    apiKeySource: 'ANTHROPIC_API_KEY',
    claude_code_version: '2.1.296',
    capabilities: [
      'interrupt_receipt_v1',
      'interrupt_cancel_queued_v1',
      'interrupt_send_now_v1',
      'msg_lifecycle_v1',
      'ui_surface_v1',
    ],
    uuid: 'u-init',
    ...extra,
  };
}

/** `result/success` (05 §4, reconstructed). */
export function result(extra: JsonObject = {}): JsonObject {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    terminal_reason: 'completed',
    result: 'Hello from mock.',
    session_id: SESSION_ID,
    ...extra,
  };
}

/** `system/session_state_changed` (05 §12, observed). */
export function sessionState(state: string): JsonObject {
  return { type: 'system', subtype: 'session_state_changed', state, session_id: SESSION_ID };
}

/** `command_lifecycle` (05 §5, observed). */
export function lifecycle(commandUuid: string, state: string): JsonObject {
  return { type: 'command_lifecycle', command_uuid: commandUuid, state };
}

/** `assistant` text (05 §4, reconstructed). */
export function assistant(text: string, extra: JsonObject = {}): JsonObject {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    ...extra,
  };
}

/** `can_use_tool` of 05 §6 (observed, Windows). */
export function canUseTool(requestId: string, extra: JsonObject = {}): JsonObject {
  return {
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      display_name: 'Bash',
      input: { command: 'echo hi && touch marker.txt', description: 'mock command' },
      description: 'mock command',
      permission_suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'echo hi *' }],
          behavior: 'allow',
          destination: 'localSettings',
        },
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      ],
      blocked_path: '<run>\\work\\marker.txt',
      tool_use_id: 'toolu_mock_0002',
      ...extra,
    },
  };
}

/** `control_cancel_request` (05 §6, observed). */
export function cancelRequest(requestId: string): JsonObject {
  return { type: 'control_cancel_request', request_id: requestId };
}

/** A success `control_response` (05 §7 interrupt answers, observed). */
export function controlOk(requestId: string, body?: JsonObject): JsonObject {
  return {
    type: 'control_response',
    response:
      body === undefined
        ? { subtype: 'success', request_id: requestId }
        : { subtype: 'success', request_id: requestId, response: body },
  };
}

/** An error `control_response` (02 §4.1 envelope). */
export function controlError(requestId: string, error: string): JsonObject {
  return { type: 'control_response', response: { subtype: 'error', request_id: requestId, error } };
}
