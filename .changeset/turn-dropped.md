---
'@hudhudjs/core': minor
'@hudhudjs/claude-code': minor
'hudhudjs': minor
---

A turn whose user message the harness drops now fails instead of waiting forever (research 10 §3, lead decision after macOS gate run 2). Claude Code 2.1.296 answers a user message whose `uuid` the session transcript already holds with `command_lifecycle` `completed` and never starts a turn for it. The turn machine correlates `command_lifecycle` frames strictly by the turn's `uuid`, before or after `system/init`, and fails a queued turn that reports `completed` without `started` with the new error code `TURN_DROPPED` (class `TurnDroppedError`, retryable: a new send carries a fresh id; `details.turnId`, `details.lifecycle`) and the new diagnostic `turn.dropped` with the observed states. Every other turn is untouched, and a `result` that arrives first still settles the turn once. Both codes are additive in the errors and events schemas.
