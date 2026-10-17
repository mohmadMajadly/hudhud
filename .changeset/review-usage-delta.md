---
'@hudhudjs/claude-code': patch
---

`usage.update.estimatedDelta` now carries figures (pre-release review, R4-7; ADR-0016). It was always `{ estimate: true }` with nothing else. Claude Code reports each turn's own main-loop tokens and a running cost total in its `result` frame; the estimate is the turn's tokens as reported and the change of the running cost since the session's previous report (a smaller total counts as a reset). The first report of a resumed or forked session has no cost delta, since its baseline is unknown. `usage.update.reported` and `TurnResult.usage` are unchanged; the guide now states what they hold (the tokens are the turn's own, not cumulative as it said).
