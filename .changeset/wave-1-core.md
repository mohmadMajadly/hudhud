---
'@hudhud/core': minor
'hudhud': minor
---

Wave 1 foundations of the harness-neutral core.

- `@hudhud/core`: neutral JSON, capability, security-posture and event types; the closed `HudhudErrorCode` table with one `HudhudError` subclass per code and an open `ErrorData` (unknown codes accepted on read, ADR-0005 §6); `SubscriberOptions` and `OverflowPolicy`; redaction (`redactText`, `redactJson`, `secretsFromEnv`, `credentialEnvNames`), the bounded redacted `StderrTail` and usage estimation; `wireSchemaVersion`.
- `@hudhud/core/protocol`: `parseJsonLine` and own-property JSON accessors that keep `__proto__` inert, `encodeJsonLine` with the 32 MiB outbound cap, errors as data (`makeErrorData`, `parseErrorData`, retryability).
- `@hudhud/core/process`: the bounded NDJSON framer (64 MiB default cap, fail-fast oversized lines), `formatFlag` and reserved-flag guard, `resolveExecutable` (refuses `.bat`/`.cmd`), `validateCwd` (Windows 258-unit limit), identity-bound `sha256File`, process-table parsers (Linux `/proc`, macOS `ps`, Windows CIM with start times in microseconds) and termination-ladder types.
- Committed JSON Schemas (`@hudhud/core/schemas/*`) for events, errors, capabilities, posture and conformance fixtures, with precompiled validators and no run-time schema dependency.
- `hudhud` re-exports the new `@hudhud/core` root exports.
