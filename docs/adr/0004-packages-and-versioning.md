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
| `@hudhudjs/core` | Harness-neutral core (amended by K3, 06 §K): subpath `/protocol` (neutral sans-IO pieces: event vocabulary, generic NDJSON encoding, the generic machine contract, exit-outcome classification); subpath `/process` (process layer, including the generic NDJSON framer); root entry (binding layer, public types, errors, securityPosture model); `schemas/` (committed neutral JSON Schema); schema pipeline tooling. It contains no harness's wire protocol. |
| `@hudhudjs/claude-code` | Claude Code adapter (`native` and `agent-sdk` backends); `src/protocol/` holds the Claude Code wire types and the Claude protocol state machines (control, permission, turn and interrupt gating, session) under the same sans-IO rules as core `/protocol` (K3); `schemas/` (committed Claude wire and option schemas); subpath `/raw` (unstable tier) |
| `hudhudjs` | Umbrella package: a zero-code re-export with exact-version dependencies, so `npm i hudhudjs` is the simple path. It must never contain logic (E4). |
| `@hudhudjs/win32-job-x64`, `@hudhudjs/win32-job-arm64` | Optional platform packages carrying the prebuilt Windows job-object addon ([ADR-0009](0009-process-layer-windows.md)). K17 (lead ruling on A2, 2026-10-16): `@hudhudjs/win32-job-arm64` stays `private` in v1, without `publishConfig`, so it cannot be published by accident; it is still built (A3) but not first-class. |

As accepted, the names were working names until the owner reserved the npm scope `@hudhud` and the name `hudhud` before the first publish (owner decision 3; both packages returned 404 on npm at research time).

Amendment (owner decision, 2026-10-16): the npm names are the scope `@hudhudjs` for every workspace package (`@hudhudjs/core`, `@hudhudjs/claude-code`, `@hudhudjs/win32-job-x64`, `@hudhudjs/win32-job-arm64`, and the private, never published `@hudhudjs/test-support`) and the unscoped `hudhudjs` for the umbrella; the table above uses them. Reason: the working names could not be had. The scope `@hudhud` belongs to another npm account, and npm refused the unscoped name `hudhud` as too similar to the existing package `hud-hud`. The owner holds the npm org `hudhudjs` and the unscoped package `hudhudjs` (a placeholder is published). Only the package names change: the project name hudhud, the `HUDHUD_*` environment variables, type, function and error-code names, the directory names (`packages/hudhud` holds `hudhudjs`) and the repository stay as they are. Nothing of hudhud had been published under the old names, so no deprecation or migration path is needed.

### Versioning layers

1. Library semver for each package.
2. Wire-schema version: an integer, plus capability strings for fine-grained features (03 §5 item 4).
3. Adapter API: an integer `adapterApiVersion`, negotiated at adapter registration. An adapter built against an unsupported integer is refused at registration, not at first use.
4. Per-adapter tested window: `minTested`, `maxTested`, `knownBroken` harness versions, reported as a `compat` event at connect. An untested version is a warning event, never a hard failure (03 §5 item 10). Feature detection uses `system/init.capabilities` and `initialize.claude_code_version`, not version sniffing.

   Amendment (lead decision, Wave 4 closer, 2026-10-14): a version listed in `knownBroken` is refused at connect by default, with the registered error code `HARNESS_VERSION_KNOWN_BROKEN` (not retryable; `details.version`, `details.reason`, the committed reason of the listing). An explicit boolean opt-in per adapter runs it anyway (Claude Code: `claudeCode.dangerouslyAllowKnownBrokenVersion: true`); the opt-in is listed in `securityPosture` and the `compat` status stays `known-broken`. Reason: a `knownBroken` entry is a deliberate, reviewed statement that the version misbehaves with hudhud, unlike an untested version, so the safe default is to refuse it while still providing every way to run it. Untested versions stay a warning, as above.

   Amendment (lead decision, Wave 5, W5 ruling 1, 2026-10-14): version drift. A session compares the version its harness reports at the handshake (Claude Code: `initialize.claude_code_version`) with the version the connect probe reported. Every drift emits the diagnostic `binary.version-changed` (`probedVersion`, `version`, `knownBroken`). A drifted version that is listed in `knownBroken` fails the session closed: the handshake fails with `HARNESS_VERSION_KNOWN_BROKEN` (`details.version`, `details.reason`, `details.probedVersion`), the termination ladder runs and no turn is written, unless the same opt-in is set (then the drift is a warning only). An `untested` drift is a warning only. The reason travels in the session configuration as the committed text of the listing; harness output is never copied into it. Reason: a binary can change between connect and a session (an update in place, a launcher pointing to a new version), and a known-broken version must not run silently because it appeared after the probe. A session that finds the binary file changed before its spawn re-verifies and re-probes it first (ADR-0011) and reports the change the same way.
5. The `/raw` tier is exempt from compatibility promises.

### Operational duty

Changelog triage for every CLI release. This is a standing maintenance task, not an event: the nightly canary ([ADR-0013](0013-testing-strategy.md)) tests each newly published CLI version and reports the result; the lead triages the CLI changelog and prepares the version-bump PR locally (amended by K16, 06 §K: scheduled jobs hold no write tokens, so the canary does not open PRs).

## Alternatives considered

- Single package. Rejected: the Windows addon is binary and platform-specific; the process layer and core must stay importable without the Claude Code adapter; adapters for other harnesses are planned.
- Claude Code wire types and protocol machines in `@hudhudjs/core` (the original reading of the layer diagram). Rejected by K3 (06 §K): the core would encode one harness's protocol, contrary to the multi-harness rule R3.
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
