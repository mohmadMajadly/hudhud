// The outcome summary of a replay: what a reviewer checks a suite against
// (`declarations.ts` declares one per case). Derived from the effects only,
// so it holds for any driver of the same machine (the loopback replay too).

import type { JsonValue, MachineEffect } from '@hudhud/core/protocol';

const PLACEHOLDER_UUID = /^00000000-0000-4000-8000-(\d{12})$/u;
const SEND_UUID = /^00000000-0000-4000-9000-(\d{12})$/u;

/** What a replay shows, as short readable strings. */
export interface ReplaySummary {
  /** `ok`, or the error code of `handshake.fail`; `none` when neither happened. */
  readonly handshake: string;
  /**
   * Each turn in the order it ended: `<turn> <outcome>[ synthesized]` for a
   * settle, `<turn> fail <CODE>` for a failure, `<turn> rejected <CODE>` for
   * a refused send.
   */
  readonly turns: readonly string[];
  /** Each `permission.resolved` event: `<behavior> by <by>`. */
  readonly permissions: readonly string[];
  /** Each `control.settle` effect: `<correlation> ok` or `<correlation> fail <CODE>`. */
  readonly controls: readonly string[];
  /** Each `ladder.start` intent. */
  readonly ladder: readonly string[];
  /** The codes of every `diagnostic` event, in order. */
  readonly diagnostics: readonly string[];
  /** `session.end`: `<outcome>` or `<outcome> <CODE>`; `none` when the session did not end. */
  readonly session: string;
}

/**
 * A readable name of a turn id: `<uuid-N>` for a recorded uuid, `send-N` for
 * a send whose recording had none, as is otherwise (`bg-<n>`).
 */
export function turnName(turnId: string): string {
  const recorded = PLACEHOLDER_UUID.exec(turnId);
  if (recorded !== null) return `<uuid-${String(Number(recorded[1]))}>`;
  const sent = SEND_UUID.exec(turnId);
  return sent === null ? turnId : `send-${String(Number(sent[1]))}`;
}

/** An event field as text (a string as is, anything else as JSON). */
function fieldText(event: object, key: string): string {
  const value = Object.hasOwn(event, key) ? (Reflect.get(event, key) as JsonValue) : undefined;
  if (value === undefined) return 'undefined';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Summarizes the effects of a replay, in order. */
export function summarize(effects: readonly MachineEffect[]): ReplaySummary {
  let handshake = 'none';
  let session = 'none';
  const turns: string[] = [];
  const permissions: string[] = [];
  const controls: string[] = [];
  const ladder: string[] = [];
  const diagnostics: string[] = [];
  for (const effect of effects) {
    if (effect.type === 'handshake.ok') {
      handshake = 'ok';
    } else if (effect.type === 'handshake.fail') {
      handshake = effect.error.code;
    } else if (effect.type === 'turn.settle') {
      const { outcome, synthesized } = effect.result;
      turns.push(`${turnName(effect.turnId)} ${outcome}${synthesized ? ' synthesized' : ''}`);
    } else if (effect.type === 'turn.fail') {
      turns.push(`${turnName(effect.turnId)} fail ${effect.error.code}`);
    } else if (effect.type === 'send.rejected') {
      turns.push(`${turnName(effect.turnId)} rejected ${effect.error.code}`);
    } else if (effect.type === 'control.settle') {
      controls.push(
        effect.ok ? `${effect.correlation} ok` : `${effect.correlation} fail ${effect.error.code}`,
      );
    } else if (effect.type === 'ladder.start') {
      ladder.push(effect.intent);
    } else if (effect.type === 'session.end') {
      session =
        effect.error === undefined ? effect.outcome : `${effect.outcome} ${effect.error.code}`;
    } else if (effect.type === 'event' && effect.event.type === 'permission.resolved') {
      permissions.push(
        `${fieldText(effect.event, 'behavior')} by ${fieldText(effect.event, 'by')}`,
      );
    } else if (effect.type === 'event' && effect.event.type === 'diagnostic') {
      diagnostics.push(fieldText(effect.event, 'code'));
    }
  }
  return { handshake, turns, permissions, controls, ladder, diagnostics, session };
}
