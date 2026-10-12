# ADR-0017: Toolchain

- Status: Accepted
- Date: 2026-10-12
- Negotiation log items: A4, E3, E6, F (E6: Node >=22.12.0), A5, A6 (06 §A, §E, §F)
- Related: [ADR-0004](0004-packages-and-versioning.md), [ADR-0005](0005-schema-and-validation.md), [ADR-0009](0009-process-layer-windows.md), [ADR-0014](0014-ci-strategy.md)

## Context

hudhud is security-sensitive and other sensitive projects build on it. The supply chain of the repository itself is part of the attack surface. Owner rule R5: toolchains may be installed on the host; services (if ever needed) run in Docker.

## Decision

### Package manager: pnpm (E3, on merit)

Reasons recorded: strict non-flat `node_modules` (no phantom dependencies); install scripts blocked by default with an explicit `onlyBuiltDependencies` allowlist; `minimumReleaseAge` to delay freshly published (possibly hijacked) versions; catalogs for single-version dependencies across the monorepo; a deterministic lockfile. Consumers are unaffected: they install published packages with any manager. Initial value (lead decision, tunable): `minimumReleaseAge` 7 days (10080 minutes), with an explicit, reviewed exclusion list for the pinned CLI/SDK test packages, used only when the canary needs a fresh version. The `onlyBuiltDependencies` allowlist starts empty because the Windows addon is distributed prebuilt ([ADR-0009](0009-process-layer-windows.md)).

### Runtime and language

- Node `engines`: `>=22.12.0` (F amends E6's `>=22`). Node 22 is in maintenance until 2027-04; it is dropped in a major version after its end of life. The driver is the consumer base (Electron 33+ ships Node 22).
- CI Node matrix: 22, 24, 26 ([ADR-0014](0014-ci-strategy.md)).
- ESM-only output; TypeScript.

### Release and API discipline

- Changesets for versioning and changelogs.
- API Extractor to produce and review the public API report (guards the stable tier, [ADR-0003](0003-public-api.md)).
- Published with npm provenance; the platform addon packages included ([ADR-0004](0004-packages-and-versioning.md), [ADR-0009](0009-process-layer-windows.md)).

### Build-time-only dependencies

TypeBox (major pinned), Ajv (standalone generation), esbuild (bundling generated validators), `json-schema-to-typescript` (documented fallback) ([ADR-0005](0005-schema-and-validation.md)). Lint and dependency-cruiser enforce that the sans-IO core has no I/O imports ([ADR-0006](0006-sans-io-core-and-daemon-readiness.md)).

### Native build

CMake + MSVC for the Windows addon, x64 and ARM64, plain C against `node_api.h` ([ADR-0009](0009-process-layer-windows.md)).

## Alternatives considered

- npm as the package manager. Rejected (E3): no non-flat layout, install scripts allowed by default, no native release-age delay or catalogs.
- Yarn / Bun. Not discussed in the log beyond the E3 criteria; pnpm was chosen on merit.
- CommonJS or dual publishing. Rejected: ESM-only is the decision (A4). Dual output doubles the test matrix and the supply-chain surface [derived].
- Supporting Node 20 or lower. Rejected: engines `>=22.12.0`.
- Dropping Node 22 immediately. Rejected (E6): Electron 33+ consumers.
- Rush or Nx as monorepo tooling. Not adopted [derived]: pnpm workspaces and catalogs cover the need.

## Consequences

- `minimumReleaseAge` delays adoption of security fixes in dependencies; an explicit override procedure is needed.
- ESM-only excludes consumers who cannot load ESM; the `>=22.12.0` floor is the version range in which the log chose to operate.
- API Extractor adds a review step to every public API change.

## Evidence

- 06 §E3, §E6, §F.
- 04 §4 (pinned actions, least-privilege workflow), 02 §2.1 (CLI wrapper `node >=22`).
