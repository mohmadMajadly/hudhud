# ADR-0017: Toolchain

- Status: Accepted
- Date: 2026-10-12
- Negotiation log items: A4, E3, E6, F (E6: Node >=22.12.0), A5, A6 (06 §A, §E, §F)
- Related: [ADR-0004](0004-packages-and-versioning.md), [ADR-0005](0005-schema-and-validation.md), [ADR-0009](0009-process-layer-windows.md), [ADR-0014](0014-ci-strategy.md)

## Context

hudhud is security-sensitive and other sensitive projects build on it. The supply chain of the repository itself is part of the attack surface. Owner rule R5: toolchains may be installed on the host; services (if ever needed) run in Docker.

## Decision

### Package manager: pnpm (E3, on merit)

Reasons recorded: strict non-flat `node_modules` (no phantom dependencies); install scripts blocked by default with an explicit `onlyBuiltDependencies` allowlist; `minimumReleaseAge` to delay freshly published (possibly hijacked) versions; catalogs for single-version dependencies across the monorepo; a deterministic lockfile. Consumers are unaffected: they install published packages with any manager. Initial value (lead decision, tunable): `minimumReleaseAge` 7 days (10080 minutes), with an explicit, reviewed exclusion list for the pinned CLI/SDK test packages, used only when the canary needs a fresh version. The `onlyBuiltDependencies` allowlist starts empty because the Windows addon is distributed prebuilt ([ADR-0009](0009-process-layer-windows.md)). pnpm 11 names it `allowBuilds`; an explicit deny entry (`allowBuilds: { esbuild: false }`) is not a weakening: it records that esbuild's postinstall is never run, the binary coming from esbuild's optional platform package. This is verified on Windows and Linux before it is relied on (K14, 06 §K).

### Runtime and language

- Node `engines`: `>=22.12.0` (F amends E6's `>=22`). Node 22 is in maintenance until 2027-04; it is dropped in a major version after its end of life. The driver is the consumer base: applications on Node 22, Electron among them. Correction (pre-release review R7-U3, FX-D, 2026-10-17): the original text said "Electron 33+ ships Node 22"; the reviewer recalls that Electron 33 and 34 ship Node 20.18 and Electron 35 is the first line with Node 22 (22.14). That could not be checked here (no network access to Electron's release notes), so the ADR names no Electron line: an Electron version is supported when its bundled Node is 22.12.0 or newer, which is what `engines` states.
- CI Node matrix: 22, 24, 26 ([ADR-0014](0014-ci-strategy.md)), plus the floor 22.12.0 exactly on Linux since the pre-release review (R7-7, ADR-0014 amendment 11), so an API newer than the floor cannot pass CI.
- ESM-only output; TypeScript.

### Release and API discipline

- Changesets for versioning and changelogs.
- API Extractor to produce and review the public API report (guards the stable tier, [ADR-0003](0003-public-api.md)).
- Published with npm provenance; the platform addon packages included ([ADR-0004](0004-packages-and-versioning.md), [ADR-0009](0009-process-layer-windows.md)). While the repository is private, provenance for the addon means a committed sha256 manifest and toolchain manifest per build; build attestations and npm provenance are added at open-sourcing (K17, 06 §K).

### Build-time-only dependencies

TypeBox (major pinned), Ajv (standalone generation), esbuild (bundling generated validators), `json-schema-to-typescript` (documented fallback) ([ADR-0005](0005-schema-and-validation.md)). Lint and dependency-cruiser enforce that the sans-IO core has no I/O imports ([ADR-0006](0006-sans-io-core-and-daemon-readiness.md)).

### Native build

CMake + MSVC for the Windows addon, x64 and ARM64, plain C against `node_api.h` ([ADR-0009](0009-process-layer-windows.md)). ARM64 is cross-compiled on the x64 runner and is not first-class until tested on a real arm64 runner (K17). Release builds (`addon-prebuild.yml`) pin every toolchain field of the release record that can change the bytes: the MSVC toolset and Windows SDK through exact Visual Studio components, and, since the pre-release review (R7-4, FX-D, 2026-10-17), CMake through the record's exact version from Kitware's release, checked against Kitware's SHA-256 list. Before that the image's CMake was used, and an image update between the record and the tag would have failed `check-toolchain` (`cmakeVersion` differs) and blocked the release. Whether a CMake version change alone can change the bytes was not shown either way (both recorded builds used CMake 4.4.4, and no second version was available offline), so the field stays a byte field and is pinned instead of being ruled informational. Exact components were not enough: Visual Studio and the Windows SDK service files inside unchanged version directories (`14.44.35207`, `10.0.26100.0`), and a runner image update to SDK servicing build 10.1.26100.9457 changed the release bytes (release dry run 40161785779). Since [ADR-0014](0014-ci-strategy.md) amendment 14 (2026-10-25), release builds therefore never read the image's Windows SDK: they use one unpacked from sha256-pinned payloads (`native/win32-job/toolchain-pin.json`). The MSVC toolset stays the image's Visual Studio Enterprise instance, chosen explicitly, because that installation is the licensing basis of the static runtime ([ADR-0015](0015-legal-and-provenance.md) item 12). Every build records the sha256 of the files it read, so any change in either shows by name.

## Alternatives considered

- npm as the package manager. Rejected (E3): no non-flat layout, install scripts allowed by default, no native release-age delay or catalogs.
- Yarn / Bun. Not discussed in the log beyond the E3 criteria; pnpm was chosen on merit.
- CommonJS or dual publishing. Rejected: ESM-only is the decision (A4). Dual output doubles the test matrix and the supply-chain surface [derived].
- Supporting Node 20 or lower. Rejected: engines `>=22.12.0`.
- Dropping Node 22 immediately. Rejected (E6): consumers on Node 22, Electron lines with Node 22 among them.
- Rush or Nx as monorepo tooling. Not adopted [derived]: pnpm workspaces and catalogs cover the need.

## Consequences

- `minimumReleaseAge` delays adoption of security fixes in dependencies; an explicit override procedure is needed.
- ESM-only excludes consumers who cannot load ESM; the `>=22.12.0` floor is the version range in which the log chose to operate.
- API Extractor adds a review step to every public API change.

## Evidence

- 06 §E3, §E6, §F.
- 04 §4 (pinned actions, least-privilege workflow), 02 §2.1 (CLI wrapper `node >=22`).
