# ADR-0001: Foundation and Claude Code backends

- Status: Accepted
- Date: 2026-10-12
- Negotiation log items: A1, A2 (06 §A)
- Related: [ADR-0015](0015-legal-and-provenance.md), [ADR-0013](0013-testing-strategy.md), [ADR-0011](0011-spawn-hygiene-and-binary-provenance.md)

## Context

hudhud drives locally installed agent harnesses for applications; Claude Code is first. The user installs and updates the harness; hudhud must never modify it (owner rule R6). Two official SDKs already spawn the CLI and speak a newline-delimited JSON protocol with it (02 §0). The TS SDK is proprietary ("All rights reserved"); the Python SDK is MIT (02 §9). The SDK adds no inference or agent logic on this path: it contributes binary resolution, option-to-argv mapping, callback registries, run-lifecycle logic, error mapping and typed messages (02 §0, §8).

## Decision

1. The foundation is hudhud's own implementation of the stream-json + control protocol against the user's installed, unmodified CLI.
2. Wire types are derived from observed frames (05) and from the MIT-licensed Python SDK, with a NOTICE file for attribution. Nothing is copied from the proprietary `sdk.d.ts` or `sdk.mjs`.
3. The Claude Code adapter has two backends:
   - `native`: hudhud's own protocol engine over any duplex byte stream. Sources of the stream: local spawn through hudhud's process layer, or a custom spawner supplied by the application.
   - `agent-sdk` (from v1.1): `@anthropic-ai/claude-agent-sdk` as an optional peer dependency. It is never redistributed or vendored. It is wired through the SDK's `spawnClaudeCodeProcess` option over hudhud's own process layer. It is also used as the CI differential oracle, likewise from v1.1 ([ADR-0013](0013-testing-strategy.md)).
4. No SDK-identity or entrypoint spoofing. The CLI in stream-json mode reports the entrypoint `sdk-cli` and the user agent `claude-cli/<version> (external, sdk-cli)` (05 §2); hudhud leaves that honest default alone and does not set `CLAUDE_CODE_ENTRYPOINT` to impersonate an SDK.
5. A legal review is required before open-sourcing (open owner decision 4, see [architecture.md](../architecture.md#open-owner-decisions)).
6. `native` is the foundation and the default backend (confirmed by the lead); `agent-sdk` is opt-in because its package is an optional peer. Both are specified here; the `agent-sdk` backend and the oracle ship from v1.1 to keep v1 small ([ADR-0018](0018-scope-and-roadmap.md)).

## Alternatives considered

- Wrap the TS Agent SDK as the only backend. Rejected: proprietary license forbids vendoring and redistribution (02 §9); the SDK pins its own binary and never falls back to the user's installed `claude` (02 §2.2), which conflicts with "drive locally installed harnesses"; its protocol is a moving target (321 releases in about a year, 02 §11) so hudhud would inherit its coupling without owning the protocol.
- Port the Python SDK. Rejected [derived]: it implements only a subset of host-to-CLI and CLI-to-host subtypes and lags the TS SDK (02 §8); hudhud needs the full lifecycle logic (turn, interrupt gating, termination) and its own sans-IO core ([ADR-0006](0006-sans-io-core-and-daemon-readiness.md)).
- Copy types from `sdk.d.ts`. Rejected: proprietary text, must not be copied (02 §9 assessment).
- Spoof the SDK entrypoint identity. Rejected: dishonest identification to the vendor; also unnecessary, because the honest `sdk-cli` default is what stream-json mode produces (05 §2).
- ACP as the foundation. Not chosen: hudhud's core vocabulary mirrors ACP where sound but remains an independent, versioned superset, and ACP types never appear in the public API ([ADR-0003](0003-public-api.md)). An ACP client adapter and an ACP facade are scheduled later ([ADR-0018](0018-scope-and-roadmap.md)). Evidence: 03 §7 recommends keeping native adapters for Claude Code because ACP adapters for it are third-party wrappers with documented gaps.

## Consequences

- hudhud owns protocol conformance and must keep up with CLI changes: this is the reason for the canary, fixtures and the oracle ([ADR-0013](0013-testing-strategy.md)) and for the changelog-triage duty ([ADR-0004](0004-packages-and-versioning.md)).
- The `agent-sdk` backend adds a second code path whose behaviour must be kept aligned through the same process layer.
- The CLI surface is at least the SDK surface by construction (02 §8, last bullet), so features not modelled by the SDK stay reachable.

## Evidence

- 02 §0 (the SDK is a subprocess wrapper), §2.2 (binary resolution), §8 (what the SDK adds), §9 (licensing), §12 (recommendation).
- 05 §2 (request headers and entrypoint), §5 (initialize optional, per-turn `system/init`).
- 03 §6, §7 (ACP interop facts).
