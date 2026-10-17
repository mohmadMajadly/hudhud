---
'@hudhudjs/claude-code': patch
---

Disposing a Harness now waits for every session start in flight (pre-release review, R4-2). A start whose Claude Code process was being spawned when dispose began ends that process itself and rejects with `HARNESS_DISPOSED`; before, dispose resolved at once and the new process ran on until its handshake or the first-frame watchdog (up to 60 s). A start that has not spawned yet stops at its next step with `HARNESS_DISPOSED`, and every call of `[Symbol.asyncDispose]()` returns the same complete promise.
