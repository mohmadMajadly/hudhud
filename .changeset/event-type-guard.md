---
'@hudhudjs/core': minor
'hudhudjs': minor
---

New `isEventType(event, type)` type guard and `HudhudEventOf<T>` type (also on `@hudhudjs/core/protocol`). `HudhudEvent` is an open union, so `switch (event.type)` or `event.type === 'tool.call'` does not narrow an event; `isEventType(event, 'tool.call')` narrows it to the `tool.call` event, and for a type that a later version adds, to the open arm with that `type`. `HudhudEventOf<'tool.call'>` names the event of one type (a union of types gives the union of their events). Additive; nothing else changed.
