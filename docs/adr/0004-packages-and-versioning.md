# ADR-0004: Packages, versioning and adapterApiVersion

- Status: Accepted
- Date: 2026-10-12
- Negotiation log items: A4, A17, E4 (06 §A, §E)
- Related: [ADR-0005](0005-schema-and-validation.md), [ADR-0009](0009-process-layer-windows.md), [ADR-0017](0017-toolchain.md)

## Context

hudhud is a TypeScript-primary monorepo that will be consumed by applications on Windows, Linux and macOS, later by other languages. The Claude Code CLI ships a new version roughly daily (02 §11), so version coupling must be explicit and observable, not implicit.

## Decision

### Packages (pnpm monorepo, ESM-only)

| Package | Content |
|---|---|
| `@hudhud/core` | Harness-neutral core (amended by K3, 06 §K): subpath `/protocol` (neutral sans-IO pieces: event vocabulary, generic NDJSON encoding, the generic machine contract, exit-outcome classification); subpath `/process` (process layer, including the generic NDJSON framer); root entry (binding layer, public types, errors, securityPosture model); `schemas/` (committed neutral JSON Schema); schema pipeline tooling. It contains no harness's wire protocol. |
| `@hudhud/claude-code` | Claude Code adapter (`native` and `agent-sdk` backends); `src/protocol/` holds the Claude Code wire types and the Claude protocol state machines (control, permission, turn and interrupt gating, session) under the same sans-IO rules as core `/protocol` (K3); `schemas/` (committed Claude wire and option schemas); subpath `/raw` (unstable tier) |
| `hudhud` | Umbrella package: a zero-code re-export with exact-version dependencies, so `npm i hudhud` is the simple path. It must never contain logic (E4). |
| `@hudhud/win32-job-x64`, `@hudhud/win32-job-arm64` | Optional platform packages carrying the prebuilt Windows job-object addon ([ADR-0009](0009-process-layer-windows.md)) |

Names are working names until the owner reserves the npm scope `@hudhud` and the name `hudhud` before the first publish (owner decision 3; both packages returned 404 on npm at research time).

### Versioning layers

1. Library semver for each package.
2. Wire-schema version: an integer, plus capability strings for fine-grained features (03 §5 item 4).
3. Adapter API: an integer `adapterApiVersion`, negotiated at adapter registration. An adapter built against an unsupported integer is refused at registration, not at first use.
4. Per-adapter tested window: `minTested`, `maxTested`, `knownBroken` harness versions, reported as a `compat` event at connect. An untested version is a warning event, never a hard failure (03 §5 item 10). Feature detection uses `system/init.capabilities` and `initialize.claude_code_version`, not version sniffing.
5. The `/raw` tier is exempt from compatibility promises.

### Operational duty

Changelog triage for every CLI release. This is a standing maintenance task, not an event: the nightly canary ([ADR-0013](0013-testing-strategy.md)) tests each newly published CLI version and reports the result; the lead triages the CLI changelog and prepares the version-bump PR locally (amended by K16, 06 §K: scheduled jobs hold no write tokens, so the canary does not open PRs).

## Alternatives considered

- Single package. Rejected: the Windows addon is binary and platform-specific; the process layer and core must stay importable without the Claude Code adapter; adapters for other harnesses are planned.
- Claude Code wire types and protocol machines in `@hudhud/core` (the original reading of the layer diagram). Rejected by K3 (06 §K): the core would encode one harness's protocol, contrary to the multi-harness rule R3.
- Umbrella with logic or ranged dependencies. Rejected (E4): the umbrella exists for convenience only; exact versions keep installs reproducible and security review simple.
- Pre-1.0 semver as in the SDKs (breaking changes announced inline, 02 §11). Rejected [derived]: other sensitive projects build on hudhud and need an explicit compatibility contract.
- Version the schema with the library only. Rejected: language bindings need a schema version independent of the TypeScript package version (03 §5 item 4).
- Hard-fail on untested harness versions. Rejected: a daily-moving CLI would make hudhud unusable between canary runs.

## Consequences

- Publishing a platform addon requires a separate package per OS/arch with provenance ([ADR-0009](0009-process-layer-windows.md), [ADR-0017](0017-toolchain.md)).
- Removing an event type or field requires a major bump; the additive-only diff linter enforces this on the committed schema ([ADR-0005](0005-schema-and-validation.md)).
- Maintenance has a fixed per-CLI-release cost (changelog triage).

## Evidence

- 02 §11 (changelog analysis, cadence, breaking changes), §1 (SDK minor tracks CLI patch).
- 03 §5 items 4, 6, 10.
- 05 §5 (`system/init.capabilities` observed).
