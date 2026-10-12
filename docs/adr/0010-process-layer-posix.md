# ADR-0010: Process layer on POSIX (Linux, macOS)

- Status: Accepted — pending macOS gate. macOS behaviour is untested; the macOS gate (see [ADR-0014](0014-ci-strategy.md) and [ADR-0018](0018-scope-and-roadmap.md)) must pass before v1.
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
