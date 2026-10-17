---
'@hudhudjs/core': minor
'@hudhudjs/claude-code': patch
---

An abort stops a running version probe at once (pre-release review, R5-U1). `connect({ signal })`, and the `signal` of a session start that probes a changed binary again, used to act only after the `--version` probe ended (up to its 15 s bound); now the probe's child is killed through its handle and the call rejects with `ABORTED` right away, with nothing left running. Hashing the binary and the OS signature check still complete before the abort is seen (both are bounded).

Process API: `BoundedCommand.signal` (aborting it kills the child; already aborted, nothing is spawned), the new `CommandOutcome` kind `'aborted'`, `VersionProbeOptions.signal` and the `VersionProbeFailure` reason `'aborted'`.
