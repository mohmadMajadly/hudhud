// Narrowing events by type. `HudhudEvent` has an arm for event types added in
// later versions (`type: string`), so `switch (event.type)` does not narrow
// it; `isEventType` does, and `HudhudEventOf` names the event of one type.
// Guide: docs/guide/events.md#reading-events-in-typescript

import { isEventType, type HudhudEvent, type HudhudEventOf } from 'hudhudjs';

/** One line about a tool call. */
function describeToolCall(event: HudhudEventOf<'tool.call'>): string {
  return `${event.toolName} (${event.kind}), input ${JSON.stringify(event.input)}`;
}

/** Logs tool calls and their results; skips every other event. */
export function logTools(event: HudhudEvent): void {
  if (isEventType(event, 'tool.call')) {
    console.log(describeToolCall(event));
  } else if (isEventType(event, 'tool.result')) {
    console.log(`${event.toolUseId}: ${event.status}`);
  }
  // Every other type, including types added in later versions, is skipped.
}
