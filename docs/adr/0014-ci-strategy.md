# ADR-0014: CI strategy

- Status: Accepted — pending the one-off macOS spike (G3). Billing multipliers and merge-queue availability are UNVERIFIED (see Context); the budget must be recomputed once real job durations are known. Amended 2026-10-12 (see [Amendments](#amendments)).
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
| Scheduled safety net | new CLI version published (G3, amendment 2) | full matrix |

Classifier rules: default-deny (anything not matched by a SAFE rule is FULL); pure function of the changed-file list; table-tested (safe path to LIGHT, risky path to FULL, unknown to FULL, empty list to FULL, renames and deletes count old and new paths, odd paths to FULL, diff failure or very large diff to FULL); the classifier and its tests are themselves FULL; a mixed PR takes the maximum tier. Always FULL: `src/**`, `.github/**`, `scripts/**`, lockfiles, package manifests, tsconfig, bundler and test config, node version files, tests and fixtures, native/binary files, anything unmatched (04 §3).

### macOS policy (G3)

- macOS runs only on the FULL tier.
- One-off macOS spike through `workflow_dispatch` before v1 (the macOS gate; see list below and [ADR-0018](0018-scope-and-roadmap.md)).
- A scheduled full run (nightly) happens when a new CLI version was published (amendment 2 removed the original "main changed" trigger). A cheap Linux registry check gates the fan-out to Windows and macOS. (G3 says "nightly"; 04 §2/§5 proposed weekly. G overrides 04.)

### Windows

Windows CI is mandatory (A16). It runs on FULL tier, after Linux is green (04 §2 staged pipeline), so that every change reaching main is covered by Linux, Windows and macOS.

### Structure and hygiene (04 §2, §4, §5)

- Single always-triggered `ci.yml` without a workflow-level path filter; jobs: `classify`, `linux`, `windows`, `macos`, `ci-gate`. The `ci-gate` job (`if: always()`) fails on any failed or cancelled need, or when a FULL-required OS job was skipped. It is the only required check.
- Staged: cheap Linux gate first; Windows and macOS `needs:` it.
- Concurrency group `ci-${{ github.ref }}` with cancel-in-progress for PRs only; never cancel on main or schedule.
- `timeout-minutes` on every job (10 for Linux, 15 for Windows/macOS in 04).
- Consolidated one job per OS; never split macOS jobs.
- Top-level `permissions: contents: read`, elevated per job; `persist-credentials: false`; third-party actions pinned to full commit SHAs and updated by Dependabot.
- Caches keyed by lockfile hash, OS and Node version; only main writes caches used by release jobs; releases build from a clean install.
- Artifacts: retention 1-3 days, upload on failure only.
- Billing guardrails: budget cap and 90% alerts.
- Node matrix on CI: 22, 24, 26 ([ADR-0017](0017-toolchain.md)).

### macOS gate list (ratified)

The one-off macOS spike must cover these seven items:

1. Binary provenance: darwin-arm64 and darwin-x64 hashes against npm integrity and `manifest.json`; `/usr/bin/codesign --verify` as the OS-signature-first path ([ADR-0011](0011-spawn-hygiene-and-binary-provenance.md)); a Gatekeeper/quarantine spawn failure mapped to a named cause.
2. Process tree: Bash tools in their own process groups as on Linux; SIGTERM cleans them; SIGINT exits 0 without a `result`; the `/bin/ps` sweep with `LC_ALL=C` and start-time verification end to end ([ADR-0010](0010-process-layer-posix.md)).
3. Keychain: with API-key auth and an isolated `CLAUDE_CONFIG_DIR`, confirm NO Keychain access headless (a GUI prompt would hang forever; the first-frame watchdog must name this cause).
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
2. **Nightly runs only for a new CLI release.** The scheduled full matrix runs only when a new Claude Code CLI version was published in the look-back window (26 h), or on manual dispatch. The "main changed" trigger is dropped: every non-docs push to main already runs FULL, so a nightly run would repeat it. When the registry cannot be read, the cheap check job fails visibly instead of either skipping silently or spending a full matrix on an outage.

## Evidence

- 04 §1-§5 (billing, techniques, safe skipping, pitfalls, recommended design).
- 05 §14 (Linux/Windows parity), §15.
- 02 §11 (release cadence).
