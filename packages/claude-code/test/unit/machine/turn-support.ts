// Shared helpers of the turn machine tests: deterministic ids, frame
// builders shaped like the frames observed with the pinned CLI (research 05),
// and a runner that folds inputs through `turnStep`.

import process from 'node:process';

import type { JsonObject } from '@hudhud/core/protocol';

import {
  initialTurnState,
  turnStep,
  type TurnEffect,
  type TurnInput,
  type TurnMachineState,
} from '../../../src/protocol/machine/turn.js';

export const SESSION_ID = 'd6e7fffb-0000-4000-8000-000000000000';

/** The n-th deterministic user message uuid (05 §7 uses the same shape). */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export const CAPS_WITH_LIFECYCLE = [
  'interrupt_receipt_v1',
  'interrupt_cancel_queued_v1',
  'msg_lifecycle_v1',
];

export function init(extra: JsonObject = {}): TurnInput {
  return {
    type: 'frame',
    frame: { type: 'system', subtype: 'init', session_id: SESSION_ID, ...extra },
  };
}

export function lifecycle(commandUuid: string, state = 'started'): TurnInput {
  return { type: 'frame', frame: { type: 'command_lifecycle', command_uuid: commandUuid, state } };
}

export function result(extra: JsonObject = {}): TurnInput {
  return {
    type: 'frame',
    frame: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: SESSION_ID,
      ...extra,
    },
  };
}

export function sessionState(state: string): TurnInput {
  return {
    type: 'frame',
    frame: { type: 'system', subtype: 'session_state_changed', state, session_id: SESSION_ID },
  };
}

export function send(turnId: string): TurnInput {
  return { type: 'send', turnId, content: `prompt ${turnId}` };
}

export function interrupt(correlation: string, turnId?: string, cancelQueued = false): TurnInput {
  return turnId === undefined
    ? { type: 'interrupt', cancelQueued, correlation }
    : { type: 'interrupt', turnId, cancelQueued, correlation };
}

export function ack(interruptId: string, response: JsonObject = { still_queued: [] }): TurnInput {
  return { type: 'interrupt.response', interruptId, ok: true, response };
}

/** Folds inputs through the machine and records the effects of each step. */
export class Runner {
  state: TurnMachineState = initialTurnState({ sessionId: SESSION_ID });
  readonly steps: (readonly TurnEffect[])[] = [];

  step(...inputs: TurnInput[]): TurnEffect[] {
    const all: TurnEffect[] = [];
    for (const input of inputs) {
      const out = turnStep(this.state, input);
      this.state = out.state;
      this.steps.push(out.effects);
      all.push(...out.effects);
    }
    return all;
  }

  get effects(): TurnEffect[] {
    return this.steps.flat();
  }
}

export function ofType<T extends TurnEffect['type']>(
  effects: readonly TurnEffect[],
  type: T,
): Extract<TurnEffect, { type: T }>[] {
  return effects.filter(
    (effect): effect is Extract<TurnEffect, { type: T }> => effect.type === type,
  );
}

const seedEnv = process.env['FC_SEED'];

/** fast-check parameters; `FC_SEED` reproduces a reported run (plan §4.1). */
export function fcParams(numRuns: number): { numRuns: number; seed?: number } {
  return seedEnv === undefined ? { numRuns } : { numRuns, seed: Number(seedEnv) };
}
