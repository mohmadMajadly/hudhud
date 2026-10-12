# ADR-0005: Schema and validation

- Status: Accepted
- Date: 2026-10-12
- Negotiation log items: A5, E2, F (tarball-install check) (06 §A, §E, §F)
- Related: [ADR-0004](0004-packages-and-versioning.md), [ADR-0006](0006-sans-io-core-and-daemon-readiness.md), [ADR-0017](0017-toolchain.md)

## Context

The wire model must serve TypeScript now and other languages later (owner rule R3). The CLI protocol evolves additively but fast (02 §11). Validation must be strict where hudhud is the author (inputs, outbound frames) and lenient where the harness is the author (inbound), otherwise every CLI addition breaks sessions.

The Ajv standalone code generator can emit `require("ajv/dist/runtime/...")` for some keywords (helpers such as `ucs2length`, `equal`, `uri`, the validation error class). Therefore "zero runtime schema dependency" holds only if those helpers are bundled into the generated module or the keywords are avoided (E2).

## Decision

1. The contract is a committed JSON Schema, draft 2020-12. Harness-neutral schemas (events, errors, capabilities, posture, conformance format) live under `@hudhud/core/schemas/`; each adapter owns the schemas of its harness's wire and options under its own `schemas/` (for Claude Code: `@hudhud/claude-code/schemas/`). The pipeline tooling below is shared (amended by K3, 06 §K).
2. Authoring uses TypeBox, build-time only, with the major version pinned. A documented fallback exists: `json-schema-to-typescript` generating types from hand-maintained JSON Schema. TypeBox is not a runtime dependency of any published package.
3. Validators are precompiled from the committed schema with Ajv standalone code generation. No runtime `eval`/`new Function`; zero runtime schema dependency.
4. Ajv runtime helpers that the generated code would `require` are bundled into the generated module at build time (esbuild). Two checks guard this:
   - a CI check that the published `dist` contains no import of `ajv`;
   - a tarball-install check: pack the published tarballs, install them into a clean project without dev dependencies, and import and run them (F).
5. An additive-only diff linter compares the committed schema against the previous release and fails on removals, renames, narrowing, or new required fields.
6. Open enums: every enum accepts unknown values on read. Experimental fields and types live in the `x-` namespace and are exempt from compatibility promises. Raw passthrough is mandatory on every event.
7. Validation modes:
   - public inputs: strict;
   - outbound frames (hudhud to harness): strict;
   - inbound frames (harness to hudhud): lenient, envelope-only (the `type`/`subtype`/ids hudhud needs for routing), unknown content preserved in `raw`.

## Alternatives considered

- Zod as the authoring and runtime validator. Rejected [derived]: introduces a runtime schema dependency and a TypeScript-defined contract; A5 requires a language-neutral committed JSON Schema and zero runtime schema dependency.
- Protocol Buffers. Rejected [derived]: the harness speaks JSON, so the schema would describe a format the wire does not use; 03 §5 item 14 names Protobuf only as one possible source of truth for bindings, and A5 chose JSON Schema.
- TypeSpec. Rejected [derived]: adds a new compiler toolchain as source of truth where JSON Schema plus TypeBox already covers the need; same reference, 03 §5 item 14.
- Ajv at runtime (compile on load). Rejected: runtime code generation and a runtime dependency.
- TypeBox at runtime. Rejected: runtime dependency; the committed schema, not the TypeBox source, is the contract.
- Strict inbound validation. Rejected: the CLI adds optional fields on most releases and "a CLI that predates it ignores it" (02 §11); strict inbound validation would turn additions into failures.

The negotiation log records the rejection of Zod, Protobuf and TypeSpec without detailed reasons; the rationale marked [derived] above is inferred from the criteria stated in A5.

## Consequences

- Build requires TypeBox and Ajv as dev dependencies only.
- The generated validator module is a build artifact checked by the tarball-install test; any new schema keyword that makes Ajv emit a new runtime helper is caught by the "no ajv import" check.
- Bindings for other languages can be generated from the committed schema without the TypeScript sources.
- Because inbound validation is envelope-only, semantic validation of CLI frames is done by fixtures and the canary, not by the runtime ([ADR-0013](0013-testing-strategy.md)).

## Evidence

- 02 §4 (control protocol catalog), §11 (additive evolution, optional fields).
- 03 §5 (open unions, additive-only evolution, JSON Schema as source of truth, `x-` namespace).
- 05 §5 (observed frames differ from `sdk.d.ts` 0.3.296: `pid`, `current_permission_mode`, `session_state`, `capabilities` on the `initialize` response are not in the SDK types).
