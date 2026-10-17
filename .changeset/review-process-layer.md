---
'@hudhudjs/core': minor
'@hudhudjs/claude-code': patch
---

Process layer fixes from the pre-release review (ADR-0009, ADR-0010).

- A tool's daemon no longer outlives `dispose()`, an aborted `close()` or a close deadline on Linux and macOS. Whenever a snapshot of the tree exists, it is swept after Claude Code exits, whichever step ended it: the POSIX ladder sweeps S1 (and S2) as soon as it sees the exit, and the binding snapshots the tree before every end of input once a ladder runs. The `termination.sweep-after-exit` diagnostic now also follows a ladder.
- Windows: the sweep after the exit never adopts a process whose parent pid only names a dead tree member. It follows the dead root only for children started before the host saw its exit, and other parents only while they are alive with their verified identity. With a job there is no snapshot and no sweep: closing the job ends the tree. `AfterExitSkipReason` gains `'job-closed'` and `'job-close-failed'`, and `AfterExitDeps` gains `rootExitObservedAt`.
- Windows best effort: the ladder no longer skips `taskkill /T` when a process with a stale parent pid names a tree member (step detail `identity-foreign-child`). Measured: `/T` leaves such a process alone.
- Linux: with `/proc` mounted `hidepid=1`, unreadable entries are skipped and counted instead of failing the snapshot. The count shows as `rejected-<n>` on the ladder's snapshot steps and as `rejected` in the after-exit report. A `/proc` that belongs to another pid namespace is refused, so the session uses the degraded path instead of reading other processes.
- macOS: `ps` runs with `-ww`.
