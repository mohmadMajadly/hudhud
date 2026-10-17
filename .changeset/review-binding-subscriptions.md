---
'@hudhudjs/core': minor
---

Session subscriptions and turn signals (pre-release review, ADR-0007, ADR-0008):

- Byte accounting: a subscriber is charged each Claude Code frame once. The first event it takes from a frame counts the frame's bytes; every other event of the same frame counts 256 bytes. Before, every event carrying the frame counted it in full, so one large `assistant` frame with several tool calls could overflow an empty default subscriber.
- The session option `events.signal` now ends every subscription of the session (`events()` and turn iterators) with `ABORTED`, in addition to each subscription's own `signal`. It was accepted and then ignored.
- A subscription lets go of the application's abort signals once it stops accepting events, so a long-lived signal passed to many `send()` calls or `events()` subscriptions no longer keeps a listener, and with it the subscription's queue and the session, alive. An abort after that still stops the delivery of events queued before the end.
- A `gap` event's `seq` is that of the first event dropped, also on a turn iterator (it was the last delivered `seq` plus one, which could name another turn's event).
- `send(input, { signal })` works like `ask()`: when the signal aborts, `turn.done` and the turn's iterator reject at once with `ABORTED` and the turn is interrupted (before, `turn.done` waited for the turn's result). A signal that is already aborted sends nothing: no user message is written and no turn starts (before, the message was written and then interrupted).
- Binding API (beta): `LinkedSignal` and `SharedBytes` are exported from `@hudhudjs/core/binding`; `Fanout.publish` takes an optional `SharedBytes`; `Selection.onClose` is new; `FanoutDeps.gapMarker` receives the first dropped event and `FanoutDeps.count` is new.
