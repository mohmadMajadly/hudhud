# ADR-0015: Legal posture and code provenance

- Status: Accepted as engineering policy. Owner decision 4 (2026-10-12): the owner confirmed the legal review. Nothing in this ADR is legal advice.
- Date: 2026-10-12
- Negotiation log items: A1, A2, R1 (06 header, §A)
- Related: [ADR-0001](0001-foundation-and-backends.md), [ADR-0011](0011-spawn-hygiene-and-binary-provenance.md), [ADR-0012](0012-security-defaults-and-trust.md)

## Context

The hudhud repository is private now and planned to become open source. Facts from 02 §9 (fetched 2026-10-12; the interpretation is UNVERIFIED):

- The TS Agent SDK is proprietary ("All rights reserved. Use is subject to the Legal Agreements"); the SDK's repository license points to the Commercial Terms of Service.
- The Python SDK code is MIT-licensed; its README still says use is governed by the Commercial Terms.
- The Claude Code legal and compliance page: preinstalling or running Claude Code in products requires agreeing to the Commercial Terms; the binary must not be modified; authentication methods must not be removed, disabled or restricted; customers may not pay for or resell Claude usage on behalf of end users; third-party developers may not offer claude.ai login or route requests through Free/Pro/Max credentials on behalf of users, nor collect, store or intermediate claude.ai credentials or session tokens; the Claude Code or Anthropic names and logos may not be part of a product, feature or company name.

## Decision

1. Protocol types are derived independently: from observed frames (05) and from the MIT Python SDK, with a NOTICE file for attribution. Nothing is copied from `sdk.d.ts`, `sdk.mjs` or other proprietary SDK files, including minified code.
2. The TS SDK is used only as an optional peer dependency, installed by the user under Anthropic's terms. hudhud never vendors, copies or redistributes it. It is also used as the CI differential oracle, from v1.1 ([ADR-0013](0013-testing-strategy.md)); the oracle is not distributed.
3. hudhud never bundles or redistributes the `claude` binary. It runs the user's installed, unmodified binary and does not modify it (R6).
4. hudhud never collects, stores or proxies OAuth tokens or claude.ai session tokens. hudhud has no login flow. The SDK features `getOAuthToken` and `claude_authenticate` (02 §9) are not implemented. Each end user authenticates with their own credentials through the harness.
5. The product name does not include "Claude Code" or "Anthropic"; describing hudhud plainly as driving Claude Code is acceptable. The owner reserves the npm names before the first publish (owner decision 3).
6. No identity spoofing: the entrypoint stays at the honest default ([ADR-0001](0001-foundation-and-backends.md)).
7. Binary provenance checking is advisory ([ADR-0011](0011-spawn-hygiene-and-binary-provenance.md)).
8. A legal review is a precondition of open-sourcing; the owner confirmed it (owner decision 4). This policy stays binding regardless.
9. Third-party licenses of dependencies are tracked as part of the toolchain ([ADR-0017](0017-toolchain.md)); published packages carry provenance.

## Alternatives considered

- Vendoring the TS SDK's types for convenience. Rejected: copying proprietary text is forbidden by 02 §9.
- Porting the Python SDK verbatim. Not chosen: MIT permits it with attribution, but hudhud's design differs materially ([ADR-0001](0001-foundation-and-backends.md)); ideas and observed behaviour are used, with a NOTICE.
- Redistributing the CLI binary with the library for convenience. Rejected: legal page and 02 §9 assessment.
- Offering a login helper that stores tokens. Rejected: prohibited credential handling.
- Skipping the legal review because nothing is copied. Rejected: owner rule R1 and the UNVERIFIED nature of the interpretation.

## Consequences

- hudhud cannot offer "managed" Claude access to end users; applications that embed it must meet Anthropic's terms themselves.
- Documentation must tell integrators that the harness must be installed and licensed by the end user or by them under the Commercial Terms.
- A NOTICE file and a dependency license audit are release requirements.

## Evidence

- 02 §9 (licensing quotes and assessment), §10 item 5 (credential copying design to avoid), §12.
- 01 §1.6 (hidden flags; semantics unverified), §5 (auth ways).
- 06 §A1.
