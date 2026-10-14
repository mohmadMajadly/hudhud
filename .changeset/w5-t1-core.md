---
'@hudhud/core': minor
---

`@hudhud/core/binding` (beta) exports the bounded fanout behind `events()` (`Fanout`, `FanoutDeps`, `FanoutSubscriberOptions`, `Selection`, `SizedEvent`, `AbortSignalLike`, `OverflowInfo`), so an adapter can offer its own bounded streams with the same limits and overflow policies (the Claude Code raw tier's frames).
