# ADR-0019: Running Claude Code as another user (`spawnAs`)

- Status: Proposed (0.2.0). Not implemented. Requested by a partner application that runs hudhud inside a per-session sandbox and wants the agent's tools unable to reach the host process.
- Date: 2026-10-18
- Negotiation log items: none (post-v1 proposal)
- Related: [ADR-0010](0010-process-layer-posix.md), [ADR-0011](0011-spawn-hygiene-and-binary-provenance.md), [ADR-0012](0012-security-defaults-and-trust.md), [ADR-0013](0013-testing-strategy.md), [ADR-0014](0014-ci-strategy.md), ADR-0020

Evidence keys used below:

- EXP-2: an experiment run by the lead on 2026-10-18 against hudhud `4446a8f` and the pinned linux-x64 CLI 2.1.296 (sha256 verified before every launch), in Docker `node:22-bookworm`, with `strace 6.1` and util-linux `setpriv` 2.38.1; the worker (hudhud) ran as root and the CLI as uid and gid 10001 through `setpriv --reuid=10001 --regid=10001 --clear-groups --no-new-privs --inh-caps=-all --bounding-set=-all`. Its report is not in the repository yet; committing it as `docs/research/12-…` is a condition of acceptance (see Consequences).
- Q2: design research of the same date (read-only; nothing run) on a uid split for the CLI, including its addendum on capability rules. Not in the repository either; its facts used here are restated with their sources.
- [man]: Linux man pages (`execve(2)`, `proc(5)`, `kill(2)`, `capabilities(7)`, `prctl(2)`, `setgroups(2)`, `setpriv(1)`). The quotations come from Q2, whose author did not re-fetch the pages; each [man] claim is therefore UNVERIFIED against the current pages until the acceptance review re-reads them.

## Context

Today the CLI runs as the user that runs hudhud. Whoever controls a Bash tool of the CLI therefore can, as that same user: signal or kill the host process, read its `/proc/<pid>/environ` (a ptrace read check that passes for the same uid while the host is dumpable), open every file the host can, and take over whatever the host talks to (Q2 §2.4 (c), [man] `kill(2)`, `proc(5)`, `ptrace(2)`). A sandboxed application whose control plane trusts what the host reports (permission outcomes, audit, billing) needs the agent unable to reach the host. The CLI and its tools always share a uid, because the CLI spawns its tools itself; no option of hudhud's changes that (Q2 §A.5).

Facts that shape the decision:

- Node's own `spawn({ uid, gid })` cannot do this safely (Q2 §2.1, §A.2): libuv calls `setgroups(0, NULL)` and ignores its failure, so a parent without `CAP_SETGID` leaves the child in the parent's supplementary groups; Node cannot set `no_new_privs` on a child, so set-user-ID binaries in the image stay an escalation path; and a non-root parent whose capabilities come from the ambient set passes them through `setuid` and `execve` to the CLI and every tool ([man] `capabilities(7)`: the sets are cleared only on a change from uid 0 to non-zero). Node cannot clear the ambient set of a child.
- An exec-only launcher keeps the process identity hudhud depends on. `execve` replaces the program in the calling process and keeps its pid ([man] `execve(2)`); `/proc/<pid>/stat` field 22, `starttime`, is set at fork and not reset by `execve` ([man] `proc(5)`). hudhud's identity is the spawned pid plus its start time (ADR-0011 J9, ADR-0010), so an identity read that lands before or after the launcher's `exec` records the same values. Measured (EXP-2 S7): the spawned pid was the CLI, `{"pid":5310,"uid":"10001","cliPid":5310}`, and `initialize.pid` equalled it, so no `binary.launcher-detected` diagnostic appeared.
- `setpriv` (util-linux) changes uid, gid and groups, sets `no_new_privs`, and clears the inheritable, ambient and bounding capability sets, then calls `execve`; it does not fork ([man] `setpriv(1)`; the no-fork behaviour is confirmed for 2.38.1 by EXP-2 S7 above).
- Cross-uid signals need privilege: `kill(2)` succeeds only when the sender has `CAP_KILL` or its real or effective uid equals the target's real or saved uid ([man] `kill(2)`). hudhud maps `EPERM` from `kill` to `not-permitted` today (`packages/core/src/process/os/posix.ts`, `deliver`). With a root worker EXP-2's ladder worked across uids: S6 (`dispose` during `sleep 20`) ended `aborted` in 75 to 98 ms in every case, and S7's `SIGKILL` was `killed-externally`; no process of uid B was left in the container.
- Cross-uid `/proc` reads: `/proc/<pid>/stat` and `/proc/<pid>/status` are world-readable unless `/proc` is mounted with `hidepid` ([man] `proc(5)`); with `hidepid=1` hudhud counts the entries as `rejected`, with `hidepid=2` they are absent (ADR-0010 "Linux /proc hardening"). `/proc/<pid>/exe` and `environ` need a ptrace read check, which a worker without `CAP_SYS_PTRACE` fails for another uid ([man] `proc(5)`, `ptrace(2)`).
- macOS has no `setpriv`, no `/proc` and no Linux capability sets; Windows has no uids.

## Decision

### 1. API

A connect option, harness-namespaced and `@beta` (ADR-0003 tiers):

```ts
claudeCode: {
  spawnAs?: {
    uid: number;            // integer, 1 ..= 4294967294, not the host's own uid
    gid: number;            // integer, 1 ..= 4294967294
    launcher: string;       // absolute path of util-linux setpriv, for example '/usr/bin/setpriv'
  };
}
```

- No default for `launcher`: the path is pinned by the application, never looked up in `PATH` (ADR-0011 §5 planting rules apply in full: absolute, `realpath`-resolved, a regular file).
- `uid` and `gid` must be integers in the range above; 0 is refused (running the agent as root defeats the purpose), 4294967295 is refused (it is `(uid_t)-1`, "no change", for the set-id calls, [man] `setresuid(2)`, UNVERIFIED as above), and a `uid` equal to the host's own effective uid is refused (`rule: 'spawn-as-same-uid'`): it would split nothing.
- Validation failures are `INVALID_OPTIONS` with `details.path` and `details.rule` (`spawn-as-shape`, `spawn-as-range`, `spawn-as-same-uid`, `spawn-as-launcher-not-absolute`).
- Platforms: Linux only. On Windows and macOS `connect()` fails with `CAPABILITY_UNSUPPORTED`, `details.capability: 'claudeCode.spawnAs'`, `details.reason: 'platform'` (`'win32'` or `'darwin'`). macOS is refused rather than emulated: there is no exec-only launcher with `no_new_privs` and capability clearing in the base system, and the post-spawn check of §4 has nothing to read without `/proc` (a macOS design is an open question, not part of 0.2.0).

### 2. How the CLI is started

hudhud still resolves and verifies the CLI exactly as today (`binaryPath` or discovery, digest table, strict mode; ADR-0011). `spawnAs` changes only what is executed:

```
<launcher> --reuid=<uid> --regid=<gid> --clear-groups --no-new-privs \
           --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- <CLI realpath> <hudhud argv...>
```

- The flag set is fixed, built at the single argv point (ADR-0011 §3, `--flag=value` form), and cannot be extended by options or by `/raw` `extraArgs` (which only append to the CLI's own argv after `--`). `--ambient-caps=-all` is the one flag EXP-2 did not pass; it is added so that a non-root worker whose capabilities are ambient cannot leak them (Context). Whether `setpriv` 2.38.1 accepts this exact combination when the host is root is UNVERIFIED until the uid-split lane (§8) runs it.
- `<CLI realpath>` is the file that was verified, not a name for the launcher to look up. The existing change check before spawn (`BinaryChangedError`, ADR-0011) applies unchanged.
- The `claude --version` probe of `connect()` (ADR-0011 K4) runs through the same launcher, so the CLI binary never executes with the host's privileges once `spawnAs` is set. Its working directory is still a fresh directory that hudhud creates and removes, created with mode `0711` instead of `0700` so that uid B can enter it but not list or write it (libuv enters the cwd as the parent, before `setpriv` runs, Q2 §2.1; the CLI then runs in it as B). That `--version` works in such a directory is UNVERIFIED.
- The CLI is still spawned non-detached; `setpriv` creates no session or process group, so the CLI stays in the host's process group, which hudhud never signals (ADR-0010). That `setpriv` 2.38.1 never calls `setsid` is UNVERIFIED by reading its source; EXP-2's dispose and sweep results are consistent with it.

### 3. Checks before spawn (at `connect()`, repeated at every session spawn)

Each failure is `SPAWN_AS_REFUSED` (new code, `retryable: false`) with `details.rule` and the offending path (paths are allowed in error details, as for `CWD_INVALID`; they never enter the posture). Nothing is spawned when a check fails.

1. Launcher provenance (`rule: 'launcher-unsafe'`): the launcher's `realpath` and every directory from it up to `/` must be owned by uid 0 and have neither the group-write nor the other-write bit (`mode & 0o022 === 0`); a symlink on the way is resolved and the same rule applies to the link's own directory chain. A file that uid B or the host's own (non-root) uid could replace is refused.
2. Launcher identity (`rule: 'launcher-not-setpriv'`): hudhud runs `<launcher> --version` once per Harness, as the host, with the same spawn hygiene as the CLI probe, and requires the output to start with `setpriv from util-linux `. A version older than the tested 2.38.1 is not refused; it is reported as the `spawn-as.launcher-untested` diagnostic (the post-spawn check of §4 is the authority, not the version). Executing the launcher as the host is acceptable because check 1 made it a root-controlled file.
3. CLI not writable by B (`rule: 'cli-writable-by-target'`): the CLI's `realpath` and every directory up to `/` must not be writable by (uid, gid): not owned by `uid`, not group-writable with group `gid`, not other-writable. `setpriv --clear-groups` leaves B with no supplementary groups, so `gid` is B's only group. A file B could rewrite would turn the next session's verified binary into B's code (TOCTOU, Q2 §2.2).
4. CLI and cwd reachable by B (`rule: 'not-reachable-by-target'`): every directory from `/` to the CLI must be searchable by (uid, gid), the CLI executable by them, and the cwd and its ancestors searchable and the cwd readable. `access(2)` tests the host's uid, so these are evaluated from mode bits and ownership; POSIX ACLs and LSM policy are not evaluated (a false "reachable" then ends as `SPAWN_FAILED` or a failing handshake, never as a weaker session).
5. Host able to switch (`rule: 'host-cannot-switch-uid'`): read once from `/proc/self/status`. If the host's effective uid is 0, `CapBnd` must contain `CAP_SETUID`, `CAP_SETGID` and `CAP_SETPCAP` (`setpriv` gets the root capability set capped by the bounding set at `execve`); otherwise `CapAmb` must contain the three (only ambient capabilities survive the host's `execve` of `setpriv` for a non-root host, [man] `capabilities(7)`). `CAP_SETPCAP` is needed for `--bounding-set=-all` ([man] `capabilities(7)`, UNVERIFIED that `setpriv` fails rather than skipping it without the capability). A host whose `NoNewPrivs` is 1 and that is not root cannot gain the capabilities through file capabilities on `setpriv` ([man] `prctl(2)`); the rule above already covers that, because only ambient capabilities are accepted for a non-root host. This check exists to fail early with a clear rule; §4 is what guarantees the outcome.
6. Child environment (`rule: 'spawn-as-env'`): the host's per-user variables are not passed to B. Under `spawnAs` both presets drop `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `MAIL` and every `XDG_*` variable of the parent (reported in `env.dropped`), and the application must set `HOME` and `TMPDIR` itself (`env.add` or an explicit map), or the session is refused. A shared `TMPDIR` or `XDG_RUNTIME_DIR` would put B's sockets and task output in the host's directories (the CLI writes `$TMPDIR/claude-<uid>/…` and `cc-socks/<pid>.sock` there, EXP-2 §2; ADR-0010 "Sockets"). Whether those directories are owned by B, and the rest of the layout, is the job of the layout check (ADR-0020), which `spawnAs` turns on in `'warn'` mode by default.
7. `/proc` visibility (`rule: 'proc-hidden'`): the host must be able to read `/proc/<pid>/status` of uid B's processes. With `hidepid=1` or `hidepid=2` and the host neither root with `CAP_SYS_PTRACE` nor in the mount's `gid=` group, it cannot, and §4 and every snapshot would fail; hudhud refuses instead of running blind. Determined from `/proc/self/mountinfo` (the `hidepid` and `gid` mount options of the `/proc` mount) and the host's capabilities and groups. Under gVisor there is no `hidepid` (Q2 §2.3, from gVisor's source on 2026-10-18).

### 4. Verification after spawn (fail closed)

The spawned process is `setpriv` until it calls `execve`. The CLI writes nothing to stdout before it runs, so the first stdout byte proves the `exec` happened. hudhud reads `/proc/<pid>/status` of the spawned pid at that moment, after confirming that `/proc/<pid>/stat` still shows the recorded start time, and before it writes anything to the CLI except the `initialize` request (no user message, no other control request):

| Field | Required |
|---|---|
| `Uid:` (real, effective, saved, filesystem) | all four equal `uid` |
| `Gid:` (real, effective, saved, filesystem) | all four equal `gid` |
| `Groups:` | empty |
| `CapEff`, `CapPrm`, `CapAmb` | `0000000000000000` |
| `CapInh`, `CapBnd` | `0000000000000000` (what the fixed flags set; a launcher that does not honour them is not the launcher hudhud built the argv for) |
| `NoNewPrivs` | `1` |

When `initialize` answers, `initialize.pid` must equal the spawned pid (exec-only proof; a forking launcher fails here with `rule: 'launcher-forked'`, where today the same mismatch is only the `binary.launcher-detected` diagnostic).

When `/proc/<pid>/exe` is readable (host is root with `CAP_SYS_PTRACE`), its device and inode must equal the verified CLI's; when it is not readable (`EACCES`), this sub-check is reported as `unverifiable` in the session's `spawn-as.verified` diagnostic, never silently passed.

Any mismatch, or a status that cannot be read: the session fails with `SPAWN_AS_FAILED` (new code, `retryable: false`, `details.rule` one of `uid-mismatch`, `gid-mismatch`, `groups-not-cleared`, `capabilities-not-cleared`, `no-new-privs-off`, `launcher-forked`, `exe-mismatch`, `status-unreadable`, with the observed field names, not values beyond the numbers above). hudhud then ends the process at once: stdin is closed (EOF) and the abort ladder of ADR-0010 runs. Because no user message was written, no tool has run on the agent's behalf. Residual, documented: the CLI's own start-up (user-scope hooks such as `SessionStart`, user-scope MCP servers) may already have started processes with the faulty credentials before the first stdout byte; in the recommended layout those come from root-owned configuration (ADR-0020), not from the agent. Without `CAP_KILL` the ladder can only close stdin (§5); the failure says so in `details.terminated: false`.

Success emits the diagnostic `spawn-as.verified` (`data`: `uid`, `gid`, `noNewPrivs`, `exe: 'verified' | 'unverifiable'`).

### 5. Containment across uids

Whether the host may signal uid B is decided at `connect()` from the host's `CapEff` (`CAP_KILL`) and confirmed at run time by the first signal's result.

- With `CAP_KILL` (or as root with it in the effective set): ADR-0010 applies unchanged. Identity, snapshots S1 and S2, the EOF snapshot, `SIGTERM`, `SIGKILL`, the verified `kill(-pgid)` of tool groups and the sweep after the exit (R3-1) all work across uids, as EXP-2 S6 and S7 measured with a root worker. `processContainment` stays `'best-effort'`.
- Without `CAP_KILL`: `processContainment` is `'best-effort'` with `capabilities.reasons.processContainment: 'cross-uid-no-kill'`, the posture entry `spawnAs.signals: 'not-permitted'`, and a `containment.cross-uid-no-kill` diagnostic at session start. What hudhud can and cannot guarantee then, stated in the docs exactly so:
  - It can: send `interrupt`, close stdin, take the snapshots (`/proc` is readable, §3 check 7), and report every survivor by pid and start time.
  - It cannot: deliver `SIGTERM` or `SIGKILL` to the CLI or any tool, or sweep. The ladder's signal steps are recorded as `not-permitted` (not as failures of hudhud), the sweep after the exit reports `status: 'skipped'`, `reason: 'not-permitted'`, with `data.survivors` (the count of verified snapshot descendants still alive).
  - Consequences: a CLI that ignores EOF (a wedged CLI, or one finishing a long tool; measured, the CLI finishes its in-flight tool before exiting on EOF, ADR-0010) keeps running; `dispose()` still resolves after the ladder's bounded waits, with `session.terminated` `outcome` from the existing classification and the `termination.ladder` diagnostic showing the skipped steps. Descendants that survive the CLI (a daemon started with `setsid`, the `rg --files` child of the drain-path finding) stay alive until the application tears the sandbox down. The application must own that teardown; hudhud cannot.
- The sweep's protected set is unchanged: the host's group, pid 0 and 1, the spawned pid and the signal target's group are never signalled. The after-exit walk's rules (R2-1: a parent's pid names that parent only while it provably held it) do not depend on the uid and are unchanged; under `hidepid` the session never starts (§3 check 7), so the walk never runs on a partial table.
- A uid-B process cannot signal the host ([man] `kill(2)`): the host's own exit hook (ADR-0008) and ladder timers cannot be disturbed by B's signals. B can still close or flood its own pipes; the framer bounds (ADR-0011 §7) apply as before.

### 6. Posture and diagnostics

- Posture entries (connect): `claudeCode.spawnAs` with value `'uid-split'` or `'off'` (default `'off'`; numbers are not secrets but the posture lists kinds, so `uid` and `gid` appear in the `spawn-as.verified` diagnostic instead), and `spawnAs.signals`: `'permitted' | 'not-permitted'` when set. `spawnAs` strengthens a default, so it is not a `dangerously*` option; it is listed because every security-relevant setting is (ADR-0012 §7).
- Diagnostics: `spawn-as.verified`, `spawn-as.launcher-untested`, `containment.cross-uid-no-kill`; the existing `env.dropped` names the per-user variables of §3 check 6.

### 7. Threat model statement (amends ADR-0012's threat model when accepted)

What the split protects: the host process's memory, environment, signals and files (mode `0600` or `0700` and owned by the host's uid), and with them the host's channel to its control plane. What it does not protect: anything the CLI itself holds. The CLI and its tools share uid B, so a tool can read the CLI's environment (including the API credential or gateway token that the CLI needs) and, for a dumpable CLI, reopen its pipes through `/proc/<cli>/fd` and inject frames towards hudhud (Q2 §A.5; the reopen is UNVERIFIED, not run in EXP-2). hudhud already treats every frame from the CLI as untrusted (ADR-0012 §8); applications must not treat the in-sandbox event stream as audit after a compromise. `spawnAs` does not replace session-scoped credentials and authorization outside the sandbox (Q2 §2.4 (c)).

### 8. Tests

- Unit (all OSes):
  - option validation: shape, ranges, `0`, `4294967295`, same uid, relative launcher, Windows and macOS refusal with `CAPABILITY_UNSUPPORTED`;
  - the launcher argv: the exact fixed flag list, `--flag=value` form, `--` before the CLI path, `/raw` `extraArgs` only after the CLI path;
  - the `/proc/<pid>/status` parser on fixture files (Linux 5.x and 6.x layouts, the gVisor layout once recorded), including missing fields (refused) and hex masks with leading zeros;
  - the mode-bit evaluator for checks 1, 3 and 4, against a reference oracle;
  - the posture entries, diagnostic shapes, and the two new error codes in the code table and `errors.schema.json` (`retryable: false`).
- Property (fast-check): the mode-bit evaluator against the oracle over arbitrary (owner, group, mode, sticky, uid, gid) chains; the status parser never accepts a status whose `Uid:`, `Gid:` or capability fields differ from the requirement; the argv builder never lets an option value appear before `--`.
- Conformance (sans-IO, loopback): the termination ladder and the sweep after the exit with every signal answering `not-permitted` (the step records, `status: 'skipped'`, `reason: 'not-permitted'`, `survivors`); `SPAWN_AS_FAILED` before any user message is written (the recorded stdin holds the `initialize` request only).
- Integration, uid-split Docker lane (Linux, `node:22` and `node:26` images, ADR-0013 hygiene: mock API, CONNECT trap, pinned hash-verified CLI; local runs take the shared Docker lock). Base container: `--user 0 --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add SETPCAP --cap-add KILL --init`, the CLI and `setpriv` root-owned, a per-uid `HOME` and `TMPDIR` laid out as ADR-0020 recommends.
  - Must pass: text turn, Bash turn, resume, fork; `spawn-as.verified`; a Bash tool's `cat /proc/<host pid>/environ` fails with `EACCES` and its `kill <host pid>` fails with `EPERM`; `dispose()` during `sleep 20` ends `aborted`; a `setsid` daemon started by a tool is killed by the sweep after the exit; no uid-B process is left.
  - Variant without `--cap-add KILL`: `cross-uid-no-kill` in capabilities, posture and diagnostics; the ladder's signal steps are `not-permitted`; the sweep reports the daemon as a survivor and does not kill it; `dispose()` resolves within its bounds.
  - Variant with `--security-opt no-new-privileges` on the container: must pass as the base (UNVERIFIED today that a root host under `no_new_privs` keeps the capabilities `setpriv` needs; this variant settles it).
  - Must refuse, each asserting that no process of uid B ever ran (a process-table check before and after): a launcher that is group- or other-writable; a launcher in a directory that uid B owns; a launcher not owned by root; a non-`setpriv` launcher (`launcher-not-setpriv`); a CLI file owned by uid B (`cli-writable-by-target`); a container started as a non-root user without capabilities (`--user 1000 --cap-drop ALL`: `host-cannot-switch-uid`, the setuid-less environment); `HOME` or `TMPDIR` not set by the application (`spawn-as-env`).
  - Must fail after spawn, each through a root-owned test launcher that prints the `setpriv` version line and then misbehaves: keeps an ambient capability (`setpriv … --inh-caps=+kill --ambient-caps=+kill`: `capabilities-not-cleared`); switches to `uid + 1` (`uid-mismatch`); omits `--clear-groups` with the host in a supplementary group (`groups-not-cleared`); forks and waits instead of exec (`launcher-forked`). Each asserts that stdin received only `initialize` and that the CLI was ended.
  - Optional variant: `/proc` remounted `hidepid=2` (needs `CAP_SYS_ADMIN` in the setup step only): `proc-hidden` refusal; and `hidepid=2,gid=<host group>` with the host in that group: must pass.
- The Windows and macOS jobs run the unit refusal tests only; no real-CLI test exists there for `spawnAs`.
- CI tier (ADR-0014): the lane runs on FULL in the Linux job (it is a container step, about the cost of one more integration project; to be measured and sized by K15 before adoption) and in the nightly canary against the newest CLI.

## Alternatives considered

- Node's `spawn({ uid, gid })` (Q2 option (a)). Not chosen for 0.2.0: no `no_new_privs`, no capability clearing, the ignored `setgroups` failure, and the ambient-capability leak for a non-root host (Context). It would be safe only for a uid-0 host with `CapAmb` 0 and `no_new_privs` set container-wide; offering it as a second way is an open question.
- Any launcher, as an application-supplied `claudeCode.launcher: { path, args }` (Q2 option (b) general form). Not chosen for 0.2.0: hudhud could not state what the launcher did, and the post-spawn requirements of §4 would have to be configurable. Pinning `setpriv` with a fixed flag set makes every guarantee checkable. A general launcher seam (for `bwrap`, `nsenter`, a delegated-cgroup launcher) stays a roadmap item.
- `sudo`, `su`, `runuser`. Rejected: they fork (`sudo` keeps a monitor parent by default; `su` and `runuser` open PAM sessions), so the spawned pid is not the CLI; the identity would be the launcher's, and signals cross-uid fail anyway (Q2 §A.1).
- A `#!` wrapper script as `binaryPath` that execs `setpriv` (works today, ADR-0011 J9). Not the supported way: hudhud verifies the script, not the CLI (EXP-2 reported `binary.unverified` for exactly this reason), and nothing checks the resulting credentials.
- Refusing `spawnAs` without `CAP_KILL`. Not chosen: in a per-session disposable sandbox, teardown is the boundary, and interrupt plus EOF end a healthy CLI; hudhud reports the gap instead (§5).
- The saved-uid trick (leave the host's uid as B's saved uid so it can signal B without `CAP_KILL`). Rejected: `execve` copies the effective uid to the saved set-user-ID ([man] `execve(2)`), and a saved uid of A would let B switch back to A (Q2 §2.2).
- `pidfd_send_signal`. Rejected for permission: it applies the same checks as `kill(2)` ([man] `pidfd_send_signal(2)`); it solves pid reuse, not privilege.
- Requiring `hidepid`. Rejected: it buys nothing for the host's secrets that the uid split does not already give (environ and mem need the ptrace check either way) and costs hudhud its identity unless the host is in the `gid=` group (Q2 §A.4).

## Consequences

- Two new error codes (`SPAWN_AS_REFUSED`, `SPAWN_AS_FAILED`), additive to the closed code list and to `errors.schema.json`; consumers with a `default:` branch are unaffected (ADR-0005).
- A session with `spawnAs` starts later by one `/proc` read and, per Harness, one `setpriv --version` run.
- The application must provide the uid, gid, launcher, a per-uid `HOME` and `TMPDIR`, and a configuration layout B cannot write; ADR-0020 reports what it gets wrong.
- Without `CAP_KILL`, hudhud's dispose guarantees shrink to what §5 lists, and the docs and the posture say so.
- hudhud's own read-only scans (the user `settings.json` for `managedPolicy`, the project credential guard, ADR-0012) still run as the host. A non-root host cannot read files that B owns with mode `0600`; the existing fail-safe values apply (`'unknown-user-settings-unreadable'`, a refusing guard). In the recommended layout the configuration is root-owned and world-readable, so this does not arise.
- Acceptance conditions: the EXP-2 report committed under `docs/research/`; the [man] citations re-read; the uid-split lane green on FULL, including the `no-new-privileges` and the forking-launcher variants.

## Evidence

- EXP-2 (2026-10-18, CLI 2.1.296, Linux, root worker, `setpriv` 2.38.1): §Setup (the launcher line and S7's pid record), §1 matrix (S6 and S7 in every case; no uid-B process left), §2 write set (`$TMPDIR/claude-<uid>/…`, `cc-socks`).
- Q2 §2.1 (libuv child init order, `setgroups` failure ignored), §2.2 (the cross-uid table), §2.3 (gVisor procfs and signal checks, from gVisor's source), §2.4 (options (a) to (d)), §A.1 (exec-only launchers keep pid and start time), §A.2 (ambient-capability leak), §A.3 (teardown without `CAP_KILL`; pidfd; `cgroup.kill`), §A.4 (`hidepid`), §A.5 (same-uid pipe reopen, UNVERIFIED).
- Repository: `packages/core/src/process/os/posix.ts` (`EPERM` to `not-permitted`), `packages/core/src/process/spawn.ts` (identity read and `IdentityProblem`), `packages/core/src/process/ladder/after-exit.ts` (the after-exit sweep and its R2-1 rules), `packages/core/src/process/binary-path.ts` (`#!` launchers accepted), `packages/core/src/protocol/errors.ts` (code and `retryable` table), ADR-0010, ADR-0011 J9 and K1.
