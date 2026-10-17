# 11 — macOS gate round 3: findings, pins and macOS integration (CLI 2.1.296)

Date: 2026-10-17. Three runs make up round 3:

- Run 38440842419, commit `8feaec9` (2026-10-13 17:42), the round-3 run research 10 §8 asked for. Both jobs passed, but nobody documented it, and its artifacts were kept for 3 days and had expired when this report was written (the API lists no artifact). Only the job logs remain (§1).
- Run 38967893191, branch `w7-t4-macos-gate` at `a3dd384` (main `f2236d2` plus the W7-T4 commits: the candidate darwin pins, the core Team ID requirement, the product checks in item 1 and the integration evidence job), dispatched by the lead on 2026-10-16. Jobs `gate (darwin-arm64)` on `macos-15` and `gate (darwin-x64)` on `macos-15-intel` passed; `integration evidence (darwin-arm64)` failed in part 1 with 4 of 87 tests (§5). Evidence: the artifacts `macos-gate-darwin-arm64`, `macos-gate-darwin-x64` and `integration-evidence` (kept until 2026-10-30) and the job logs.
- Run 38977497768, branch `w7-t4-macos-gate` at `bb8c6b2` (the fixes of §5 and the darwin snapshots), dispatched by the lead on 2026-10-17: the confirming run. All three jobs passed; integration part 1 ran 92 tests, 92 passed (§9).

Paths such as `/Users/runner/...`, `/var/folders/...` and `/private/tmp/...` below are public GitHub runner paths.

---

## 0. Summary

| # | Finding | Verdict | Change | Next run must show |
|---|---|---|---|---|
| 1 | All seven gate items pass on both architectures, in run 38440842419 (logs only) and in run 38967893191 (full evidence) | **gate passed** (ADR-0014 gate list) | ADR-0010, 0014, 0018 statuses updated | nothing new |
| 2 | Item 1: the pinned digests match on both runners, the product's Team ID check passes, its control is refused with exit 3, and `verifyBinary` reports `verified` in strict and advisory mode | **pins confirmed** (research 10 §7 D) | the candidate pins and the core Team ID requirement stay; they merge with this branch | the same |
| 3 | Item 3: the Keychain canary's first verdict is `isolated` on both architectures | **fact** for ADR-0012 / ADR-0014 item 3 | none | the same |
| 4 | Item 6: resumes pass; a re-sent `uuid` is dropped on macOS too; the write order does not matter; the `/tmp` alias resume injects no environment update | **confirmed** (research 10 §3) | none | the same |
| 5 | `containment/host-crash`: the crash host refused the real CLI on a GitHub-hosted runner | **test harness defect**: the host process got no host-policy markers | `hostPolicyEnv` passes exactly the policy's variables | passed in run 38977497768 (§9) |
| 6 | `containment/orphan`: the workload `sleep` never started | **test defect**: macOS has no `setsid(1)` | the workload detaches through perl's `POSIX::setsid` on macOS | passed in run 38977497768 (§9) |
| 7 | `security/child-launch` (both tests): no argv file | **test defect**: the probe reads `/proc`, which macOS does not have | `ps -ww -o args=` and the Bash tool's environment on macOS | passed in run 38977497768 (§9) |
| 8 | Request-shape: the five darwin snapshots equal the Linux ones byte for byte | **fact** | `snapshots/*.darwin.shape` committed | passed, snapshots unchanged, run 38977497768 (§9) |
| 9 | Close deadline overrun on darwin-arm64: 40 samples over two runs, 14.6 to 39.2 ms | **measurement** (plan §4.4) | none here; the closer sizes the bound (§6) | — |

No product defect was found. The four integration failures were defects of the test code on its first macOS run (§5); the confirming run 38977497768 ran the whole integration project green on darwin-arm64 (§9).

## 1. Run 38440842419 (commit `8feaec9`): what the logs still show

From the job logs (`Run the seven gate items`):

| Item | darwin-arm64 | darwin-x64 |
|---|---|---|
| 1 Binary provenance | pass, 1109 ms | pass, 9383 ms |
| 2 Process tree | pass, 8743 ms | pass, 25466 ms |
| 3 Keychain | pass, 1421 ms | pass, 8633 ms |
| 4 zsh login-shell snapshot hang | pass, 136432 ms | pass, 141461 ms |
| 5 Socket path | pass, 1200 ms | pass, 5077 ms |
| 6 Path identity | pass, 2580 ms | pass, 12860 ms |
| 7 CI runner | pass, 764 ms | pass, 2764 ms |

Item 6 fell from 211 849 ms (run 2) to 2580 ms: the fresh-`uuid` fix of research 10 §3.4 holds. The jobs took 2 min 53 s (arm64, image `macos-15-arm64` 20260907.0337.1) and 5 min 51 s (x64). Everything else research 10 §8 asked for (the canary verdict, `aliasResume`, `duplicateUuidResume`, the digests) was only in the artifacts and is lost. Run 38967893191 repeats round 3 on a later tree with complete evidence. Since then the workflow keeps its artifacts 14 days and prints every result file into the job log.

## 2. Item 1: binary provenance and the pins

Both runners fetched both darwin binaries. With the pin no longer `pendingGate`, the fetch compared the registry integrity and the Agent SDK 0.3.296 `manifest.json` against the pin before installing, and reported `pin: verified-against-pin`:

| Platform | npm integrity | sha256 | Size |
|---|---|---|---|
| darwin-arm64 | `sha512-vqtx3kS3…10+Oj9A==` | `c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937` | 240664432 |
| darwin-x64 | `sha512-yCJe1vp7…zFjLA==` | `a6bf4f30be241053a923f3820ad23c5991d2f5ac2935b3a8dd64da218d9cc603` | 249194752 |

These are the values of research 10 §5, now recorded by four independent fetches (two runners in run 2, two in this run) and a local fetch on Windows on 2026-10-16.

Code signature (`codesign -dv`, both binaries, unchanged from run 2): `Identifier=com.anthropic.claude-code`, `Authority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)`, `Developer ID Certification Authority`, `Apple Root CA`, `TeamIdentifier=Q6L2SF6YDW`, `Runtime Version=26.5.0`, timestamps `Oct 9, 2026 at 2:33:24 PM` (arm64) and `2:33:29 PM` (x64).

The binaries' own designated requirement (`codesign -d -r-`, new evidence):

```text
designated => identifier "com.anthropic.claude-code" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = Q6L2SF6YDW
```

The core's requirement (`codesignRequirement`) is this requirement without the identifier clause: the Team ID binds the publisher, and the digest table binds the exact file.

The product's own checks, run on each runner's binary with the committed pins (`tooling/macos-gate/src/items/product-verify.ts`):

| Check | darwin-arm64 | darwin-x64 |
|---|---|---|
| core codesign check with `CLAUDE_CODE_PUBLISHER` | `valid`, "codesign valid, pinned Team ID Q6L2SF6YDW" | same |
| the same check with Team ID `AAAAAAAAAA` | `invalid`, "codesign failed: exit 3" | same |
| `verifyBinary` strict | `verified`, "codesign valid, pinned Team ID Q6L2SF6YDW; sha256 matches 2.1.296" | same |
| `verifyBinary` advisory | `verified`, "sha256 matches 2.1.296" | same |

Exit 3 is codesign's "valid signature, requirement not satisfied", so the control proves that the requirement is parsed and decides the verdict; exit 1 would have meant no valid signature at all.

Quarantine (evidence only, research 09): the quarantined signed copy and the quarantined copy with its signature removed both ran (`2.1.296 (Claude Code)`, cause `ok`) on both runners: the quarantine attribute did not stop either launch from the harness (a non-GUI parent). hudhud does not depend on Gatekeeper behaviour (lead ruling).

**Decision.** Every criterion of research 10 §7 D holds. The darwin entries of `tooling/cli-pin.json` and `KNOWN_BINARIES` and `CLAUDE_CODE_PUBLISHER.darwinTeamId` stay as committed on this branch (commits `6c52857`, `19ef5d6`).

## 3. Items 2 to 7

- **Item 2.** `ps` parses (0 rejected of 435 lines on arm64, 516 on x64); the Bash tool's `sleep` runs under the CLI and leads its own group under `/bin/zsh`; SIGTERM exits 143 and cleans the tool groups; SIGINT mid-stream gives `{"shape":"error-result","results":[{"subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming"}]}`, exit 0, and the core classifies it `unknown` with `PROCESS_EXITED` (research 09 §3, unchanged); SIGKILL plus the sweep leave nothing.
- **Item 3.** `security(1)` children seen twice (first at 39 ms arm64, 110 ms x64); the shim argv is the research 10 §2.4 shape (`find-generic-password -a runner -w -s "Claude Code-credentials-<hash>"` and `"Claude Code-<hash>"`); `keychainIsolation`: `cffixedUserHome: isolated, homeAlone: isolated, proven: true`. **Canary, first verdict:** on both runners the control lookup with the runner's `HOME` found the canary item (exit 0), both lookups with the CLI's environment (sandbox `HOME`, with and without `CFFIXED_USER_HOME`) answered not found (exit 44), and the item was deleted (`deleted.gone: true`): verdict `isolated`. The sandbox's `HOME` alone keeps `security(1)` lookups away from the runner's login keychain. Scope as stated in the evidence: the user search list of `security(1)`; an in-process Security framework call or an explicit keychain path is not covered. The local-Mac refusal of the real CLI (research 09 §8) stays: the canary ran on a throw-away runner, not on a developer's login session.
- **Item 4.** The default shell turn completes in 320 ms; with a hanging login shell the CLI completes the turn on its own after 130 685 ms (arm64) and 130 866 ms (x64), as in runs 1 and 2.
- **Item 5.** The socket lies inside the isolated `TMPDIR` (82 and 83 bytes, under the 104-byte `sun_path` limit); with an over-long `TMPDIR` it falls back to `/tmp/cc-socks-501/<pid>.sock`.
- **Item 6.** Start and both resumes pass with `lifecycle [queued, started, completed]` and the canonical cwd `/private/tmp/...`, history 5 messages; `aliasResume` (resume from the `/tmp` alias): `ok`, cwd `/private/tmp/...`, **`environmentUpdate: false`** (the open question of research 10 §8 item 4, answered for ADR-0011 §9); `duplicateUuidResume`: `dropped: true`, lifecycle `[completed]`; `eagerResume`: `ok`, so the write order does not matter on macOS either. The item took 2480 ms (arm64) and 4031 ms (x64).
- **Item 7.** arm64 native (`proc_translated=0`); x64 kernel `x86_64`, binary native.

Item durations (arm64 / x64, ms): 1920 / 7855, 9179 / 13340, 1670 / 3138, 136496 / 137254, 1105 / 1717, 2480 / 4031, 784 / 862. Jobs: 2 min 59 s (arm64) and 3 min 35 s (x64). Cleanup on both: 0 signalled, 0 survivors.

## 4. The integration evidence job

| Step | Result | Time |
|---|---|---|
| Set up, build, `cli:fetch` (darwin-arm64, verified against the pin) | success | 45 s |
| Part 1: the integration project without request-shape | **failure**: 87 tests, 83 passed, 4 failed | 2 min 22 s |
| Part 2: request-shape in update mode, and its check | success: 5 darwin snapshots, every test failed only because it wrote its snapshot | 5 s |
| Part 3: 20 close-deadline runs | success: 20 samples, every run exit 0 | 1 min 22 s |

The whole job took 4 min 40 s. Part 1 is the first measurement of the integration project on macOS: 142 s for the project file by file (Linux in Docker 165 s, Windows 11 686 s, plan §5.9 K15 samples).

## 5. The four failures of part 1

### 5.1 `containment/host-crash.test.ts`: the crash host refused the real CLI

**Observation.** `Error: crash host: SandboxRefusedError: refusing to run the real Claude Code CLI on a local macOS host: it calls security(1) on the login keychain even with an API key set (research 09) ... set HUDHUD_ALLOW_LOCAL_MACOS_REAL_CLI=1`, after 270 ms.

**Cause.** The test starts `support/crash-host.mjs` as a separate Node process with a minimal environment: `hostEnv` gave it only `TMPDIR` and `HOME` on POSIX. The host resolves the pinned CLI itself (`resolvePinnedCli`), which runs the macOS host policy (`realCliHostRefusal`) on its own process environment. Without `CI` and `RUNNER_ENVIRONMENT` the GitHub-hosted runner looked like a local Mac. On Linux the policy does not apply, and Windows passes a different environment, so the defect could only show on macOS.

**Fix.** `HOST_POLICY_VARIABLES` (`CI`, `RUNNER_ENVIRONMENT`, `HUDHUD_ALLOW_LOCAL_MACOS_REAL_CLI`) and `hostPolicyEnv(env)` in `tooling/test-support/src/launcher/host-policy.ts`; the crash host gets exactly these from the worker, so it reaches the worker's decision, neither looser nor stricter. A unit test checks the variable list and that the macOS decision is the same with the full and the reduced environment for every combination of marker values.

### 5.2 `containment/orphan.test.ts`: the workload never started

**Observation.** `sleep 600.532619408927715 not seen within 30000 ms`. The other suites that wait for a tagged `sleep` (`ladder`, `launcher`) passed, so the process table reads work on macOS.

**Cause.** The workload is `setsid sleep <tag> >/dev/null 2>&1 & sleep 5`. `setsid(1)` is a util-linux program; macOS does not ship it, so the shell reported the command as not found (its output goes to `/dev/null`) and no `sleep <tag>` ever ran.

**Fix.** On macOS the same `setsid(2)` call runs through the system perl, which then execs `sleep`: `/usr/bin/perl -MPOSIX -e 'POSIX::setsid() or die qq(setsid: $!); exec @ARGV or die' sleep <tag>`. The workload then leads its own session and group as on Linux, and the test's expectations stay as they were. Checked with the system perl of `node:22-bookworm` (bash, no job control): the started process is `sleep 3.25` (comm `sleep`) with pid = process group = session id, and after its shell exited it was reparented to pid 1 and kept running. `/usr/bin/perl` with the core `POSIX` module ships with macOS; the next gate run confirms it there.

### 5.3 `security/child-launch.test.ts` (both tests): no argv file

**Observation.** `ENOENT: no such file or directory, open '/private/tmp/hudhud-it-.../work/probe-argv.txt'`.

**Cause.** The probe tool call writes the CLI's argv and environment with `tr '\0' '\n' < /proc/$CLAUDE_PID/cmdline > probe-argv.txt`. macOS has no `/proc`; the input redirection fails before the output file is created. The pid file was written (`CLAUDE_PID` is set for tools on macOS as well), so the failing read was the argv file.

**Fix.** On macOS the probe reads the argv with `/bin/ps -ww -o args= -p "$CLAUDE_PID"` (argv joined by single spaces, unquoted) and the environment with `env` in the Bash tool, as on Windows: `ps -E` prints another process's environment only joined by spaces, which values with spaces make ambiguous. The test's exact-environment comparison therefore runs on Linux only, as before; every other assertion (the exact argv in order, the pinned variables, the absent variables, the trace variables) runs on macOS. `observedArgv` compares the unquoted macOS command line case-sensitively against the binary path.

## 6. Close deadline overrun on darwin-arm64 (plan §4.4)

Run 38967893191: twenty single-process runs of `close with a deadline: a turn that never ends is cut at the deadline` (`closeTimeoutMs` 2000), overrun past the deadline recorded before any assertion, in run order (ms):

```text
14.62, 27.741, 15.757, 17.15, 29.842, 20.972, 18.661, 16.574, 39.241, 19.523,
19.386, 24.481, 18.168, 18.322, 17.887, 17.766, 18.098, 20.493, 19.449, 19.418
```

Minimum 14.62 ms, median 19.02 ms, maximum 39.241 ms, Node v22.23.2, arm64.

Run 38977497768 (the confirming run, same test and method), in run order (ms), every run exit 0:

```text
20.331, 16.273, 21.168, 37.666, 28.434, 15.358, 30.277, 19.65, 23.405, 17.897,
18.668, 15.715, 27.319, 16.304, 33.251, 17.452, 17.033, 18.165, 20.639, 19.244
```

Minimum 15.358 ms, median 19.447 ms, maximum 37.666 ms.

Both runs, 40 samples: minimum 14.62 ms, median 19.315 ms, 95th percentile 33.251 ms, maximum 39.241 ms (run 38967893191). Plan §4.4: the bound is 3x the slowest measurement on the platform that runs it, `3 x 39.241 = 117.7 ms`. **Recommendation** (the closer applies it): a darwin entry `3 * 40` ms (120 ms, the maximum rounded up to a whole 10 ms) citing both runs; until then darwin uses the Linux value `3 * 45` (135 ms), which all 40 samples met, as did the in-project runs of part 1 in both runs.

## 7. Request-shape on macOS

The five snapshots written in update mode (`partial-messages`, `resume`, `session-options`, `text-turn`, `tool-use`) are byte-identical to the committed Linux snapshots. The only difference between the Linux and Windows snapshots is the tool list (107 lines per scenario: the Windows build sends `Glob` and `Grep`, the Linux and macOS builds do not; `snapshots` file comment). The darwin files are committed unchanged from the artifact.

## 8. The `ci.yml` change for macOS integration (prepared, not applied)

For the closer, after this branch, W7-T1's `ci.yml` and the darwin close-deadline bound have merged. The macOS job runs what the Linux and Windows jobs run (`check:full`); `timeout-minutes` from this run's measurements (K15: p95 x 2): the current job (`pnpm check`) estimate of 3 min plus setup, build and `cli:fetch` (45 s and 40 s measured in the evidence jobs of runs 38967893191 and 38977497768) plus the integration project (142 s without request-shape and 140 s with it, same runs; the maxima are used), about 6 min, times 2 = 12 min. The confirming run changed none of these numbers.

```diff
   macos:
     name: macos (darwin-arm64, node 22)
     needs: [classify, linux]
     if: needs.classify.outputs.tier == 'FULL'
     runs-on: macos-15
-    # K15: estimated p95 x 2. The last two runs took 68 s (green) and 78 s
-    # (tests failed after 21 s); the launcher and leak tests that now run in
-    # full add about 25 s. Job about 2 min, p95 taken as 3 min. Static checks,
-    # unit and conformance only until the macOS gate passes (K15).
-    timeout-minutes: 6
+    # K15: p95 x 2. `pnpm check` about 3 min (estimate kept from the
+    # pre-gate job), plus setup, build and cli:fetch 45 s and the integration
+    # project 142 s (maxima of the macOS gate's integration evidence job,
+    # runs 38967893191 and 38977497768, research 11): about 6 min, times 2.
+    # Integration on macOS since the gate passed (ADR-0014 amendment 6).
+    timeout-minutes: 12
     permissions:
       contents: read
     steps:
@@
-      - name: Check (format, build, lint, depcruise, tests with coverage, API reports, privacy)
-        run: pnpm run check
+      - name: Check and integration (check:full)
+        run: pnpm run check:full
```

If W7-T1 adds a CLI cache step to the Linux and Windows jobs, the macOS job takes the same step keyed by the darwin-arm64 pin's integrity.

## 9. The confirming run 38977497768

Branch `w7-t4-macos-gate` at `bb8c6b2`, dispatched by the lead on 2026-10-17 after the fixes of §5. Jobs: `gate (darwin-arm64)` 2 min 59 s, `gate (darwin-x64)` 3 min 53 s, `integration evidence (darwin-arm64)` 4 min 33 s, all green. The criteria this report set before the run, checked in the artifacts:

| Criterion | Result |
|---|---|
| Part 1 green, the whole integration project including request-shape | 92 tests, 92 passed, 0 failed, 0 skipped (`integration.json`), 140 s; `containment/host-crash`, `containment/orphan` and both `security/child-launch` tests passed |
| Part 2: the update run leaves the committed darwin snapshots unchanged | the step's `git diff` and `git status` checks passed, and the five uploaded files are byte-identical to the committed ones (`cmp`) |
| Part 3: 20 samples, every run exit 0 | 20 samples (§6); `close-abort-runs.txt` shows exit code 0 for all 20 runs |
| Gate jobs: same digests, same Team ID, canary `isolated` | `digests.json` on both runners holds exactly the pinned integrity, sha256 and size of both platforms (§2); `TeamIdentifier=Q6L2SF6YDW` and `Developer ID Application: Anthropic PBC (Q6L2SF6YDW)` on both binaries; every product check of item 1 passed (pinned Team ID `valid`, control `codesign failed: exit 3`, `verifyBinary` strict and advisory `verified`); `keychainCanary.verdict` `isolated` with `deleted.gone: true` on both runners |

Item 6 again: `duplicateUuidResume.dropped: true`, `eagerResume.ok: true`, `aliasResume.environmentUpdate: false` on both runners. Item durations (arm64 / x64, ms): 2057 / 11448, 9073 / 14496, 1480 / 3598, 136466 / 137446, 971 / 2050, 2485 / 4519, 441 / 1055. Round 3 is closed: the gate, the pins and macOS integration are confirmed; what remains belongs to the closer (the darwin bound of §6 and the `ci.yml` change of §8).
