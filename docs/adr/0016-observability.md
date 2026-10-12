# ADR-0016: Observability

- Status: Accepted
- Date: 2026-10-12
- Negotiation log items: A18, A17 (compat event), D15 (06 §A, §D)
- Related: [ADR-0004](0004-packages-and-versioning.md), [ADR-0011](0011-spawn-hygiene-and-binary-provenance.md), [ADR-0012](0012-security-defaults-and-trust.md)

## Context

hudhud handles prompts, tool inputs, file paths and credentials-adjacent data. Diagnostics that leak these are a security problem in their own right. At the same time, diagnosing a daily-moving CLI requires rich information: versions, resolved binary, dropped env names, retry events, termination reasons.

## Decision

1. Redaction is mandatory in every diagnostic channel (logs, debug events, error messages, traces). Redaction is not an option that can be disabled per call. Values of environment variables are never emitted; only names (the dropped-name diagnostics of [ADR-0012](0012-security-defaults-and-trust.md)).
2. Distributed tracing is opt-in: when enabled, hudhud propagates `TRACEPARENT` (and no other trace context unless configured) to the harness process. The TS SDK injects `TRACEPARENT`/`TRACESTATE` from the active span (02 §2.5); hudhud makes it explicit and opt-in.
3. Usage reporting: usage is cumulative as reported by the harness, with estimated deltas computed by hudhud and marked as estimates (the CLI's cost figures are client-side estimates, 01 §1.1 `--max-budget-usd`).
4. Always-available structured diagnostics at connect: `compat` event ([ADR-0004](0004-packages-and-versioning.md)), binary information and `binary.verification` ([ADR-0011](0011-spawn-hygiene-and-binary-provenance.md)), `securityPosture` ([ADR-0012](0012-security-defaults-and-trust.md)), `processContainment` capability.
5. Surfaced harness events that matter operationally are not swallowed: `system/api_retry` (with attempt, delay and error category), `stalled` ([ADR-0008](0008-turn-and-lifecycle-semantics.md)), termination intent and outcome classification, subscriber overflow and gap markers ([ADR-0007](0007-event-delivery-backpressure-timeouts.md)).
6. Stderr: the CLI's stderr is captured with a bounded tail and attached to process-exit errors (as the TS SDK does with 2,048 characters, 02 §2.6), after redaction.

## Alternatives considered

- Verbose logging with opt-in redaction. Rejected: leaks by default.
- Always propagate trace context. Rejected: the trace identifiers of the host application would flow into a third-party process without consent.
- Report only harness-provided cost. Not chosen: harness figures can lag or be absent; the estimate must be labelled as such.
- A bundled telemetry backend. Rejected: R5 (services in Docker, not installed) and R1; hudhud only emits data.

## Consequences

- Redaction rules need tests (fixtures containing fake secrets) and an allowlist of fields that may be logged.
- Estimated usage deltas need a clear type distinction from reported values.

## Evidence

- 02 §2.5 (OTEL injection), §2.6 (stderr tail), §10.
- 05 §9 (`system/api_retry` frames), §12.
- 01 §1.1 (budget estimate), §3 (rate-limit events).
