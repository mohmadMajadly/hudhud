# ADR-0003: Public API shape

- Status: Accepted
- Date: 2026-10-12
- Negotiation log items: A3, B2, A10 (consumer-facing parts), A6 (JSON-only boundary) (06 §A)
- Related: [ADR-0002](0002-execution-modes-and-every-way-registry.md), [ADR-0004](0004-packages-and-versioning.md), [ADR-0007](0007-event-delivery-backpressure-timeouts.md), [ADR-0008](0008-turn-and-lifecycle-semantics.md)

## Context

Applications need a small surface that is safe by default and still exposes everything the harness can do. The harness evolves daily (02 §11: 20-30 SDK releases a month), so the public surface must tolerate unknown event types and fields without breaking consumers (03 §5 items 2, 3, 6).

## Decision

### Shape

```
connect() -> Harness
Harness  : capabilities, binary info, sessions.create() / sessions.resume()
Session  : ask(), send() -> Turn, events() (session-wide)
Turn     : { id, done, interrupt(), filtered iteration }
hudhud.session()  -- sugar over connect() + sessions.create()
```

- `Session.ask()` is the one-call convenience; `Session.send()` returns a `Turn` that can be awaited (`done`), iterated (filtered to that turn), and interrupted (`interrupt()`).
- `Session.events()` is the session-wide subscription. It is opt-in per subscriber with bounded queues ([ADR-0007](0007-event-delivery-backpressure-timeouts.md)). `ask()` and `turn.done` never depend on subscribers.
- The session-to-process binding is adapter-internal and may be one-to-many. The public API makes no promise that one `Session` equals one OS process.
- `Symbol.asyncDispose` and `AbortSignal` are supported everywhere. `dispose` means abort; `close()` means drain ([ADR-0008](0008-turn-and-lifecycle-semantics.md)).
- One-shot is a `Session` with degraded capabilities, not a separate operation (B2 option i, [ADR-0002](0002-execution-modes-and-every-way-registry.md)).

### Event model

- Open event union: every discriminated union has an arm of the form `type: string & {}` for unknown values, and every event carries the raw frame (mandatory raw passthrough).
- Consumers must be able to ignore unknown `type` and `subtype`; hudhud never throws on an unrecognized value (03 §5 item 2; the SDKs behave the same, 01 §2).
- Wire-level rules: ISO-8601 timestamps plus a monotonic `seq`, string ids, no `bigint` / `Date` / class instances in events, base64 for binary, optional fields are absent rather than `null` (see [ADR-0006](0006-sans-io-core-and-daemon-readiness.md)).

### ACP vocabulary alignment (ratified)

hudhud's core vocabulary mirrors ACP where ACP is sound: tool call kind and status, permission option kinds, stop reasons, `usage_update`. It remains an independent, versioned superset (turn-independent background activity, subagent tree, richer usage, mandatory raw passthrough, tri-state capabilities; 03 §7). The ACP adapters (client adapter, later facade) translate at the edge ([ADR-0018](0018-scope-and-roadmap.md)).

### Three API tiers

| Tier | Where | Stability promise |
|---|---|---|
| Stable | `hudhudjs`, `@hudhudjs/core`, `@hudhudjs/claude-code` | semver; additive-only schema |
| Harness-namespaced options | e.g. `claudeCode: { settingSources, ... }` options on the Claude Code adapter; `settingSources` lives here because it is a Claude-Code-specific mechanism, while the harness-neutral `workspaceTrust` maps to it | semver per adapter; tracked by the adapter's compatibility window |
| Unstable | `@hudhudjs/claude-code/raw` | exempt from compatibility promises ([ADR-0004](0004-packages-and-versioning.md)) |

Experimental fields and types use the `x-` prefix and are exempt from compatibility promises ([ADR-0005](0005-schema-and-validation.md)).

### Capabilities and diagnostics at connect

`Harness` exposes capabilities, binary information including `binary.verification` ([ADR-0011](0011-spawn-hygiene-and-binary-provenance.md)), a `securityPosture` diagnostic ([ADR-0012](0012-security-defaults-and-trust.md)), and emits the adapter `compat` event ([ADR-0004](0004-packages-and-versioning.md)).

The sketch of intended shapes is in [architecture.md](../architecture.md#public-api-sketch). It is design intent, not implemented.

## Alternatives considered

- Closed event union (exhaustive TS union with no unknown arm). Rejected: every CLI release can add event types; a closed union turns additive upstream changes into consumer compile or runtime failures (03 §5 items 2, 3).
- Expose ACP types as the public API (or make the wire schema be ACP). Rejected: ACP v2 was still Draft at research time and its one-request-one-turn model fits poorly with background work (03 §6, §7 item 4). ACP types never appear in the public API.
- One session equals one process, as a public guarantee. Rejected: adapters need freedom (for example one process serving several sessions; the log records only that the binding "may be one-to-many").
- Separate `run()` operation for one-shot. Rejected (B2).
- Throwing on unknown events. Rejected: see open union.

## Consequences

- Consumers must write `default:` branches. The documentation and the type design push them that way.
- Every normalized event carries both the normalized fields and the raw frame, which costs memory; subscriber queues are bounded in count and bytes ([ADR-0007](0007-event-delivery-backpressure-timeouts.md)).
- The `/raw` tier lets advanced users reach unmodelled CLI features without waiting for hudhud, at the price of no stability promise (02 §8: the CLI surface is at least the SDK surface).

## Evidence

- 03 §5 (event-model best practices), §7 (ACP alignment).
- 02 §3 (message routing), §8 (what the CLI exposes that the SDK does not).
- 05 §5 (event sequences), §15 (surprises).
