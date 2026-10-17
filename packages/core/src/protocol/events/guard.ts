// Narrowing the open event union by `type` (W7-Z). `HudhudEvent` ends in an
// open arm (`type: string & {}`) so that event types added later reach old
// code with their `type` and `raw` (ADR-0003). TypeScript therefore does not
// narrow `event` in `switch (event.type)` or after `event.type === 'x'`: the
// open arm also admits every known literal. The guard below narrows with
// `Extract`, which keeps exactly the arms whose `type` is the given one.

import type { JsonValue } from '../json.js';
import type { EventBase, HudhudEvent } from './types.js';

/**
 * The event with `type` T: the matching arm of {@link HudhudEvent} for a
 * known type, or the open arm with that `type` for any other string (an
 * event type of a later version). A union of types gives the union of their
 * events.
 *
 * @example
 * ```ts
 * function onToolCall(event: HudhudEventOf<'tool.call'>): void {
 *   console.log(event.toolName, event.kind);
 * }
 * ```
 *
 * @public
 */
export type HudhudEventOf<T extends string> = T extends unknown
  ? [Extract<HudhudEvent, { readonly type: T }>] extends [never]
    ? EventBase & { readonly type: T; readonly raw?: JsonValue }
    : Extract<HudhudEvent, { readonly type: T }>
  : never;

/**
 * Whether `event` has the event type `type`, narrowing it to
 * {@link HudhudEventOf} when it has. Compares `type` only; it does not
 * validate the event.
 *
 * @example
 * ```ts
 * for await (const event of turn) {
 *   if (isEventType(event, 'message.delta') && event.deltaType === 'text') {
 *     process.stdout.write(event.text ?? '');
 *   }
 * }
 * ```
 *
 * @public
 */
export function isEventType<T extends HudhudEvent['type']>(
  event: HudhudEvent,
  type: T,
): event is HudhudEventOf<T> {
  return event.type === type;
}
