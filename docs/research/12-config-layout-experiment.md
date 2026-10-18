# 12 — Experiment EXP-2: what Claude Code CLI 2.1.296 writes and reads as configuration, and how it behaves when configuration is read-only

Date: 2026-10-18. hudhud `main` at `4446a8f`, fresh clone. Linux only: Docker `node:22-bookworm`, extended with `strace` 6.1-0.1 (Debian bookworm) into a tools image; util-linux `setpriv` 2.38.1; Node 22.23.2. **No Windows or macOS run; nothing here is verified on those OSes.**

Everything ran on the pinned linux-x64 2.1.296 binary (`pnpm cli:fetch`, sha256 `24972e3b…d0de`, 257068216 bytes) against hudhud's in-process mock API, in a container with `--network none`, `--cap-add SYS_PTRACE`, `--rm` and `--init`. No real API, no real credentials, no user install or user config was used. The only network use was building the tools image (`apt-get`, a lead-approved deviation), `pnpm install` and `pnpm cli:fetch`.

Paths: `S` = scratch workspace (not part of this repository). Scripts: `S/exp2/` (`run.sh`, `driver.mjs`, `launch.sh`, `tamper.sh`, `analyze2.mjs`, `matrix.mjs`); matrix: `S/exp2/matrix.txt`; raw evidence per case: `S/exp2/out/<case>/` (`driver.log`, `results.json` and `*.events.json` for hudhud's events and diagnostics; `trace-relevant.txt`, the strace lines under HOME, TMPDIR and `/proc/self/fd`; `a2.txt`, the analysis; `*.tree`, name, mode, owner and size snapshots after each scenario; `*.claudejson-keys`, `.claude.json` key paths with values redacted; `tamper.txt`; `launches.log`). In this report `<home>` is the CLI user's home directory in the container, `<cfg>` the config directory (`<home>/cfg` when `CLAUDE_CONFIG_DIR` is set, `<home>/.claude` when it is not), and `B` the CLI's uid and gid 10001.

---

## 0. Summary

- The minimal writable set for every scenario below: `projects/`, `sessions/`, `session-env/` and `shell-snapshots/` under the config directory, owned by B, plus a writable `TMPDIR` (§3).
- Without a writable `projects/`, resume and fork fail with `SESSION_NOT_FOUND`, and large tool output is sent inline in the model request instead of being kept on disk (C5, §2).
- A failed `.claude.json` save is not fatal and is silent: nothing on the CLI's stderr, no hudhud diagnostic, every turn completes (§5).
- `settings.json` is watched and re-read about 1.0 to 1.1 s after an in-place write or an atomic rename; its `env` and deny rules apply to the next tool call (§4).
- With `CLAUDE_CONFIG_DIR` set, the CLI still accesses `~/.config/anthropic/active_config`, `~/.config/anthropic/configs/default.json` and `~/.claude/state/unattended-serving-consent.json`, and tries `~/.claude/state/settings-review.json` (§3, §4).
- A sticky directory protects existing names owned by another user but lets B create every missing name; a root-owned `0555` directory refuses every tamper attempt (§6).
- Recommended read-only layout: C6 or C6s (§7). hudhud saw no extra diagnostic in any case (§2).

## 1. Setup

### 1.1 Driver

- Driven by hudhud's own adapter, not the integration harness: `connectWith` from `packages/claude-code/dist`, over `nodeHost()`.
- Two host fields were replaced: `env` came from test-support's `buildSandboxEnv` (fake key, the mock as base URL and proxy, `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`), and `homedir` was `<home>`.
- The mock was test-support's in-process `startMockServer`.
- `CLAUDE_CONFIG_DIR` was removed for the "unset" cases; for the "set" cases it came from `claudeCode.configDir`.
- The argv was the production one (`launches.log`): `--output-format=stream-json --input-format=stream-json --verbose --setting-sources=user --permission-mode=default --session-id=… --permission-prompt-tool=stdio`.
- cwd was `/proj`, a git repository owned by B. `TMPDIR` was `/tmp/b`, owned by B, mode `0700`.

### 1.2 Identities and launcher

- The worker (driver and hudhud) ran as root. The CLI ran as B.
- `binaryPath` was a root-owned launcher script, `/opt/exp2/launch.sh`. Before every launch it re-hashed the pinned CLI and refused to run on a mismatch; every launch logged the pinned hash.
- The launcher then ran `exec strace -D -f -ff -tt -y -e trace=%file,write,writev,pwrite64,ftruncate,fchmod,fchown setpriv --reuid=10001 --regid=10001 --clear-groups --no-new-privs --inh-caps=-all --bounding-set=-all -- <pinned CLI>`.
- The spawned pid is the CLI. Scenario S7 recorded `{"pid":5310,"uid":"10001","exe":"/work/hudhud/.cache/claude-cli/2.1.296/linux-x64/claude","cliPid":5310}`.
- hudhud reports `binary.unverified`, because it hashes the launcher script, not the CLI. Expected and advisory.

### 1.3 Scenarios (each one a separate CLI process)

| Scenario | What it does |
|---|---|
| S1 | A text turn |
| S2 | A Bash turn (`echo hi > /proj/f.txt`), the permission allowed by `onPermission` |
| S3 | A Bash turn producing 3 MB of output |
| S4 | Resume of S1 |
| S5 | Fork of S1 |
| S6 | `session[Symbol.asyncDispose]()` 1.5 s after the `tool.call` of `sleep 20` (`sleep` is auto-allowed, so the scenario keys on `tool.call`, seen at about 200 ms) |
| S7 | `SIGKILL` of the verified CLI pid, sent by the test after one turn |
| S9 | Mid-session change of `settings.json` by root, first in place, then by an atomic rename |
| Tamper | A separate `setpriv` shell as B tries `mv`, `rm`, `touch`, appends, `chmod`, new names and a symlink (permission checks only) |

Out of scope: anything on `/proc/<pid>/fd` of another process, and forged frames.

### 1.4 Layouts

"State dirs": `projects sessions session-env shell-snapshots todos backups statsig file-history plans debug logs cache tasks`, pre-created, owned by B, mode `0700`. "Config dirs": `agents commands skills hooks plugins output-styles`, root-owned, mode `0555`. Template `settings.json`: `{"env":{"EXP2_MARK":"v1"},"permissions":{"deny":[]}}`. Template `.claude.json`: `{"hasCompletedOnboarding":true}`.

| Case | `CLAUDE_CONFIG_DIR` | Layout |
|---|---|---|
| C0 | `<home>/cfg` | Baseline: everything owned by B; the CLI creates what it wants |
| C0u | unset | Baseline, HOME-based (`~/.claude.json` and `~/.claude/`) |
| C1 | set | C0, with `settings.json` root:root `0444` |
| C2 | set | Config root root `0555`; state dirs owned by B; `.claude.json` owned by B, `0644`; `settings.json` and `CLAUDE.md` root `0444`; HOME owned by B |
| C3 | set | C2, with `.claude.json` root `0444` |
| C4 | unset | HOME and `~/.claude` both root:B `1775` (sticky, group-writable); `~/.claude.json` owned by B, `0600`; configuration names root `0444`, config dirs root `0555`, state dirs owned by B |
| C4r | set | Config dir root:B `1775` (sticky); `.claude.json` root `0444` inside it; configuration names and dirs root-owned, state dirs owned by B; HOME owned by B |
| C4ru | unset | HOME and `~/.claude` root:B `1775` (sticky); `~/.claude.json` root `0444` |
| C5 | set | Everything read-only: HOME and config dir root `0555`, files root `0444`, no state dirs; `TMPDIR` writable |
| C6 | unset | HOME root `0555`, `~/.claude` root `0555`, `~/.claude.json` root `0444`, configuration names and dirs root-owned, only the state dirs owned by B |
| C6s | set | As C6, with the config dir `<home>/cfg` root `0555` inside a root `0555` HOME |

## 2. Results matrix

Cells show the turn outcome; for S6 and S7 the `session.terminated` event. "ok" means `completed`, then `close/closed/0`. Mock egress violations were 0 in every case.

| Case | S1 | S2 | S3 | S4 resume | S5 fork | S6 dispose mid-tool | S7 SIGKILL | S9 mid-change | Write errors (all non-fatal, silent) |
|---|---|---|---|---|---|---|---|---|---|
| C0 | ok | ok | ok (kept in `tool-results`) | ok | ok | dispose/aborted/exit 1, 91 ms | none/killed-externally/SIGKILL | re-read (v2, v3; deny applied) | none (only `ENOTEMPTY` from the cleanup `rmdir`) |
| C0u | ok | ok | ok | ok | ok | aborted, 91 ms | killed-externally | re-read | none |
| C1 | ok | ok | ok | ok | ok | aborted, 83 ms | killed-externally | re-read | none: the CLI never writes `settings.json` |
| C2 | ok | ok | ok | ok | ok | aborted, 94 ms | killed-externally | re-read | `.claude.json.lock` mkdir `EACCES`, then a fallback in-place write that succeeded; `.last-cleanup` `EACCES`; cleanup `rmdir` of empty state dirs `EACCES` |
| C3 | ok | ok | ok | ok | ok | aborted, 87 ms | killed-externally | re-read | `.claude.json` save fails in every session (lock, tmp and in-place all `EACCES`); also the C2 items |
| C4 | ok | ok | ok | ok | ok | aborted, 97 ms | killed-externally | re-read | none |
| C4r | ok | ok | ok | ok | ok | aborted, 87 ms | killed-externally | re-read | `rename(tmp → .claude.json)` `EPERM` (sticky), in-place open `EACCES`, every session |
| C4ru | ok | ok | ok | ok | ok | aborted, 88 ms | killed-externally | re-read | as C4r, in HOME |
| C5 | ok | ok | ok, but the 3 MB output was inlined into the model request (`tool-results` not writable) | `SESSION_NOT_FOUND` | `SESSION_NOT_FOUND` | aborted, 85 ms | killed-externally | re-read | `projects`, `sessions`, `session-env`, `shell-snapshots` mkdir `EACCES`; `.claude.json` save fails |
| C6 | ok | ok | ok | ok | ok | aborted, 98 ms | killed-externally | re-read | `.claude.json` save fails; `.last-cleanup` and cleanup `rmdir` `EACCES` |
| C6s | ok | ok | ok | ok | ok | aborted, 75 ms | killed-externally | re-read | as C6 |

Notes:

- hudhud saw no extra diagnostic in any case: only the usual `security.posture`, `binary.unverified`, `env.dropped` and `termination.*`.
- C5 resume and fork fail because no transcript can be written (`projects/<proj>/<id>.jsonl`).
- S7 leaves stale files (C4 tree diff, `out/C4/s7-sigkill.tree`): `sessions/<pid>.json`, `sessions/<pid>.<sha256>.key`, `/tmp/b/cc-socks/<pid>.sock`, `/tmp/b/claude-10001/fswatch-probe-*/probe`.
- With a root worker, the ladder worked across uids in every case (S6 `aborted` in 75 to 98 ms, S7 `killed-externally`), and no process of uid B was left in the container after any case.

## 3. The write set

### 3.1 Baseline (C0, C0u)

Paths are relative to `<cfg>` unless they start with `~` or `$TMPDIR`. Evidence: `out/C0/a2.txt`, `out/C0u/a2.txt`.

```
<cfg>/.claude.json            (unset: ~/.claude.json)   lock dir <file>.lock (mkdir/utimensat/rmdir), <file>.tmp.<pid>.<hex> (O_EXCL, fchmod) -> rename
<cfg>/backups/.claude.json.backup.<ms>                  (first save only)
<cfg>/.last-cleanup                                     (periodic cleanup; S9)
<cfg>/projects/<proj>/<session>.jsonl                   transcript, O_APPEND (resume/fork read it)
<cfg>/projects/<proj>/memory/                            mkdir (auto-memory dir; reported in system/init memory_paths.auto)
<cfg>/projects/<proj>/<session>/tool-results/<id>.txt    large tool output (S3)
<cfg>/sessions/<pid>.json, <pid>.<sha256>.key (tmp+rename), chmod of sessions/   removed on clean exit, stale after SIGKILL
<cfg>/session-env/<session>/                             Bash turns
<cfg>/shell-snapshots/snapshot-bash-<x>.sh               written by bash, unlinked later
$TMPDIR/claude-<uid>/fswatch-probe-<x>/probe             leftover dir every session
$TMPDIR/claude-<uid>/<proj>/<session>/tasks/<id>.output  via /proc/self/fd/<dirfd>/... (fd-relative mkdir/unlink)
$TMPDIR/claude-<hex>-cwd                                 bash writes, CLI unlinks
$TMPDIR/cc-socks/<pid>.sock                              (dir 0700)
```

- Cleanup pass (S9; `.last-cleanup` is written): `rmdir` of the empty pre-created state dirs `file-history logs plans statsig tasks todos session-env` and of empty project directories. In C4 and C4r these dirs were removed (owned by B); in C2, C3, C6 and C6s the `rmdir` failed with `EACCES` and did no harm.
- Attempted but never created in these scenarios (`ENOENT`): `jobs/pins.json.tmp.<hex>` and `~/.claude/state/settings-review.json`. The second is a HOME path even when `CLAUDE_CONFIG_DIR` is set (C0, C2 and others).
- With `CLAUDE_CONFIG_DIR` unset, `backups/` is `~/.claude/backups/`.

### 3.2 Minimal writable set (backed by C3, C6 and C6s: every scenario passes; only the optional items fail)

- Required: `projects/`, `sessions/`, `session-env/` and `shell-snapshots/` under the config dir, owned by B; a writable `$TMPDIR`.
- Required for resume and fork: `projects/` (in C5 it was missing, and resume and fork returned `SESSION_NOT_FOUND`).
- Required to keep large outputs on disk: `projects/` again, for `tool-results/`; without it the output is inlined into the context (C5 S3).
- Optional: writing `.claude.json` and creating its lock and tmp next to it; `backups/` and `.last-cleanup`; the cleanup `rmdir`s. Failures of any of these are silent (§5).
- Not separated by this experiment: in C5 the other three state dirs were missing too, and no effect beyond `projects/` was observed in these scenarios.

## 4. What is read as configuration, and when

Evidence: the "read opens" sections of `out/*/a2.txt`.

### 4.1 Read at every start

- Opened: `<cfg>/settings.json` (an `O_PATH` probe, an `O_DIRECTORY` probe returning `ENOTDIR`, then two reads); `<cfg>/CLAUDE.md`; `.claude.json` (about 19 opens per session); directory listings of `agents/`, `commands/`, `hooks/`, `output-styles/`, `skills/` and `plugins/` when they exist (C4, C6).
- Probed (`ENOENT`): `<cfg>/.credentials.json`; `plugins/{installed_plugins.json, installed_plugins_v2.json, known_marketplaces.json, known_marketplaces_claudeai.json, plugin-directory-marketplace.json, flagged-plugins.json}`; `skills/manifest.json`, `themes`, `workflows`, `plans` and `dev-mods/<uuid>`; `cache/model-catalog/masked-ids.json`.
- HOME paths accessed regardless of `CLAUDE_CONFIG_DIR`: `~/.config/anthropic/active_config`, `~/.config/anthropic/configs/default.json`, `~/.claude/state/unattended-serving-consent.json`. Also git's `~/.gitconfig` and `~/.config/git/config`, and bash's `~/.bashrc`.
- Project tier: with `--setting-sources=user`, `/proj/.claude/settings.json` and `settings.local.json` are only probed (`ENOENT`); `scheduled_tasks.json` is probed too.

### 4.2 Read during the session (S9)

- The CLI puts inotify watches on `<cfg>/settings.json` (`IN_MODIFY|IN_ATTRIB|IN_DELETE_SELF|IN_MOVE_SELF`) and on the `<cfg>` directory (`IN_CREATE|IN_MOVED_TO|…`).
- It re-reads `settings.json` about 1.0 to 1.1 s after a change, whether the change is an in-place write or an atomic rename; after a rename it re-adds the watch.
- The `env` values and the deny rules apply to the next tool call: the `printenv` turn returned v2, then v3; `echo two` and `pwd` were denied without asking `onPermission` (`asked:0`).
- This held in every case, including the root-owned and sticky layouts (C1 to C6s).
- Timing evidence (C4; `marks` in `results.json`, timeline in `trace-relevant.txt`; `<home>` substituted):

  ```
  marks {"inplace":"12:26:45.463Z","rename":"12:26:48.732Z"}
  12:26:45.111545 inotify_add_watch(12<anon_inode:inotify>, "<home>/.claude/settings.json", IN_MODIFY|IN_ATTRIB|IN_DELETE_SELF|IN_MOVE_SELF) = 3
  12:26:45.112942 inotify_add_watch(12<anon_inode:inotify>, "<home>/.claude", IN_MODIFY|IN_ATTRIB|IN_MOVED_FROM|IN_MOVED_TO|IN_CREATE|IN_DELETE|...
  12:26:46.564335 openat(AT_FDCWD</proj>, "<home>/.claude/settings.json", O_RDONLY|O_LARGEFILE|O_CLOEXEC) = 17   <- 1.1 s after in-place write
  12:26:48.736535 inotify_add_watch(12<anon_inode:inotify>, "<home>/.claude/settings.json", ...) = 5             <- re-watch after rename
  12:26:49.788173 openat(AT_FDCWD</proj>, "<home>/.claude/settings.json", O_RDONLY|O_LARGEFILE|O_CLOEXEC) = 17   <- 1.05 s after rename
  ```

  Turn starts in between show no reads, so the re-read is driven by the file watcher, not by turns.
- Consequence: a `settings.json` that the CLI's uid could rewrite would take effect mid-session. Root-owned configuration closes this; changes by the host take effect in about 1 s.
- Not tested: a mid-session change of `.claude.json`.

## 5. A failed `.claude.json` save is not fatal, and it is silent

- C2 (lock dir not creatable, file owned by B): the lock mkdir fails `EACCES`, the tmp file fails `EACCES`, and the CLI falls back to writing the file in place (`O_WRONLY|O_CREAT`, then `ftruncate`), which succeeds:

  ```
  12:25:26.837564 openat(..., "<home>/cfg/.claude.json.tmp.2912.6def9aff3999", O_WRONLY|O_CREAT|O_EXCL|...) = -1 EACCES
  12:25:26.864123 openat(..., "<home>/cfg/.claude.json", O_WRONLY|O_CREAT|O_LARGEFILE|O_CLOEXEC, 0666) = 9<<home>/cfg/.claude.json>
  ```

- C3, C6 and C6s (file root `0444` in a root `0555` dir): lock, tmp and in-place all `EACCES`, in every session:

  ```
  12:26:01.333506 mkdir("<home>/cfg/.claude.json.lock", 0777) = -1 EACCES (Permission denied)
  12:26:01.340357 openat(..., "<home>/cfg/.claude.json", O_WRONLY|O_CREAT|O_LARGEFILE|O_CLOEXEC, 0666) = -1 EACCES (Permission denied)
  ```

- C4r and C4ru (sticky dir, root-owned file): lock and tmp are created, the rename is refused `EPERM` (sticky bit), in-place gives `EACCES`, and the tmp file is unlinked:

  ```
  12:26:55.727090 openat(..., "<home>/cfg/.claude.json", O_WRONLY|O_CREAT|O_LARGEFILE|O_CLOEXEC, 0666) = -1 EACCES (Permission denied)
  12:26:55.737674 rename("<home>/cfg/.claude.json.tmp.5971.d68ac27c6161", "<home>/cfg/.claude.json") = -1 EPERM (Operation not permitted)
  ```

- Nothing on the CLI's stderr: no `Failed to save config` in any strace `write(2,…)` of the CLI; only its child tools (`rg`, `git`, `bash`) wrote to fd 2. No hudhud diagnostic; every turn completed.
- What is lost: the first-start keys the CLI adds. In C0 these are `firstStartTime`, `firstStartVersion`, `machineID`, `userID`, `migrationVersion`, the `*Migration*` flags, `seenNotifications` and `pluginUsage.*` (`out/C0/s9-midchange.claudejson-keys`). In C3, C4ru and C6 the file stayed `{"hasCompletedOnboarding":true}`. The save is retried at every launch.
- Transcripts behave the same way (C5): a failed transcript or state write is silent too; the only symptom is a later failing resume.

## 6. Tamper control (B in a separate `setpriv` shell; permission checks only)

Evidence: `out/<case>/tamper.txt`.

| Attempt | C1 (B-owned dir) | C4 (sticky, `.claude.json` owned by B) | C4r / C4ru (sticky, `.claude.json` root) | C5 / C6 / C6s (root `0555`) |
|---|---|---|---|---|
| append to `settings.json` (root `0444`) | `EACCES` | `EACCES` | `EACCES` | `EACCES` |
| `touch settings.json` | `EACCES` | `EACCES` | `EACCES` | `EACCES` |
| `mv settings.json` | succeeds | `EPERM` (sticky) | `EPERM` | `EACCES` |
| `rm CLAUDE.md` | succeeds | `EPERM` | `EPERM` | `EACCES` |
| write `agents/x.md` (root `0555` dir) | n/a (no dir) | `EACCES` | `EACCES` | `EACCES` (C6, C6s) |
| `rm -r agents/` | succeeds | `EPERM` | `EPERM` | `EACCES` (C6, C6s) |
| write `.claude.json` | succeeds | succeeds (owned by B) | `EACCES` | `EACCES` |
| `mv .claude.json` | succeeds | succeeds | `EPERM` | `EACCES` |
| create a new name (`settings.local.json`, `policy-limits.json`) | succeeds | succeeds (sticky lets B create) | succeeds | `EACCES` |
| symlink `commands-evil -> /tmp` | succeeds | succeeds | succeeds | `EACCES` |
| `chmod settings.json` | n/a (already moved) | `EPERM` | `EPERM` | `EPERM` |

The sticky bit protects existing root-owned names but lets B create every missing name. The CLI probes many missing names (§4.1: `.credentials.json`, the `plugins/*.json` files, `cache/model-catalog/masked-ids.json`, and the HOME paths `~/.config/anthropic/*` and `~/.claude/state/*`), so a sticky layout would need all of them pre-created, and that list changes with CLI versions. A root `0555` directory has no such gap: in C6 every attempt was refused.

## 7. Recommended layout for read-only configuration

C6 or C6s: every scenario passes, every tamper attempt is refused.

```
$HOME                     root:root 0555            (CLAUDE_CONFIG_DIR unset, or set to a dir inside it: C6s)
$HOME/.claude.json        root:root 0444            generated from a template (saves fail silently, non-fatal)
$HOME/.claude/  (or cfg)  root:root 0555
  settings.json, CLAUDE.md                          root:root 0444  (template)
  agents/ commands/ skills/ hooks/ plugins/ output-styles/   root:root 0555 (template content)
  projects/ sessions/ session-env/ shell-snapshots/          B:B 0700  (the minimal writable set)
  backups/ todos/ statsig/ file-history/ plans/ debug/ logs/ cache/ tasks/   optional, B:B 0700 (never needed in these scenarios)
$TMPDIR                   B:B 0700 (per uid)
```

Why:

- Nothing has to be pre-created by name: root `0555` directories refuse every new name, so a later CLI that probes a new configuration file cannot be fed one by B. Sticky layouts (C4, C4r) leave that gap open (§6).
- HOME is root `0555` too, because the CLI reads `~/.config/anthropic/*` and `~/.claude/state/*` even when `CLAUDE_CONFIG_DIR` is set.
- `.claude.json` root-owned and read-only is not fatal (§5), so B can neither rewrite user-scope `mcpServers` and `projects[...]` nor carry them into a later launch. Regenerating it from the template before each spawn is still advisable.

Costs, all silent: the `.claude.json` first-start keys are never persisted; `.last-cleanup` is not written, so the cleanup pass can repeat; the cleanup `rmdir`s of empty state dirs fail. A host that wants the CLI's own `.claude.json` state can use C4's arrangement for that one file only (owned by B, in a sticky HOME), at the price that B can create new names in HOME.

Residual: the B-writable state dirs feed back into the CLI. `projects/<proj>/<session>.jsonl` is read on resume and fork; `projects/<proj>/memory/` is the CLI's auto-memory directory (`system/init` `memory_paths.auto`; whether files placed there enter the context is UNVERIFIED, but it is a likely channel); `sessions/*.json` is read at start. A host that resumes sessions in the same sandbox should treat these as untrusted session state, not configuration.

## 8. Implications for hudhud

None of these failures surfaces to hudhud today. A host that needs to know must check the layout itself, for example that `projects/` is writable before relying on resume. [ADR-0020](../adr/0020-layout-check.md) proposes a layout check that turns these findings into diagnostics before spawn; [ADR-0019](../adr/0019-spawn-as.md) uses §1.2 and §2 for the uid split. The docs correction on HOME reads is in the [security guide](../guide/security.md#config-directory-and-bare-mode).

## 9. Not done

- Windows and macOS.
- A mid-session change of `.claude.json`.
- Whether files placed in `projects/<proj>/memory/` reach the model's context.
- Writes from features these scenarios did not use (todos, file checkpointing, plugins, jobs).
- Forged frames and anything on `/proc/<pid>/fd` of another process.

## Cleanup

Every container ran with `--rm`; the work volume and the tools image were removed after the last case. No process of uid B was left after any case. The shared Docker lock was taken with an owner file for each run and released after it. The user's own Claude Code install, config and credentials were not touched; only the pinned, hash-checked binary was executed, inside the container.
