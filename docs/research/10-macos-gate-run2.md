# 10 — macOS gate run 2: findings and fixes (CLI 2.1.296)

Date: 2026-10-13. Workflow `macos-gate.yml`, run 38430627507, commit `1da35d5` (waves 0 to 3 merged), dispatched by the lead. Both jobs ran all seven items: `gate (darwin-arm64)` on `macos-15` (arm64, Node 22.23.2) and `gate (darwin-x64)` on `macos-15-intel` (x64, Node 22.23.2, pnpm through Corepack). Evidence: the uploaded artifacts `macos-gate-darwin-arm64` and `macos-gate-darwin-x64` (`summary.md`, `item-*.json`, `result.json`, `digests.json`) and the job logs. Paths such as `/Users/runner/...`, `/var/folders/...` and `/private/tmp/hhg-...` are public GitHub runner paths.

On both architectures items 1, 2, 4, 5 and 7 passed, and items 3 and 6 failed. The two architectures failed the same checks in the same way.

---

## 0. Summary

| # | Finding | Verdict | Fix (this change) | Round 3 must show |
|---|---|---|---|---|
| 1 | Item 3 failed only on `API key: no security(1) child at any sample (no Keychain access)` | **gate verdict bug**: ADR-0014 amendment 5 changed item 3 to "Keychain access recorded", but the check still required absence | the check records the access (and fails only if the tree was never sampled); the search-list probes must all run, and the `CFFIXED_USER_HOME` verdict is computed and reported | item 3 passes on both architectures with the access recorded and the isolation verdict stated |
| 2 | Item 6: every resumed session answered `control_response` and `command_lifecycle:completed`, then nothing (90 s, 90 s, 30 s) | **gate harness bug**: every CLI process numbered its user-message `uuid`s from 1, so each resume re-sent the start run's `uuid`, and the CLI drops a message whose `uuid` the resumed transcript already holds | fresh random `uuid` per user message (`GateHost.uuid`); an evidence-only run reproduces the drop on macOS; a dropped message ends the wait at once | the three resume checks pass; `duplicateUuidResume.dropped` is `true`; `eagerResume.ok` is `true` |
| 3 | The run-1 explanation of item 6 (a write-order race on resume) | **refuted** on Linux: the eager order works with a fresh `uuid`, and the `initialize`-first order fails with a reused one | no product change; the session-machine rule stays (see §6) | `eagerResume` passes on macOS |
| 4 | Round-1 fixes (x64 setup, BSD `ps`, item 2 descendants, `sigintShape`) | **confirmed** on both architectures (§4) | recorded `ps` lines committed as core fixtures | nothing new |
| 5 | darwin binary digests and the signing Team ID | recorded by the gate, consistent across npm, the SDK manifest and both runners (§5) | none (not added to `KNOWN_BINARIES`; lead decision) | the same values |

## 1. Run facts

From the job logs (`Run the seven gate items`):

| Item | darwin-arm64 | darwin-x64 |
|---|---|---|
| 1 Binary provenance | pass, 717 ms | pass, 3373 ms |
| 2 Process tree | pass, 8895 ms | pass, 15214 ms |
| 3 Keychain | **fail**, 1449 ms | **fail**, 6983 ms |
| 4 zsh login-shell snapshot hang | pass, 136545 ms | pass, 140583 ms |
| 5 Socket path | pass, 1011 ms | pass, 3148 ms |
| 6 Path identity | **fail**, 211849 ms | **fail**, 214033 ms |
| 7 CI runner | pass, 901 ms | pass (x64, kernel `x86_64`, `proc_translated=n/a`) |

Cleanup: `0 signalled, 0 survivors` on both runners.

## 2. Item 3: the check did not follow the amended ADR

### 2.1 Evidence

`summary.md`, both architectures:

```text
| 3 | Keychain | fail | API key: no security(1) child at any sample (no Keychain access) |
```

Every other check of the item passed: first frame after 195 ms (arm64) and 716 ms (x64), `apiKeySource` `ANTHROPIC_API_KEY`, `result/success`, no egress violation, the control run ended, nothing survived. The failing check's detail lists the descendants seen: `(security), (git), (xcodebuild), (claude), (sh)` (arm64) and `(security), (git), (xcodebuild), <defunct> [zombie]` (x64). `item-3-keychain.json` records two `security` children per run, live when sampled (arm64: pids 1603 and 1604 at 86 ms after the spawn; x64: first at 163 ms; control run: 39 ms).

### 2.2 Cause

ADR-0014 item 3 since amendment 5 (W3-Z ruling 10): "record the Keychain access headless (...) and run the `PATH` shim and keychain search-list probes; isolation counts as possible only if the `CFFIXED_USER_HOME` probe proves it." The ADR does not ask for the absence of access any more. W3-Z changed the ADR, research 09 §8 and the test-support launcher policy, but not `tooling/macos-gate/src/items/keychain.ts`: its last change is the round-1 commit `1990e2f`, which made the absence check catch `(security)` on purpose ("the next run fails item 3 (...) the expectation, not the check, has to change", research 09 §4). The expectation changed; the check did not. Item 3 is therefore not designed to fail on observed access, and the failure is a gate verdict bug.

### 2.3 Fix

- The absence check is replaced by `API key: Keychain access recorded (the tree was sampled from the spawn to the result)`. It passes when the CLI's tree was sampled at least once while the CLI ran, and its detail states the access (`security(1) seen 2x, first at 86 ms after the spawn (n samples)`, or `no security(1) child in n samples`). A run whose tree was never sampled (spawn failure, unknown identity) recorded nothing and fails.
- New check `search-list probes: every read-only query ran`: all six `security list-keychains -d user` / `default-keychain -d user` probes must have run (a timeout or a spawn error fails it). Its detail carries the isolation verdict.
- New evidence `keychainIsolation` from `searchListIsolation`: per environment `isolated`, `not-isolated` or `inconclusive`. `inconclusive` when the runner-`HOME` baseline lists no keychain (an empty list elsewhere would then prove nothing) or a probe did not run; `not-isolated` when a probe names a keychain outside the sandbox `HOME`; `isolated` otherwise. `proven` is the `CFFIXED_USER_HOME` verdict, as the ADR words it. The scope is stated in the evidence: the user search list and default keychain of `security(1)` only, not an in-process Security framework call or an explicit keychain path.
- Unchanged: first-frame watchdog, key source, turn completion, control run with the stall classifier, shim run, egress and survivor checks.

This does not weaken the item: the item is what ADR-0014 ratified, and the new checks fail on missing evidence where the old check could not.

### 2.4 Keychain findings (evidence-only runs)

- **What the CLI asks for.** The shim run (`security` first on `PATH`, exit 44 "not found") was invoked, so CLI 2.1.296 resolves `security` through `PATH`. `securityShim.argv` on both architectures:

  ```text
  [find-generic-password][-a][runner][-w][-s][Claude Code-credentials-4972dce4]
  [find-generic-password][-a][runner][-w][-s][Claude Code-4972dce4]
  ```

  With `ANTHROPIC_API_KEY` set and reported as the key source, the CLI still reads two generic passwords with `-w` (print the secret): the OAuth credentials item and the API-key item, account `$USER`, service name suffixed with a hash of the config directory (research 01 §5, "keyed by config dir", confirmed). The turn then completed normally (`result: success`).
- **Search list.** Runner `HOME`: `"/Users/runner/Library/Keychains/login.keychain-db"` for both `list-keychains -d user` and `default-keychain -d user`. Sandbox `HOME`: empty list, and `default-keychain` exits 1 with `SecKeychainCopyDomainDefault user: A default keychain could not be found.` Sandbox `HOME` plus `CFFIXED_USER_HOME`: identical to sandbox `HOME` alone.
- **Did `CFFIXED_USER_HOME` isolate the Keychain?** For the scope the probe can see, the sandbox is isolated, but `CFFIXED_USER_HOME` is not what isolates it: the user search list of `security(1)` follows `HOME`, and adding `CFFIXED_USER_HOME` changed nothing. Under the new verdict both environments are `isolated` and `proven` is `true`. The gate already gives every CLI run the sandbox `HOME`, so the `security` children the CLI started in this run searched an empty user list. What the probe cannot show: the common and system domains (`-d user` only), an explicit keychain path, and an in-process Security framework lookup by the CLI. A probe that settles this needs a known item in the runner's login keychain (see §7, decision 4).
- `~/Library/Keychains` was not created in the sandbox `HOME` (`keychainsDirInIsolatedHome: null`).

## 3. Item 6: resumed sessions dropped a re-used user-message uuid

### 3.1 Evidence

`item-6-path-identity.json`, both architectures. The start run completed:

```text
control_response, command_lifecycle:queued, command_lifecycle:started, system/init, assistant, result/success, command_lifecycle:completed
```

All three `--resume=<id>` runs (canonical cwd, `/tmp` alias, eager order) recorded exactly:

```text
"frames": ["control_response", "command_lifecycle:completed"], "frameCount": 2, "stderrTail": ""
```

The resume checks failed with `undefined`, `0 messages` and `cwd undefined`: no `system/init` and no request to the mock. Timing (arm64 start times from the session identities): resume pid 3969 at 1791909015, alias pid 5809 at 1791909105, eager pid 7902 at 1791909196, item end 30 s later. That is 90 s + 90 s + 30 s plus about 2 s of start run: the full `TURN_MS` (90 000) twice and `EAGER_RESUME_MS` (30 000) once, so the harness waited the whole limit for a `result` that never came, three times. x64 shows the same (214033 ms). The CLI exited on EOF each time; nothing survived.

Unlike run 1, run 2 recorded the lifecycle state: the single frame is `completed`, not `queued`. Research 09 §5 had guessed `queued` (a message held while the resumed session loaded). A message that is `completed` without `queued` or `started` was never run.

### 3.2 What was the same in all three resumes

The run-1 fix made the canonical and alias resumes wait for the `initialize` response, and only the eager run kept the old order; all three failed alike, so the write order was not the cause. The one property common to all three is the user message's `uuid`: `CliSession.user` numbered messages per process (`00000000-0000-4000-8000-000000000001` for the first message of every process). The start run wrote that `uuid` into the session transcript, and every resume re-sent it.

### 3.3 Reproduction on Linux (pinned CLI 2.1.296)

Container `node:22-bookworm`, the pinned `linux-x64` binary fetched with `pnpm cli:fetch` (sha256 `24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de`, size 257068216), the test-support mock with its egress trap, an isolated `HOME`, `CLAUDE_CONFIG_DIR` and `TMPDIR`, a fake key, the gate's session flags. One start session, then resumes of it in this order (times in ms after the spawn; `cl` = `command_lifecycle`, the suffix is the `uuid`'s last 4 digits):

| Run | `uuid` | First write | Frames | Result |
|---|---|---|---|---|
| start | `…0001` | after the `initialize` response | 253 `control_response`, 264 `cl:queued:0001`, 266 `cl:started:0001`, 292 `system/init`, 375 `assistant`, 386 `result/success`, 388 `cl:completed:0001` | success |
| resume, same `uuid` | `…0001` | after the response | 202 `control_response`, 213 `cl:completed:0001` | **none within 20 s** |
| resume, fresh `uuid` | `…0002` | after the response | `control_response`, `cl:queued`, `cl:started`, `system/init`, `assistant`, `result/success` (322), `cl:completed` | success |
| resume, no `uuid` | none | after the response | `control_response`, `system/init`, `assistant`, `result/success` (322) | success |
| resume, fresh `uuid`, eager | `…0003` | right behind `initialize` | `control_response`, `cl:queued`, `cl:started`, `system/init`, `assistant`, `result/success` (283), `cl:completed` | success |
| resume, same `uuid`, eager | `…0001` | right behind `initialize` | 216 `control_response`, 221 `cl:completed:0001` | **none within 20 s** |
| new session, `uuid` reused from the other session | `…0001` | after the response | full turn | success |

Every process exited 0 on EOF; the mock recorded 5 requests and no egress violation. The macOS frames of §3.1 match the "same `uuid`" rows exactly.

**Conclusion.** CLI 2.1.296 drops a user message whose `uuid` is already in the transcript of the session it resumed, on every platform measured (Linux here, macOS arm64 and x64 in gate runs 1 and 2). It answers `command_lifecycle` `completed` for that `uuid` immediately, starts no turn, writes no `system/init` and no `result`, and then waits for more input. The `uuid` space is per session transcript, not global (the last row). The write order does not matter (the eager rows). Research 09 §5's "CLI race" is refuted; the harness was at fault in both runs. Research 07 §1 never saw this because its user messages carried no `uuid`, and the recorded resume fixtures (`packages/claude-code/conformance/resume`, `fork`) send the resumed message without one.

### 3.4 Fix (gate harness)

- `GateHost.uuid()`: `crypto.randomUUID()` in the host wrapper, a run-wide counter in the simulated host. `CliSession.user` uses it for every message and returns the `uuid`.
- `CliSession.lifecycle(uuid)` returns the lifecycle states of a message; item 6 records them per run and puts them in the resume check's detail (`session …, result/success, lifecycle [queued, started, completed]`).
- The turn wait of item 6 also ends when the message ended without starting (`completed` or `cancelled` and no `started`). A dropped message then fails the checks at once instead of after 90 s. The limits are unchanged; the success path still waits for the `result` frame.
- New evidence-only run `duplicateUuidResume`: a resume that re-sends the start run's `uuid` on purpose, with `dropped: true` when it ends as above. It confirms the cause on macOS without failing the gate.
- The eager-order evidence run stays and now uses a fresh `uuid`; it shows whether the write order matters on macOS.
- The simulated CLI drops a repeated `uuid` per session transcript, as measured. A unit test replays the run-2 shape (one `uuid` for every message): the three resume checks fail with `lifecycle [completed]` within a fraction of the old time.

### 3.5 Product impact

- The binding contract already requires a fresh random UUID for every `cmd.send` ("never reused, never chosen by the application", `CommandInput` in `packages/core/src/protocol/machine/contract.ts`), so a correct binding cannot trigger the drop. ADR-0008 item 4 now records the fact and why the uniqueness must hold across the whole transcript, including earlier processes of a resumed session.
- No product code changed. Two things are left for the lead (§7, decisions 2 and 3).

## 4. Round-1 fixes

| Round-1 fix (research 09) | Status | Evidence |
|---|---|---|
| darwin-x64 setup through Corepack | **confirmed** | x64 log: `pnpm-installer: corepack`, step "Install pnpm through Corepack (signature-verified, version from "packageManager")", the `pnpm --version` equality test passed, `Done in 37.2s using pnpm v11.24.0`; item 7 reports `x64`, kernel `x86_64`, binary `x86_64` |
| BSD `ps` `lstart`/`stat` parsing | **confirmed** | `ps: every line parses`: 0 rejected of 431 (arm64) and 455 (x64); the CLI's name is its path without padding; `psLinesBeforeSigterm` shows `stat` width 4 (`S<  `, `S<s `, `R<  `) and `lstart` width 28, exactly the layout of `darwin/ps.synthesized.out`; the lines are now committed as `darwin/ps.recorded-arm64.out` and `ps.recorded-x64.out` with a parser test |
| Item 2 descendants | **confirmed** | `SIGTERM run` and `SIGKILL run: the Bash tool runs under the CLI` pass; the raw lines print the tool as a bare `sleep` (not a path, not `(sleep)`), so in run 1 the name was `"    sleep"` and the 4-space padding alone explained the miss (research 09 §2 had ruled the padding out on the assumption of a path); the tool's shell leads its own group (`sleep pgid 1507, CLI pgid 948, leader /bin/zsh`) |
| `sigintShape` and the exit classification | **confirmed** | both architectures: `{"shape": "error-result", "results": [{"subtype": "error_during_execution", "is_error": true, "terminal_reason": "aborted_streaming"}]}`, exit `{"code":0,"signal":null}`, classification `{"outcome":"unknown","turnSynthesis":"none","error":"PROCESS_EXITED"}` |
| Keychain probes | **ran**; verdict logic was missing (§2) | shim invoked with the argv of §2.4; search list follows `HOME`, `CFFIXED_USER_HOME` adds nothing |
| Resume ordering (`initialize` first) | **not the cause** (§3) | the `initialize`-first resumes failed exactly like the eager one; the reused `uuid` is the cause |

## 5. Binary digests and Team ID

Recorded by item 1 (`digests.json`, `item-1-provenance.json`); `pinStatus: "recorded"` because `tooling/cli-pin.json` marks both darwin platforms `pendingGate`. Both runners fetched and recorded identical values, and item 1 checked each against the npm `integrity` and the `manifest.json` of `@anthropic-ai/claude-agent-sdk@0.3.296` (`sdkIntegrity sha512-Y+cZ2BT8X94mQ9GJOVyIqhjC/nWGvwozUVLjdkzX7aSt+zuo5tgk7Hdv9V7tEUQ9fKnEuiL6moYNWDeHqCD4Lw==`):

| Platform | Package | npm integrity | sha256 of `claude` | Size |
|---|---|---|---|---|
| darwin-arm64 | `@anthropic-ai/claude-code-darwin-arm64@2.1.296` | `sha512-vqtx3kS3r1hNLMk+N8JMG5J4kcLHIbI3t/NSIdcFQZrRVCFA6NtcxJyn/B+Sf3GxJaFJOCEfoBQXsFo10+Oj9A==` | `c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937` | 240664432 |
| darwin-x64 | `@anthropic-ai/claude-code-darwin-x64@2.1.296` | `sha512-yCJe1vp7juHg3xVyk0Ts8b+mcEylCo6aINg7yC7r1eI8BKfm1DT15htxl1riz3y+B1FV25emIK90d7rH+zFjLA==` | `a6bf4f30be241053a923f3820ad23c5991d2f5ac2935b3a8dd64da218d9cc603` | 249194752 |

Code signature (`codesign -dv`, both binaries; `codesign --verify --strict` accepted both): `Identifier=com.anthropic.claude-code`, `Authority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)`, `Developer ID Certification Authority`, `Apple Root CA`, **`TeamIdentifier=Q6L2SF6YDW`**, `Runtime Version=26.5.0`, timestamps `Oct 9, 2026 at 2:33:24 PM` (arm64) and `2:33:29 PM` (x64), formats `Mach-O thin (arm64)` and `Mach-O thin (x86_64)`.

Not added to `KNOWN_BINARIES`, `cli-pin.json` or `CLAUDE_CODE_PUBLISHER.darwinTeamId` (lead decision, §7).

## 6. Session-machine rule

W3-Z ruling 3 (research 09 §8) made the session machine hold every command until the `initialize` response in all modes, because research 09 §5 suspected a write-order race on resume. §3.3 refutes that motivation: the eager order resumes correctly with a fresh `uuid`. The rule still matches the verified method of research 07 §1 and costs only the `initialize` round trip that hudhud pays anyway (ADR-0008 item 2), so this change leaves it in place.

## 7. Open decisions for the lead

1. **Pin the darwin digests and the Team ID** (§5) in `cli-pin.json`, `KNOWN_BINARIES` and `CLAUDE_CODE_PUBLISHER`, after round 3 passes.
2. **Keep or relax the `initialize`-first rule** (§6). Keeping it costs nothing; its documented reason changes.
3. **A dropped message in the turn machine.** If a binding ever re-sent a stored `uuid`, the turn would never start: the CLI writes no `system/init`, so the machine has not yet seen `msg_lifecycle_v1` and ignores the `completed` frame, and the turn waits for a watchdog. A defensive rule (settle a queued turn with a typed error when a terminal `command_lifecycle` arrives for its `uuid` without `started`) needs an error code and a decision on lifecycle frames before `system/init`. Not done here.
4. **A decisive Keychain probe**, if local macOS isolation is wanted (research 09 §4.2 option 2): on the GitHub-hosted runner only, add a generic password under a unique service to the runner's own login keychain, look it up with the sandbox `HOME` (with and without `CFFIXED_USER_HOME`) and without `-d user` limits, then delete it. Found means not isolated. This writes to the runner's keychain, so it needs the lead's approval and must never run on a developer Mac.

## 8. What round 3 must confirm

Dispatch both jobs on a commit that contains these fixes.

1. Item 3 passes on both architectures: `API key: Keychain access recorded` shows the `security(1)` sightings, `search-list probes: every read-only query ran` passes, and `keychainIsolation` reads `cffixedUserHome: isolated, homeAlone: isolated, proven: true` (or explains a change).
2. Item 6 passes on both architectures: the three resume checks pass with `lifecycle [queued, started, completed]`, the history holds at least 3 messages, and the CLI reports the canonical cwd without an environment update.
3. `duplicateUuidResume` shows `dropped: true` with frames `control_response`, `command_lifecycle:completed` (the cause on macOS); `eagerResume` shows `ok: true` (the write order does not matter on macOS either).
4. `aliasResume`: whether the `/tmp` alias resume injects an environment update (evidence for ADR-0011 §9; not reached in runs 1 and 2).
5. Item 6 takes seconds, not 212 s; the whole run stays inside the 35-minute step limit with the same item 4 durations (about 137 s).
6. Items 1, 2, 4, 5 and 7 still pass, with the digests and Team ID of §5 unchanged, and cleanup reports 0 survivors.
