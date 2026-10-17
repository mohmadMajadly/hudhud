# ADR-0014: CI strategy

- Status: Accepted. The macOS gate passed on 2026-10-16 (both architectures, all seven items; run 38967893191, [research 11](../research/11-macos-gate-run3.md)); amendment 6 records the result. Billing multipliers and merge-queue availability are UNVERIFIED (see Context); the budget must be recomputed once real job durations are known. Amended 2026-10-12 (see [Amendments](#amendments)).
- Date: 2026-10-12
- Negotiation log items: R7, A16 (Windows CI mandatory), G3, F (macOS gate list) (06 header, §A, §F, §G)
- Related: [ADR-0013](0013-testing-strategy.md), [ADR-0010](0010-process-layer-posix.md), [ADR-0017](0017-toolchain.md)

## Context

GitHub Actions minutes are limited (owner rule R7); the risk-tiered CI must not reduce quality. hudhud is a private repository on a personal account, so standard hosted runners consume the included minutes (Free: 2,000 per month; Pro: 3,000) (04 §1).

Facts from 04 (researched 2026-10-12):

- Per-minute overage rates (after the 2026-01-01 cut): Linux 2-core $0.006, Windows 2-core $0.010, macOS 3/4-core $0.062; each job is rounded up to whole minutes.
- Included-minute multipliers Linux 1x, Windows 2x, macOS 10x are UNVERIFIED in current official docs (dollar ratios are consistent with them). Plan with 1/2/10 as conservative.
- A 4-minute job per OS costs 4 + 8 + 40 = 52 Linux-equivalent minutes; macOS is about 77% of a full matrix.
- A workflow skipped by `paths` filtering leaves required checks "Pending" and blocks merge; a job skipped via `if:` counts as passing. `[skip ci]` bypasses the classifier. `pull_request_target` must not be used.
- Merge-queue availability for private repositories on personal accounts is UNVERIFIED.

## Decision

### Tiers (04 §5), decided by a repo-local, unit-tested classifier `scripts/ci-classify.mjs`

| Tier | Trigger | Jobs |
|---|---|---|
| LIGHT (docs only) | pull request or push to main (amendment 1) touching only allowlisted docs paths (`docs/**`, `README.md`, `CHANGELOG.md`, `LICENSE`) | classify, Linux markdown/link lint, gate |
| STANDARD | any other pull request push (draft or not ready) | classify, one Linux job (install, lint, typecheck, build, all tests with coverage), gate |
| FULL | PR ready for review or label `full-ci`; merge queue if available; push to main (except docs-only, amendment 1); manual dispatch with `full=true`; release tags | Linux first, then Windows and macOS (`needs: linux`), each one consolidated job; gate |
| Scheduled safety net | new CLI version published (G3, amendments 2 and 3) | nightly: integration suite against the newest CLI on Linux; weekly: the same on Windows and (after the macOS gate) macOS when a newer version appeared since the last weekly run; no write tokens (amendment 3) |

Classifier rules: default-deny (anything not matched by a SAFE rule is FULL); pure function of the changed-file list; table-tested (safe path to LIGHT, risky path to FULL, unknown to FULL, empty list to FULL, renames and deletes count old and new paths, odd paths to FULL, diff failure or very large diff to FULL); the classifier and its tests are themselves FULL; a mixed PR takes the maximum tier. Always FULL: `src/**`, `.github/**`, `scripts/**`, lockfiles, package manifests, tsconfig, bundler and test config, node version files, tests and fixtures, native/binary files, anything unmatched (04 §3).

### macOS policy (G3)

- macOS runs only on the FULL tier.
- One-off macOS spike through `workflow_dispatch` before v1 (the macOS gate; see list below and [ADR-0018](0018-scope-and-roadmap.md)).
- A scheduled nightly run happens when a new CLI version was published (amendment 2 removed the original "main changed" trigger); since amendment 3 it tests the newest CLI on Linux only; a weekly canary covers Windows and, after the macOS gate, macOS (amendment 3). (G3 says "nightly"; 04 §2/§5 proposed weekly. G overrides 04.)
- Until the macOS gate passes, the macOS job runs static checks, unit and conformance tests only (amendment 4).

### Windows

Windows CI is mandatory (A16). It runs on FULL tier, after Linux is green (04 §2 staged pipeline), so that every change reaching main is covered by Linux, Windows and macOS.

### Structure and hygiene (04 §2, §4, §5)

- Single always-triggered `ci.yml` without a workflow-level path filter; jobs: `classify`, `linux`, `windows`, `macos`, `ci-gate`. The `ci-gate` job (`if: always()`) fails on any failed or cancelled need, or when a FULL-required OS job was skipped. It is the only required check.
- Staged: cheap Linux gate first; Windows and macOS `needs:` it.
- Concurrency group `ci-${{ github.ref }}` with cancel-in-progress for PRs only; never cancel on main or schedule.
- `timeout-minutes` on every job (initially 10 for Linux, 15 for Windows/macOS from 04; re-sized as measured p95 x 2 once the integration suite exists, amendment 4).
- Consolidated one job per OS; never split macOS jobs.
- Top-level `permissions: contents: read`, elevated per job; `persist-credentials: false`; third-party actions pinned to full commit SHAs and updated by Dependabot.
- Caches keyed by lockfile hash, OS and Node version; only main writes caches used by release jobs; releases build from a clean install.
- Artifacts: retention 1-3 days, upload on failure only.
- Billing guardrails: budget cap and 90% alerts.
- Node matrix on CI: 22, 24, 26 ([ADR-0017](0017-toolchain.md)).

### macOS gate list (ratified)

The one-off macOS spike must cover these seven items:

1. Binary provenance: darwin-arm64 and darwin-x64 hashes against npm integrity and `manifest.json`; `/usr/bin/codesign --verify` as the OS-signature-first path ([ADR-0011](0011-spawn-hygiene-and-binary-provenance.md)); a Gatekeeper/quarantine spawn failure mapped to a named cause (outcome, research 11 §77: quarantine did not stop a launch, so no cause is mapped; pre-release review R3-3).
2. Process tree: Bash tools in their own process groups as on Linux; SIGTERM cleans them; SIGINT exits 0 without a `result`; the `/bin/ps` sweep with `LC_ALL=C` and start-time verification end to end ([ADR-0010](0010-process-layer-posix.md)).
3. Keychain (changed by amendment 5): with API-key auth and an isolated `CLAUDE_CONFIG_DIR`, record the Keychain access headless (run 1 showed the CLI calling `security(1)` even with an API key, research 09) and run the `PATH` shim and keychain search-list probes; isolation counts as possible only if the `CFFIXED_USER_HOME` probe proves it. On GitHub-hosted runners only, a canary probe (lead decision after gate run 2, research 10 §2.5) writes a labelled fake item to the runner's own login keychain, checks whether the CLI's environment can find it without printing any secret, and deletes it again (verified); its verdict is recorded as evidence. A GUI prompt would hang forever; the first-frame watchdog must name this cause (outcome, research 11: the lookups were isolated and no prompt appeared, so the watchdog names none; pre-release review R3-3, roadmap in [ADR-0018](0018-scope-and-roadmap.md)).
4. zsh login-shell snapshot hang (GH#78903, 01 §7) on a default macOS runner leads to the idle-watchdog `stalled` path.
5. Socket path: `$TMPDIR` is `/var/folders/.../T/`; confirm `cc-socks/<pid>.sock` stays under the 104-byte `sun_path` limit for hudhud's isolated temp dirs, and test the fallback.
6. Path identity: `/tmp` is `/private/tmp` and APFS may be case-insensitive; hudhud passes a realpath'd cwd consistently, otherwise resume breaks.
7. CI: darwin-arm64 is a mandatory runner; darwin-x64 is declared in `maxTested` only when it has run.

## Alternatives considered

- Naive full matrix on every push. Rejected: 52 Linux-equivalent minutes per push; about 38 pushes exhaust the Free plan (04 §1).
- Path-filtered workflows. Rejected: required checks stay pending and block merges (04 §2).
- Test-impact analysis for source changes. Rejected for src, build, lockfile and CI of a security library (04 §2); permitted only for ordering tests.
- `dorny/paths-filter`. Rejected in favour of a repo-local classifier: unit-testable and no third-party code in a security-sensitive repository (04 §2).
- Self-hosted runner on the owner's PC as the core. Not core: runs repository code with the owner's privileges, covers one OS, and the planned platform fee is postponed, not cancelled (04 §2). Optional only.
- Weekly safety net (04) in place of nightly-when-changed (G3). Superseded by G3.
- macOS on every FULL-eligible PR push. Rejected (G3): FULL tier only.

## Consequences

- Budget risk: 04 estimated at most 4-5 scheduled full runs per month (about 56 Linux-equivalent minutes each). A nightly run that triggers whenever a new CLI version appears (amendment 2) could run far more often (the SDK has seen 20-30 releases per month, 02 §11); each such run costs about 56 equivalents. The estimate in 04 §5 must be recomputed with measured durations, and the cron/trigger may need a rate limit. The log does not define one.
- Classification mistakes are caught by the post-merge full run on main (04 §3); after amendment 1 that holds for every non-docs push, and a docs-only push cannot affect code.
- The gate job name is a contract with branch protection; renaming it is a breaking CI change.
- Recompute the budget after the first month of real job durations (the 04 estimates use assumed ~4 minute jobs).

## Amendments

Lead resolutions, 2026-10-12. Both reduce minutes without reducing what is tested before code reaches users.

1. **Docs-only push to main is LIGHT.** A push to `main` whose change set passes the same strict LIGHT allowlist and the same well-formedness rules as a pull request runs the LIGHT tier instead of FULL. Rationale: the allowlist cannot affect code, so FULL with macOS (10x) on a documentation push is pure waste. The change set is the diff `github.event.before..github.sha`; the classify job fetches the `before` commit alone at depth 1 (no full history). Every other push to main stays FULL: any non-docs, unknown, empty, oversized or odd path, an all-zero or missing `before` (new branch), and a `before` that cannot be fetched or diffed (force push). Release tags are always FULL. All cases are table-tested.
2. **Nightly runs only for a new CLI release.** The scheduled full matrix runs only when a new Claude Code CLI version was published in the look-back window (26 h), or on manual dispatch. The "main changed" trigger is dropped: every non-docs push to main already runs FULL, so a nightly run would repeat it. When the registry cannot be read, the cheap check job fails visibly instead of either skipping silently or spending a full matrix on an outage. (Superseded in part by amendment 3.)
3. **The nightly tests the new CLI, on Linux, without write tokens** (K16, 06 §K). When a newer CLI version exists, the nightly downloads the newest published version (registry integrity recorded and pinned for that run) and runs the integration suite against it on Linux; it never re-runs the pinned version. On failure the run goes red with a job summary. Scheduled jobs hold no write tokens; the lead prepares version-bump PRs locally. In addition, a weekly scheduled canary runs the integration suite on Windows, and on macOS once the macOS gate has passed (Windows only before that), against the newest version whenever a version newer than the pinned one was published since the last weekly run, also without write tokens; every OS therefore sees a new CLI within a week, and the bump PR's FULL run covers it again. Cost basis: about 20-30 CLI releases per month (02 §11) gives at most about 30 nightly Linux runs and at most about 4.3 weekly runs per OS per month; with the planning multipliers of 04 §1 (Linux 1x, Windows 2x, macOS 10x) the monthly cost is about 30 x D_linux + 4.3 x 2 x D_windows + 4.3 x 10 x D_macos Linux-equivalent minutes, where D is the measured integration-suite duration per OS; the durations are re-measured after Wave 6 and the estimate recomputed.
4. **Timeouts and macOS before its gate** (K15, 06 §K). `timeout-minutes` per job is re-sized from the measured integration-suite durations: measured p95 times 2, with the measurement and the formula documented next to the value. Until the macOS gate passes, the macOS job runs static checks, unit and conformance tests only; integration tests on macOS start after the macOS gate results land.
5. **Keychain: evidence, not absence; real-CLI runs on GitHub-hosted macOS only** (lead decision after gate run 1, 2026-10-13, research 09). Gate item 3 changes from "no Keychain access" to "Keychain access recorded; isolation possible only if the `CFFIXED_USER_HOME` probe proves it"; the item stays evidence plus the shim and search-list probes. Real-CLI suites (integration, fixture recordings, the gate) run on GitHub-hosted macOS runners (`CI=true`, `RUNNER_ENVIRONMENT=github-hosted`) and are refused by the test-support launcher on a local Mac unless `HUDHUD_ALLOW_LOCAL_MACOS_REAL_CLI=1` is set ([ADR-0013](0013-testing-strategy.md)).
6. **The macOS gate passed; macOS joins integration** (W7-T4, 2026-10-16, [research 11](../research/11-macos-gate-run3.md)). All seven items passed on darwin-arm64 (`macos-15`) and darwin-x64 (`macos-15-intel`) in run 38967893191, after an undocumented passing run on `8feaec9` whose artifacts expired (gate artifacts are now kept 14 days and printed into the log). Item 1 now also runs the product's own verification: the pinned darwin digests and the Team ID `Q6L2SF6YDW` are committed (`tooling/cli-pin.json`, `KNOWN_BINARIES`, `CLAUDE_CODE_PUBLISHER`), and strict mode on macOS requires a Developer ID signature of that team ([ADR-0011](0011-spawn-hygiene-and-binary-provenance.md)). Item 3's canary verdict is `isolated` on both architectures; the local-Mac refusal of amendment 5 stays. Item 7: darwin-x64 has run, so it counts for `maxTested`. The macOS CI job runs `pnpm check:full` (darwin-arm64) once the integration project is green on macOS; the gate workflow's integration evidence job is the check before that (amendment 4's condition).

6. **Pull request change set from the merge commit** (W7-T1, 2026-10-16). A pull request is classified from the merge commit GitHub tests (`GITHUB_SHA`, the tip of `refs/pull/<n>/merge`): its tree against its first parent, the base commit it was merged onto, with the second parent required to equal `pull_request.head.sha` (otherwise the change set is unknown). The classify job checks it out at depth 2, which holds exactly the merge commit and both parents; no history and no extra fetch are needed. Defect fixed: the old diff `base...head` needs the merge base, and the checkout depth expression `pull_request && 0 || 1` evaluated to 1 (0 is falsy in Actions expressions), so every pull request diff failed with `fatal: Invalid symmetric difference expression` and ran FULL. An unknown change set is reported as a workflow warning naming its cause and stays FULL for a ready pull request, STANDARD for a draft. Both paths are tested against real shallow clones (`scripts/test/ci-cli.test.ts`) and with a fake git (`scripts/test/ci-diff.test.ts`). Verified live on 2026-10-17: pull request #5 (ready for review), run 38991931621, checked out `pull/5/merge` (316b6f1, merging 2e3f18d into f2236d2) at `--depth=2` and classified it `FULL` (the change set touches `ci.yml`) without an unknown-diff warning.

7. **Integration on CI, timing bounds and timeouts measured on the runners** (K15, W7-T1, 2026-10-16). The Linux jobs (every Node version of the tier) and the Windows job run what `pnpm check:full` runs, as separate steps so a failure names its phase: `pnpm check`, the OS-scoped coverage of the syscall adapters (`vitest.os.config.ts`, plan §4.8; the macOS job runs it too), and `pnpm test:integration`. The setup action's `integration` input restores the pinned CLI from `actions/cache` (key: platform, pinned version and pinned npm integrity; written by pushes to main only), runs `pnpm cli:fetch`, which re-hashes a restored binary against the pin and fetches and verifies it again when it differs (the cache is never trusted), and creates a fresh owner-only test root exported as `HUDHUD_TEST_ROOT` (`RUNNER_TEMP` is under the home on Linux and macOS runners, refused by the forbidden-ancestor rule; test-support takes it as a default on Windows only; mode 0700 on POSIX, on Windows an ACL without inheritance granting the runner's account only). The macOS job keeps `pnpm check` until the macOS gate. Timing bounds of the integration suites (plan §4.4 flake policy) are sized from samples taken on the CI runners by `.github/workflows/timing.yml`, run by a dispatch or a push to a `ci-timing/**` branch only (at least 15 runs per platform; each bounded test records its measured value through `HUDHUD_TIMING_LOG`; summary and samples as a 3-day artifact): bound = 3x the maximum on that platform, the run cited in the test. `timeout-minutes` per job = measured p95 x 2 from CI runs with integration, formula and numbers next to each value in `ci.yml`. Evidence (W7-T1): FULL runs 38980330927 (round A), 38984419589 (round B) and 38989536648 (round C, green on Linux 22/24/26, Windows with integration and macOS); timing runs 38980331321, 38984419523 and 38989537233 (15 runs per platform each). Values at the end of W7-T1: Linux 21 min (9 jobs, at most 10.3 min), Windows 50 min (2 jobs, 24.9 and 22.5 min), macOS 4 min (1.8 and 2.0 min), timing workflow 56 min.

8. **macOS runs the integration project on CI** (W7-Z, 2026-10-17; amendment 6's condition met: the gate's integration evidence job was green on darwin-arm64 in runs 38967893191 and 38977497768, 92 of 92 tests in the second). The macOS job runs what the Linux and Windows jobs run, in the same steps: setup with `integration: 'true'` (CLI cache keyed by the darwin-arm64 pin, test root `/private/tmp/hudhud-test-root`), `pnpm check`, the OS-scoped coverage and `pnpm test:integration`. Its timeout is 12 min ([research 11](../research/11-macos-gate-run3.md) §8: about 6 min measured and estimated, times 2), until FULL runs with integration measure it. The close-deadline overrun bound of `lifecycle/close-abort.test.ts` gains a darwin entry, `3 * 40` ms (40 samples in the two runs, maximum 39.241 ms; research 11 §6), where darwin used the Linux value before. `pnpm check:full` now includes `pnpm check:tarball` (plan §4.1; the packages carry a README and a LICENSE since W7-T3), so every OS job runs it as its own step after `pnpm check`, and the addon release phase 2 (`release-verify` in `addon-prebuild.yml`) runs it after the release-record check. `ci.yml` no longer has a `workflow_call` trigger: its only caller was the nightly's former fan-out to the pinned FULL matrix, which W7-T2 replaced (amendment 3); a manual FULL run is `workflow_dispatch` with `full: true`.

## Evidence

- 04 §1-§5 (billing, techniques, safe skipping, pitfalls, recommended design).
- 05 §14 (Linux/Windows parity), §15.
- 02 §11 (release cadence).
