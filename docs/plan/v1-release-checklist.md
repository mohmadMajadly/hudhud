# hudhud v1 release checklist

Status: 2026-10-16, written by W7-T4 on main f2236d2 plus the W7-T4 branch. This is the list of every gate between the current tree and the first npm publish of `hudhudjs`, `@hudhudjs/core`, `@hudhudjs/claude-code` and `@hudhudjs/win32-job-x64`. Each gate says who acts, how it is verified and what state it is in today. A gate is closed only by its verification, never by a statement.

Who acts:

- **Owner**: only the repository owner can do it (npm account, GitHub settings, legal decisions). The agents prepare it, the owner does it.
- **Lead**: the lead dispatches, merges and decides.
- **Agent**: work an agent does on a branch, merged by the lead.

States: **done** (verified, evidence cited), **open** (work left), **owner** (waits for an owner action), **decision** (waits for a lead or owner ruling).

## 1. Code and CI

| # | Gate | Who | Verified by | State |
|---|---|---|---|---|
| 1.1 | Integration on Linux and Windows in CI: the Linux jobs (Node 22, 24, 26 per the tier rules) and the Windows job run `pnpm check:full`; timing bounds and `timeout-minutes` re-sized from CI measurements (plan §4.4 flake policy, K15) | Agent (W7-T1), Lead | a FULL `ci.yml` run on main, green, with integration on Linux and Windows, zero egress violations and zero leaks; the measurements cited in the tests and in ADR-0014 | open (W7-T1) |
| 1.2 | macOS gate: all seven items pass on darwin-arm64 and darwin-x64 with the pinned CLI | Lead (dispatch), Agent (W7-T4) | `macos-gate.yml` run on the W7-T4 branch, documented in `docs/research/11-macos-gate-run3.md` | open (W7-T4 run pending) |
| 1.3 | darwin pins: digests in `tooling/cli-pin.json` and `KNOWN_BINARIES`, Team ID in `CLAUDE_CODE_PUBLISHER`, core Team ID requirement | Agent (W7-T4) | gate item 1 reports `verified-against-pin` for both binaries and the product's checks pass (research 11); merged only after that | open (candidate on the W7-T4 branch) |
| 1.4 | Integration on macOS in CI (darwin-arm64): the darwin request-shape snapshots committed, the macOS close-deadline bound sized (3x the maximum of the gate run's samples), then the `ci.yml` macOS job runs `pnpm check:full` | Agent (W7-T4 snapshots, W7-Z bound and `ci.yml`), Lead | the gate run's integration evidence job (research 11), then a FULL `ci.yml` run green with macOS integration | open |
| 1.5 | Canary: nightly (Linux, newest CLI) and weekly (Windows, and macOS once 1.4 is done) | Agent (W7-T2), Lead | a dry-run dispatch of each workflow against the pinned version, green and labelled as a dry run; no write token in either | open (W7-T2) |
| 1.6 | Product follow-ups of Wave 6 (`env.dropped` meaning, `cmd.permission-abort` internal, the connect hashing cost recommendation) | Agent (W7-T5), Lead | the W7-T5 commits with their tests; the lead's ruling on the digest cache recorded in the plan | open (W7-T5) |
| 1.7 | Wave 7 closer: all Wave 7 branches merged, cross-task wiring (`check:tarball` into `check:full` and into addon release phase 2) | Agent (W7-Z), Lead | `pnpm check` 3x on Windows and once on Linux at the merge head; a FULL `ci.yml` run green on all OSes | open |
| 1.8 | `CLAUDE_CODE_COMPAT` matches the pin: `minTested` = `maxTested` = 2.1.296 = `tooling/cli-pin.json` `version`, `knownBroken` empty (no listing with a reason exists) | Agent | `packages/claude-code/test/unit/compat.test.ts` (keeps the window, the pin and `KNOWN_BINARIES` in agreement); checked by W7-T4 on 2026-10-16: consistent, no change | done |
| 1.9 | Every workflow action pinned by full SHA with a version comment; minimal `permissions`; no secret in any workflow except the publish job of 4.4 | Agent, Lead | review of `.github/workflows/*.yml` at the release commit (`grep -n "uses:"` shows a 40-hex SHA on every line) | open (re-check at release) |

## 2. Windows job addon (plan §6.3)

| # | Gate | Who | Verified by | State |
|---|---|---|---|---|
| 2.1 | Release phase 1, record: a `workflow_dispatch` run of `addon-prebuild.yml` builds x64 and arm64 with the toolset of record, a local build with the same pin gives equal hashes, the lead commits `native/win32-job/release/<version>/` (`manifest.json`, `SHA256SUMS`, `toolchain.json`) and the table written from it (`write-digests.mjs --from-manifest`) | Lead | `scripts/addon/manifest.mjs compare` reports `MATCH` for both architectures and no `TOOLCHAIN MISMATCH`; `test-x64` green, including `check-toolchain` | open: run 38947897592 reproduced the record (`0.0.0-dev`); the record of the release version is still to be made |
| 2.2 | Release phase 2, tag: `release-verify` rebuilds with the pin, requires sha256 = manifest = table in `dist`, packs, re-hashes the addon in the tarballs (`check-tarball.mjs --release-record`) and runs the full `pnpm check:tarball` | Lead | the `release-verify` job green on the release tag (it has not run yet) | open |
| 2.3 | The core's optional dependency names the exact x64 platform version that is published | Agent | `checkReleaseRecord` in `scripts/lib/tarball.mjs` (part of 2.2) | open (runs in 2.2) |
| 2.4 | Windows arm64 ships `'best-effort'` (K17): `@hudhudjs/win32-job-arm64` stays private and unpublished in v1 | Lead | `packages/win32-job-arm64/package.json` has `"private": true` and no `publishConfig` at the release commit | done (as of f2236d2) |

## 3. Packages and documentation

| # | Gate | Who | Verified by | State |
|---|---|---|---|---|
| 3.1 | User documentation: README of the root and of each published package, `docs/guide/**` (install, requirements and OS matrix, every way, errors, troubleshooting, compatibility, license), code examples type-checked in `pnpm check` | Agent (W7-T3), Lead | `pnpm lint:md` (links included) and the example type-check in `pnpm check`; lead review of the guide against the API reports | open (W7-T3) |
| 3.2 | The OS support statement matches the evidence: Windows x64 job containment, arm64 best-effort, Linux, macOS arm64 and x64 as the gate (research 11) and 1.4 established | Agent (W7-T3 with W7-T4 facts), Lead | the guide's matrix compared line by line with research 11 and the CI jobs that run | open |
| 3.3 | `pnpm check:tarball` passes fully: on Windows with the native package built, on Linux with it skipped by design | Agent (W7-T3), Lead | the command's output on both, cited in the W7-T3 report; then part of `check:full` (W7-Z) | open |
| 3.4 | `NOTICE` per ADR-0015, including any third-party notice the shipped files need (the addon links the static MSVC runtime) | Agent (W7-T3), Owner (legal ruling if asked) | the W7-T3 report citing the license terms relied on | open |
| 3.5 | License final: Apache-2.0 is the current decision; settle it (or MIT) before outside contributions | Owner | the owner's decision recorded in ADR-0015 | decision |
| 3.6 | API reports reviewed: every `@public` symbol in `packages/*/api/*.api.md` is intended for v1 | Lead | `pnpm api:check` green and a lead read of the reports | open |

## 4. Versioning and publishing

| # | Gate | Who | Verified by | State |
|---|---|---|---|---|
| 4.1 | Pre-release review swarm on the merged tree (after W7-Z): security, process layer, protocol, docs; every finding fixed or ruled on | Lead | the swarm's findings list with a fix commit or a ruling per finding | open |
| 4.2 | Publishable packages are not private: remove `"private": true` from `hudhudjs`, `@hudhudjs/core`, `@hudhudjs/claude-code` and `@hudhudjs/win32-job-x64` (all four are private today; each already has `publishConfig.access: "public"`) | Agent, Lead | `node -p "require('./packages/<p>/package.json').private"` prints `undefined` for the four, `true` for `win32-job-arm64` | open |
| 4.3 | Changesets: the accumulated changesets produce the intended first versions (`pnpm changeset version`, reviewed diff); `.changeset/config.json` has `"access": "restricted"`, which the per-package `publishConfig.access: "public"` overrides; set it to `public` or confirm the override, so no scoped package is ever published as restricted | Lead, Decision | the version PR's diff; `npm view <name> access` style check after the first publish (3 scoped packages public) | decision |
| 4.4 | A publish workflow exists (none does today): triggered by the release tag only, after `release-verify` (2.2); one publish job with `id-token: write` (npm trusted publishing) and `contents: read`, in a protected GitHub environment that needs the owner's approval; every other job read-only | Agent, Lead | the workflow reviewed; a dry run (`npm publish --dry-run` of each packed tarball) green on a test tag in a fork or with publishing disabled | open |
| 4.5 | Publish order: `@hudhudjs/win32-job-x64` first, then `@hudhudjs/core` (its exact optional dependency must already resolve), then `@hudhudjs/claude-code`, then `hudhudjs` | Agent (workflow), Lead | the workflow's job order; after the publish, `npm view` of each shows the versions the release record names | open |
| 4.6 | Trusted publishing on npm for each of the four packages: trusted publisher = this GitHub repository, the publish workflow's file name and the environment of 4.4; then, per package, publishing access "require two-factor authentication and disallow tokens" | **Owner** (npmjs.com, package settings) | the package settings page on npmjs.com for each package; a publish from anything but the workflow fails | owner |
| 4.7 | npm names reserved and owned by the owner's account: `hudhudjs` and the `@hudhudjs` scope | **Owner** | `npm view hudhudjs` and `npm access list packages @hudhudjs` from the owner's account (run by the owner) | owner (in progress, owner's note) |
| 4.8 | Provenance: every published package sets `publishConfig.provenance: true`, but the repository is private. npm documents provenance statements for builds from public repositories (docs.npmjs.com, "Generating provenance statements"); confirm against the current npm documentation whether a private repository can publish with provenance. If it cannot, the release waits for open-sourcing, or the lead rules to publish without provenance and records that in ADR-0015 | Lead, Owner | the npm documentation at release time, cited; then a `--dry-run` of the publish job | decision |
| 4.9 | Repository settings for the release: branch protection on `main` requiring `ci-gate`; tag protection for the release tag pattern; the environment of 4.4 with required reviewers | **Owner** (GitHub settings) | the settings pages; a push of an unprotected tag is refused | owner |

## 5. After the publish

| # | Gate | Who | Verified by | State |
|---|---|---|---|---|
| 5.1 | Install smoke test from the registry on a clean machine per OS (Windows x64, Linux x64, macOS arm64): `npm i hudhudjs`, then the guide's quick start type-checks and imports | Lead | the commands and their output per OS; on Windows the x64 addon is installed and its sha256 equals the release record | open |
| 5.2 | The weekly canary runs on macOS once 1.4 is done (W7-T2 leaves a documented switch) | Lead | the first weekly run that includes macOS | open |
| 5.3 | The release record (`native/win32-job/release/<version>/`), the tag and the published versions agree | Lead | `check-tarball.mjs --release-record` against the published tarballs (`npm pack <name>@<version>`) | open |

## 6. Order

1. W7-T1 to W7-T5 land on their branches; the macOS gate run on the W7-T4 branch (1.2, 1.3, evidence for 1.4).
2. W7-Z merges, wires `check:tarball`, sizes the macOS bound and enables macOS integration (1.4, 1.7); FULL CI green on all OSes.
3. Pre-release review swarm (4.1) and its fixes; FULL CI green again.
4. Owner actions in parallel: license (3.5), npm names (4.7), repository settings (4.9); the provenance ruling (4.8).
5. Addon release phase 1 for the release version (2.1); the publish workflow (4.4) and the private flags (4.2); the version PR (4.3).
6. Owner configures trusted publishing (4.6) for the four packages.
7. Tag: phase 2 (2.2), then the publish job in order (4.5) after the owner's approval.
8. After the publish: 5.1 to 5.3.
