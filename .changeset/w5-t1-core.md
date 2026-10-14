---
'@hudhud/core': minor
---

`@hudhud/core/binding` (beta) exports the bounded fanout behind `events()` (`Fanout`, `FanoutDeps`, `FanoutSubscriberOptions`, `Selection`, `SizedEvent`, `AbortSignalLike`, `OverflowInfo`), so an adapter can offer its own bounded streams with the same limits and overflow policies (the Claude Code raw tier's frames).

Fix: events published before the handshake settled (the adapter's diagnostics, `session.started`) reached no application subscriber. The session driver keeps them in a bounded pre-handshake buffer (`PRE_HANDSHAKE_MAX_EVENTS`, `PRE_HANDSHAKE_MAX_BYTES`; truncation reported by the diagnostic `events.pre-handshake-truncated`) and replays them to every `events()` subscriber after `compat`, within the subscriber's own limits.
