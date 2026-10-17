# ADR-0006: Sans-IO core, serialization rules and daemon readiness

- Status: Accepted
- Date: 2026-10-12
- Negotiation log items: A6, A7, E5 (06 §A, §E)
- Related: [ADR-0003](0003-public-api.md), [ADR-0005](0005-schema-and-validation.md), [ADR-0013](0013-testing-strategy.md), [ADR-0018](0018-scope-and-roadmap.md)

## Context

Future bindings for other languages are an owner requirement (R3). Native ports of the protocol engine in every language would multiply the security surface. A deterministic, I/O-free core is also the best testing target: golden fixtures replay frames and assert state transitions without processes or timers.

Sans-IO applied to everything adds cost without payoff (E5): the process layer and the binding layer are inherently I/O.

## Decision

### Sans-IO scope (E5)

Strictly sans-IO: the protocol, turn and permission state machines. Pure functions of the form `(state, input) -> (state, effects[])`, with an injected clock and injected id generator. The core has no I/O imports; this is enforced by lint rules and dependency-cruiser.

Placement (amended by K3, 06 §K): there are two sans-IO directories. `@hudhudjs/core` `/protocol` (`packages/core/src/protocol/`) holds only harness-neutral pieces: the event vocabulary, generic NDJSON encoding, exit-outcome classification and the generic machine contract (`HarnessMachine`: `initialState`, `step`, neutral inputs and effects) that the binding layer drives. Each adapter implements its harness's protocol as machines against that contract in its own sans-IO directory; for Claude Code that is `packages/claude-code/src/protocol/` (wire types, control correlator, permission, turn and interrupt gating, session). The same ESLint and dependency-cruiser rules apply to both directories: no Node built-ins, no ambient time or randomness, no npm runtime dependencies, no process or binding layer; the adapter's sans-IO directory may import only `@hudhudjs/core/protocol` and files inside itself. The core must contain no harness wire vocabulary.

Ordinary async code: the process layer ([ADR-0009](0009-process-layer-windows.md), [ADR-0010](0010-process-layer-posix.md)) and the binding layer. TS closures (handlers, callbacks) belong to the binding layer.

### Callbacks

Callbacks into the application (permission handlers, later hooks and tools) are modelled in the core as id-correlated request/response messages with an optional deadline and a cancel message. The core emits an effect "ask the application X with id N"; the binding layer turns it into a closure call and feeds the answer, a timeout or a cancel back as an input.

As built (W7-T5): for permissions the binding feeds `cmd.permission` (the handler's decision) or `cmd.permission-error` (no valid decision; the machine answers fail-closed); a withdrawal by the harness, on close or on abort is the machine's own `permission.cancel` effect, which aborts the handler's signal. The contract's third answer input, `cmd.permission-abort`, is internal: no application call produces it, and it exists so that the conformance replay can feed a recorded answer hudhud never writes (a control error for a permission request) through `SessionDriver.command`. A machine must still end the ask when it arrives, never with an allow.

### JSON-only boundary

Everything crossing the core boundary is JSON:

- timestamps as ISO-8601 strings, plus a monotonic `seq`;
- ids as strings;
- no `bigint`, `Date` or class instances;
- binary as base64;
- optional means absent (never `null` as a stand-in);
- errors are data (a typed object in an event or response), not thrown across the boundary.

A loopback binding ships in v1 and proves the boundary: the same core is driven through a serialize/deserialize round trip in tests.

### Golden fixtures

Golden fixtures are language-neutral JSONL conformance suites (frames in, effects and events out). They are the shared contract for any future binding. The fixture line format is a neutral schema in the core; the suites for a harness live with its adapter (for Claude Code: `packages/claude-code/conformance/`, K3).

### Daemon readiness (A7)

Multi-language support comes later from a daemon, not from native ports:

- JSON-RPC 2.0 over NDJSON;
- local authenticated channel only; never TCP by default;
- thin generated clients per language, generated from the committed schema ([ADR-0005](0005-schema-and-validation.md)).

The daemon is out of v1 scope ([ADR-0018](0018-scope-and-roadmap.md)). v1 only guarantees that the core boundary is daemon-ready.

## Alternatives considered

- Sans-IO for everything including process management. Rejected (E5): determinism gain is concentrated in state machines; process code is dominated by OS behaviour that must be tested against real processes.
- Native ports of the core to each language. Rejected (A7): duplicates a security-sensitive engine per language.
- Callbacks as direct closures inside the core. Rejected: makes the core language-bound and non-serializable; breaks the daemon path.
- Daemon over TCP by default. Rejected: security. The channel is local and authenticated ([ADR-0012](0012-security-defaults-and-trust.md): whoever controls the CLI's stdin has the agent's full authority; the same reasoning applies to a daemon channel).
- Protobuf or gRPC for the daemon. Not adopted; JSON-RPC over NDJSON keeps the same JSON model as the harness protocol.

## Consequences

- Core tests are fast and deterministic: virtual clock, fixed ids, no sockets.
- The binding layer is the only place with timers and process handles; handler timeouts live there ([ADR-0007](0007-event-delivery-backpressure-timeouts.md)).
- Every public type must be expressible in JSON Schema, which constrains API design (no `Date`, no `bigint` in events).

## Evidence

- 02 §12 (recommendation: pluggable duplex transport; control-protocol router), §4.1 (request correlation and cancel).
- 03 §5 items 1, 7, 8, 14 (envelope, ordering, replay, schema as source of truth).
- 05 §5 (frame sequences used as fixtures).
