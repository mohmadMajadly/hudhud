# ADR-0020: Layout check of Claude Code's directories before spawn

- Status: Proposed (0.2.0). Not implemented.
- Date: 2026-10-18
- Negotiation log items: none (post-v1 proposal)
- Related: [ADR-0012](0012-security-defaults-and-trust.md), [ADR-0019](0019-spawn-as.md), [ADR-0011](0011-spawn-hygiene-and-binary-provenance.md), [ADR-0013](0013-testing-strategy.md)

Evidence keys: EXP-2 and Q2 as defined in [ADR-0019](0019-spawn-as.md). EXP-2 ran on Linux only (Docker `node:22-bookworm`, CLI 2.1.296, worker as root, CLI as uid and gid 10001 through `setpriv`); every behavioural fact below that is not marked otherwise is from it. Its cases: C0 and C0u (everything owned by the CLI's uid, `CLAUDE_CONFIG_DIR` set and unset), C1 (`settings.json` root 0444), C2 (config root root 0555, state directories owned by B, `.claude.json` owned by B), C3 (C2 with `.claude.json` root 0444), C4, C4r and C4ru (sticky group-writable directories), C5 (everything read-only, no state directories), C6 and C6s (HOME and the config directory root 0555, configuration root 0444, only the state directories owned by B).

## Context

A host that wants Claude Code to run with read-only configuration (the partner's sandbox, or any host using `spawnAs`, [ADR-0019](0019-spawn-as.md)) has to lay out the CLI's directories by hand, and EXP-2 found that every mistake in that layout is silent:

- No failed write surfaces. The CLI wrote nothing to its stderr when saving `.claude.json` failed (no `Failed to save config`), every turn completed, and hudhud emitted no diagnostic beyond the usual ones in any case (EXP-2 §1, §4).
- The one failure with a visible effect shows up much later: with no writable `projects/` (C5), resume and fork returned `SESSION_NOT_FOUND`, and a 3 MB tool output was sent inline in the model request instead of being kept under `tool-results/` (EXP-2 §1, §2).
- `settings.json` is watched (inotify) and re-read about 1.0 to 1.1 s after an in-place write or an atomic rename; its `env` and deny rules applied to the next tool call (EXP-2 §3, C4 timeline). A `settings.json` the CLI's uid can rewrite therefore changes the running session, not only the next one.
- A sticky directory protects existing names owned by someone else, but lets the CLI's uid create every missing name: in C4, C4r and C4ru, uid B created `settings.local.json`, `policy-limits.json` and a symlink. The CLI probes many missing names at every start (`.credentials.json`, six `plugins/*.json` files, `skills/manifest.json`, `themes`, `workflows`, `cache/model-catalog/masked-ids.json`), so a sticky layout is safe only if all of them are pre-created, and that list changes with CLI versions. A root `0555` directory refused every attempt (C5, C6, C6s; EXP-2 §5).
- `CLAUDE_CONFIG_DIR` does not cover everything: with it set, the CLI still accessed `~/.config/anthropic/active_config`, `~/.config/anthropic/configs/default.json` and `~/.claude/state/unattended-serving-consent.json`, and tried `~/.claude/state/settings-review.json` (EXP-2 §2, §3; the security guide states this since the docs correction of the same date).
- `.claude.json` is saved through a lock directory and a temporary file next to it, renamed over it, with an in-place write as fallback: the save succeeded in place when the file was writable but its directory was not (C2), failed when neither was (C3, C6, C6s), and failed when the directory was sticky and the file owned by another uid (rename `EPERM`, C4r, C4ru). A failed save is not fatal; the first-start keys (`firstStartTime`, `machineID`, `userID`, migration flags and others) are not persisted, and the save is retried at every launch (EXP-2 §4).
- The minimal writable set for all of EXP-2's scenarios (text, Bash, 3 MB output, resume, fork, dispose, `SIGKILL`, live settings change): `projects/`, `sessions/`, `session-env/` and `shell-snapshots/` in the config directory, owned by the CLI's uid, and a writable `TMPDIR` (EXP-2 §2). In C5, without the four directories, only resume, fork and the on-disk tool results failed; no effect of the missing `sessions/`, `session-env/` or `shell-snapshots/` was observed in those scenarios.

The recommended layout is EXP-2's C6 (or C6s with `CLAUDE_CONFIG_DIR` inside HOME): HOME, the config directory and the configuration directories root-owned `0555`, `settings.json`, `CLAUDE.md` and `.claude.json` root-owned `0444`, and only the four state directories and `TMPDIR` owned by the CLI's uid, mode `0700`. Sticky directories (C4, C4r) are not recommended. hudhud never creates or changes this layout (R6, ADR-0012 §1); it can only tell the host what it got wrong before the CLI starts.

## Decision

### 1. Option and composition with `spawnAs`

A session option, harness-namespaced and `@beta`:

```ts
claudeCode: { layoutCheck?: 'off' | 'warn' | 'enforce' }
```

- `'off'`: nothing is checked.
- `'warn'`: every finding is emitted as a diagnostic (§3) before spawn; the session starts regardless.
- `'enforce'`: as `'warn'`, and a finding of severity `error` refuses the session before anything is spawned, with `LAYOUT_CHECK_FAILED` (new code, `retryable: false`: the layout is the application's input; `details.findings` lists at most 50 findings as `{ code, path }`, `details.truncated` when more).
- Default: `'off'` without `spawnAs`; `'warn'` when the Harness was connected with `spawnAs`. An explicit `'off'` under `spawnAs` deviates and appears in the posture. Whether the `spawnAs` default should be `'enforce'` is an open question; `'warn'` is proposed so that a host with an ACL-based layout the mode-bit evaluator misreads (§5) is not refused by default.
- The check runs at every spawn of a session (create, resume, fork), after options validation and the environment assembly, after the `spawnAs` checks of [ADR-0019](0019-spawn-as.md) §3 and before the spawn. Its paths come from the session's final child environment: `HOME`; the config directory `C` is `claudeCode.configDir` (`CLAUDE_CONFIG_DIR`) when set, else `$HOME/.claude`; the global config file `G` is `C/.claude.json` when `CLAUDE_CONFIG_DIR` is set, else `$HOME/.claude.json` (Q2 §3.1 from the 2.1.296 strings; research 01 §4.1); the temporary directory is `CLAUDE_CODE_TMPDIR` when set, else `TMPDIR`, else `/tmp` (the precedence is UNVERIFIED; EXP-2 set `TMPDIR` only).
- The subject (the "CLI's uid"): under `spawnAs`, (`uid`, `gid`) with no supplementary groups, which [ADR-0019](0019-spawn-as.md) §4 verifies after spawn. Without it, the host's effective uid, gid and supplementary groups; then every configuration file the host can write is writable by the CLI by construction, so the writability findings (§3, codes 3 to 6) are replaced by one `layout.same-uid` finding of severity `info`, and only the usability and save findings remain meaningful.
- A standalone entry, `checkClaudeCodeLayout({ env, configDir, spawnAs })` (`@beta`, `@hudhudjs/claude-code`), returns the same findings without a Harness, so a host can run it when it builds the sandbox image.

### 2. How the check reads the file system

- `lstat` on each path component from `/` (never following a symlink silently: a link is evaluated as an entry of its directory, then its target is evaluated too), `readdir` of the configuration directories with a bound (depth 4, 10 000 entries, 2 s; beyond it `layout.scan-truncated`, severity `warning`), and on Linux one read of `/proc/self/mountinfo` to detect read-only mounts. Nothing is opened for reading content, nothing is written (R6).
- Writable by the subject: subject uid 0 means writable unless the mount is read-only; otherwise the owner bits if the subject owns the file, else the group bits if the file's group is one of the subject's groups, else the other bits; and never on a read-only mount.
- Replaceable (rename or unlink of an existing name): its directory is writable by the subject and not (the directory is sticky and neither the name nor the directory is owned by the subject).
- Creatable (a missing name): its directory is writable by the subject; the sticky bit does not prevent creation (EXP-2 §5).
- A path the host cannot `lstat` (`EACCES`) gives `layout.unverifiable` (severity `warning`) for that path; the check never reports a path as safe that it could not read.

### 3. Findings

Each finding is one `diagnostic` event, `code` below, `data`: `severity` (`'info' | 'warning' | 'error'`), `path` written relative to a symbolic root (`<home>/…`, `<config>/…`, `<tmp>/…`, never the expanded path, so no user name reaches an event), `problem`, and `cliVersionBasis: '2.1.296'` for findings that rest on EXP-2's name lists. Diagnostics carry no severity field today; `data.severity` is additive (ADR-0005).

| # | Code | When | Severity |
|---|---|---|---|
| 1 | `layout.state-dir-unusable` | One of `<config>/projects`, `sessions`, `session-env`, `shell-snapshots` is missing and not creatable, is not a directory, is not writable and searchable by the subject, or is on a read-only mount (`problem`: `missing`, `not-a-directory`, `not-writable`, `read-only-mount`) | `error` for `projects` (resume and fork fail with `SESSION_NOT_FOUND`, large tool output goes inline, EXP-2 C5); `warning` for the other three (the CLI tries them every session; no effect was observed in EXP-2's scenarios) |
| 2 | `layout.tmpdir-unusable` | The temporary directory is missing, not a directory, or not writable and searchable by the subject; under `spawnAs` also when it is not owned by the subject or has any group or other permission bit (`problem`: `…`, `not-private`) | `error` for the first three (EXP-2 lists a writable `TMPDIR` as required; the failure shape without one was not measured, UNVERIFIED); `warning` for `not-private` |
| 3 | `layout.config-writable` | Under `spawnAs`: a configuration name is writable or replaceable by the subject, or missing and creatable, and the cause is not a sticky directory (code 4). Names: HOME itself, `<config>` itself, `settings.json`, `CLAUDE.md`, the directories `agents`, `commands`, `skills`, `hooks`, `plugins`, `output-styles` and their entries, and the names the CLI probes when missing: `.credentials.json`, `plugins/installed_plugins.json`, `plugins/installed_plugins_v2.json`, `plugins/known_marketplaces.json`, `plugins/known_marketplaces_claudeai.json`, `plugins/plugin-directory-marketplace.json`, `plugins/flagged-plugins.json`, `skills/manifest.json`, `themes`, `workflows` | `error` (`settings.json` is re-read about 1 s after a change and applies to the next tool call; the others are read at every start, EXP-2 §3) |
| 4 | `layout.sticky-allows-new-names` | Under `spawnAs`: a directory of the configuration set (HOME, `<config>`, the configuration directories, the HOME paths of code 5) is sticky and writable by the subject: existing names owned by another uid are protected, every missing name can be created (`data.missingProbedNames`: the count of code 3's probed names that are absent) | `error` (EXP-2 §5: uid B created new names in C4, C4r and C4ru; the remedy is a root `0555` directory, C6) |
| 5 | `layout.home-config-outside-config-dir` | Always: the HOME paths the CLI reads whatever `CLAUDE_CONFIG_DIR` says, `<home>/.config/anthropic/active_config`, `<home>/.config/anthropic/configs/default.json`, `<home>/.claude/state/unattended-serving-consent.json` and `<home>/.claude/state/settings-review.json`, each with `exists`. Under `spawnAs`, also whether any of them, or a missing ancestor, is writable, replaceable or creatable by the subject (`problem: 'writable'`) | `info` (`exists` only, and with `claudeCode.configDir` set: the reminder that the config directory does not isolate these); `error` under `spawnAs` when writable |
| 6 | `layout.global-config-writable` | Under `spawnAs`: `G` is writable or replaceable by the subject | `warning`: the CLI's uid can change user-scope `mcpServers` and `projects[…]` entries (allowed tools, the trust flag) for the next launch with the same HOME (Q2 §3.3); the mitigation is to regenerate `G` from a template before every spawn, resume included. Whether a mid-session change of `G` takes effect was not tested (EXP-2 §3, UNVERIFIED) |
| 7 | `layout.global-config-save-will-fail` | `G` exists, is not writable by the subject, and its directory is not writable by the subject or is sticky with `G` owned by another uid; or `G` is missing and not creatable | `info` when `G` exists (expected in the recommended layout: silent, not fatal, first-start keys not persisted, retried every launch, EXP-2 §4); `warning` when `G` is missing and not creatable (not measured, UNVERIFIED) |
| 8 | `layout.same-uid` | No `spawnAs`: the writability findings 3, 4, 6 and the writable part of 5 do not apply | `info` |
| 9 | `layout.unverifiable`, `layout.scan-truncated` | §2 | `warning` |

Severity rule: `error` means EXP-2 measured the failure or the tamper path that the finding predicts; `warning` means a degradation or an unmeasured prediction; `info` is expected and harmless. Only `error` refuses under `'enforce'`.

The name lists in codes 1, 3, 5 and 7 are facts about CLI 2.1.296 on Linux. They live in one committed module next to the digest table, keyed by the tested version window, and a bump of the pinned CLI must re-confirm them (§6). A CLI outside the tested window still runs the check with the newest list, and the findings carry the list's `cliVersionBasis`.

### 4. Per OS

- Linux: everything above.
- macOS: `spawnAs` is refused there ([ADR-0019](0019-spawn-as.md) §1), so only the same-uid findings apply (1, 2, 5 with `exists`, 7, 8, 9). macOS ACLs are not evaluated and there is no `/proc/self/mountinfo`, so read-only mounts are not detected. The HOME paths of code 5 were measured on Linux only; on macOS the finding carries `measured: false`.
- Windows: `layoutCheck` other than `'off'` fails with `CAPABILITY_UNSUPPORTED` (`details.capability: 'claudeCode.layoutCheck'`, `details.reason: 'platform'`). There is no uid to evaluate, writability is decided by ACLs, and Node's `fs.access` does not check ACLs (Node documentation of `fs.access`), so a mode-bit evaluator would report wrong answers; probing by writing is excluded by R6. A Windows design is an open question.

### 5. Limits (stated in the docs as they are here)

The layout check is advisory. It is a linter for the host's layout, not a guarantee, and the docs say so where they present it:

- Time of check to time of use: the file system can change between the check and the CLI's reads, and during the session (the CLI re-reads `settings.json` live). Only the file system's own permissions enforce anything.
- Mode bits only: POSIX ACLs (Node cannot read the `system.posix_acl_access` attribute without native code), LSM policy (SELinux, AppArmor), immutable or append-only attributes, idmapped and overlay mounts, NFS root squashing and masked paths are not evaluated. An ACL that grants the subject write access is a false negative of codes 3 to 6; one that denies it is a false positive of codes 1 and 2.
- The subject's capabilities are assumed to be none under `spawnAs`, which [ADR-0019](0019-spawn-as.md) §4 verifies only after spawn; without `spawnAs`, a root CLI can write everything, and the check says so through `layout.same-uid`.
- The name lists are the measured ones for one CLI version; a newer CLI may read or write names the lists lack until the next bump confirms them.
- State that the CLI's uid writes and later reads (transcripts read on resume and fork, `projects/<proj>/memory/`, `sessions/*.json`) is not configuration and is not checked; it is untrusted session state (EXP-2 §6), an open question.

### 6. Tests

- Unit (all OSes): path derivation (`configDir` set and unset, `G`'s location, the temporary-directory precedence); the writable, replaceable and creatable evaluator against a truth table (owner, group, other, sticky, subject root, read-only mount); each finding against a fake file system; the severity mapping; the default mode with and without `spawnAs`; `'enforce'` refusing with `LAYOUT_CHECK_FAILED` and its `details`; the Windows refusal; the macOS subset; the symbolic path roots (no expanded path in any event; the privacy scan covers fixtures).
- Property (fast-check): generated directory trees with random owners, groups, modes and sticky bits, checked against an oracle that simulates what the subject can do (write, create, rename, unlink, symlink; the operations of EXP-2 §5): a code 3, 4, 5 or 6 finding is reported for a configuration name exactly when the oracle can tamper with it.
- Conformance: the new diagnostic shapes in the committed event schema; the loopback replay round-trips them.
- Integration, Linux, in the uid-split Docker lane of [ADR-0019](0019-spawn-as.md) §8: the EXP-2 layouts C0, C1, C2, C3, C4, C4r, C5, C6 and C6s are built as fixtures and the check's findings are asserted for each (C6 and C6s: only codes 5 and 7 as `info`; C4 and C4r: code 4; C1: code 3 for the config directory; C5: code 1 `error` for `projects`). Each prediction is then tied to behaviour with the pinned CLI under `'warn'`: in C5 a resume fails with `SESSION_NOT_FOUND`; in C3 `G`'s key paths are unchanged after a session; and for every tamper finding a uid-B shell performs the predicted operation successfully, while in C6 every operation of EXP-2 §5 fails. No `strace` is needed in the lane.
- Integration, same-uid, Linux and macOS jobs: the integration sandbox's own layout yields no `error` finding; Windows runs the refusal test only.
- Canary: the nightly runs the C5 and C6 cases against the newest CLI, so a change of the minimal writable set (a new required directory) shows up as a prediction that no longer matches behaviour. A new HOME path read by a newer CLI is not detectable this way (it needs a syscall trace); that is an open question.

## Alternatives considered

- Documentation only (a guide section with the recommended layout). Not chosen alone: EXP-2 showed that every layout mistake is silent, and the guide cannot see the host's file system. The guide section is written anyway, with the check.
- hudhud builds the layout itself (creating the state directories, chmod of the configuration). Rejected: hudhud never writes Claude Code's directories (R6, ADR-0012 §1), and a library changing ownership in a sandbox it does not own is the wrong layer.
- Probing writability by writing a temporary file as the subject. Rejected: it writes into the harness's directories (R6) and needs a process of the subject's uid before the session's own.
- Checking after the session from the CLI's behaviour (for example, watching for a missing transcript). Rejected: the failures are silent by design of the CLI (EXP-2 §4); prediction before spawn is the only point where hudhud can speak.
- Enforcing by default for every session. Rejected: without `spawnAs` most findings do not apply, and a same-uid host with a normal layout gains nothing from refusals.

## Consequences

- One new error code (`LAYOUT_CHECK_FAILED`), additive (ADR-0005), and new diagnostic codes with `data.severity`.
- A per-version name list joins the version-bump checklist next to the digest table.
- A session with the check pays a few dozen `lstat` calls and one bounded directory walk before spawn.
- Acceptance conditions: the EXP-2 report committed under `docs/research/` (shared with [ADR-0019](0019-spawn-as.md)); the guide section "Running Claude Code with read-only configuration" written from EXP-2 §6.

## Evidence

- EXP-2 (2026-10-18, CLI 2.1.296, Linux): §1 results matrix, §2 write set and minimal writable set, §3 read set (HOME paths, live re-read of `settings.json`, C4 timeline), §4 `.claude.json` save failures, §5 tamper table, §6 recommended layout and its costs.
- Q2 §3.1 (`.claude.json` and `settings.json` locations from the 2.1.296 strings), §3.3 (`.claude.json` as configuration and state), §3.4 (the sticky-layout proposal that EXP-2 then refuted for missing names).
- Repository: ADR-0012 §1 (never-write posture, R6), [docs/guide/security.md](../guide/security.md) (config directory and HOME reads), `packages/claude-code/src/env.ts` (the `'harness'` preset passes `HOME`).
