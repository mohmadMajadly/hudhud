# ADR-0010: Process layer on POSIX (Linux, macOS)

- Status: Accepted. The macOS gate passed on 2026-10-16 ([research 11](../research/11-macos-gate-run3.md); runs 1 and 2: research 09, 10): the `ps` contract `pid=,ppid=,pgid=,stat=,lstart=,comm=`, the process groups of the Bash tool, SIGTERM, SIGINT and the sweep were confirmed on darwin-arm64 and darwin-x64.
- Date: 2026-10-12
- Negotiation log items: A12 (REPLACED), E1 as amended in F, D8, G3 (06 §A, §D, §E, §F, §G)
- Related: [ADR-0008](0008-turn-and-lifecycle-semantics.md), [ADR-0009](0009-process-layer-windows.md), [ADR-0011](0011-spawn-hygiene-and-binary-provenance.md)

## Context

Original A12 proposed a no-native-code process layer whose last step was `SIGKILL` of the process group. That is wrong (D8), measured on Linux with CLI 2.1.296 (05 §10):

- The CLI puts each Bash tool in its own process group (`pgid == bash pid`).
- `SIGTERM` or `SIGINT` to the CLI: the CLI cleans its tool groups; no survivors.
- `SIGKILL` to the CLI, or `kill(-pgid of the CLI)`: bash and sleep survive.
- Exit codes: SIGTERM gives 143, SIGHUP 129, SIGINT 0 with no `result` frame ([ADR-0008](0008-turn-and-lifecycle-semantics.md)).
- Graceful EOF leaves no orphans; the CLI waits for the tool (exit 12.6 s after EOF in a `sleep 15` test).

A non-detached child shares the host's process group, so `kill(-pgid of the CLI)` would target the host's own group. It is forbidden.

## Decision

### Spawn

Non-detached by default. No native code on POSIX.

### Abort ladder (replaces A12; E1 as amended by F)

1. Send `interrupt` with `cancel_queued: true`.
2. Close stdin (EOF).
3. Wait 2 s. If the CLI has not exited: take snapshot S1 of the spawned process's descendants and send `SIGTERM` to the signal target only. (`SIGTERM` is the step proven to make the CLI clean its tool groups.)
4. Wait 5 s. If the CLI has not exited: take snapshot S2, send `SIGKILL` to the signal target and to the spawned process, then run the sweep over S1 ∪ S2.

Signal target (K1, 06 §K): `initialize.pid` when it appears in S1 as a descendant of the spawned pid with a start time matching the snapshot (the real CLI behind a launcher, which forwards no signals, 07 §4); otherwise the spawned pid. Snapshots, containment and the sweep are always rooted at the spawned pid ([ADR-0011](0011-spawn-hygiene-and-binary-provenance.md), J9).

Never `kill(-pgid of the CLI)`.

### Sweep

- Snapshots collect, for every descendant: pid, parent pid, process-group id, and a start-time value. They are taken while the tree is intact, before the signal that may break it (S1 before `SIGTERM`, S2 before `SIGKILL`).
- Kill a process only if its pid and start-time still match the snapshot (pid + starttime guard against pid reuse).
- For groups led by a descendant (such as each Bash tool's group), `kill(-pgid)` is used; the group id comes from the snapshot, and the group leader's identity is verified as above. Groups led by the host or the CLI are never signalled.
- Linux: scan `/proc/<pid>/stat` (parent pid, process group, start time).
- macOS: parse the output of `/bin/ps` invoked by absolute path with `LC_ALL=C` (fields: pid, parent pid, process group and a start-time field). The exact `ps` field list is to be fixed by the macOS gate. A libproc-based darwin addon is a possible future replacement and is not in v1.

### Drain path

Not the ladder. `close()` keeps stdin open until `idle`, then sends EOF and waits for the CLI to finish (see [ADR-0008](0008-turn-and-lifecycle-semantics.md)). `dispose` = abort ladder; `close` = drain.

The drain path sweeps too (W3-Z ruling 5, 2026-10-13). Finding of the golden-fixture recordings (W3-T6): on Linux the pinned CLI exited normally after EOF and left its `rg --files` child running, reparented to init. So when stdin is ended for a graceful close, the binding takes a snapshot of the descendants of the spawned process, rooted at its verified identity (`snapshotAtEof`); after the CLI has exited, every descendant of that snapshot whose pid and start time still match a fresh snapshot is killed (`sweepAfterExit`, the same planner and `SIGKILL` rules as the ladder's sweep: verified groups first, never the host's, the spawned process's or the CLI's group). Nothing is signalled while the spawned process still runs. Processes started after EOF (lead review): a member of a process group whose leader is a snapshot descendant that is still alive with its verified identity, started no earlier than that leader, is killed too, even when it was reparented to init: while the leader lives, its pid and so the group id cannot have been reused. Residuals, documented: (1) a process started after EOF whose parent exited (reparented to init or a subreaper) and that is not in such a live tool group cannot be identified soundly and is not killed; the CLI runs in the host's process group and session (it is not detached), so neither ties such a process to it, and the host's group is never signalled; (2) as for every sweep, the fresh snapshot and the kill calls are not atomic, so a process that exits and whose pid is reused within that window (one table read plus the calls) can be signalled; a hit needs that pid to be handed out again inside the window, which on Linux takes the pid counter to wrap. As built (W4-T1): the process transport takes the snapshot first and ends stdin after it; the CLI is alive until it sees EOF, so the snapshot cannot miss its root.

### Sweep after the exit (both platforms)

Amended by the pre-release review (2026-10-17, R3-1, R8-1; the same rule in [ADR-0009](0009-process-layer-windows.md)). Before the review the POSIX ladder swept only after its own `SIGKILL`: a CLI that exited at the EOF step or on `SIGTERM` (the normal outcomes of `dispose()`, an aborted `close()` and a close deadline) left a tool's daemon (`setsid`, `nohup … &`) running, although S1 had recorded it, while the graceful close killed the same process. The rule now, stated once for both platforms:

- Whenever hudhud holds a snapshot of the tree taken while the spawned process was alive, it sweeps that snapshot's survivors after the exit, whichever step ended the process. The ladders sweep S1 (and S2) as soon as they observe the exit after S1 (POSIX: also at the `snapshot-s1`, `sigterm` and `snapshot-s2` steps; Windows best effort: at every step after S1).
- Before any end of input (the graceful close, and every end of input once a ladder runs) the binding takes its own snapshot, so an exit at the interrupt or EOF step is covered too: the snapshot starts with the ladder, overlapping the interrupt step, and EOF follows it. The host-exit hook still ends input at once, without a snapshot. After the exit the binding sweeps that snapshot (`sweepAfterExit`), reported as the `termination.sweep-after-exit` diagnostic.
- A Windows job needs neither: closing the job after the exit ends the whole tree (`job-closed`).
- Every kill after the exit is a `SIGKILL` (or `taskkill /F /PID`) of a recorded descendant, or of a process it forked, verified by pid and start time against a fresh table; the host, pid 0/1, the spawned pid and the protected groups are never signalled.

Linux `/proc` hardening (review R3-2, R3-U1): with `/proc` mounted `hidepid=1` (`noaccess`) other users' entries are listed but their `stat` is refused with `EPERM`; those entries are skipped and counted in the snapshot's `rejected` count (named in the ladder's snapshot steps, `rejected-<n>`, and in the after-exit report), instead of failing the snapshot. Such a process can never be a verified descendant, and an unprivileged host cannot signal it anyway. A host in a pid namespace whose `/proc` belongs to the parent namespace (`unshare -p -f` without `--mount-proc`) would read another process under its own child's pid; the table adapter checks once that `/proc/self` names the host, and otherwise refuses every read (`EPIDNS`), so the session runs on the degraded path: no identity, no snapshot, no sweep, signals to the host's own child only. Confirmed in a Docker pid namespace (plan §5.9 review fixes).

macOS `ps` runs with `-ww` (review R3-U2), so the last column (`comm`) is never cut to a default width; names are informational only.

### Containment capability and residuals

- POSIX reports `processContainment: 'best-effort'` in v1.
- Residual, documented: if the host itself dies, nothing runs the ladder, and descendants of a CLI killed with `SIGKILL` can survive. Measured on Linux (07 §2, J8): host death is stdin EOF and the CLI behaves exactly like a graceful EOF. It finishes the in-flight stream or tool (up to the tool's own duration, observed 15 s), then exits 0, with no orphans. EPIPE on later writes did not change the outcome. The documented residual is narrower: an orphan only arises if the CLI itself is SIGKILLed, and a long tool keeps running after the host is gone, up to its own timeout. macOS is untested.
- A strong option is planned for v1.x: a cgroup spawner (systemd scope or delegated cgroup v2) reporting `processContainment: 'cgroup'`. It is not available everywhere (needs delegation), so it is optional, not the default.

### Sockets

On Linux the CLI's messaging socket falls back to `/tmp/cc-socks-<uid>/<pid>.sock` when the path would exceed 103 bytes or the filesystem cannot host sockets; stale `.sock` files remain after SIGKILL (05 §13). hudhud does not write to or clean the harness's directories (R6); this is documented as a known harness behaviour. Tests put `TMPDIR` on a native filesystem ([ADR-0013](0013-testing-strategy.md)).

## Alternatives considered

- Process-group kill as the last step (original A12). Rejected: measured to miss tool groups (05 §10).
- `PR_SET_CHILD_SUBREAPER` (native). Rejected (E1): a global side effect on the consumer's process (the host becomes reaper of all orphaned descendants) and zombie accumulation, because libuv reaps only its own children. It would also need native code on POSIX.
- cgroup v2 as the only mechanism. Rejected as sole mechanism: not universally available (needs systemd scope or delegation). Kept as an optional strong mode, planned v1.x.
- `/proc` walk after `SIGKILL`. Rejected: after the CLI dies, descendants are reparented and the tree can no longer be traced from the CLI; hence snapshots before the signals.
- Rely on `SIGTERM` plus a documented residual only. Rejected: `SIGKILL` stays necessary for a wedged CLI, and then the sweep is the only cleanup.
- Detached spawn with `kill(-pgid)`. Rejected: measured to miss the tool groups, and creates a different process-group semantics for consumers ([ADR-0009](0009-process-layer-windows.md) also does not detach).
- Native libproc addon on macOS in v1. Deferred to a possible later addon.

## Consequences

- The sweep is inherently racy (a descendant may fork between snapshot and kill). The two snapshots reduce but do not eliminate the window; this is documented as best-effort.
- The `/proc` and `ps` parsers are locale- and format-sensitive; `LC_ALL=C` and fixtures per OS are required.
- On macOS, the whole ladder (including whether `SIGTERM` makes the CLI clean its tool groups) is untested until the macOS gate runs.
- Process identity (`pid`, start time) is used by the sweep and always refers to the pid hudhud spawned. `initialize.pid` differs from it behind a launcher and is informational; a mismatch is reported as a diagnostic, see [ADR-0011](0011-spawn-hygiene-and-binary-provenance.md) (J9).

## Evidence

- 05 §10 (Linux table and implications), §9 (signal exit codes), §13 (socket fallback), §15 item 4.
- 02 §6.3 (SDK close ladder: EOF, 2 s, SIGTERM, 5 s, SIGKILL; no tree kill).
- 05 §5 (`initialize.pid` is the CLI's own pid).
- 07 §2 (Linux host-crash rows L71-L74), §4 (pid versus launcher); 06 §J8-J9.
