// A type guard for the open event union. `HudhudEvent` has an arm for event
// types added in later versions (`type: string`), so `switch (event.type)`
// does not narrow it; this guard does.
// Guide: docs/guide/events.md#reading-events-in-typescript

import type { HudhudEvent } from 'hudhudjs';

/** The event type with the given `type`. */
export type EventOf<T extends string> = Extract<HudhudEvent, { readonly type: T }>;

/** Whether `event` is the event type `type`, narrowing it when it is. */
export function isEvent<T extends string>(event: HudhudEvent, type: T): event is EventOf<T> {
  return event.type === type;
}
