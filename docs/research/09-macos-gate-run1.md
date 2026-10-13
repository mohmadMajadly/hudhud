# 09 — macOS gate run 1: findings and fixes (CLI 2.1.296)

Date: 2026-10-13. Workflow `macos-gate.yml`, run 38389913090, commit `e0ce6e1`, dispatched by the lead. Jobs: `gate (darwin-arm64)` on `macos-15` (arm64, Node 22.23.2) ran all seven items; `gate (darwin-x64)` on `macos-15-intel` failed while installing pnpm, before any item ran. Evidence: the uploaded `macos-gate-darwin-arm64` artifact (`summary.md`, `item-*.json`, `result.json`, `digests.json`) and the job log. Paths such as `/Users/runner/...` and `/var/folders/...` below are public GitHub runner paths.

This is the first time any hudhud code ran on macOS. Items 1, 4, 5 and 7 passed; item 3 passed for the wrong reason; items 2 and 6 failed.

---

## 0. Summary

| # | Finding | Verdict | Fix (this change) | The next gate run must show |
|---|---|---|---|---|
| 1 | Every process name parsed from `/bin/ps` started with exactly 4 spaces | **core bug** (parser) | `parsePsOutput` matches the BSD `lstart` width exactly; `stat` column added; zombies marked | raw `ps` lines in item 2 evidence; 0 rejected lines; CLI name without padding |
| 2 | Item 2 never found the Bash tool's `sleep` | **harness bug**, cause not fully proven | name matching accepts `(name)`; live (non-zombie) match; names seen are recorded | `SIGTERM run: the Bash tool runs under the CLI` passes; `descendantsSeen` shows how `sleep` is printed |
| 3 | SIGINT mid-stream: `result/error_during_execution`, then exit 0 | **real CLI behaviour** on macOS (differs from Linux) | gate records the shape; core `classifyExit` maps it to `unknown` + `PROCESS_EXITED` | `sigintShape` = `error-result` (or `no-result`), with `terminal_reason` |
| 4 | The CLI ran `security(1)` with `ANTHROPIC_API_KEY` set; the check missed it | **real CLI behaviour**; **harness bug** in the check | check sees `(security)` and zombies; evidence-only `security` shim records argv; read-only search-list probe | item 3 **fails** on its check (the ratified expectation is false) and `securityShim.argv` shows what is queried |
| 5 | Resumed sessions answered `initialize` and one `command_lifecycle` frame, then nothing for 90 s | **harness divergence** from the verified method; CLI race suspected | resume runs wait for the `initialize` response; the old write order runs once more as evidence | resume checks pass; `eagerResume` shows whether the race is real |
| 6 | `darwin-x64`: `ERR_PNPM_PNPM_ENGINE_IDENTITY_UNVERIFIABLE` | **toolchain fact**: pnpm 11 has no Intel-macOS binary | `darwin-x64` installs pnpm through Corepack (signature-verified) | `gate (darwin-x64)` reaches the items |

---

## 1. `ps` column padding (core parser)

**Observation.** Every `name` in the evidence carried exactly 4 leading spaces, for example `"    /Users/runner/work/_temp/macos-gate/cli-cache/2.1.296/darwin-arm64/claude"` (items 2, 3, 6, every session identity) and `"    (security)"` (item 3).

**Cause.** The core contract was `/bin/ps -A -o pid=,ppid=,pgid=,lstart=,comm=`. The parser expected `lstart` (24 characters, `%a %b %e %H:%M:%S %Y`) followed by one separator. macOS `ps` prints `lstart` as a left-justified column of width 28, so the date is followed by 4 padding spaces and then the separator. procps on Linux uses width 24 (the recorded Linux fixture had a single space), and the macOS fixture had been synthesized from the Linux shape. The 4-space residue in run 1 matches the width-28 layout exactly. Pids, groups and start times parsed correctly (item 2's lstart and the sweep worked), so no identity or sweep decision was wrong: the core never uses names for decisions. The gate does.

**Fix.**

- `parsePsOutput(output, dialect = 'bsd')`: the gap after the date is matched exactly (5 spaces for `bsd`, 1 for `procps`), so a name keeps its own leading spaces and nothing else. A line with any other gap is rejected.
- The `ps` contract becomes `pid=,ppid=,pgid=,stat=,lstart=,comm=` (core `os/darwin.ts`, the gate's `ps.ts`, the test-support leak table). `stat` is one token; a state starting with `Z` sets `zombie: true` on the record. `/proc/<pid>/stat` state `Z` does the same on Linux.
- Fixtures: `linux/ps.out` re-recorded with the new columns in `node:22-bookworm` (procps-ng), including a real zombie; `darwin/ps.synthesized.out` rewritten in the width-28 BSD layout with a `(security)` zombie, a name with its own leading spaces and a line with the procps gap. Property tests generate both layouts with random states and names.

**Parentheses.** macOS `ps` prints `comm` as the executable path when it can read the process's arguments (`KERN_PROCARGS2`), and otherwise as the 16-byte kernel name in parentheses, for example `(security)`. That happens for every zombie and for processes the caller may not inspect. The core keeps the name exactly as printed and marks zombies from `stat` only, never from the name. The gate's `commandName` reads `(x)` as the kernel name `x`.

**Zombies in the sweep.** A zombie holds its pid until its parent reaps it, so its identity stays valid and its pid cannot be reused. It runs nothing and ignores signals. `planSweep` therefore never signals a verified zombie by pid (new skip reason `zombie`) but still counts it as a verified group member, so a group led by an exited, unreaped shell is still signalled for its live members. The gate does not count a zombie as a survivor.

## 2. Item 2: the Bash tool was never found

**Observation.** Both `the Bash tool runs under the CLI` checks failed. The SIGTERM session nevertheless ran the tool to completion (`system/task_started`, `tool_progress`, `system/task_notification`, `user`, `assistant`, `result/success`), and the item took 183 s, which is two full 90 s polling timeouts plus the SIGINT run. So the CLI ran `sleep 45` while the harness sampled its tree every 100 ms and never matched a descendant named `sleep`.

**Cause, as far as run 1 shows.** The padding alone does not explain it: `path.posix.basename("    /bin/sleep")` is `sleep`. A `sleep` printed as a path would have matched. Two explanations remain, and run 1 recorded nothing that separates them, because the item did not record the names it saw:

1. `sleep` was printed as `(sleep)`: `ps` could not read its arguments (item 3 shows this form for every child it caught). `basename("    (sleep)")` is `    (sleep)`, which never matches.
2. `sleep` was not a descendant of the CLI's identity in the snapshot.

**Fix.** The match uses `commandName`, which accepts `(sleep)`, and requires a live (non-zombie) record. Every descendant seen is recorded (`descendantsSeen`, with `[zombie]` marks), the raw `ps` lines of the tree are recorded (`psLinesBeforeSigterm`), and a new check asserts that the CLI's own name is its path without padding. If explanation 2 holds, the next run fails again, with the evidence to show why.

## 3. Item 2: SIGINT mid-stream ends with an error result on macOS

**What the research says.** 05 §0 row 6: "Linux SIGTERM → 143, SIGHUP → 129, **SIGINT → 0** (no `result` frame)". 05 §9: "Linux SIGINT mid-stream | `assistant` partial + "[Request interrupted by user]", **no `result` frame**, process exits | **0**". Windows was not measured for SIGINT (a Windows child has no POSIX SIGINT).

**Observation (macOS arm64, CLI 2.1.296).** The signal was sent after `system/init` while the mock streamed. The frames after the signal were `assistant`, `user`, `result/error_during_execution`, `command_lifecycle`; then the CLI exited with code 0 and no signal. `stderr` was empty. Run 1 did not record `is_error` or `terminal_reason`.

**Impact on hudhud.** The exit code alone again proves nothing (05 §9). The CLI's own rule is "exit 1 when the last result had `is_error:true`" (05 §0 row 6), so code 0 after an error result means the CLI did not end on its own. Before this change `classifyExit` mapped that case to `crashed`; the plan §3.3 row for the Linux shape (code 0, turn open, no result) is `unknown`. A row is added: intent `none`, code 0, no active turn, last result `is_error` → `unknown`, nothing synthesized (the turn already settled from the CLI's result), error `PROCESS_EXITED`. A turn-machine test confirms that the error result settles the turn once (`cancelled` for an `aborted_*` reason) and that the later exit settles nothing.

**Gate change.** The check no longer requires "no result frame". It accepts no result, or exactly one error result, and records which (`sigintShape`, with `subtype`, `is_error`, `terminal_reason`). A second check runs the core `classifyExit` on the observed exit and requires `unknown` + `PROCESS_EXITED` with exactly one settlement.

## 4. Item 3: the CLI runs `security(1)` with an API key

**Observation.** With `ANTHROPIC_API_KEY` set (the `initialize` response reported `apiKeySource: "ANTHROPIC_API_KEY"`), an isolated `HOME` and `CLAUDE_CONFIG_DIR`, the samples of the CLI's tree showed the descendants `(security)` and `(git)`. The control run without any credential showed `(security)`, `(git)` and `(xcodebuild)`. Both turns completed (first frame after 174 ms), so nothing hung on the runner. `~/Library/Keychains` was not created in the isolated `HOME`.

**Why the check passed.** It compared `basename(name)` with `security`. For `"    (security)"` that is `    (security)`. The parenthesized form means `ps` could not read the process's arguments; for a short-lived child caught between its exit and its reaping, that is a zombie. The CLI therefore started `security(1)` at least once per run, regardless of the API key.

**Finding.** CLI 2.1.296 on macOS invokes `security(1)` even when `ANTHROPIC_API_KEY` is set and is the reported key source. Which keychain item it asks for is not yet known: `security` exited before any sample could read its arguments. The ratified gate expectation (ADR-0014 item 3, "confirm NO Keychain access headless") is false for this version.

**Gate change.** The check now matches `(security)` and zombies, so the next run **fails item 3** on `API key: no security(1) child at any sample`. That is the correct report; the expectation, not the check, has to change (lead decision). Added evidence:

- `security`: every sighting with time since spawn, pid, printed name and zombie state.
- `securityShim` (evidence only): a third run puts a `security` shell script first on `PATH`. It appends its arguments to a log and exits 44 (`errSecItemNotFound`) without touching any keychain. The report shows the argv, or `invoked: false` if the CLI does not resolve `security` through `PATH` (then it calls `/usr/bin/security` directly, and the shim proves nothing).
- `keychainSearchList` (evidence only): read-only `security list-keychains -d user` and `security default-keychain -d user` with the runner's `HOME`, with the sandbox `HOME`, and with the sandbox `HOME` plus `CFFIXED_USER_HOME`.

### 4.1 Implication for local macOS test runs

On a developer Mac, the real-CLI test suites would run the CLI with the developer's own login session. hudhud redirects `HOME` and `CLAUDE_CONFIG_DIR` into a sandbox, but the keychain search list is per-user state of the Security framework, not a file under `$HOME`. Run 1 shows that `security` ran and that no keychain appeared in the sandbox `HOME`, which fits the expectation that the query went to the user's real login keychain. On a developer Mac that keychain may hold real Claude Code credentials (research 01 §5: keyed by config dir). Possible effects are a credential read by the CLI under test, or a GUI permission prompt that hangs a headless test until the first-frame watchdog fires. This is an inference from run 1 plus the Security framework's design; the `keychainSearchList` probe and the shim run will confirm or refute it on the runner.

### 4.2 Mitigation proposal (not implemented)

1. **Default: real-CLI suites refuse to run on a local macOS host.** On `darwin`, the integration and real-CLI conformance suites run only on a GitHub-hosted runner (`GITHUB_ACTIONS=true` and `RUNNER_ENVIRONMENT=github-hosted`), or with an explicit, documented opt-in variable that states the keychain risk. Unit tests, which never start the CLI, stay unrestricted. This is clean, needs no OS state change, and is safe.
2. **Candidate isolation, only if the next run supports it.** If `CFFIXED_USER_HOME=<sandbox home>` gives `security` an empty or sandbox-local search list in the probe, and the shim run shows that the CLI resolves `security` through `PATH`, a later change can set `CFFIXED_USER_HOME` in the sandbox environment and gate a local opt-in on it. A `PATH` shim alone is not isolation: the CLI may call `/usr/bin/security` directly or the Security framework in process.
3. **Rejected: a throwaway keychain through `security create-keychain` plus `security list-keychains -d user -s <throwaway>`.** `list-keychains -s` rewrites the user's persistent search list. That list is shared by every process in the user's session, so the change is not scoped to the test. A crashed test leaves the developer's list modified, a concurrent app sees the substitute list, and an explicit lookup in the login keychain still reaches the real keychain. It cannot be done without touching the developer's real keychain list.

## 5. Item 6: resume answered nothing after `initialize`

**Observation.** The start run (`--session-id` not given; fresh session) completed: `control_response`, `command_lifecycle` ×2, `system/init`, `assistant`, `result/success`, `command_lifecycle`, cwd `/private/tmp/hhg-7WmZTh/work`, session `ee72f16a-…`. Both `--resume=<that id>` runs, from the canonical cwd and from the `/tmp` alias, emitted only `control_response` and one `command_lifecycle` frame, then nothing until the 90 s timeout. `stderr` was empty. The mock received no request carrying the resumed turn's text.

**Comparison with the verified method (07 §1).** In 07 §1 (Windows W90, Linux L70) every step wrote `initialize`, **waited for its response**, and only then wrote the user message (Linux a2: response at 900 ms, user message at 900 ms, `system/init` at 945 ms). The research user messages carried no `uuid`. The gate wrote the user message, with a `uuid`, immediately behind `initialize`, before any response. For a fresh session that order worked on macOS, and it is the order the start run used. The resume flag form (`--resume=<id>`), the session id (taken from `system/init`) and the cwd spelling (`/private/tmp/...`, the realpath) match the verified method. The gate waited for `result`, which is the right frame.

**Verdict.** The harness diverged from the verified method in the one respect that differs between the start run and the resume runs: the write order on a resumed session. The likely cause is a CLI race: a user message that arrives while the resumed session is still being loaded is queued (one `command_lifecycle`, presumably `queued`; run 1 did not record lifecycle states) and never started. Whether this race is macOS-only is unknown, because neither Windows nor Linux was ever tested with this write order on resume.

**Gate change.** Resume runs wait for the `initialize` response before the first user message. One extra evidence-only run repeats the run-1 order (`eagerResume`, 30 s limit). Lifecycle states are now recorded (`command_lifecycle:queued`).

**Implication for hudhud.** Until `eagerResume` shows otherwise, the session layer must not write the first user message of a resumed session before the `initialize` response, and should not do so for any session. This needs a decision for the session machine; it is not changed here.

## 6. darwin-x64: pnpm cannot be installed by `pnpm/action-setup`

**Observation.** `pnpm/action-setup` bootstrapped pnpm 11.25.0 from its committed lockfile, then ran `pnpm self-update 11.24.0` (the `packageManager` version) and failed: `[ERR_PNPM_PNPM_ENGINE_IDENTITY_UNVERIFIABLE] Cannot verify the identity of the @pnpm/exe.darwin-x64 native binary: it is missing from pnpm-lock.yaml.` The arm64 job ran the same step successfully.

**Cause.** The "pnpm-lock.yaml" in the message is not the repository lockfile. `self-update` resolves `pnpm` and `@pnpm/exe` into a separate environment lockfile under `PNPM_HOME` and verifies the npm registry signature of the native binary for the runner's platform (`verifyPnpmEngineIdentity`, read in the pnpm 11.24.0 bundle). `@pnpm/exe@11.24.0` and `@pnpm/exe@11.25.0` list optional platform packages for win-x64, win-arm64, linux-x64, linux-arm64, linuxstatic-x64, linuxstatic-arm64 and **macos-arm64 only**; `@pnpm/macos-x64` was last published as 11.0.4 (npm registry, 2026-10-13). pnpm documents that the pnpm 11 standalone build does not run on Intel Macs because of a Node.js SEA bug (pnpm issue 11423, nodejs/node 62893) and points Intel users to npm, Corepack or Homebrew. No content of the repository lockfile can fix this, and recording platform binaries there would not change what `self-update` verifies. The repository lockfile has no package-manager section at all. `ci.yml` and `nightly.yml` run no darwin-x64 job, so only the gate is affected.

**Fix.** The setup action gets an input `pnpm-installer`: `action-setup` (default, unchanged) or `corepack`. The darwin-x64 gate job uses `corepack`. `corepack enable pnpm` installs exactly the `packageManager` version of the JavaScript `pnpm` package; Corepack verifies its npm registry signature against its built-in keys. Verified locally on 2026-10-13 with Corepack 0.35.0: the install succeeds with the default keys and fails ("The package was not signed by any trusted keys") with a substituted key set. The step then checks that `pnpm --version` equals the pinned version. Corepack ships with Node 22 to 24 only, which covers the gate's Node 22. No policy is weakened: `pmOnFail`, the frozen lockfile and every supply-chain setting stay as they are.

## 7. What the next gate run must confirm

Dispatch both jobs again on a commit that contains these fixes.

1. `gate (darwin-x64)` gets past "Set up the toolchain" (Corepack path), and item 7 reports `x64`, no Rosetta.
2. Item 2: `ps: every line parses` with the `stat` column (0 rejected); `ps: the CLI name is its executable path, without column padding`; `psLinesBeforeSigterm` shows the BSD layout (`stat` width 4, `lstart` width 28). Compare these lines with `darwin/ps.synthesized.out` and replace the fixture with recorded lines if they differ.
3. Item 2: `SIGTERM run` and `SIGKILL run: the Bash tool runs under the CLI` pass. If they fail, `descendantsSeen` decides between explanations 1 and 2 of §2.
4. Item 2: `sigintShape` and its `terminal_reason`, and the classification check passes.
5. Item 3: `API key: no security(1) child` **fails**, with `security` sightings marked `[zombie]` or live. `securityShim.invoked` and `argv` show what the CLI asks the keychain for; `keychainSearchList` shows whether `HOME` or `CFFIXED_USER_HOME` changes the search list. Lead decision needed on the ADR-0014 item 3 expectation and on §4.2.
6. Item 6: all three resume checks pass with the `initialize`-first order; `eagerResumeSession` shows whether the run-1 order stalls again (`command_lifecycle:queued` and nothing else).
7. Cleanup: 0 survivors (zombies are not counted, and none should remain after the CLI exits).
