---
'@hudhudjs/claude-code': patch
---

Raw tier `frames()` (pre-release review, ADR-0007):

- A full `overflow: 'block'` raw subscriber now stalls the session instead of breaking it. The inbound tap and every outbound write publish through one serialized chain; before, a write during a stall made a second publish throw, so the session took it for a broken input pipe and refused every later call with `SESSION_CLOSED` (or stopped reading Claude Code's output on the read path).
- The session option `events.signal` ends `frames()` subscriptions with `ABORTED`, as it does for `events()`, and a subscription lets go of its signals once it stops accepting frames.
