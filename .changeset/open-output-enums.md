---
'@hudhudjs/core': minor
'hudhudjs': minor
---

Breaking, before the first release (pre-release review R5-4, ADR-0005 §6): every value from a fixed list that hudhud gives applications is now an open enum, so a later minor version can add a value without breaking your code. Newly open, in the types and in `events.schema.json` and `capabilities.schema.json`: `CompatInfo.status`, `session.started`'s `mode`, `turn.started`'s `origin`, the `status` of `tool.call` and `tool.result`, `permission.resolved`'s `behavior` and `by`, `Capability` and `ProcessContainment`; in the types only: `SessionInfo.mode`, `BinaryInfo.source`, `BinaryVerification.status` and `BinaryVerification.method`. Each keeps its known values and also accepts any string (`| (string & {})`). Code that switches over one of them exhaustively needs a `default` branch. Values hudhud emits are unchanged.
