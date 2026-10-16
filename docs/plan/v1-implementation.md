# hudhud v1 implementation plan

Status: build contract, 2026-10-12. Derived from [architecture.md](../architecture.md), the [ADRs](../adr/README.md) 0001-0018 and the research snapshots 01, 02, 05, 06 (sections A-K) and 07. Where the documents left a choice to implementation, this plan decides on merit and marks it **plan decision** with a one-line reason. The lead's rulings on the open points of the first draft are recorded in [Lead rulings (K1-K23)](#8-lead-rulings-k1-k23) and are applied throughout; the ADRs and the architecture document were amended to match (06 §K).

Conventions:

- "ADR-00NN §x" points to the numbered or titled section of that ADR; "05 §x" and "07 §x" point to research snapshots; "Kn" points to a lead ruling in §8.
- File paths are relative to the repository root. `S/sandbox/...` is the spike scratch workspace (not in the repository), used here only as the seed for the test infrastructure.
- Sizes: S (under 200 lines including tests), M (200-600), L (600-1500), XL (over 1500).
- Model tiers: **Opus** for process/OS/security/concurrency/protocol state machines; **Sonnet** for well-specified work.

## Contents

1. [Module map](#1-module-map)
2. [Public API for v1](#2-public-api-for-v1)
3. [Error taxonomy](#3-error-taxonomy)
4. [Test strategy](#4-test-strategy)
5. [Work breakdown into waves](#5-work-breakdown-into-waves)
6. [Windows job-object addon track](#6-windows-job-object-addon-track)
7. [Risks and de-risking order](#7-risks-and-de-risking-order)
8. [Lead rulings (K1-K23)](#8-lead-rulings-k1-k23)

---

## 1. Module map

### 1.1 Package and directory layout

The core is harness-neutral; everything that encodes the Claude Code stream-json and control protocol lives in the adapter (K3).

```
packages/
  core/                         @hudhudjs/core (published, stable tier, harness-neutral)
    schema-src/                 TypeBox sources for neutral schemas (build time only, not published)
    schemas/                    committed JSON Schema 2020-12: events, errors, capabilities, posture, conformance format
    src/
      index.ts                  root entry: binding layer, errors, public types
      protocol/                 /protocol entry: neutral sans-IO pieces (lint + depcruise enforced)
        generated/              Ajv standalone validators for neutral schemas (bundled, committed)
        json.ts                 JsonValue types and guards
        encode.ts               generic NDJSON line encoder with outbound cap
        events/                 neutral event vocabulary (types) and display sanitizer
        machine/                neutral machine contract (inputs, effects) and exit-outcome classifier
        errors.ts               ErrorData (errors as data), codes, retryability
        capabilities.ts         neutral capability types
      process/                  /process entry: ordinary async code
        framer.ts, spawn.ts, argv.ts, binary-path.ts, cwd.ts, hash.ts
        tree/                   process-table snapshots (Linux /proc, darwin ps)
        ladder/                 termination ladders (types, posix, windows)
        sweep.ts, taskkill.ts
        verify/                 OS signature and digest verification
        containment/            optional Windows job addon loader
        os/                     thin OS syscall adapters (coverage-scoped per OS)
      binding/                  ordinary async: generic driver, handles, queues, clock, loopback
      observability/            redaction, stderr tail, usage estimation
      security/                 securityPosture model and builder
  claude-code/                  @hudhudjs/claude-code (published)
    schema-src/                 TypeBox sources: Claude wire schemas, option schemas
    schemas/                    committed JSON Schema: wire-inbound, wire-outbound, options
    conformance/                golden JSONL conformance suites for the Claude protocol machines
    src/
      index.ts                  connect, session, hudhud namespace, option types
      protocol/                 Claude sans-IO (same lint + depcruise rules as core/protocol)
        generated/              Ajv validators for the wire schemas
        wire/                   stream-json + control protocol: types, inbound, outbound
        machine/                control, permission, turn, session machines (implement the core contract)
        events/                 Claude frame -> neutral event normalization, tool-kind mapping
      generated/                Ajv validators for the option schema
      options.ts, argv.ts, env.ts, rules.ts, settings-guard.ts
      discovery.ts, provenance.ts, known-binaries.ts
      posture.ts, capabilities.ts, compat.ts, registry.ts
      adapter.ts, connect.ts, session-factory.ts
      raw/index.ts              /raw entry: unstable tier
  hudhud/                       hudhudjs: umbrella (re-exports only, exact versions)
  win32-job-x64/                @hudhudjs/win32-job-x64 (prebuilt .node only)
  win32-job-arm64/              @hudhudjs/win32-job-arm64 (built, not shipped first-class in v1, K17)
native/win32-job/               plain C addon source, CMake, delay-load hook, committed release manifests
tooling/
  cli-pin.json                  pinned CLI version, per-platform sha512 + sha256 + size
  test-support/                 private workspace package (never published)
    src/mock/                   in-process mock Messages API + egress trap
    src/cli/                    pinned CLI fetch, verify, cache; newest-version fetch for the canary
    src/launcher/               sandboxed test launcher (testConnect)
    src/fixtures/               golden fixture recorder and normalizer; record/: the suite scripts and the
                                recording driver (pnpm fixtures:record, W3-Z)
    src/leaks/                  process-leak assertions
    src/snapshots/              request-shape structural snapshots
    src/canary/                 degradation classifier, local bump helper
  macos-gate/                   one-off macOS gate scripts (workflow_dispatch); as built a plain
                                directory, not a workspace package: it imports test-support and core
                                sources by relative path and its tests run in the `unit` project
scripts/
  schema/                       schema build, check, additive diff linter (logic in scripts/lib/schema/)
  addon/                        digest manifest writer, addon build wrapper
```

Plan decision: test infrastructure lives in a private workspace package under `tooling/` (added to `pnpm-workspace.yaml`), not under `packages/`. Reason: `scripts/api-report.mjs` treats every `packages/*` entry as a published API, and depcruise already forbids `packages/*/src` from importing tooling.

As built (package rename, 2026-10-16; owner decision, ADR-0004 amendment): the npm package names are `@hudhudjs/<name>` for every workspace package (`@hudhudjs/core`, `@hudhudjs/claude-code`, the private `@hudhudjs/test-support`, and the planned `@hudhudjs/win32-job-x64` and `@hudhudjs/win32-job-arm64`) and `hudhudjs` for the umbrella, replacing the working names `@hudhud/*` and `hudhud`: the scope `@hudhud` belongs to another npm account, and npm refused `hudhud` as too similar to `hud-hud`. This plan uses the new names throughout. The rename covers the manifests, workspace dependencies, every import and subpath specifier, the ESLint and dependency-cruiser rules, the smoke tests, `WIN32_JOB_ADDON_SPECIFIER` (`@hudhudjs/win32-job-x64/hudhud_win32_job.node`), the regenerated API reports (only the package names changed), the package keys of the pending changesets and the lockfile; one changeset per published package records it. Unchanged: the directory names (`packages/hudhud/` holds `hudhudjs`; its report stays `api/hudhud.api.md`), the project name, the exported `hudhud` binding, `HUDHUD_*` variables, error codes and the `urn:hudhud:` schema id prefix. The `recorder` field of `packages/claude-code/conformance/manifest.json` keeps `@hudhud/test-support`: it records the recorder that wrote the fixtures at their `recorderRevision`, and the next `pnpm fixtures:record` writes the new name (`RECORDER` in `tooling/test-support/src/fixtures/record/record.ts`).

### 1.2 Layering (dependency-cruiser and ESLint)

Existing rules stay ([.dependency-cruiser.mjs](../../.dependency-cruiser.mjs), [eslint.config.js](../../eslint.config.js)). Two sans-IO directories exist after K3: `packages/core/src/protocol/` (neutral) and `packages/claude-code/src/protocol/` (Claude protocol). Additions and changes in task W0-T1:

| Rule | From | Forbidden to | ADR |
|---|---|---|---|
| `protocol-sans-io` (extended) | both sans-IO directories | Node built-ins | ADR-0006 |
| `protocol-not-to-process` (extended) | both sans-IO directories | `@hudhudjs/core/process`, `packages/core/src/process/` | ADR-0006 |
| `protocol-no-npm-runtime-deps` (extended) | both sans-IO directories | every npm dependency, with one exception: `packages/claude-code/src/protocol/` may import `@hudhudjs/core/protocol` (resolved to `packages/core/(src\|dist)/protocol/` or `node_modules/@hudhudjs/core/(src\|dist)/protocol/`) | ADR-0005, ADR-0006, K3 |
| `protocol-not-to-binding` | both sans-IO directories | `packages/core/src/(binding\|process\|observability\|security)/`, `@hudhudjs/core` root entry | ADR-0006 |
| `adapter-protocol-closed` | `packages/claude-code/src/protocol/` | `packages/claude-code/src/` outside `protocol/` | K3 (the Claude machines stay pure) |
| `process-not-to-binding` | `packages/core/src/process/` | `packages/core/src/binding/` | ADR-0006 |
| `adapter-public-entry-only` | `packages/claude-code/src/` | deep paths into `packages/core/src/`; only `@hudhudjs/core`, `@hudhudjs/core/protocol`, `@hudhudjs/core/process`, `@hudhudjs/core/binding` (beta, W4-Z) | ADR-0004 |
| `core-neutral` (existing `core-not-to-adapters`) | `packages/core/` | `@hudhudjs/claude-code`, `hudhudjs` | ADR-0004, K3 |
| `packages-not-to-tooling` | `packages/*/src/` | `tooling/` | ADR-0013 |
| `raw-only-from-raw` | `packages/claude-code/src/` except `src/raw/` | `packages/claude-code/src/raw/` | ADR-0003 |
| `os-adapters-leaf` | `packages/core/src/process/os/` | anything except `node:*` built-ins and `process/os/types.ts` | coverage scoping (§4.8) |

ESLint: the existing `sansIoRules` block is applied to `packages/claude-code/src/protocol/**` as well; its import patterns additionally forbid `@hudhudjs/core` (root) and `@hudhudjs/core/process` there, while `@hudhudjs/core/protocol` stays allowed. Generated directories are excluded from ESLint (generated) but stay under depcruise. Integration tests (`packages/*/test/integration/**`) get a `no-restricted-imports` rule that forbids importing `connect`/`session` from the package root: they must use `testConnect` from test-support, so no integration test can reach the user's real config or an unpinned binary (ADR-0013).

A neutrality test in `packages/core/test/unit/neutral.test.ts` greps `packages/core/src/**` and `packages/core/schemas/**` for Claude wire vocabulary (`control_request`, `can_use_tool`, `system/init`, `stream-json`, `--permission-mode`) and fails on any hit (K3).

### 1.3 Schema pipeline (ADR-0005)

Responsibility: committed, language-neutral contracts; precompiled validators; zero runtime schema dependency. The pipeline tooling is shared and harness-neutral; each package owns its schemas (ADR-0005 as amended by K3).

```
packages/<pkg>/schema-src/*.ts  --(TypeBox, build time)-->  packages/<pkg>/schemas/*.schema.json   (committed)
packages/<pkg>/schemas/*.json   --(Ajv standalone, esm)-->  tmp/*.js
tmp/*.js                        --(esbuild bundle, helpers inlined, format esm, no externals)-->
   packages/core/src/protocol/generated/validators.gen.js         (+ .d.ts, committed)   neutral schemas
   packages/claude-code/src/protocol/generated/validators.gen.js  (+ .d.ts, committed)   wire schemas
   packages/claude-code/src/generated/validators.gen.js           (+ .d.ts, committed)   option schema
```

| Command | Effect |
|---|---|
| `pnpm schema:build` | regenerate schemas and validators for every package |
| `pnpm schema:check` | regenerate into a temp dir and fail on any byte difference; part of `pnpm check` |
| `pnpm schema:diff` | additive-only linter: compares `schemas/` with `schemas/.baseline/` per package and fails on removed properties, renamed definitions, narrowed types or enums, new `required` entries, `additionalProperties` closed; `x-` prefixed definitions and properties are exempt |
| `pnpm check:no-ajv` | scans every `packages/*/dist/**/*.js` for `ajv` specifiers; part of `pnpm check` |
| `pnpm check:tarball` | `pnpm pack` each published package, install the tarballs into a fresh temp project with `--prod`, import every `exports` subpath and run a smoke validation; part of `pnpm check:full` |

Plan decisions:

- Published TypeScript types are handwritten and a type-level test asserts mutual assignability with `Static<typeof Schema>` from the TypeBox source. Reason: `Static<>` in published `.d.ts` would make TypeBox a consumer-visible dependency (ADR-0005 §2).
- Generated validators are committed and checked by `schema:check`. Reason: reviewable diffs and no code generation at install time.
- The baseline for `schema:diff` is a committed copy `schemas/.baseline/`, replaced by the release task. Reason: no previous release exists to diff against.
- `format` is not used. Reason: `ajv-formats` would be a second dependency with no protocol need.
- Inbound wire schemas are envelope-only (`type`, `subtype`, `request_id`, `request.subtype`, `response.subtype`, `response.request_id`, `uuid`, `session_id`) with `additionalProperties: true` everywhere (ADR-0005 §7).
- `esbuild` runs from its optional platform package with its postinstall denied (`allowBuilds: { esbuild: false }`, K14); W0-T1 verifies this on Windows and Linux.

Schemas. Core (neutral): `events.schema.json` (open unions via `anyOf` with a `{type: string}` arm), `errors.schema.json`, `capabilities.schema.json`, `posture.schema.json`, `conformance.schema.json` (golden fixture line format), `version.json` (`{ "wireSchemaVersion": 1 }`). Claude Code: `wire-inbound.schema.json`, `wire-outbound.schema.json` (strict: `initialize`, `interrupt`, `set_permission_mode`, `user`, `control_response` for `can_use_tool`, `control_response` error), `options.schema.json` (strict, `additionalProperties: false`).

### 1.4 Neutral sans-IO core: `@hudhudjs/core/protocol` (ADR-0006, K3)

No Node built-ins, no ambient time or randomness, JSON-only values crossing the boundary, errors as data. This entry point contains no harness protocol; "protocol" means the neutral event and framing vocabulary (K3).

#### `protocol/json.ts` (public)

```ts
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };
export function isJsonObject(value: unknown): value is JsonObject;
export function ownString(obj: JsonObject, key: string): string | undefined; // Object.hasOwn based
export function parseJsonLine(text: string): { ok: true; value: JsonObject } | { ok: false; reason: 'not-json' | 'not-object' | 'too-deep' };
```

Invariant: untrusted frames are never spread or `Object.assign`ed into objects; field access uses `Object.hasOwn` (a `__proto__` key stays inert, ADR-0012 §8). `JSON.parse` `RangeError` on pathological nesting maps to `too-deep`.

#### `protocol/encode.ts` (public)

```ts
export function encodeJsonLine(value: JsonObject, maxBytes: number): { ok: true; line: string; bytes: number } | { ok: false; error: ErrorData };
```

`line` is `JSON.stringify(value) + "\n"` with exactly one `\n`; byte length via `TextEncoder`; above the cap yields `OUTBOUND_FRAME_TOO_LARGE` (ADR-0011 §7).

#### `protocol/machine/contract.ts` (public) — the neutral machine contract

Every harness adapter implements its protocol as a pure machine against this contract; the binding layer drives any machine that satisfies it (ADR-0006, K3).

```ts
export type TimerName = string;
export interface MachineClockInput { readonly atMs: number; readonly at: string }
export type TransportInput =
  | { type: 'process.started'; pid: number }
  | { type: 'line'; text: string; bytes: number }
  | { type: 'line.oversized'; bytes: number }
  | { type: 'line.invalid-utf8'; bytes: number }
  | { type: 'stderr.line'; text: string }
  | { type: 'stdout.end' }
  | { type: 'stdin.error'; code: string }
  | { type: 'process.spawn-error'; code: string }
  | { type: 'process.exit'; code: number | null; signal: string | null }
  | { type: 'timer'; name: TimerName }
  | { type: 'ladder.done' };
export type CommandInput =
  | { type: 'cmd.send'; turnId: string; content: JsonValue }
  | { type: 'cmd.interrupt'; turnId?: string; cancelQueued: boolean; correlation: string }
  | { type: 'cmd.permission'; requestId: string; decision: JsonObject }
  | { type: 'cmd.permission-abort'; requestId: string }
  | { type: 'cmd.permission-error'; requestId: string; reason: 'no-handler' | 'handler-failed' | 'invalid-decision' }   // W4-Z
  | { type: 'cmd.set-permission-mode'; mode: string; correlation: string }
  | { type: 'cmd.close' }
  | { type: 'cmd.abort'; intent: 'abort' | 'dispose' };
export type MachineInput = MachineClockInput & (TransportInput | CommandInput);
export type MachineEffect =
  | { type: 'write'; line: string }
  | { type: 'stdin.end' }
  | { type: 'timer.set'; name: TimerName; ms: number }
  | { type: 'timer.clear'; name: TimerName }
  | { type: 'event'; event: HudhudEventData }
  | { type: 'permission.ask'; requestId: string; request: PermissionRequestData }
  | { type: 'permission.cancel'; requestId: string; reason: 'harness' | 'close' | 'abort' }
  | { type: 'handshake.ok'; info: SessionInfoData }
  | { type: 'handshake.fail'; error: ErrorData }
  | { type: 'turn.settle'; turnId: string; result: TurnResultData }
  | { type: 'turn.fail'; turnId: string; error: ErrorData }
  | { type: 'control.settle'; correlation: string; ok: true; response: JsonValue }
  | { type: 'control.settle'; correlation: string; ok: false; error: ErrorData }
  | { type: 'ladder.start'; intent: TerminationIntent }
  | { type: 'session.end'; outcome: SessionOutcome; error?: ErrorData };
export interface HarnessMachine<State, Config> {
  initialState(config: Config): State;                                   // State and Config are JSON
  step(state: State, input: MachineInput): { state: State; effects: readonly MachineEffect[] };
}
```

Plan decision: machines generate only deterministic ids (`hudhud_<n>` request ids, `bg-<n>` harness-initiated turn ids); every UUID (session id, user message `uuid`) arrives from the binding inside an input or the config. Reason: a pure function that replays byte-identically from a fixture.

Contract invariants (checked by a reusable property-test kit exported from test-support and run against every machine): every turn settles exactly once; each `permission.ask` ends with exactly one cancel or answer (`cmd.permission`, `cmd.permission-abort` or `cmd.permission-error`); a `cmd.permission-error` is answered fail-closed (its step resolves the ask as a deny, never an allow); no `write` after `stdin.end`; event `seq` strictly increases by 1; timers are cleared before `session.end`; after `session.end` every input yields no effects; `step` output survives `JSON.parse(JSON.stringify(x))` unchanged.

#### `protocol/machine/outcome.ts` (public) — ADR-0008 "Termination intent and exit-code semantics"

```ts
export type TerminationIntent = 'none' | 'close' | 'close-timeout' | 'abort' | 'dispose' | 'watchdog' | 'auth-fail-fast' | 'oversized-frame' | 'handshake-failed';
export interface ExitObservation { code: number | null; signal: string | null }
export type SessionOutcome = 'closed' | 'aborted' | 'failed' | 'crashed' | 'killed-externally' | 'unknown';
export function classifyExit(input: { intent: TerminationIntent; exit: ExitObservation; lastResultIsError?: boolean; turnActive: boolean; platform: 'win32' | 'posix' }): { outcome: SessionOutcome; turnSynthesis: 'cancelled' | 'error' | 'none' };
```

Harness-neutral (intent plus OS exit facts). Table in [§3.3](#33-process-exit-mapping). Never infers success from an exit code; `4294967295` is `unknown`.

#### `protocol/events/` (public)

Neutral event union in [§2.2](#22-harness-neutral-stable-tier-hudhudjscore) and `sanitizeForDisplay(text)` (strips C0/C1 controls and ANSI CSI/OSC sequences, ADR-0012 §8). ACP-aligned vocabulary (ADR-0003, H12): tool kinds `read | edit | delete | move | search | execute | think | fetch | other`; tool status `pending | in_progress | completed | failed`; stop reasons `end_turn | max_tokens | max_turn_requests | refusal | cancelled`, all open.

#### `protocol/errors.ts`, `protocol/capabilities.ts` (public)

`ErrorData { code: HudhudErrorCode; message: string; retryable: boolean; details?: JsonObject }` and the code table of [§3](#3-error-taxonomy). Neutral `Capability`, `HarnessCapabilities`, `ProcessContainment` types.

### 1.5 Claude Code protocol machines: `@hudhudjs/claude-code` `src/protocol/` (K3)

Same sans-IO rules as the core protocol directory; may import only `@hudhudjs/core/protocol` and files inside `src/protocol/`. Not a public entry point (internal to the adapter; the conformance suites drive it through a test-only import).

#### `protocol/wire/types.ts` (internal, schema-checked)

Envelope types for every frame hudhud reads or writes (01 §2.6-2.8, 02 §4, 05 §5-§9): `ControlRequestFrame`, `ControlResponseFrame` (success/error), `ControlCancelRequestFrame`, `KeepAliveFrame`, `SystemFrame` (open `subtype`), `AssistantFrame`, `UserFrame`, `StreamEventFrame`, `ResultFrame`, `CommandLifecycleFrame`, `UnknownFrame`. Typed fields are only those the machines read: `system/init` (`session_id`, `permissionMode`, `capabilities`, `model`, `claude_code_version`), `result` (`subtype`, `is_error`, `result`, `errors`, `terminal_reason`, `api_error_status`, `user_message_uuid`, `user_message_uuids`, `usage`, `total_cost_usd`, `num_turns`, `permission_denials`), `api_retry`, `session_state_changed`, `permission_denied`, `can_use_tool` fields (02 §4.3), `initialize` response (`pid`, `claude_code_version`, `account.apiKeySource`, `models[].value`, `capabilities`, `current_permission_mode`).

#### `protocol/wire/inbound.ts` (internal)

```ts
export type InboundClass =
  | { kind: 'control_request'; requestId: string; subtype: string; frame: JsonObject }
  | { kind: 'control_response'; requestId: string; ok: true; response: JsonObject | undefined; frame: JsonObject }
  | { kind: 'control_response'; requestId: string; ok: false; error: string; frame: JsonObject }
  | { kind: 'control_cancel_request'; requestId: string; frame: JsonObject }
  | { kind: 'keep_alive'; frame: JsonObject }
  | { kind: 'conversation'; type: string; subtype: string | undefined; frame: JsonObject }
  | { kind: 'malformed'; reason: string; frame: JsonObject };
export function classifyInbound(frame: JsonObject): InboundClass;
```

Lenient: unknown `type`/`subtype` is `conversation`; `malformed` only when a routing field has the wrong JSON type (ADR-0005 §7, ADR-0011 §7-8, 02 §3).

#### `protocol/wire/outbound.ts` (internal)

```ts
export function initializeRequest(requestId: string, body: InitializeBody): JsonObject;  // no workspaceTrust parameter exists
export function interruptRequest(requestId: string, cancelQueued: boolean): JsonObject;
export function setPermissionModeRequest(requestId: string, mode: PermissionModeWire): JsonObject;
export function userMessage(uuid: string, content: UserContentWire): JsonObject;
export function permissionResponse(requestId: string, decision: PermissionDecisionWire): JsonObject;
export function controlErrorResponse(requestId: string, message: string): JsonObject;
```

`InitializeBody` in v1: `{}` (W1 provenance ruling, ADR-0015: `appendSystemPrompt`, `systemPrompt` and the user frame `priority` were never observed in frames nor in the MIT Python SDK, so they are not in the wire types; system prompts go through the documented `--system-prompt` / `--append-system-prompt` flags). Every frame passes the strict generated validator, then `encodeJsonLine` (32 MiB cap). `initialize.workspaceTrust` cannot be sent (ADR-0012 §2, J3).

#### `protocol/machine/control.ts` (internal) — control-request correlator

Outbound pending map `requestId -> { purpose: 'initialize' | 'interrupt' | 'set_permission_mode' | 'raw'; sentAtMs }`; inbound pending map `requestId -> { subtype; turnId? }`. A `control_response` for an unknown id is ignored with diagnostic `control.unknown-response`; duplicate inbound in-flight ids are ignored (02 §3); `control_cancel_request` removes the inbound entry and yields a cancel; nothing is written for a cancelled request; unknown inbound subtypes are answered with `control_response` error "Unsupported control request subtype" except the never-answered set (`remote_*`, unhandled `request_user_dialog` kinds). v1 handles inbound `can_use_tool` only; `hook_callback` and `mcp_message` are answered with an error (v1 registers no hooks and no SDK MCP servers).

#### `protocol/machine/permission.ts` (internal) — ADR-0007, ADR-0012 §3

```ts
export interface PermissionEntry { requestId: string; toolUseId: string; toolName: string; turnId?: string; state: 'asked' | 'answered' | 'cancelled' }
export type PermissionDecisionWire =
  | { behavior: 'allow'; updatedInput?: JsonObject; updatedPermissions?: readonly JsonObject[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };
export function stripNonSessionDestinations(updates: readonly JsonObject[], allowConfigWrites: boolean): { kept: JsonObject[]; strippedCount: number };
```

No default timeout; each `asked` entry ends exactly once in `answered` or `cancelled` (CLI cancel, application `AbortSignal`, close, abort); `permission_suggestions` passed through as raw data, never applied or shape-checked (D17); non-`session` destinations stripped unless `dangerouslyAllowConfigWrites`; more than 4096 updates rejected locally. On close (drain) the machine answers the CLI with `{behavior:'deny', message:'hudhud session closing', interrupt:false}` so the turn reaches `idle`; on abort nothing is written because the interrupt makes the CLI withdraw the request (K12, ADR-0007).

#### `protocol/machine/turn.ts` (internal) — ADR-0008 "Turns and interrupts"

Per turn: `{ turnId (= user message uuid, or bg-<n>), origin: 'application' | 'harness', phase: 'queued' | 'started' | 'interrupting' | 'settled', initSeen, pendingInterrupt? }` in FIFO order.

- A host `send` creates a `queued` turn and writes the `user` frame with `uuid`.
- Turn start: `command_lifecycle` `state:"started"` with `command_uuid` when capability `msg_lifecycle_v1` was seen, otherwise the next `system/init` starts the oldest queued turn. A `system/init` with no queued host turn starts a harness-originated turn `bg-<n>` (07 §7).
- Interrupt gating: an interrupt before the turn's `system/init` is stored and sent once it arrives (D5, GH#98713); on a settled turn it is a no-op.
- Plan decision: if the interrupt response's `still_queued` contains the target uuid after its `system/init`, re-send once after 50 ms and emit `interrupt.still-queued-retry`. Reason: 05 §7 names the workaround; one retry, then report. As built (W4-Z, a defect found by the turn-machine model check, seed 1704925574): a `still_queued` answer that arrives after stdin closed fails the interrupt with `SESSION_CLOSED` (as a retry that is waiting when stdin closes does) instead of arming a retry whose timer would write to the closed stdin; in the composed machine that write was dropped and the application's interrupt waited for the process exit.
- Turn end: `result` with matching `user_message_uuid(s)`, else the oldest started turn; synthesized from `session_state_changed` `idle` or process exit (05 §9). `error_during_execution` with `terminal_reason` `aborted_streaming`/`aborted_tools` after an interrupt is outcome `cancelled`, raw kept.
- As built (W2-Z ruling C): the outcome, `isError` and stop reason of an observed `result` come from `classifyResult` of `protocol/events/normalize.ts`, the one mapping of result frames; any `aborted*` `terminal_reason` is `cancelled`, with or without hudhud's interrupt. Synthesized results stay in the turn machine and always carry `isError: true`. A `result` that matches no unsettled turn is ignored with diagnostic `turn.unmatched-result`.
- As built (macOS gate round 2 review, research 10 §3): a `command_lifecycle` frame is correlated strictly by `command_uuid` with an application turn, before or after `system/init`, and its state is recorded on the turn (at most 16 states). `started` starts a queued turn only once `msg_lifecycle_v1` was seen (before that the `system/init` starts it with its capabilities). `completed` for a turn that is still `queued` and never reported `started` is a dropped message (Claude Code 2.1.296 drops a message whose `uuid` the transcript already holds): the turn fails `TURN_DROPPED` (`details.turnId`, `details.lifecycle`) with diagnostic `turn.dropped`; every other turn is untouched. A `result` that arrives first settles the turn, so the later `completed` finds none; a `result` after the drop is `turn.unmatched-result`. Messages merged into one turn report `started` before `completed` (recorded with 2.1.296), so they are never taken for a drop.

#### `protocol/machine/session.ts` (internal) — the composed Claude machine, implements `HarnessMachine`

```ts
export interface ClaudeSessionConfig {
  readonly mode: 'create' | 'resume' | 'fork';
  readonly sessionId: string;                 // expected system/init.session_id
  readonly firstFrameTimeoutMs: number;       // 60000
  readonly idleStallMs: number;               // 300000
  readonly closeTimeoutMs: number;            // 30000, measured from cmd.close (K13)
  readonly interruptWaitMs: number;           // 1000
  readonly maxOutboundBytes: number;          // 33554432
  readonly onOversizedFrame: 'fail' | 'skip';
  readonly onAuthFailure: 'fail-fast' | 'harness-retry';
  readonly authFailFastSources: readonly string[];  // ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] (K10, matched against apiKeySource and tokenSource)
  readonly permissionHandler: boolean;
  readonly allowConfigWrites: boolean;
  readonly platform: 'win32' | 'posix';
  readonly initialize: InitializeBody;
}
export declare const claudeSessionMachine: HarnessMachine<ClaudeSessionState, ClaudeSessionConfig>;
```

Phases: `created -> handshaking -> ready <-> (turns active) -> draining -> terminating -> ended`, plus `failed`.

- `process.started`: write `initialize` first (ADR-0008 §2) and set `first-frame`. The binding feeds `process.started` only after Windows job assignment (ADR-0009 §1).
- Commands before `handshake.ok` are queued and flushed after it (02 §4.1).
- Handshake: the init `control_response` clears `first-frame`, records `pid`, `claude_code_version`, `apiKeySource`, `capabilities`, emits `handshake.ok` and `session.started`. A `result` before the response (J7) is `SESSION_NOT_FOUND` when `mode` is `resume`/`fork` and the frame is `error_during_execution` with `num_turns` 0, otherwise `HANDSHAKE_FAILED` cause `result-before-response`. Exit or `stdout.end` first: `HANDSHAKE_FAILED` cause `exited-before-response` (or `SESSION_NOT_FOUND` if the matching `result` was seen). Timer: `HANDSHAKE_TIMEOUT`, `ladder.start` intent `watchdog`.
- Identity: the first `system/init.session_id` must equal the expected id (`fork`: the hudhud-chosen new id); mismatch is diagnostic `session.id-mismatch`, and a `ProtocolError` for `create`.
- Idle watchdog: while a turn is queued or started, every frame re-arms `idle`; on fire emit `stalled` once per silence period with `pendingPermissions`; never kills (ADR-0008).
- Auth fail-fast (ADR-0012 §6, K10): applies when `onAuthFailure` is `fail-fast` and the `initialize` response's `account.apiKeySource` or `account.tokenSource` is in `authFailFastSources`, default `['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']` (lead decision after the `auth-token-source` fixture (W3-Z review): a static env credential that got a 401 does not succeed on retry, for the token as for the key; the fixture shows the token as `tokenSource: "ANTHROPIC_AUTH_TOKEN"`). OAuth (`apiKeySource` `none`, no listed token source) and `apiKeyHelper` stay excluded because they can refresh. The machine records `tokenSource` with `apiKeySource` (state, `SessionInfoData`, `session.started`), and the `AUTHENTICATION_FAILED` details name the triggering credential (`credentialSource`). Trigger: the first of `system/api_retry` with `error === "authentication_failed"`, `assistant` with `error === "authentication_failed"`, `result` with `api_error_status === 401`; 403 is not a trigger. Effect: session poisoned, active turns fail `AUTHENTICATION_FAILED`, `ladder.start` intent `auth-fail-fast`, later commands fail `SESSION_POISONED`. `system/api_retry` is always surfaced as `api.retry`.
- Oversized frame: `fail` gives `OVERSIZED_FRAME` and `ladder.start` intent `oversized-frame`; `skip` gives diagnostic `frame.skipped-oversized` (byte count only).
- Close (drain, K13): reject new sends; set the `close` timer to `closeTimeoutMs` at the `cmd.close` instant (single deadline); pending permissions are cancelled with the non-interrupting deny (K12); wait for no active turn and `session_state_changed` `idle`, then `stdin.end`; keep consuming frames and accept harness-originated turns after EOF (07 §7); on timer `ladder.start` intent `close-timeout`.
- Abort/dispose: record the intent first; if the handshake completed and stdin is open, write `interrupt{cancel_queued:true}` and set `interrupt-wait`; emit `ladder.start`; pending permissions cancel with reason `abort`, nothing written (K12).
- `process.exit`: classify via core `classifyExit`; settle or fail remaining turns; emit `session.terminated`; `session.end`.
- As built (W3-T1, W3-Z rulings 7 and 10): every write but `initialize` is held until the `initialize` response in every mode (create, resume, fork), so the first user message never precedes it (07 §1 method). Rationale updated after macOS gate run 2 (research 10 §3, §6): the resume stall of research 09 §5 that motivated the rule was caused by a reused user-message `uuid`, not by the write order (the eager order resumes correctly with a fresh `uuid`); the rule is kept as a conservative ordering that costs nothing beyond the `initialize` round trip every session pays anyway. A `cmd.send` whose turn id is not a UUID or is the id of a live turn is answered with the contract effect `send.rejected`, bound to that command; it never settles or touches the live turn (binding contract: a fresh UUID per send). A stdin failure after the handshake emits diagnostic `stdin.error`; during the handshake it stays `HANDSHAKE_FAILED` cause `stdin-error`. A `can_use_tool` that reuses the id of an earlier, ended request is never asked again (diagnostic `permission.duplicate-request-id`, a non-interrupting deny; nothing is written after abort, K12); an in-flight duplicate is ignored by the correlator (`control.duplicate-request`). Event `seq` starts at 1 (seq 0 is the replayed `compat`).

#### `protocol/events/normalize.ts`, `tool-kind.ts` (internal)

`normalizeFrame(frame, ctx) -> HudhudEventData[]` into the neutral vocabulary. Claude tool mapping: Bash, PowerShell -> execute; Read, NotebookRead -> read; Edit, Write, NotebookEdit -> edit; Glob, Grep -> search; WebFetch, WebSearch -> fetch; everything else -> other. Every event built from a frame carries `raw`; unmapped frames emit `harness.frame`.

As built (W2-T5): `normalizeFrame` emits no turn or permission events. `system/init` yields nothing and `result` yields only `usage.update`; the turn machine builds `turn.started` and `turn.completed`, the permission machine `permission.requested`. `classifyResult(frame): { outcome, isError, stopReason? }` is exported for the turn machine (ruling C).

### 1.6 Binding layer: `@hudhudjs/core` root (ordinary async, harness-neutral)

| Module | Responsibility | Key API | ADR |
|---|---|---|---|
| `binding/clock.ts` | real clock and ids | `interface Clock { nowMs(): number; nowIso(): string }`, `interface IdSource { uuid(): string }`, `systemClock`, `cryptoIds` | ADR-0006 |
| `binding/driver.ts` | drives any `HarnessMachine`: serial input queue, effect executor, Node timers, transport I/O, ladder hand-off | `class SessionDriver<S, C> { constructor(deps: DriverDeps<S, C>); start(): Promise<SessionInfo>; command(input: CommandInput): void; readonly ended: Promise<SessionEnd> }` | ADR-0006, ADR-0007, ADR-0008, K3 |
| `binding/transport.ts` | internal transport seam between driver and process or loopback; not public in v1 (K18) | `interface HarnessTransport { write(line: string): Promise<void>; end(): void; readonly output: AsyncIterable<TransportOutput>; readonly exited: Promise<ExitObservation>; terminate(intent: TerminationIntent): Promise<void> }` | ADR-0001 §3 |
| `binding/queue.ts` | bounded per-subscriber queue (counts and bytes), three overflow policies, gap marker | `class BoundedQueue<T> { push(item: T, bytes: number): 'ok' \| 'overflow-error' \| 'dropped' \| Promise<void> }` | ADR-0007 |
| `binding/fanout.ts` | broadcast, turn filters, compat replay | `subscribe(filter, opts): AsyncIterableIterator<HudhudEvent>` | ADR-0007, ADR-0003 |
| `binding/handles.ts` | `Session`, `Turn`, `Harness` implementations over the driver | §2 | ADR-0003 |
| `binding/permission-bridge.ts` | `permission.ask` effects -> handler calls with an `AbortSignal`; strict validation of the returned decision; a throwing handler yields a CLI-facing error answer through the machine | | ADR-0006, ADR-0007 |
| `binding/errors.ts` | error classes from `ErrorData` | `class HudhudError extends Error { readonly code; readonly retryable; readonly details? }` and subclasses | §3 |
| `binding/adapter.ts` | adapter registration and `adapterApiVersion` check | `defineAdapter(def: AdapterDefinition): RegisteredAdapter` | ADR-0004 §3 |
| `binding/loopback.ts` | loopback binding: every input and effect through `JSON.stringify`/`JSON.parse`, asserting round-trip equality; machine supplied by the caller | `createLoopbackDriver(machine, ...)` | ADR-0006 |
| `binding/host-exit.ts` | one `process.once('exit')` hook that ends stdin of live sessions synchronously; no signal handlers (K22) | | 02 §6.3 |

Invariants: stdout is read continuously regardless of subscribers (ADR-0007); `ask()` and `turn.done` never wait on a subscriber; only `'block'` can pause input processing (documented hazard); handler exceptions never escape into the driver; one input at a time, no re-entrancy.

Plan decision: the per-event byte size used by queues is the raw frame byte count from the framer (synthesized events count 256 bytes). Reason: deterministic and dominated by the mandatory raw payload. As built (W4-T1): an event counts the byte size of the line its step consumed when it carries a `raw` member, else 256; several events of one line each count it (conservative: they share the parsed frame).

As built (W4-T1):

- `SessionDriver` (`driver.ts`) runs one FIFO of inputs (transport output, timers, commands, permission answers); `step` and the execution of its effects finish before the next input is taken, and application code (permission handlers, abort listeners, promise callbacks) never runs inside a step. Turn results, controls and the handshake settle while the effects run; events go to the fanout behind them through an outbox. Only a full `'block'` subscriber holds the next input (and with it stdout reading, timers and the close deadline); `abort`/`dispose` cut through by cancelling every `'block'` subscriber that still holds the session (its iterator rejects with `SESSION_CLOSED`). The reader holds at most one output at a time.
- Event `seq` is assigned by the driver (gapless from 1 after the replayed `compat` at 0), so the binding's own diagnostics share one stream with the machine's events: `containment.fallback` (passed in by the adapter), `termination.ladder` (the ladder report), `termination.sweep-after-exit` (the graceful close's sweep report), `permission.handler-failed` / `permission.invalid-decision` (bridge), `stdout.error`, `binding.machine-error`. A gap marker carries the seq of the first event it replaces (the subscriber's last delivered seq plus one).
- End of a session: on the exit the driver waits for the ladder (if one runs) and for the sweep of the graceful close, publishes both reports, waits for the end of stdout at most `outputDrainMs` (default 2000; a descendant may hold the pipe), then feeds `process.exit`; `session.terminated` is the last event. `start()` rejects with the handshake error only after that (nothing left running, §3.2). A machine that throws, or does not end after the exit, is contained: diagnostic `binding.machine-error`, abort ladder, synthesized `session.terminated` (outcome `failed`), every pending call rejects with `PROTOCOL_ERROR`.
- `session.terminated`: `intent` and `outcome` are deterministic; `exitCode`/`signal` are raw OS observations that can differ by race (a launcher that exits 7 versus a SIGKILL that lands first, `posix.real.test.ts`). Applications decide on `outcome` (doc comment of the event).
- Machine effects: `send.rejected` rejects the send of its own step only (a live turn with the same id is never touched); `turn.fail` with `TURN_DROPPED` fails that turn (`turn.done` rejects with `TurnDroppedError`, its iterator rejects after its buffered events); the first failed write is fed once as `stdin.error` and ends the ladder's interrupt wait.
- Ladder hand-off: `ladder.start` runs `transport.terminate` once with the recorded intent and `initialize.pid` (`SessionInfo.cliPid`, K1); its interrupt hook resolves when the machine ends input (`stdin.end`), at once when input is already ended. `ladder.done` is fed when the ladder resolves.
- Graceful close (W3-Z ruling 5): `stdin.end` outside a ladder step ends input gracefully; the process transport (`transport.ts`, `createProcessTransport`) then takes `snapshotAtEof` first and ends stdin after it (the harness is idle and waits for EOF, so the snapshot cannot miss its root), and `afterExit()` runs `sweepAfterExit` (POSIX with the ladder's K1 signal target when a ladder ran).
- Permission bridge (`permission-bridge.ts`): one `AbortSignal` per ask, aborted (in a microtask) on `permission.cancel` and at the end of the session; the handler runs in a microtask; its decision is copied in one pass (plain objects and arrays of JSON values only, data properties only, depth 64, 100,000 nodes) and checked strictly; a missing, throwing or rejecting handler and an invalid decision are answered through the machine (never an allow) plus a diagnostic. As built (W4-Z, lead decision on W4-T1's question 3): the bridge feeds the contract input `cmd.permission-error` with the fixed reason `no-handler`, `handler-failed` or `invalid-decision` instead of a deny decision of its own; the machine answers with its own fail-closed policy (Claude: the non-interrupting deny of a failed handler, or of a refused decision for `invalid-decision`, and `permission.resolved` deny by `application`; no second diagnostic, the bridge's `permission.handler-failed` / `permission.invalid-decision` already told the application). The machine kit's `fail-ask` action and `KitDriver.permissionError` check it: the step must resolve the ask as one deny, so a machine that ignores the input or allows breaks the contract.
- Handles (`handles.ts`): `createSession(core)`, `HarnessBase` (tracks sessions, disposing it disposes them, then `HARNESS_DISPOSED`), `normalizeUserInput` (strict copy). `send()` throws `INVALID_OPTIONS` for invalid input; the driver's `encodeUserInput` hook maps the neutral input to the machine's `cmd.send` content (default: the neutral JSON form).
- Pre-handshake replay (lead review of W5-T1, Q1, accepted as a defect of W4-T1): an application can subscribe only after `create` resolved, so the events published before the handshake settled (the adapter's `diagnostics`, `session.started`, every event up to the end of the step that settled the handshake, or up to the end of a session that never had one) were lost to it. The driver now keeps them in a bounded buffer (`PRE_HANDSHAKE_MAX_EVENTS` 256, `PRE_HANDSHAKE_MAX_BYTES` 1 MiB, counted as events count for queues; one slot and 256 bytes reserved): it keeps the earliest in order, drops the newest beyond the cap and closes with one diagnostic `events.pre-handshake-truncated` (`data.dropped`). Every `events()` subscriber gets `compat` and then this buffer as its replay, in `seq` order, before live events; turn iterators do not (pre-handshake events belong to no turn). The replay is put directly into the subscriber's own queue within its own limits: when it does not fit, the subscriber gets the prefix that fits and one `gap` marker numbered as the first event left out (`dropped` counts the rest); it never waits on a publish, so it stalls no one (after it, live events follow the subscriber's policy as before, `'block'` included). A subscriber made before the start receives each event once (the replay is a snapshot at subscription). The loopback conformance replay is unchanged (74 variants identical).
- `host-exit.ts`: one `process.once('exit')` listener while at least one session is live, removed with the last; it ends every live session's input synchronously. No signal handlers (K22), asserted by a source test.
- `loopback.ts`: `loopbackMachine` (JSON round trip of config, state, input and step result with deep equality; a violation is recorded and thrown, so the driver ends the session with `PROTOCOL_ERROR`), `LoopbackTransport` (scripted in-memory harness), `createLoopbackDriver` (manual clock, `counterIds`, no host-exit hook); `driver.command(input)` feeds raw commands for replays. Proven with a test machine and scripted sessions; the replay of the Claude conformance set is wired by W4-Z on W4-T2's loader. As built (W4-Z, ruling 2): `packages/claude-code/test/conformance/loopback.ts` drives every recorded variant (74) through `createLoopbackDriver` with the Claude session machine, scripted turn ids and the Claude user-input encoder: harness output through the transport's reader, timers through the `ManualClock`, application calls through the public handles (`session.send`, `turn.interrupt`, `session.close`, the permission handler; only a recorded control-error answer, which has no public call, is fed as the raw `cmd.permission-abort`), the exit and the ladder through the transport. Every value crosses the JSON boundary, and the result must equal the direct replay: per record the machine inputs (as a multiset) and the inputs with effects (in order), every written line, every published event with its `seq`, each `turn.done`, each control call, each permission request, the handshake and the session end, and the expect file. Two orders differ by design and only in steps without effects: the driver feeds `ladder.done` before the exit (it waits for the ladder first), and it feeds nothing after `session.end`.
- Exports: the `@hudhudjs/core` root gains the public handle and permission types (`Session`, `Turn`, `Harness`, `SessionInfo`, `BinaryInfo`, `BinaryVerification`, `VerificationMode`, `UserInput`, `UserContentBlock`, `PermissionRequest`, `PermissionDecision`, `PermissionHandler`) and `defineAdapter`/`AdapterDefinition` (`@beta`); `adapterApiVersion` moved to `binding/adapter.ts`. The driver, transports, loopback and clocks are tagged `@beta` but not exported yet (K18; how W5 reaches them is a W4-Z decision). As built (W4-Z): they are exported by the new beta entry `@hudhudjs/core/binding` (§2.1) with its own API report (`core-binding.api.md`), package export, smoke test and dependency-cruiser entry (`adapter-public-entry-only` admits it; the sans-IO layers may not import it); the permission bridge and the decision copy stay internal.

### 1.7 Process layer: `@hudhudjs/core/process` (ADR-0009, ADR-0010, ADR-0011)

| Module | Public | Key API | Invariants |
|---|---|---|---|
| `framer.ts` | yes | `createFramer({ maxLineBytes }): { push(chunk: Uint8Array): FramerOutput[]; end(): FramerOutput[] }`; `FramerOutput = {kind:'line', text, bytes} \| {kind:'oversized', bytes} \| {kind:'invalid-utf8', bytes}` | generic NDJSON; memory bounded by cap plus one chunk; oversized lines discarded while streaming until the next LF; CRLF, blank lines, leading BOM, split multibyte characters tolerated (05 §11) |
| `argv.ts` | yes | `formatFlag(name: string, value?: string): string` | always `--name=value`; name `^[a-z][a-z0-9-]*$`; NUL refused (ADR-0011 §3) |
| `binary-path.ts` | yes | `resolveExecutable(path: string): Promise<ResolvedExecutable>` | realpath, absolute, regular file, executable bit on POSIX, `.cmd`/`.bat` refused in original or resolved path, case-insensitive on win32 |
| `cwd.ts` | yes | `validateCwd(cwd: string, platform): Promise<string>` | exists, directory, realpath'd (macOS gate item 6); win32 realpath length of 259 UTF-16 units or more throws `CwdTooLong`; never `\\?\` (J10) |
| `hash.ts` | yes | `sha256File(path): Promise<string>` | streaming |
| `spawn.ts` | yes | `spawnHarnessProcess(spec: SpawnSpec): Promise<HarnessProcess>` | `shell:false`, `windowsHide:true`, stdio pipes, explicit `env`, not detached; serialized writes with backpressure; stderr into the bounded tail; `error` events become `process.spawn-error`; child stdout `ENOTCONN` after a failed spawn swallowed (07 §6) |
| `tree/` | yes | `snapshotDescendants(rootPid, deps): Promise<ProcessRecord[]>`; `ProcessRecord {pid, ppid, pgid?, startTime, name, zombie?}`; `parseProcStat`, `parsePsOutput` | Linux `/proc/<pid>/stat` (start time field 22, comm up to the last `)`, state `Z` = zombie); macOS `/bin/ps -A -o pid=,ppid=,pgid=,stat=,lstart=,comm=` with `LC_ALL=C` and `TZ=UTC0` (`lstart` padded to 28 columns, confirmed by macOS gate run 1; `stat` to be confirmed by the next run; research 09) |
| `ladder/types.ts` | yes | `LadderTiming`, `LadderStep`, `LadderReport`, `LadderHooks` | timing injected |
| `ladder/posix.ts` | yes | `runPosixLadder(proc, hooks, timing): Promise<LadderReport>` | ADR-0010 as amended by K1: interrupt (hook) -> EOF -> 2 s -> S1 + SIGTERM to the signal target -> 5 s -> S2 + SIGKILL of the signal target and the spawned pid + sweep(S1 ∪ S2); never `kill(-pgid)` of the CLI, launcher or host group |
| `sweep.ts` | yes | `sweep(records, deps)` | kill only if pid and start time still match; `kill(-pgid)` only for groups led by a recorded descendant whose identity matches |
| `ladder/windows.ts` | yes | `runWindowsLadder(proc, hooks, timing, job: JobHandle \| null)` | interrupt (wait at most 1 s) -> EOF -> 2 s -> `TerminateJobObject`; fallback `taskkill /T /F` (absolute `%SystemRoot%\System32\taskkill.exe`, `shell:false`) -> 2 s -> `TerminateProcess` via the child handle |
| `verify/` | yes | `verifyBinary(path, opts: { mode: 'advisory' \| 'strict'; digests }): Promise<BinaryVerification>` | K8: advisory checks the digest table only; strict runs the OS signature check first (win32 Authenticode with the pinned publisher subject, darwin `/usr/bin/codesign --verify --strict`) and then the digest table |
| `containment/win32-job.ts` | yes | `loadJobAddon(deps): JobAddonLoad` | never throws; pre-`dlopen` sha256 (defence in depth); arm64 reports `unavailable` in v1 (K17); see §6 |
| `os/win32.ts`, `os/posix.ts`, `os/darwin.ts` | no | thin syscall adapters behind `interface OsCalls` | no logic; coverage-scoped per OS (§4.8) |

As built (Wave 2, W2-Z):

- `spawnHarnessProcess(spec: SpawnSpec): Promise<HarnessProcess>`; the handle signals only through its own child handle, `killViaHandle(signal)`, never by a bare pid. On win32, `childEnv(env, platform)` passes every name of `WIN32_REQUIRED_ENV_NAMES` the map lacks as `''`, so libuv copies nothing from the host; a map without a non-empty `SYSTEMROOT` is refused. The adapter's `buildChildEnv` reports those names in `spawnInjected` (one list, ruling H). On darwin a child linked against CoreFoundation (Node.js, the CLI) sets `__CF_USER_TEXT_ENCODING` itself at start (`0x<uid>:0x<script>:0x<region>`, computed from the account's `.CFUserTextEncoding`); hudhud does not pass it and cannot keep it out: `DARWIN_CHILD_SET_ENV_NAMES`, next to the Windows list. `osCallsFor(platform, hostPid): OsCalls` is the public OS seam; the adapter modules under `os/` stay internal.
- Identity is non-blocking: `spawnHarnessProcess` resolves as soon as the child runs; `HarnessProcess.identity` is a `Promise<IdentityRead>` (`{ identity, problem }`, never rejects) started right after the spawn, `null` with `exited` when the child exited before the read completed (as before). The ladders take it as `LadderIdentity` (`proc.pid` plus `proc.identity`) and await it only before their first pid step (POSIX: S1; Windows: S1, the `taskkill` check, the `TerminateProcess` check); without a verified identity they take no snapshot, no tree kill and no sweep, and act only through the handle (Windows) or on the unreaped spawned pid (POSIX). The Windows CIM query runs WQL through the in-box .NET classes, without a cmdlet (no PowerShell module discovery).
- `runPosixLadder(proc: PosixLadderProcess, hooks, timing, deps: { intent, os: PosixOsCalls, clock: LadderClock })`.
- `runWindowsLadder(proc: WindowsLadderProcess, hooks, timing, job: JobHandle | null, deps: { intent, initializePid, clock: LadderClock, os: WindowsOsCalls })`. The best-effort path takes S1 before EOF and, whenever the process is seen to have exited, sweeps the S1 descendants still matching pid and start time (`taskkill /F /PID`, no `/T`, leaf first).
- `sweep(request: { spawned, signalTarget, recorded: ProcessSnapshot[] }, deps: { hostPid, processTable, signals }): Promise<SweepResult>` (POSIX); the plan comes from `planSweep` over a fresh snapshot.
- One `LadderClock { now(); schedule(ms, callback): cancel }` in `ladder/types.ts` (ruling A). One `taskkill` implementation, `taskkill.ts` (`createTaskkillCalls`, realpath-checked `%SystemRoot%\System32\taskkill.exe`), used by `osCallsFor('win32')`.

As built (Wave 3, W3-Z):

- `verify/`: `verifyBinary(binary: ResolvedExecutable, { mode, digests, publisher?, platform?, hostEnv?, cache?, deps? })` binds every verdict to the file identity (`BinaryChangedError` when it changed during verification); `settleProbedVersion` folds the K4 version into it; `assertSpawnable` (strict refuses non-`verified`, then `recheckBinary`) runs before every spawn, and `assertSpawnableOrReverify(binary, reverify)` re-resolves and fully re-verifies once when the file changed (a legitimate update), refusing a second change or a refused re-verification with `BinaryNotVerifiedError` (`BINARY_VERIFICATION_FAILED`). Strict mode pins the publisher (`PublisherPin.windowsSubject`, exact signer subject; no pin fails; the darwin Team ID after the gate). `runVersionProbe` runs in a new empty `mkdtemp` directory under `os.tmpdir()`, removed afterwards (no `cwd` option); `runBoundedCommand` bounds every checker and probe (timeout, stdout cap, `shell:false`).
- `containment/`: `loadJobAddon` as §6.4; `createSessionContainment()` plugs into `SpawnSpec.startTime`, so the job is created and the pid assigned synchronously inside the spawn, before `spawnHarnessProcess` resolves (before the first write), and serves the addon's start time as the identity; `attach` returns `info.containment`, the `JobHandle` for `runWindowsLadder`, a `containment.fallback` diagnostic on failure (K2), and closes the job after the exit. The shipped digest table was empty until A2, which filled it with the x64 build of record (§6.2).
- `ladder/after-exit.ts` (W3-Z ruling 5): `snapshotAtEof` and `sweepAfterExit`, the sweep of the graceful close path (ADR-0008, ADR-0009, ADR-0010): the binding snapshots the descendants when it ends stdin and, after the CLI exited by itself, kills the survivors of that snapshot (POSIX through `sweep`; Windows best effort, `taskkill /F /PID` leaf first); nothing while the spawned process runs. W4 calls both on its close path.

Ladder timing defaults (initial, tunable, H5): `interruptWaitMs 1000`, Windows `eofGraceMs 2000`, `taskkillGraceMs 2000`; POSIX `eofGraceMs 2000`, `termGraceMs 5000`. Every ladder records its termination intent before the first signal (ADR-0008 E8). The interrupt step is a hook (`hooks.interrupt(): Promise<'acknowledged' | 'timeout' | 'not-applicable'>`) supplied by the driver from the machine's `control.settle` or `interrupt-wait` timer (plan decision; reason: ladder stays ordinary async, the protocol step stays in the machine, ADR-0006 E5).

Process identity and signal target (K1): identity, containment root and sweep root are the spawned pid plus its start time (ADR-0011, J9). The POSIX signal target is `initialize.pid` only when it appears in snapshot S1 as a descendant of the spawned pid with a start time matching the snapshot; otherwise it is the spawned pid. A spawned pid that differs from `initialize.pid` emits diagnostic `binary.launcher-detected`.

### 1.8 Claude Code adapter (outside `src/protocol/`)

| Module | Public | Responsibility | ADR |
|---|---|---|---|
| `options.ts` | types public | option types, strict validation, cross-field rules, default resolution into `EffectiveOptions` (JSON) | ADR-0003, ADR-0005 §7, ADR-0012 |
| `rules.ts` | no | tool rule strings and skill names against the tokenizer constraints (no unparenthesized comma or whitespace, balanced parentheses, no leading `-`, no control characters) | ADR-0011 §4 |
| `argv.ts` | no | single point of argv construction (§2.5) through `formatFlag` | ADR-0011 §3 |
| `env.ts` | no | presets and the object form `{ preset, add, remove }` (K19); pinned keys; dropped and added names; win32 case-insensitive names | ADR-0012 §4 |
| `settings-guard.ts` | no | `projectCredentialEnv: 'refuse'` pre-spawn check (read only, K5) | ADR-0012 §2 |
| `discovery.ts` | no | discovery order ratified in K7 | ADR-0011 §5 |
| `provenance.ts`, `known-binaries.ts` | no | digest table for the tested window plus application digests (K8); the pinned publisher | ADR-0011 |
| `posture.ts` | no | Claude posture entries; `managedPolicy` from the child env and a read-only parse of the user's settings `env` (K23) | ADR-0012 §5, §7 |
| `capabilities.ts` | no | `HarnessCapabilities` for Claude Code v1 | architecture "Capability model" |
| `compat.ts` | no | `CLAUDE_CODE_COMPAT = { minTested, maxTested, knownBroken }`, `compatStatus(version)` | ADR-0004 §4 |
| `registry.ts` | no | per-Harness live session-id lock | ADR-0008, J6 |
| `adapter.ts`, `connect.ts`, `session-factory.ts` | `connect`, `session`, `hudhud` public | validate -> guard -> cwd -> resolve -> verify -> spawn -> job -> driver(`claudeSessionMachine`) | all |
| `raw/index.ts` | `/raw` | unstable tier (§2.6) | ADR-0003, ADR-0004 §5 |

Discovery (K7): (1) `binaryPath`; (2) the native installer launcher `~/.local/bin/claude` (`%USERPROFILE%\.local\bin\claude.exe`) resolved to its version directory; (3) a `PATH` lookup that skips empty and relative entries and the current directory, accepts only `.exe` on win32 and refuses `.cmd`/`.bat`. No `node_modules` probing.

Verification (K8, K9): `known-binaries.ts` is a committed digest table (version -> platform -> sha256, size) for the tested window, updated by the bump PR the lead prepares locally (K16); applications may add digests (`claudeCode.binaryDigests`). Nothing is fetched at run time. `binaryVerification: 'advisory'` (default) uses the digest table only (`verified` on a match, `failed` on a mismatch, `unverified` for an unknown version). `'strict'` first runs the OS signature check (Windows: `Get-AuthenticodeSignature` through `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive`, `shell:false`, the path passed as a separate argument; macOS: `/usr/bin/codesign --verify --strict`), then the digest table, and refuses anything but `verified`. Results are cached per (realpath, size, mtime) for the Harness lifetime, definitive verdicts only: a strict signature check that did not complete (timeout, spawn failure, a failing checker, unusable output) is `failed` with `verification.transient: true`, is never cached, and runs again on the next attempt (ADR-0011, lead decision 2026-10-13). As built (W3-Z ruling 9): `known-binaries.ts` is the single source (the JSON mirror is gone; no `resolveJsonModule`), kept equal to `tooling/cli-pin.json` for every pinned platform by a test, and it holds `CLAUDE_CODE_PUBLISHER`, the exact Authenticode signer subject strict mode requires on Windows (read read-only from the pinned win32-x64 binary; leaf and chain thumbprints recorded as evidence, not pinned, ADR-0011). The adapter passes it as `publisher` to `verifyBinary` and uses `assertSpawnableOrReverify` before the probe and every session spawn (W5).

As built (W4-T3): `capabilities.ts` exports `claudeHarnessCapabilities({ processContainment, containmentReason? })` (pure; the version probe is deliberately not an input, ADR-0004 §4), `parseFeatures` and `featureFlags` (in `protocol/wire/features.ts` so the machines may use them under the K3 dependency rule, re-exported by `capabilities.ts`; feature strings from `system/init` and the `initialize` response: at most 256 entries, at most 128 characters, `[A-Za-z0-9][A-Za-z0-9_.:-]*`, unique, unknown names kept, the rest dropped; the session and turn machines use it). `compat.ts` holds `CLAUDE_CODE_COMPAT` (window 2.1.296..2.1.296, `knownBroken` empty; a test keeps `maxTested`, the digest table and `tooling/cli-pin.json` equal), a strict semver-precedence `parseVersion`/`compareParsed`, `compatStatus` and `claudeCompatInfo`. Policy: a version outside the window, or unparseable, is `untested`; a listed one is `known-broken`; W4-T3 refused neither. Superseded for `known-broken` by the lead decision applied by W4-Z (ADR-0004 §4 amendment): see the connect paragraph below; `untested` stays a warning. `registry.ts` is the per-Harness `SessionRegistry` (an instance per Harness, no module state): `claim(id)` returns a `SessionClaim` (`release()` idempotent, `rebind(id)` atomic for an id learned from `system/init`), ids compare case-insensitively and are bounded (1 to 128 characters, no control characters), `dispose()` drops every claim and later claims throw `HARNESS_DISPOSED`; a conflict throws `SESSION_ID_IN_USE` with `details.sessionId`. Nothing is exported from the package root yet; W5 wires the three modules and exports `CLAUDE_CODE_COMPAT`.

As built (W4-Z, lead decision on W4-T1's question 2): `user-input.ts` exports `encodeClaudeUserInput`, the pure encoder of the neutral `UserInput` (already checked by the binding's `normalizeUserInput`) into Claude Code `message.content`: a string as is; text blocks as is; an image block as `{ type: 'image', source: { type: 'base64', media_type, data } }`; order kept, nothing added or dropped. W5 passes it as the driver's `encodeUserInput` hook; the session machine stays at the wire level and checks the content again. A property test feeds every input the binding accepts through the encoder into the session machine and asserts the written `user` frame carries exactly the encoded content; the loopback conformance replay (§1.6) sends every recorded user message through `session.send` and this encoder.

Connect (K4): `connect()` validates options, resolves and verifies the binary, runs one `claude --version` probe (explicit env, `shell:false`, 15 s timeout; zero network requests, 05 §1) to populate `binary.version` and `compat`, and builds `securityPosture`. Sessions compare `initialize.claude_code_version` with it and emit `binary.version-changed` on drift.

Version policy (lead decision, W4-Z; ADR-0004 §4 amendment; W5 wires it into `connect`): after the probe, a `known-broken` status (the probed version is listed in `CLAUDE_CODE_COMPAT.knownBroken`) refuses the connect with `HARNESS_VERSION_KNOWN_BROKEN` (§3.1, not retryable; `details.version`, `details.reason`), before any session is spawned, unless `claudeCode.dangerouslyAllowKnownBrokenVersion: true`. The opt-in keeps the `compat` status `known-broken` and is listed in `securityPosture` (deviation from the default `false`). Each listing carries a committed reason (W5 adds the reason next to the version in `compat.ts`, with a test that every listed version has one); the reason goes into `details.reason`, never harness output. `untested` (outside the window, or not parseable) stays a warning: the `compat` event and `harness.compat.status`, never a refusal (a daily-moving CLI, ADR-0004 §4). The option is named with the `dangerously` prefix because it weakens a safety default and is listed in `securityPosture` (ADR-0012 §7 naming rule for boolean opt-ins).

Settings guard (K5): runs whenever the effective setting sources include `project` or `local`, whether they come from `workspaceTrust: 'full'` or from `claudeCode.settingSources`. It reads `.claude/settings.json` and `.claude/settings.local.json` in the cwd, in the nearest git root (first `.git` directory or file walking up) and in the main worktree root (follow a `.git` file's gitdir/commondir), per L1 (06 §L, 08). If the git root cannot be resolved it falls back to the K5 superset (cwd and every ancestor) and records a diagnostic. Ancestors, outer repos and `--add-dir` entries are not scanned (the CLI never applies their `env`); `--add-dir` plugin and marketplace entries are an open item for the plugin posture (L3). The scan set is tied to CLI 2.1.296; the canary re-runs the lookup check (W7-T2). It refuses when any `env` key matches `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `/^ANTHROPIC_.*_BASE_URL$/`, `/^CLAUDE_CODE_USE_/`, or a top-level `apiKeyHelper` exists. Unparseable files refuse (fail closed). Variable names, never values, go into the error. Reads use a 2 MiB cap and do not follow a symlinked settings file outside its directory without recording it in `details`. The lookup was narrowed by evidence from spike W0-T2 (08). TOCTOU is documented (ADR-0012).

As built (W5-T1, lead rulings W5 1 to 10):

- Modules. `adapter.ts`: the registration (`CLAUDE_CODE_ADAPTER`, `defineAdapter`), the internal host seam `ClaudeHost` (`nodeHost()` is the real host; tests pass a fake; no custom spawner is public, K18), the error mapping of the process layer to §3.1, and the binary pipeline shared by connect and every session (`verifyExecutable`, `spawnableBinary`, `probeBinary`). `connect.ts`: `connect`, `session`, `hudhud`, the `ClaudeCodeHarness` (one `SessionRegistry`, one `VerificationCache`, the probed binary per Harness); `connectWith`/`sessionWith` take a host factory that is called only after the options validated. `session-factory.ts`: the per-session pipeline. `raw-channel.ts` (new): the transport tap of the raw tier; it lives outside `src/raw/` because the session factory wraps every session's transport with it and `raw-only-from-raw` forbids the reverse import. `raw/session.ts`: `raw`, `createSessionRaw`. The package root `index.ts` and `raw/index.ts` are the public barrels (W5-Z).
- Order (§5.7, ruling 8). `connect`: validate, then (host made) resolve, verify, the spawn gate (`assertSpawnableOrReverify`), exactly one `--version` probe (whose own `assertSpawnable` reads the identity once more), the posture (parent env plus the read-only user settings scan, K23), the capabilities (`jobContainmentCapability`). `sessions.create`/`resume`: validate (options, session id, argv, child env; pure), the guard, the cwd, the session's posture, the spawn gate, `checkCommandLine`, the registry claim, the spawn with the containment's start-time reader (job assignment inside the spawn, before `process.started`), the driver. `session()`: validate both option sets and the launch, the guard and the cwd, then connect, then the session; its private Harness is disposed when the session closed or failed to open. An `AbortSignal` is checked between the steps (a running probe or check completes first, so nothing is left running); during the handshake it aborts the session and the call rejects with `AbortError` after the ladder. Disposing a Harness disposes the registry, aborts the drivers still starting (their call rejects `HARNESS_DISPOSED`), then disposes the live sessions.
- Probe environment: the default `'harness'` preset with hudhud's pinned keys (`DISABLE_AUTOUPDATER`, nonessential traffic off, `CLAUDE_CONFIG_DIR` with `configDir`), minus every credential variable (`isCredentialEnvName`; plan decision, least privilege: `--version` needs none and makes no network request); the probe never sees a session's `env` option. The default `cwd` (`process.cwd()`) is read when a session starts, not at connect.
- Re-verification at a session (ruling 2): when the gate finds the file changed, it re-resolves the discovered path, verifies the new file fully (cache keyed by identity), probes it once (its bytes were never probed: K4 is one probe per verified file, still exactly one per connect), applies strict mode and the version policy as at connect, and checks the identity once more right before the spawn (a second change refuses, `BINARY_VERIFICATION_FAILED`). The Harness then spawns the new binary; `harness.binary` and `harness.compat` stay the connect facts, the session's `compat` replay and `SessionInfo.version` are the new ones, and a different version is published as `binary.version-changed` (`reverified: true`). A transient verdict fails that attempt only and is never cached (tested through connect and through a Harness).
- Version policy (ruling 1): `compat.ts` holds `CLAUDE_CODE_KNOWN_BROKEN`, the listings `{ version, reason }` with a committed reason each; `CLAUDE_CODE_COMPAT.knownBroken` is derived from them, so a version cannot be listed without a reason, and `checkKnownBrokenListings` (run by a unit test) refuses an empty, multi-line, control-character or over-512-character reason, a duplicate and an unparseable version. `probeBinary` refuses a listed probed version with `HarnessVersionKnownBrokenError` (`details.version`, `details.reason`) unless `claudeCode.dangerouslyAllowKnownBrokenVersion` (new option in the schema, the types and the connect posture). Drift: the session machine got three optional config fields (`probedVersion`, `knownBroken` listings, `allowKnownBrokenVersion`); on the `initialize` response every drift emits `binary.version-changed` (`probedVersion`, `version`, `knownBroken`, untrusted text capped), and a listed drifted version fails the handshake through the machine's own fatal path (`HARNESS_VERSION_KNOWN_BROKEN` with `version`, `reason`, `probedVersion`; intent `handshake-failed`, the ladder runs, nothing but `initialize` was written) unless allowed. Without `probedVersion` (recorded replays) nothing changes. Plan decision (safer than wrapping the machine): the check lives in the machine because only there the handshake can fail before `handshake.ok` and before any held write is flushed; the W3-T1 file gained the check only, with its own tests and the drift arbitraries in the machine-kit property.
- Guard under `'allow'` (ruling 3): `settings-guard.ts` gained `scanProjectSettings`, the same read-only scan without the refusal (`checkProjectCredentialEnv` is that scan plus the refusal). Its variable names feed `projectSettingsFlagsOf` into `ClaudePostureInput.projectSettings`; whenever it found a credential or routing variable, an `apiKeyHelper` or an unparseable file, the diagnostic `settings-guard.allowed` lists names, `apiKeyHelper`, the unparseable files and the scope (never values). The guard's own diagnostics (`settings-guard.git-root-unresolved`, `settings-guard.symlink-followed`) are published in both modes.
- Session diagnostics, published through `DriverOptions.diagnostics` before `process.started`, in this order: `security.posture` (`{ entries }`, the session's full posture: connect and session options, `managedPolicy` from the child env and the user settings, the raw extras), `binary.version-changed` (re-verified), `binary.unverified` (the verdict when not `verified`), `env.dropped` (`{ names, spawnInjected }`), `env.added`, `env.removed` (`{ names }`, each only when non-empty), the guard's, `containment.fallback`. New diagnostic codes (open vocabulary): `security.posture`, `settings-guard.allowed`, `session.id-in-use`. They reach the application through the driver's pre-handshake replay (§1.6, lead review of W5-T1, Q1): every `events()` subscriber receives them after `compat`, also one made after `create` resolved (`test/unit/adapter/session.test.ts`).
- Registry (ruling 6): the claim is taken right before the spawn (after the gate) and released when the driver ended; `SESSION_ID_IN_USE` spawns nothing. The machine is driven through a thin wrapper that, when the machine first records `observedSessionId`, rebinds the claim to it; an id another live session of the Harness holds adds the diagnostic `session.id-in-use` and aborts the session after the step (two live processes on one id diverge, J6); an id the registry cannot hold (over 128 characters, control characters) keeps the claim on the expected id (the machine's `session.id-mismatch` already reports it).
- Close path (ruling 4): the process transport's `afterExit` runs `sweepAfterExit` after a graceful close; the driver publishes `termination.sweep-after-exit` (tested with a fake process table where a tool outlived the CLI). User input (ruling 5): `encodeClaudeUserInput` is the driver's `encodeUserInput`. The permission callback is passed to the driver behind a typed adapter; the bridge copies and checks every decision (a throwing handler is answered with the machine's deny).
- Raw tier (§2.6): every session's transport goes through a `RawChannel`; it parses a line only while a raw subscriber or a raw control request waits. `frames()` uses the core fanout (exported from `@hudhudjs/core/binding` for it, beta: `Fanout`, `FanoutDeps`, `FanoutSubscriberOptions`, `Selection`, `SizedEvent`, `AbortSignalLike`, `OverflowInfo`; this reverses W4-Z's listing of `Fanout` as internal, accepted by the lead review of W5-T1, Q2: one bounded queue implementation beats two; `BoundedQueue` stays internal) with the session's subscriber defaults; a dropped stretch under `'drop-oldest-with-gap-marker'` yields one explicit `RawGap` (`{ kind: 'gap', seq, ts, dropped }`, `seq` that of the first frame left out; lead review Q8b), so `RawFrame` is `RawWireFrame | RawGap` with `kind: 'frame'` on wire frames (§2.6). Every pending `controlRequest` rejects with `SESSION_CLOSED` when the session ends, by close or by dispose (Q8a). `controlRequest` uses ids `hudhud-raw-<n>` (the machine reports the answer as `control.unknown-response`), has no default timeout (`timeoutMs` optional, a positive safe integer), and settles with the answer, `CONTROL_REQUEST_FAILED` (error answer or timeout), `ABORTED` or `SESSION_CLOSED`. Both writing calls keep the outbound policies (`rawControlRefusal`, `rawFrameRefusal`) and the outbound cap. `createSessionRaw` checks the extras (`checkExtraArgs`, `checkExtraEnv`, shapes) before anything runs; `extraArgs` follow hudhud's argv, `extraEnv` overrides the child env (names without case on win32).

### 1.9 Security defaults and posture (ADR-0012)

`core/src/security/posture.ts` (neutral model and builder): `buildPosture(entries: PostureEntryInput[]): SecurityPosture`, each entry `{ setting, value, defaultValue, deviates }`, `deviates` by deep JSON equality. `claude-code/src/posture.ts` produces the Claude entries. Membership is fixed in [§2.4](#24-options-defaults-and-securityposture-membership); a test enumerates the option schema and fails if a security-relevant option lacks an entry (ADR-0012 §7).

`managedPolicy` (K23): `'not-fetched-custom-base-url'` when `ANTHROPIC_BASE_URL` is set in the child env or in the `env` of the user settings file (`<config dir>/settings.json`, where the config dir is `claudeCode.configDir`, else `CLAUDE_CONFIG_DIR`, else `~/.claude`); `'not-applicable-third-party-provider'` when a `CLAUDE_CODE_USE_*` switch is set there; otherwise `'fetched-if-eligible'`. The user settings file is parsed read-only for these keys only; values are never logged or stored (only booleans leave the parser); the file is never written (R6). As built (W3-T4, W3-Z ruling 3): two more values, `'unknown-raw-settings'` (the `/raw` `extraArgs` pass `--settings`) and `'unknown-user-settings-unreadable'`; precedence base URL, provider, raw settings, unreadable. The user settings file is `<config dir>/settings.json` only. `ClaudePostureInput.projectSettings` (from `projectSettingsFlagsOf` over the guard's findings when the session runs with `projectCredentialEnv: 'allow'`) feeds the same decision; the adapter assembly (W5) runs the scan under `'allow'` and wires it. As built (lead review of W5-T1, Q6): `'unknown-project-settings-unreadable'` when that scan found a file it could not read or parse (`ProjectSettingsEnvFlags.readable`); precedence base URL, provider, raw settings, project unreadable, user unreadable (reasons in ADR-0012 §5). No schema or API report lists the values yet: `posture.ts` is internal until W5-Z exports it. The neutral builder (`buildPosture`, `parsePosture`, `serializePosture`, `postureDeviations`, `postureEntry`) is exported from the `@hudhudjs/core` root.

### 1.10 Errors, capabilities, observability

- Errors: `core/src/protocol/errors.ts` (data) and `core/src/binding/errors.ts` (classes), table in §3.
- Capabilities: computed by `claude-code/src/capabilities.ts` at connect; per-session `features` from `system/init.capabilities`; per-session `containment` (K2).
- Observability (ADR-0016): `observability/redact.ts` exports `redactText(text, secrets)` and `redactJson(value, policy)`. Values of every child env variable whose name matches `/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i` are replaced by `<redacted>` wherever they occur; `sk-ant-` keys, bearer tokens and URL userinfo are masked; headers `x-api-key`, `authorization`, `cookie`, `proxy-authorization` are masked. `observability/stderr-tail.ts`: last 2048 UTF-16 code units, redacted on read (02 §2.6). As built (W4-Z, a defect found by the `StderrTail` property, seed 2115420365): every redaction rule now matches on the original text and the union of all matches is masked at once. Before, the literal secrets were masked first and the shape rules stopped at the inserted marker, so a known secret inside a credential left the rest readable (an `sk-ant-` key with a known secret inside kept its tail; `https://user:pa<secret>ss@host` kept `user:pa` and `ss`; a `Bearer` or `name=value` token kept its tail; a known secret covering the start of `sk-ant-` left `-ant-...`). `observability/usage.ts`: cumulative usage plus estimated deltas typed `{ estimate: true }`. Diagnostics carry env names only (ADR-0012 §4). `TRACEPARENT`/`TRACESTATE` are removed from the child env in every form of `env` unless the `trace` option is set (ADR-0016 §2).

### 1.11 Test support (`tooling/test-support`)

| Module | Responsibility | Seed |
|---|---|---|
| `mock/server.ts` | in-process `http.Server` on `127.0.0.1:0`; Messages API (SSE and non-streaming), scenario markers `[[mock:NAME k=v]]` in user text only, step = assistant messages after the marked message, never assumes the last message is `user` (D16) | `S/sandbox/mock-api/server.mjs` |
| `mock/provider.ts` | pluggable response provider; responses typed against `@anthropic-ai/sdk` (dev dependency of test-support only) | ADR-0013 §6 |
| `mock/egress-trap.ts` | `CONNECT`: log host, answer 403, `socket.on('error')` before any write (J12); absolute-URI proxy requests logged and refused; every hit and every non-allowlisted path is a violation that fails the test | 05 §2, 07 §0.2 |
| `mock/allowlist.ts` | `POST /v1/messages?beta=true` only, plus per-test extras | ADR-0013 §5 |
| `cli/pinned.ts` | fetch, verify and cache the pinned CLI (§4.6) | 05 §1 |
| `cli/newest.ts` | canary: resolve the newest published version, record its registry integrity for the run, fetch and verify against that record (K16) | |
| `launcher/sandbox.ts` | per-test sandbox (config, home, appdata, tmp on a native filesystem outside the home tree; on macOS the default test root is `/private/tmp` (real path), because `$TMPDIR` under `/var/folders` leaves no room for the CLI socket (05 §13, gate items 5 and 6) and `RUNNER_TEMP` lies under the runner's home; ancestor check for `.claude`, `CLAUDE.md`, `.mcp.json`); `testConnect(opts)` injecting the pinned `binaryPath`, an explicit env map (fake key, base URL = mock, `HTTPS_PROXY`/`HTTP_PROXY` both cases = mock, `NO_PROXY=127.0.0.1`, nonessential variable on, Git Bash path on win32) and `claudeCode.configDir` | 05 §3, §13.2; `S/sandbox/driver/lib.mjs` |
| `launcher/warm.ts` | warms a fresh config dir with one session before concurrent fan-out (J11) | |
| `leaks/` | records every spawned root, samples descendants, asserts zero survivors; suite-level sweep by sandbox root in command lines (07 §13); sources: Linux `/proc`, Windows one WMI query, macOS the core `ps` adapter plus one `ps ... args=` run joined by pid and start time | `S/sandbox/driver/t06-tree.mjs` |
| `fixtures/recorder.ts` | drives the pinned CLI directly (not through hudhud) and records `in`/`out`/`err`/`exit` into the conformance format; normalizer replaces uuids, pids, paths, versions, timestamps, durations and costs | `lib.mjs` `Session` |
| `fixtures/record/` | as built (W3-Z ruling 5): the suite scripts of §4.3 (`suites.ts`, against a `ScriptSession` with an injected delay) and the recording driver (`record.ts`: per suite a fresh sandbox and mock, the egress trap, the leak tracker with sampling, the orphan settle, the outside-write check; `main.ts`, `pnpm fixtures:record`), reused by the canary; as built (W4-T2) every case launches with the product's own argv and environment (`launch.ts`, builders injected by `packages/claude-code/test/record/`, see §4.3); `RecordingSession` attaches its listeners in the launch's `onSpawn` hook | W3-T6 scratch recorder |
| `machine-kit.ts` | reusable fast-check kit asserting the contract invariants of §1.4 against any `HarnessMachine` | K3 |
| `snapshots/request-shape.ts` | normalized structural snapshots; semantic change fails, additive warns | ADR-0013 §4 |
| `canary/classify.ts` | classifies a red canary run as `mock-inadequate` or `protocol-regressed` and writes the job summary | ADR-0013 §8 |
| `canary/bump.ts` | local, lead-run helper (`pnpm cli:bump <version>`): updates `tooling/cli-pin.json`, `known-binaries.ts`, `CLAUDE_CODE_COMPAT.maxTested`, re-records fixtures; never pushes | K16 |

Golden fixtures: `packages/claude-code/conformance/<suite>/<case>.jsonl`; line format from the neutral `conformance.schema.json`: `{"t":<ms>,"dir":"config"|"in"|"out"|"err"|"exit"|"cmd"|"timer","v":<json>}` followed by `{"dir":"expect","effects":[...],"events":[...]}` blocks. The conformance runner replays them against `claudeSessionMachine.step` with a fake clock.

As built (W3-Z): the launcher refuses the real pinned CLI on a local macOS host (`launcher/host-policy.ts`, ruling 10: the CLI calls `security(1)` on the login keychain even with an API key) unless `CI=true` and `RUNNER_ENVIRONMENT=github-hosted`, or `HUDHUD_ALLOW_LOCAL_MACOS_REAL_CLI=1`; the macOS gate checks the same policy. The refusal is keyed on what would run, not on the pin's path (lead review): default deny, only a pin entry whose sha256 is that of the running Node.js binary (the stand-in CLI of the unit tests) passes, and the host markers come from the real process environment, never from the caller's `env`. An injected platform can only make the policy stricter: a run counts as macOS when the injected platform or the real `process.platform` is `darwin` (also for the macOS gate). A sandbox may be created with the test-only `credential: 'fake-auth-token'` (`ANTHROPIC_AUTH_TOKEN` set to a fake `sk-ant-fake-hudhud-` token, no API key) for the K10 fixture; callers still cannot set protected names. Every Vitest project runs with a 60 s hang guard as its test and hook timeout (ruling 4; ADR-0013 item 20).

As built (W6-T0, the integration harness): `testConnect` lives in test-support, not in `launcher/sandbox.ts`, as `launcher/integration.ts` (`IntegrationSuite`: suite, test and teardown lifecycle; `registerIntegrationHooks`) and `launcher/product-host.ts` (the host seams and the launch check). Test-support may not depend on the adapter (§4.3 "Single-source launch"), so the product's connect is injected: the composition root is `packages/claude-code/test/integration/support/harness.ts`, which passes the adapter's `connectWith` (the body of the public `connect`) over its real host (`nodeHost()`) with only these seams replaced: the parent environment is the sandbox's explicit map (never `process.env`, so no `env` form, `'inherit'` included, can reach a host variable), `homedir` and `cwd` are the sandbox's, the version probe's directory is made in the sandbox temp directory, and every launch (session spawn and version probe) is checked before the core starts it: the file is the verified pinned binary unchanged since verification (`recheckPinnedCli`: under the cache root, same device, inode, size and mtime), the working directory lies inside the sandbox, and the environment keeps every isolation variable of the sandbox (`assertKeepsIsolation`, shared with `exactLaunch`; the probe alone may lack the credential, which the product never gives it, and a launch may add only `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, which a sandbox of the one trap test leaves out). A refused launch fails the test even when the product caught it. Discovery, verification, the probe, the argv and environment builders, the spawn, the machine and the ladders are the product's own. ESLint keeps `connectWith`, `sessionWith` and `nodeHost` to the composition root. Per suite: the pinned CLI is resolved once (refused on a local macOS host by `host-policy.ts`, unchanged), and a suite directory is made under the test root after the forbidden-ancestor check and used by its real path, because hudhud runs the CLI in the real path of its cwd (`validateCwd`): a `subst` test root must not move the run out of the sandbox. Per test (on first use): a fresh mock with its egress trap, a fresh sandbox in the suite directory, and a leak tracker (before snapshot, descendant sampling every 250 ms, 1 s on Windows); every spawned session process is recorded by its spawn identity (`HarnessProcess.identity`, new `LeakTracker.recordIdentity`; a root whose identity cannot be read, or is read in another unit than the leak table's, fails the test). After each test the harness always disposes every Harness the test connected, then fails the test for a root that has not exited, a tracked, new or command-line-marked survivor (killed by verified pid and start time first), a refused launch, or an egress violation of any of the test's mocks, and closes the mocks and removes the sandbox; `afterAll` sweeps for processes naming the suite directory (07 §13) and removes it. J11: `warm()` runs one complete session through the product (the injected `warmUp`) and checks the CLI-written `.claude.json` before a test fans out.

How a Wave 6 suite uses it (one context per test; tests of a file run one after the other, fan-out happens inside a test after `warm()`):

```ts
import { integrationSuite } from '../support/harness.js';

const suite = integrationSuite(); // registers beforeAll/beforeEach (+ onTestFinished)/afterAll

test('...', async () => {
  // Optional, before the first use: mock provider or allowlist, sandbox options
  // (nonessentialTraffic 'allowed' for the one trap test, credential, extra env).
  await suite.setup({ mock: { allow: [] }, sandbox: { name: 'perm' } });
  const harness = await suite.testConnect({ binaryVerification: 'advisory' }); // connect options minus binaryPath
  const session = await harness.sessions.create({ onPermission }); // cwd: the sandbox work dir
  const result = await session.ask('[[mock:bash cmd=...]] go');
  await session.close();
  const mock = await suite.mock(); // requests, violations
  const second = await suite.extraMock(); // e.g. the C3 redirect target, asserted and closed too
  const sandbox = await suite.sandbox(); // dirs, env
});
```

`suite.testSession({ connect, session })` is `testConnect` plus `sessions.create`. Run: `pnpm cli:fetch` once (registry.npmjs.org only, verified against the pin), then `pnpm test:integration` (`pnpm build`, then the Vitest project `integration`); on Windows set `HUDHUD_TEST_ROOT` to a directory outside the user profile (the default temp directory lies under it and is refused with instructions), for example `C:\hudhud-test-root`.

As built (Wave 6, harness additions; W6-Z closer rulings 1-5). All in `launcher/integration.ts` and `leaks/tracker.ts` unless named, each with unit tests at 100 % coverage:

- `testLaunch(launch)` (W6-T1): runs another product entry point (the adapter's `session()`, whose Harness is private, through `ClaudeIntegrationSuite.testSessionFunction`) with the same request, seams and tracking as `testConnect`; what it returns is disposed after the test, after the Harnesses.
- `onSpawn(listener)` (W6-T1): called with each spawned session process once the harness recorded it; the product receives the process only after every listener settled (a test aborts a session at a chosen point before its handshake). `product-host.ts` awaits the harness's `onRoot`.
- `TestSetup.rootsMayExitBeforeIdentity` (W6-T1), opt-in and only for a CLI that exits on its own at once (resume of an unknown id, 07 §1 a11): a root whose identity read reports `exited` does not fail the test; it must still have exited, and every new process and every process naming the sandbox still fails the test.
- `TestSetup.launcher` (W6-T3): a generated `#!` launcher in front of the pinned CLI (`launcher/test-launcher.ts`, POSIX), and `support/crash-host.mjs`, the child host of the host-crash test (see §4.4).
- Identity first, on for every suite (ruling 1): the sandbox spawn seam hands a spawned root to the product only after its identity read settled, so a session a test ends right after its spawn still has a tracked tree. Measured (W6-Z, Windows 11 without the job addon, the whole integration project file by file): identity reads 1241-1524 ms (n=90); the shortest roots lived 324 and 418 ms; with 15 files at once the reads took 4.9-5.8 s. The product's timing is unchanged (only the test seam waits; the CLI's output waits in the pipe). The suite-local `identityFirst` listener (W6-T1) and `IntegrationSuite.identified()` (W6-T2) are gone.
- The integration project runs one test file at a time (`fileParallelism: false` in `vitest.config.ts`). Root cause of the failures with a worker per core, from traced whole-project runs on the 16-core W6-Z Windows host (temporary instrumentation of every product and harness phase: connect, binary verification, probe, spawn, identity read, each stdin and stdout line, mock request, CIM query, the driver's close and exit path, the harness's after-test checks; host CPU sampled each second), file by file vs 15 files at once: host CPU busy median 19 % vs 100 %; concurrent CIM queries (one `powershell.exe` each) median 1 vs 15, at most 2 vs 29; one CIM query median 1.28 s vs 4.86 s; the product's identity read 1.31 s vs 4.93 s; the product's sha256 of the 260 MB pinned binary at connect median 0.37 s vs 18.3 s (max 0.42 s vs 46.3 s); the CLI's answer to `initialize` median 13 ms vs 70 ms. In each of the 12 tests of that run that reached the 60 s hang guard every phase completed or was still progressing: the binary hash took 28-46 s of the 60 s, product CIM queries (identity reads, the close's EOF snapshot, the after-exit sweep) 5-23 s, everything else 4-17 s; at 60 s each test was in a product CIM query (the close's EOF snapshot or the after-exit sweep) or in a CLI turn that was answering, and the CLI answered every input within milliseconds; no product state machine waited on an event that never came. The run's other failures followed from the same load: a fail-fast bound of 1.8 s (3x the unloaded measurement) measured at 2.2 s, a process tree sampled after it had changed, and the workloads of tests cut off at the guard. So the failures are host contention (CPU saturation by 15 parallel CLIs, binary hashes and `powershell.exe` CIM queries), not a product hang. File by file the slowest test body took 17.3 s (n=88), under a third of the 60 s hang guard, and the after-test checks at most 2.1 s of their 120 s guard, so neither guard changes. Concurrency stays inside a test, after `warm()` (J11).
- Leak tracker, pid reuse (W6-Z): a process is no longer a descendant of a known process whose pid the table now shows with another start time, when it started no earlier than that new holder. Measured on Windows: an exited root's pid reused by the harness's own CIM query (`powershell.exe`), whose `conhost.exe` was then reported as the root's descendant (the signature of the conhost flakes W6-T4 reported: a `conhost.exe` descendant already gone at the kill). A process that started before the holder stays a descendant (a Windows orphan keeps naming its dead parent).
- Conhost settle (ruling 2): on Windows the `conhost.exe` of a recorded root that has exited is a leak only if a fresh read after `CONHOST_SETTLE_MS` (1 ms) still lists it; every other survivor is a leak at once. Sized as 3x the slowest measured teardown: after Node observed the root's exit its own `conhost.exe` was gone within 0.28 ms (pinned CLI, n=79) and 0.2 ms (a Node child, n=40). The confirming read (a CIM query of 1.2 s or more) follows the window.
- Workload tags (ruling 3): `suite.workloadTag(seconds)` returns `<seconds>.<15 random digits>`, a duration GNU `sleep` accepts; every Bash-tool workload that can outlive its tool call (the containment suites' `sleep`s, the permissions suite's background `sleep`) carries its test's tag as its argument. After each test, after the tracker's checks, every process whose command line contains one of the test's tags fails the test and is killed by verified pid and start time. Reason: on Windows Git Bash starts an external command from a forked `bash.exe` that exits at once, so no parent-pid walk reaches it (ADR-0009 MSYS2 residual, W6-T3); the check runs on every platform (on Linux an orphan re-parented between two samples escapes the walk too).
- After-test checks as `onTestFinished` (ruling 5): `registerIntegrationHooks` registers `endTest` from its `beforeEach` as the starting test's `onTestFinished` hook. Vitest runs `afterEach` hooks in reverse order of registration and stops at the first that throws, so a test file's own failing `afterEach` used to skip the harness's checks; `onTestFinished` hooks run after every `afterEach` hook, each on its own (`test/launcher/hook-order.test.ts` proves it on the real runner). The suite-level sweep stays an `afterAll` hook: Vitest offers no equivalent that runs after a failing `afterAll`.
- `isHudhudError(value, code?)` (ruling 6) replaces the lifecycle suites' local `hasCode`.

---

## 2. Public API for v1

Stability tags follow ADR-0003: §2.2-§2.5 are the stable tier (`@public`); `claudeCode` options are the harness-namespaced tier; §2.6 is `/raw` (unstable). Declarations are complete for v1; JSDoc is omitted here and required in code.

### 2.1 Entry points

| Specifier | Contents |
|---|---|
| `@hudhudjs/core` | neutral public types (`Harness`, `Session`, `Turn`, events, results, capabilities, posture, errors), error classes, `adapterApiVersion`, `wireSchemaVersion`, `defineAdapter` (`@beta`) |
| `@hudhudjs/core/protocol` | neutral sans-IO API: `HarnessMachine` contract, input/effect types, `classifyExit`, `encodeJsonLine`, `parseJsonLine`, `sanitizeForDisplay`, `ErrorData` |
| `@hudhudjs/core/process` | process layer API used by adapters (§1.7) |
| `@hudhudjs/core/binding` | `@beta`, for adapter authors (W4-Z, lead decision on W4-T1's question 1): the session driver (`SessionDriver`, `openSession`), the transports (`createProcessTransport`, `HarnessTransport`; the loopback `createLoopbackDriver`, `LoopbackTransport`, `loopbackMachine`), the clocks and id sources, the host-exit hook, `createSession`, `HarnessBase`, `normalizeUserInput`, the bounded fanout (`Fanout` and its option types; added by W5-T1 for the raw tier's frames), and type-only re-exports of the process and protocol types they name. Not part of the application API: the root stays the stable application tier, and no custom spawner is public (K18) |
| `@hudhudjs/core/schemas/*.json` | neutral JSON Schema files (exports `"./schemas/*": "./schemas/*"`) |
| `@hudhudjs/claude-code` | `connect`, `session`, `hudhud`, Claude Code option and request types, `CLAUDE_CODE_COMPAT` |
| `@hudhudjs/claude-code/schemas/*.json` | Claude wire and option schemas |
| `@hudhudjs/claude-code/raw` | unstable tier |
| `hudhudjs` | re-exports of `@hudhudjs/core` and `@hudhudjs/claude-code` (no logic) |

### 2.2 Harness-neutral stable tier (`@hudhudjs/core`)

```ts
export declare const adapterApiVersion: 1;
export declare const wireSchemaVersion: 1;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

// ---- capabilities -------------------------------------------------------
export type Capability = 'supported' | 'emulated' | 'unsupported';
export type ProcessContainment = 'job' | 'best-effort' | 'cgroup';
export interface HarnessCapabilities {
  readonly multiTurn: Capability;
  readonly resume: Capability;
  readonly fork: Capability;
  readonly interrupt: Capability;
  readonly permissionsInBand: Capability;
  readonly workspaceTrust: { readonly none: Capability; readonly context: Capability; readonly full: Capability };
  readonly processContainment: ProcessContainment;   // what this Harness can provide (K2)
  readonly reasons: { readonly [capabilityPath: string]: string };
}

// ---- binary, compat, posture --------------------------------------------
export interface BinaryVerification {
  readonly status: 'verified' | 'unverified' | 'failed';
  readonly method: 'os-signature' | 'sha256-manifest' | 'none';
  readonly mode: 'advisory' | 'strict';
  readonly detail?: string;
}
export interface BinaryInfo {
  readonly path: string;
  readonly requestedPath?: string;
  readonly version: string;               // from the connect probe (K4)
  readonly source: 'option' | 'native-install' | 'path';
  readonly verification: BinaryVerification;
}
export interface CompatInfo {
  readonly harness: string;
  readonly version: string;
  readonly minTested: string;
  readonly maxTested: string;
  readonly knownBroken: readonly string[];
  readonly status: 'tested' | 'untested' | 'known-broken';
}
export interface SecurityPostureEntry {
  readonly setting: string;
  readonly value: JsonValue;
  readonly defaultValue: JsonValue;
  readonly deviates: boolean;
}
export interface SecurityPosture { readonly entries: readonly SecurityPostureEntry[] }

// ---- events -------------------------------------------------------------
export interface EventBase { readonly seq: number; readonly ts: string; readonly sessionId: string }
export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other' | (string & {});
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | (string & {});
export interface UsageTotals {
  readonly inputTokens?: number; readonly outputTokens?: number;
  readonly cacheCreationInputTokens?: number; readonly cacheReadInputTokens?: number;
  readonly costUsd?: number;
}
export type TurnOutcome = 'completed' | 'error' | 'cancelled' | 'max-turns' | 'max-budget' | 'unknown' | (string & {});
export interface TurnResult {
  readonly turnId: string;
  readonly sessionId: string;
  readonly outcome: TurnOutcome;
  readonly isError: boolean;
  readonly text?: string;
  readonly stopReason?: StopReason;
  readonly terminalReason?: string;
  readonly errors?: readonly string[];
  readonly apiErrorStatus?: number;
  readonly usage?: UsageTotals;
  readonly permissionDenials: readonly { readonly toolName: string; readonly toolUseId: string }[];
  readonly synthesized: boolean;
  readonly raw?: JsonValue;
}
export type DiagnosticCode =
  | 'env.dropped' | 'env.added' | 'env.removed' | 'binary.launcher-detected' | 'binary.version-changed' | 'binary.unverified'
  | 'project.permissions-ignored' | 'containment.fallback' | 'containment.addon-unavailable'
  | 'stdout.non-json-line' | 'frame.skipped-oversized' | 'interrupt.still-queued-retry'
  | 'session.id-mismatch' | 'control.unknown-response'
  | 'events.pre-handshake-truncated' | 'security.posture' | 'settings-guard.allowed' | 'session.id-in-use'   // W5 (as built: the full list is DiagnosticCode in core events/types.ts and events.schema.json)
  | (string & {});

export type HudhudEvent =
  | (EventBase & { type: 'compat'; compat: CompatInfo; raw?: JsonValue })
  | (EventBase & { type: 'session.started'; mode: 'create' | 'resume' | 'fork'; pid: number; cliPid?: number; version: string; apiKeySource?: string; tokenSource?: string; permissionMode?: string; raw: JsonValue })
  | (EventBase & { type: 'turn.queued'; turnId: string })
  | (EventBase & { type: 'turn.started'; turnId: string; origin: 'application' | 'harness'; features: readonly string[]; model?: string; raw: JsonValue })
  | (EventBase & { type: 'message.assistant'; turnId?: string; text?: string; aborted?: boolean; raw: JsonValue })
  | (EventBase & { type: 'message.delta'; turnId?: string; index: number; deltaType: 'text' | 'thinking' | 'input_json' | (string & {}); text?: string; raw: JsonValue })
  | (EventBase & { type: 'tool.call'; turnId?: string; toolUseId: string; toolName: string; kind: ToolKind; status: 'pending'; input: JsonValue; raw: JsonValue })
  | (EventBase & { type: 'tool.result'; turnId?: string; toolUseId: string; status: 'completed' | 'failed'; raw: JsonValue })
  | (EventBase & { type: 'permission.requested'; requestId: string; turnId?: string; toolName: string; toolUseId: string; raw: JsonValue })
  | (EventBase & { type: 'permission.resolved'; requestId: string; behavior: 'allow' | 'deny' | 'cancelled'; by: 'application' | 'harness' | 'close' | 'abort'; raw?: JsonValue })
  | (EventBase & { type: 'permission.denied'; toolName: string; toolUseId: string; reasonType?: string; raw: JsonValue })
  | (EventBase & { type: 'api.retry'; attempt: number; maxRetries?: number; retryDelayMs?: number; errorStatus?: number; error?: string; raw: JsonValue })
  | (EventBase & { type: 'usage.update'; turnId?: string; reported: UsageTotals; estimatedDelta: UsageTotals & { readonly estimate: true }; raw?: JsonValue })
  | (EventBase & { type: 'turn.completed'; turnId: string; result: TurnResult; raw?: JsonValue })
  | (EventBase & { type: 'session.state'; state: 'idle' | 'running' | 'requires_action' | (string & {}); raw: JsonValue })
  | (EventBase & { type: 'background.tasks'; raw: JsonValue })
  | (EventBase & { type: 'stalled'; silentForMs: number; turnId?: string; pendingPermissions: number; raw?: JsonValue })
  | (EventBase & { type: 'diagnostic'; code: DiagnosticCode; message: string; data?: JsonObject; raw?: JsonValue })
  | (EventBase & { type: 'gap'; dropped: number; raw?: JsonValue })
  | (EventBase & { type: 'session.terminated'; intent: string; outcome: string; exitCode?: number; signal?: string; raw?: JsonValue })
  | (EventBase & { type: 'harness.frame'; frameType: string; subtype?: string; raw: JsonValue })
  | (EventBase & { type: string & {}; raw?: JsonValue });                    // open arm

// ---- subscriptions --------------------------------------------------------
export type OverflowPolicy = 'error' | 'drop-oldest-with-gap-marker' | 'block';
export interface SubscriberOptions {
  readonly maxEvents?: number;            // default 10000
  readonly maxBytes?: number;             // default 67108864
  readonly overflow?: OverflowPolicy;     // default 'error'; 'block' can stall control frames
  readonly signal?: AbortSignal;
}

// ---- permissions ----------------------------------------------------------
export interface PermissionRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly toolName: string;
  readonly displayName?: string;
  readonly toolUseId: string;
  readonly input: JsonValue;
  readonly suggestions: readonly JsonValue[];   // passed through, never applied
  readonly blockedPath?: string;
  readonly decisionReason?: string;             // untrusted; sanitizeForDisplay before rendering
  readonly title?: string;
  readonly description?: string;
  readonly raw: JsonValue;
}
export type PermissionDecision =
  | { readonly behavior: 'allow'; readonly updatedInput?: JsonObject; readonly updatedPermissions?: readonly JsonObject[] }
  | { readonly behavior: 'deny'; readonly message: string; readonly interrupt?: boolean };
export type PermissionHandler = (request: PermissionRequest, ctx: { readonly signal: AbortSignal }) => Promise<PermissionDecision>;

// ---- input ---------------------------------------------------------------
export type UserContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; readonly dataBase64: string };
export type UserInput = string | { readonly content: readonly UserContentBlock[] };

// ---- handles --------------------------------------------------------------
export interface SessionInfo {
  readonly id: string;
  readonly mode: 'create' | 'resume' | 'fork';
  readonly forkedFrom?: string;
  readonly pid: number;                   // spawned pid (process identity)
  readonly cliPid?: number;               // initialize.pid (informational)
  readonly version: string;
  readonly apiKeySource?: string;
  readonly tokenSource?: string;          // K10: the auth token shows here (W3-Z)
  readonly features: readonly string[];
  readonly containment: ProcessContainment;   // what this session got (K2)
}
export interface Turn extends AsyncIterable<HudhudEvent> {
  readonly id: string;
  readonly done: Promise<TurnResult>;
  interrupt(opts?: { readonly cancelQueued?: boolean }): Promise<void>;
}
export interface Session extends AsyncDisposable {
  readonly id: string;
  readonly info: SessionInfo;
  readonly closed: Promise<void>;
  ask(prompt: UserInput, opts?: { readonly signal?: AbortSignal }): Promise<TurnResult>;
  send(input: UserInput, opts?: { readonly signal?: AbortSignal; readonly events?: SubscriberOptions }): Turn;
  events(opts?: SubscriberOptions): AsyncIterable<HudhudEvent>;
  setPermissionMode(mode: string, opts?: { readonly signal?: AbortSignal }): Promise<void>;
  close(opts?: { readonly signal?: AbortSignal }): Promise<void>;
}
export interface Harness extends AsyncDisposable {
  readonly capabilities: HarnessCapabilities;
  readonly binary: BinaryInfo;
  readonly compat: CompatInfo;
  readonly securityPosture: SecurityPosture;
}

// ---- adapters (beta) --------------------------------------------------------
export interface AdapterDefinition { readonly name: string; readonly adapterApiVersion: number }
export declare function defineAdapter<T extends AdapterDefinition>(def: T): T;

// ---- errors (section 3) -----------------------------------------------------
export type HudhudErrorCode = /* union of every code in section 3.1 */ string;
export declare class HudhudError extends Error { readonly code: HudhudErrorCode; readonly retryable: boolean; readonly details?: JsonObject }
export declare function isHudhudError(value: unknown, code?: HudhudErrorCode): value is HudhudError;
```

Semantics:

- `ask()` resolves with the `TurnResult` for every completed turn, including `isError: true` and `cancelled`; it rejects only for session-level failures (K21). An aborted `opts.signal` interrupts the turn (gated) and rejects `ask()` with `AbortError` immediately; the turn still settles in the background.
- `send()` returns a `Turn` whose iterator buffers from creation with the subscriber defaults (bounded, `'error'` scoped to that iterator).
- `events()` starts with a replayed `compat` event (seq 0); `harness.compat` exposes the same data; there is no separate harness-level event channel in v1 (K20).
- `close()` drains under a single deadline measured from the call (`closeTimeoutMs`, default 30 s) and then runs the abort ladder (K13). `Symbol.asyncDispose` on Session and Harness runs the abort ladder; disposing a Harness disposes its sessions.
- `setPermissionMode('bypassPermissions')` is refused unless the session was created with `dangerouslyAllowBypassPermissions`.
- hudhud installs no signal handlers; a terminal Ctrl+C that reaches a non-detached CLI ends as outcome `unknown` with `PROCESS_EXITED` (K22). This is documented.

### 2.3 Claude Code adapter (`@hudhudjs/claude-code`)

```ts
import type { Harness, Session, PermissionHandler, SubscriberOptions } from '@hudhudjs/core';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'auto' | 'bypassPermissions';   // K11; 'manual' not offered in v1
export type WorkspaceTrust = 'none' | 'context' | 'full';
export type SettingSource = 'user' | 'project' | 'local';
export type EnvOption =
  | 'harness'
  | 'inherit'
  | { readonly [name: string]: string }                                   // explicit map: exactly these variables
  | { readonly preset: 'harness' | 'inherit'; readonly add?: { readonly [name: string]: string }; readonly remove?: readonly string[] };   // K19

export interface ConnectOptions {
  readonly backend?: 'native';
  readonly binaryPath?: string;
  readonly binaryVerification?: 'advisory' | 'strict';   // K9, default 'advisory'
  readonly claudeCode?: ClaudeCodeConnectOptions;
  readonly signal?: AbortSignal;
}
export interface ClaudeCodeConnectOptions {
  readonly configDir?: string;
  readonly bare?: boolean;
  readonly binaryDigests?: { readonly [version: string]: { readonly [platform: string]: string } };
  readonly dangerouslyAllowRawControl?: boolean;
  readonly dangerouslyAllowKnownBrokenVersion?: boolean;   // W4-Z, ADR-0004 §4 amendment; wired by W5
}

export interface SessionOptions {
  readonly cwd?: string;
  readonly permissionMode?: PermissionMode;
  readonly dangerouslyAllowBypassPermissions?: boolean;
  readonly onPermission?: PermissionHandler;
  readonly workspaceTrust?: WorkspaceTrust;
  readonly projectCredentialEnv?: 'refuse' | 'allow';
  readonly env?: EnvOption;
  readonly autoUpdate?: 'disabled' | 'harness-default';
  readonly nonessentialTraffic?: 'disabled' | 'harness-default';
  readonly dangerouslyAllowConfigWrites?: boolean;
  readonly onAuthFailure?: 'fail-fast' | 'harness-retry';
  readonly onOversizedFrame?: 'fail' | 'skip';
  readonly maxFrameBytes?: number;
  readonly maxOutboundFrameBytes?: number;
  readonly firstFrameTimeoutMs?: number;
  readonly idleStallMs?: number;
  readonly closeTimeoutMs?: number;
  readonly termination?: {
    readonly interruptWaitMs?: number;
    readonly eofGraceMs?: number;
    readonly termGraceMs?: number;
    readonly taskkillGraceMs?: number;
  };
  readonly trace?: { readonly traceparent: string; readonly tracestate?: string };
  readonly claudeCode?: ClaudeCodeSessionOptions;
  readonly events?: SubscriberOptions;
  readonly signal?: AbortSignal;
}
export interface ClaudeCodeSessionOptions {
  readonly settingSources?: readonly SettingSource[];
  readonly model?: string;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly additionalDirectories?: readonly string[];
  readonly maxTurns?: number;
  readonly includePartialMessages?: boolean;
  readonly appendSystemPrompt?: string;
  readonly backgroundWaitCeilingMs?: number;
}
export interface ResumeOptions extends SessionOptions { readonly fork?: boolean }

export interface ClaudeCodeHarness extends Harness {
  readonly sessions: {
    create(opts?: SessionOptions): Promise<Session>;
    resume(sessionId: string, opts?: ResumeOptions): Promise<Session>;
  };
}
export declare function connect(opts?: ConnectOptions): Promise<ClaudeCodeHarness>;
export declare function session(opts?: ConnectOptions & SessionOptions): Promise<Session>;
export declare const hudhud: { readonly connect: typeof connect; readonly session: typeof session };
export declare const CLAUDE_CODE_COMPAT: { readonly minTested: string; readonly maxTested: string; readonly knownBroken: readonly string[] };
```

`continue` is not part of v1 (K6). A custom spawner is not public in v1 (K18).

Cross-field validation (`INVALID_OPTIONS` unless noted): `workspaceTrust` and `claudeCode.settingSources` both set; `workspaceTrust: 'context'` is `CAPABILITY_UNSUPPORTED`; `permissionMode: 'bypassPermissions'` without `dangerouslyAllowBypassPermissions: true` (as built, ruling F2: the flag authorizes bypass for the session, as the initial mode or through a later `setPermissionMode`, so it is valid with any initial mode); a Windows command line above 32,000 UTF-16 code units, measured as `CreateProcess` receives it after libuv's quoting (`checkCommandLine`, ruling F1, before spawn); `projectCredentialEnv` set while the effective sources contain neither `project` nor `local`; rule strings failing `rules.ts`; non-UUID `resume` ids (plan decision: titles are not addressable identities, 07 §1 a12); frame caps outside `[1 MiB, 1 GiB]`, timeouts outside `[1000, 86400000]` ms; env names that are not valid variable names, values containing NUL; `env.add` or `env.remove` naming a hudhud-pinned key (`CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`, `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `CLAUDE_CONFIG_DIR`, `TRACEPARENT`, `TRACESTATE`); `trace.traceparent` not in W3C format.

### 2.4 Options: defaults and securityPosture membership

| Option | Default | Effect | In securityPosture | Ruling / ADR |
|---|---|---|---|---|
| `backend` | `'native'` | only value in v1 | no | 0001 |
| `binaryPath` | discovery (K7) | `binary.source` | no | 0011 |
| `binaryVerification` | `'advisory'` | advisory: digest table only; strict: OS signature then digests, refuse non-`verified` | yes | K8, K9, 0011 |
| `claudeCode.configDir` | user's real config dir | `CLAUDE_CONFIG_DIR` | yes (`'user'` or `'isolated'`, no path) | 0012 §1 |
| `claudeCode.bare` | `false` | `--bare` | yes | 0012 §1 |
| `claudeCode.binaryDigests` | none | extra digests | no | K8 |
| `claudeCode.dangerouslyAllowRawControl` | `false` | `/raw` writes | yes | 0003, 0012 §8 |
| `claudeCode.dangerouslyAllowKnownBrokenVersion` | `false` | run a probed version listed in `knownBroken` instead of refusing it with `HARNESS_VERSION_KNOWN_BROKEN` (§3.1); the `compat` event still says `known-broken` | yes | 0004 §4, 0012 §7 |
| `cwd` | `process.cwd()` realpath'd | `CwdTooLong` check | no | 0011 §9 |
| `permissionMode` | `'default'` | `--permission-mode=<v>` always | yes | K11, 0012 §3 |
| `dangerouslyAllowBypassPermissions` | `false` | `--allow-dangerously-skip-permissions` | yes | 0012 §7 |
| `onPermission` | none | `--permission-prompt-tool=stdio` iff set | yes (`permissionPrompting`) | 0012 §3 |
| `workspaceTrust` | `'none'` | `--setting-sources=user` (`'full'`: `user,project,local`) | yes | 0012 §2 |
| `claudeCode.settingSources` | derived from `workspaceTrust` | `--setting-sources=<csv>` | yes | 0012 §2, H15 |
| `projectCredentialEnv` | `'refuse'` whenever sources include project or local | pre-spawn guard | yes | K5, 0012 §2 |
| `env` | `'harness'` | preset, map, or `{preset, add, remove}` | yes: the form, `'inherit'`, explicit maps (names only), and every credential or routing variable named in `add` (`ANTHROPIC_*`, `CLAUDE_CODE_USE_*`, provider families) | K19, 0012 §4 |
| `autoUpdate` | `'disabled'` | `DISABLE_AUTOUPDATER=1` | yes | 0012 §4 |
| `nonessentialTraffic` | `'disabled'` | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | yes, plus `managedPolicy` | K23, 0012 §5 |
| `dangerouslyAllowConfigWrites` | `false` | keep non-session permission destinations | yes | 0012 §3 |
| `onAuthFailure` | `'fail-fast'` (`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`; not OAuth or `apiKeyHelper`) | §1.5 trigger | no | K10, 0012 §6 |
| `onOversizedFrame` | `'fail'` | | no | 0011 §7 |
| `maxFrameBytes` | 67108864 | inbound cap | no | 0011 §7 |
| `maxOutboundFrameBytes` | 33554432 | outbound cap | no | 0011 §7 |
| `firstFrameTimeoutMs` | 60000 | handshake watchdog | no | 0008 |
| `idleStallMs` | 300000 | `stalled` | no | 0008 |
| `closeTimeoutMs` | 30000, from the `close()` call | drain deadline | no | K13, 0008 |
| `termination.*` | 1000 / 2000 / 5000 / 2000 | ladder timing | no | 0009, 0010 |
| `trace` | none | `TRACEPARENT` only when set | no | 0016 §2 |
| `claudeCode.backgroundWaitCeilingMs` | 600000 | `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` | no | 0008, J5 |
| `claudeCode.allowedTools`, `disallowedTools`, `additionalDirectories` | unset | flags | yes | 0011 §4 |
| `claudeCode.model`, `maxTurns`, `includePartialMessages` (`false`), `appendSystemPrompt` | unset | flags only (W1 provenance ruling) | no | |
| `events` / `SubscriberOptions` | 10000 events, 64 MiB, `'error'` | | no | 0007 |
| (fixed) `initialize.workspaceTrust` | never sent | none in v1 | yes (constant entry) | 0012 §2, J3 |
| (fixed) `permission_suggestions` | never applied | none | yes (constant entry) | 0012 §3 |
| (raw) `extraArgs`, `extraEnv` | none | §2.6 | yes (names only) | 0003 |

Plan decision: `includePartialMessages` defaults to `false`. Reason: each partial frame repeats content (05 §11); streaming applications opt in.

### 2.5 Always-passed argv and environment

```
--output-format=stream-json --input-format=stream-json --verbose
--setting-sources=<csv>                         always (05 §13.1, 07 §9 p5); canonical order user,project,local, no duplicates (ruling F3)
--permission-mode=<mode>                        always (05 §6, D4)
create: --session-id=<uuid>                     resume: --resume=<id>        fork: --resume=<id> --fork-session --session-id=<new uuid>
[--permission-prompt-tool=stdio]                iff onPermission
[--allow-dangerously-skip-permissions]          iff dangerouslyAllowBypassPermissions
[--bare] [--model=] [--max-turns=] [--include-partial-messages]
[--allowed-tools=<csv>] [--disallowed-tools=<csv>] [--add-dir=<path>]...
```

Flag names are kebab case, as the product passes them (`argv.ts`); W6-T4 proved `--allowed-tools` against the pinned CLI (`security/child-launch.test.ts`: the flag reaches the child and the CLI honours it).

Environment (K19): the base comes from the form of `env` — `'harness'` (allowlist by rule, H4; removes `NODE_OPTIONS`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_AGENT_SDK_*`; dropped names reported), `'inherit'` (everything), an explicit map (exactly those variables), or `{ preset, add, remove }` (the preset, then `remove` names deleted, then `add` entries set; added and removed names reported as `env.added`/`env.removed`). Then pinned keys override in every form: `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, `DISABLE_AUTOUPDATER=1` (unless `harness-default`), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (unless `harness-default`), `CLAUDE_CONFIG_DIR` (only with `configDir`); always removed: `CLAUDE_CODE_SDK_READS_SESSION_STATE` (D11), `TRACEPARENT`/`TRACESTATE` (unless `trace`). hudhud never sets `CLAUDE_CODE_ENTRYPOINT` (ADR-0001 §4).

### 2.6 Unstable tier (`@hudhudjs/claude-code/raw`)

```ts
export interface RawWireFrame { readonly kind: 'frame'; readonly direction: 'in' | 'out'; readonly seq: number; readonly ts: string; readonly bytes: number; readonly frame: JsonValue }
export interface RawGap { readonly kind: 'gap'; readonly seq: number; readonly ts: string; readonly dropped: number }   // as built (W5 lead review, Q8b)
export type RawFrame = RawWireFrame | RawGap;
export interface RawSpawnOptions {
  readonly extraArgs?: readonly string[];
  readonly extraEnv?: { readonly [name: string]: string };
}
export interface RawSession {
  frames(opts?: SubscriberOptions): AsyncIterable<RawFrame>;
  controlRequest(subtype: string, body?: JsonObject, opts?: { readonly signal?: AbortSignal; readonly timeoutMs?: number }): Promise<JsonValue>;
  writeFrame(frame: JsonObject): Promise<void>;
}
export declare function raw(session: Session): RawSession;
export declare function createSessionRaw(harness: ClaudeCodeHarness, opts: SessionOptions & { readonly raw: RawSpawnOptions }): Promise<Session>;
```

`controlRequest` and `writeFrame` throw `INVALID_OPTIONS` unless the Harness was connected with `claudeCode.dangerouslyAllowRawControl: true` (plan decision; reason: arbitrary control frames carry the agent's full authority, ADR-0012 §8). `extraArgs` may not contain the flags of §2.5, `--dangerously-skip-permissions` or `--project-config-root` (it moves the project config root, L4); each is rejected with a typed error; `extraEnv` may not name pinned keys.

---

## 3. Error taxonomy

### 3.1 Codes and classes

All classes extend `HudhudError` (`name` equals the class name; `AbortError` keeps `name === 'AbortError'`). `retryable`: repeating the same call with the same inputs may succeed without a change by the application.

| Class | `code` | Raised by | When | Retryable |
|---|---|---|---|---|
| `InvalidOptionsError` | `INVALID_OPTIONS` | `connect`, `create`, `resume`, `send`, `setPermissionMode`, raw | validation or a cross-field rule (§2.3); `details.path`, `details.rule` | no |
| `CapabilityUnsupportedError` | `CAPABILITY_UNSUPPORTED` | options | `workspaceTrust: 'context'`, `backend: 'agent-sdk'`, an `unsupported` capability | no |
| `AdapterApiVersionError` | `ADAPTER_API_VERSION_MISMATCH` | `defineAdapter` | unsupported adapter integer | no |
| `BinaryNotFoundError` | `BINARY_NOT_FOUND` | `connect` | explicit path missing or discovery empty; `details.candidates` | no |
| `BinaryRefusedError` | `BINARY_REFUSED` | `connect` | `.cmd`/`.bat` in the path, not a regular file, not executable, relative `PATH` entry | no |
| `BinaryVerificationError` | `BINARY_VERIFICATION_FAILED` | `connect` | `binaryVerification: 'strict'` and status not `verified` | no |
| `BinaryProbeError` | `BINARY_PROBE_FAILED` | `connect` | `--version` probe fails or times out (15 s) | yes |
| `HarnessVersionKnownBrokenError` | `HARNESS_VERSION_KNOWN_BROKEN` | `connect` | the probed version is listed in the adapter's `knownBroken` and `claudeCode.dangerouslyAllowKnownBrokenVersion` is not `true` (ADR-0004 §4 amendment); `details`: `version`, `reason` (the committed reason of the listing). An `untested` version is never refused (a warning `compat` event) | no |
| `CwdInvalidError` | `CWD_INVALID` | `create`, `resume` | missing or not a directory | no |
| `CwdTooLongError` | `CWD_TOO_LONG` | `create`, `resume` (win32) | realpath'd cwd of 259 UTF-16 units or more; message names `subst`/junction | no |
| `ProjectCredentialEnvError` | `PROJECT_CREDENTIAL_ENV` | `create`, `resume` | guard hit (K5); `details.files`, `details.variables` (names), `details.apiKeyHelper`, `details.unparseable` | no |
| `SessionIdInUseError` | `SESSION_ID_IN_USE` | `create`, `resume` | a live session with that id exists in this Harness (J6) | yes |
| `SpawnError` | `SPAWN_FAILED` | `create`, `resume` | child `error` before spawn; `details.cause`: `'enoent' \| 'eacces' \| 'eperm' \| 'gatekeeper' \| 'unknown'` | no |
| `HandshakeTimeoutError` | `HANDSHAKE_TIMEOUT` | `create`, `resume` | first-frame watchdog; `details.cause: 'no-response'`; darwin `details.hint: 'keychain-prompt-suspected'` | yes |
| `HandshakeError` | `HANDSHAKE_FAILED` | `create`, `resume` | `details.cause`: `'exited-before-response'`, `'stdout-closed'`, `'error-response'`, `'result-before-response'`, `'stdin-error'`; redacted stderr tail | yes |
| `SessionNotFoundError` | `SESSION_NOT_FOUND` | `resume` | `result/error_during_execution`, `num_turns` 0, before the `initialize` response (07 §1 a11, J7) | no |
| `AuthenticationFailedError` | `AUTHENTICATION_FAILED` | `turn.done`, `ask` | fail-fast trigger (K10); session poisoned; recreate | no |
| `SessionPoisonedError` | `SESSION_POISONED` | `send`, `ask`, `setPermissionMode` | after poisoning (D15) | no |
| `ProtocolError` | `PROTOCOL_ERROR` | `turn.done`, session end | a machine invariant broke (for example id mismatch on `create`) | no |
| `OversizedFrameError` (extends `ProtocolError`) | `OVERSIZED_FRAME` | `turn.done`, session end | inbound line above `maxFrameBytes` under `'fail'` | no |
| `OutboundFrameTooLargeError` | `OUTBOUND_FRAME_TOO_LARGE` | `send`, `ask`, raw `writeFrame` | encoded line above the outbound cap; nothing written | no |
| `ControlRequestError` | `CONTROL_REQUEST_FAILED` | `interrupt`, `setPermissionMode`, raw `controlRequest` | CLI answered with an error | yes |
| `ProcessExitedError` | `PROCESS_EXITED` | `turn.done`, `ask`, later calls | process ended without a hudhud intent; `details`: `exitCode`, `signal`, `outcome`, redacted `stderrTail` | yes |
| `TurnDroppedError` | `TURN_DROPPED` | `turn.done`, `ask` | the harness reported the user message finished without ever starting a turn for it (Claude: `command_lifecycle` `completed` before `started`, research 10 §3); `details`: `turnId`, `lifecycle` (observed states). Retryable: a new send carries a fresh id | yes |
| `SessionClosedError` | `SESSION_CLOSED` | any call | after `close()` or dispose started | no |
| `HarnessDisposedError` | `HARNESS_DISPOSED` | `sessions.create`, `sessions.resume` | after Harness dispose | no |
| `AbortError` | `ABORTED` | any call with a `signal` | the signal aborted; `cause` = `signal.reason` | no |
| `SubscriberOverflowError` | `SUBSCRIBER_OVERFLOW` | that iterator | queue full under `'error'` | no |

`stalled` is an event, never an error. A `result` with `is_error: true` is a `TurnResult` (K21).

### 3.2 Where errors surface

| Phase | Surface |
|---|---|
| Option validation, binary, cwd, guard | `connect`, `create` or `resume` rejects; nothing is spawned |
| Spawn and handshake | `create`/`resume` reject after the ladder ran (no orphan) |
| Turn | `turn.done` and `ask` reject only for session-level causes |
| After the session ended | every call rejects with the ending error or `SESSION_CLOSED` |

### 3.3 Process exit mapping

Rules apply top to bottom; the intent is recorded before any signal.

| Intent | Exit observation | Outcome | Active turn becomes | Error |
|---|---|---|---|---|
| any | code `4294967295` | `unknown` | `error` (synthesized) | `PROCESS_EXITED` unless intent is close/abort |
| `abort`, `dispose` | any | `aborted` | `cancelled` (synthesized) | none |
| `close` | code 0 or 1, no active turn | `closed` | none | none |
| `close-timeout` | any | `aborted` | `cancelled` | none (`session.terminated` says `close-timeout`) |
| `watchdog`, `handshake-failed` | any | `failed` | n/a | the handshake error |
| `auth-fail-fast` | any | `failed` | `error` | `AUTHENTICATION_FAILED` |
| `oversized-frame` | any | `failed` | `error` | `OVERSIZED_FRAME` |
| `none` | code 0, no active turn, last result not error | `closed` | none | none |
| `none` | code 1, last result `is_error` | `closed` | settled from the result | none |
| `none` | code 0 with an active turn and no result (Linux SIGINT from outside, for example a terminal Ctrl+C, K22; a foreign job close on Windows) | `unknown` | turn fails | `PROCESS_EXITED` |
| `none` | code 0, no active turn, last result `is_error` (macOS SIGINT from outside: `result/error_during_execution`, then exit 0; research 09) | `unknown` | none (settled from the result) | `PROCESS_EXITED` |
| `none` | code 143 or 129, or a `signal` (Windows `TerminateProcess` shows as `SIGTERM`) | `killed-externally` | turn fails | `PROCESS_EXITED` |
| `none` | any other | `crashed` | turn fails | `PROCESS_EXITED` |

Exit codes never prove success (05 §9, 07 §2). The redacted stderr tail is attached to `PROCESS_EXITED` and `HANDSHAKE_FAILED`.

---

## 4. Test strategy

### 4.1 Layers and commands

| Layer | Vitest project | Command | Runs in |
|---|---|---|---|
| Unit (sans-IO, pure, fakes) | `unit` | `pnpm test` | `pnpm check` |
| Property and fuzz (fast-check) | `unit` | same | same; seeds printed, `FC_SEED` reproduces |
| Conformance (golden JSONL against `claudeSessionMachine.step`) | `conformance` | `pnpm test:conformance` | `pnpm check` |
| Integration (pinned CLI + in-process mock) | `integration` | `pnpm test:integration` | `pnpm check:full` (CI STANDARD Linux, FULL Linux and Windows; macOS after M1 lands, K15) |
| Tarball install | script | `pnpm check:tarball` | `pnpm check:full` |
| Canary | `integration` with `HUDHUD_CLI_CHANNEL=newest` | nightly (Linux) and weekly (Windows; macOS after its gate) | scheduled (K16) |

`pnpm check` adds `schema:check`, `check:no-ajv`, conformance. `pnpm check:full` = `pnpm check` + `cli:fetch` + integration + tarball. Coverage stays at 100 %; exclusions in §4.8.

### 4.2 Unit and property tests per module

| Module | Unit tests | Property / fuzz |
|---|---|---|
| core `framer` | CRLF, blank lines, BOM, split multibyte at every offset, cap and cap+1, oversized then valid, invalid UTF-8, partial line at `end()` | random chunkings reassemble; random bytes never throw, memory under cap + chunk; exact oversize detection |
| core `json`, `encode` | `__proto__` keys inert; deep nesting `RangeError`; cap boundary | arbitrary strings produce exactly one LF and round-trip |
| core `machine/outcome` | every row of §3.3 on both platforms | total over intents x representative exits |
| core `events/sanitize` | ANSI CSI/OSC/C1 stripped | arbitrary strings never throw |
| claude `wire/inbound`, `outbound` | every frame type in fixtures; unknown types; malformed envelopes; each builder matches the strict schema; `initialize` has no `workspaceTrust` (type and runtime) | arbitrary JSON classifies totally |
| claude `machine/control` | unknown response id, duplicate inbound id, cancel of unknown id, unsupported subtype answered, silent set | random request/response/cancel interleavings keep the table consistent |
| claude `machine/permission` | allow, deny, deny+interrupt, error, cancel by CLI, by signal, by close (non-interrupting deny written, K12), by abort (nothing written), destination stripping, 4097 updates | every ask ends exactly once |
| claude `machine/turn` | FIFO start, `command_lifecycle` correlation, background turn, interrupt before and after init, on settled turn, `still_queued` retry once, idle-synthesized end | random interleavings never settle twice or before the write |
| claude `machine/session` | handshake success, `result` before response (resume vs create), exit before response, first-frame timer, auth fail-fast per trigger with `ANTHROPIC_API_KEY` and with `ANTHROPIC_AUTH_TOKEN` (`tokenSource`; the recorded fixture is replayed by the conformance runner), no fail-fast for `apiKeyHelper` or OAuth `none` (K10), oversized fail/skip, close with pending permission, close deadline from the call (K13), abort before/after handshake, queued commands | the contract invariants via `machine-kit` with a fake clock; JSON round-trip of every state and effect |
| claude `events/normalize` | every fixture frame maps as specified; unknown frames to `harness.frame`; raw always present | arbitrary frames never throw |
| core `binding/queue`, `fanout` | count and byte limits, each policy, gap counts, `'block'` resumes, `return()` releases, signal abort | random push/pull schedules within bounds, order preserved |
| core `binding/driver` | fake transport and timers driving a test machine: effect order, no re-entrancy, permission bridge (throws, invalid decision, signal), ladder hand-off, `ask()` independent of subscribers | microtask-order permutations |
| core `binding/loopback` | the full Claude conformance set through serialize/deserialize (test imports the Claude machine as a test dependency) | |
| core `process/argv` | dash-leading values, commas, spaces, `=`, empty, NUL refused | one argv entry each |
| core `process/binary-path`, `cwd` | `.cmd`/`.bat` in any segment and case, symlink chains, relative paths, 258/259 via injected platform | |
| core `process/tree` | `/proc/<pid>/stat` with spaces and `)` in comm; ps fixtures (C locale) | arbitrary comm strings |
| core `process/ladder/*`, `sweep` | fake `OsCalls` and clock: step order, intent first, early exit at each step, start-time mismatch skips kill, signal target selection per K1 (launcher present, absent, `initialize.pid` not in S1, start-time mismatch), never the host group | random exit timing: no signal after exit |
| core `process/verify` | advisory uses digests only and never spawns PowerShell/codesign (K8); strict runs the OS check first; cache keyed by realpath, size, mtime | |
| core `containment/win32-job` loader | missing package, wrong arch, arm64 (K17), digest mismatch, dlopen throws, success; never throws | |
| claude `options`, `rules`, `argv`, `env` | every row of §2.3/§2.4; env forms including `{preset, add, remove}`, pinned keys refused in `add`/`remove`, win32 case-insensitive names, added credential variables listed in posture (K19); argv snapshot per option combination | random option objects: argv entries all start with `--` and parse back |
| claude `settings-guard` | each variable pattern, `apiKeyHelper`, `settings.local.json`, cwd, git root and main worktree root (linked worktree, nested repo), unresolvable git root falls back to every ancestor with a diagnostic, ancestors and `additionalDirectories` not scanned when the git root resolves, unparseable, oversized, symlinked file; applies under `claudeCode.settingSources` too (K5) | |
| claude `posture` | membership against the option schema; deviation flags; `managedPolicy` from child env and from user settings `env`; values never appear in output (K23) | |
| core `observability/redact` | fake secrets in env values, keys, bearer tokens, URL userinfo, headers | random strings with a secret never leak it |
| core neutrality | no Claude wire vocabulary in core sources or schemas (K3) | |
| test-support mock | trailing `system` message, reset CONNECT socket (J12), absolute-URI proxy refused, allowlist violation fails, SSE framing | |

### 4.3 Golden fixtures (ADR-0006, ADR-0013 §10)

Recorded by `tooling/test-support/src/fixtures/recorder.ts` from the pinned CLI on Windows and Linux, normalized, hand-minimized, stored in `packages/claude-code/conformance/`. Suites: `handshake`, `text-turn`, `two-turns`, `partial-messages`, `tool-bash`, `permission-allow`, `permission-deny`, `permission-deny-interrupt`, `permission-error-response`, `permission-never-answered-interrupt`, `permission-eof`, `interrupt-midstream`, `interrupt-queued`, `interrupt-cancel-queued`, `interrupt-same-write` (GH#98713), `eof-idle`, `eof-midstream`, `eof-midtool`, `resume`, `resume-not-found`, `fork`, `fork-session-id`, `auth-401-no-retry`, `auth-401-retries` (shortened timing), `overloaded-529`, `max-turns`, `bg-shell-turn-after-eof`, `session-state-events`, `big-frame-5mb` (stored compressed), `utf8-arabic`, `crlf-bom`. Both OSes are recorded where the sequence differs (05 §14). A fixture with `apiKeySource: "ANTHROPIC_AUTH_TOKEN"` is recorded when the mock harness can produce it; only then is that source added to `authFailFastSources` (K10). As built (W3-Z): suite `auth-token-source` (sandbox credential `fake-auth-token`, then a 401 with no retries) recorded on Windows and Linux: `account.apiKeySource` is `"none"` and the token shows as `account.tokenSource: "ANTHROPIC_AUTH_TOKEN"`; the 401 yields the same `authentication_failed` assistant frame and `api_error_status: 401`. Lead decision (W3-Z review): fail-fast extends to the token; the machine reads `tokenSource`, and `authFailFastSources` defaults to `['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']`. As built (macOS gate round 2 review, research 10 §3): suite `resume-duplicate-uuid` (setup: one turn whose user message carries uuid N1; main: `--resume` and a user message with uuid N1 again) recorded on Linux: the CLI answers `command_lifecycle` `completed` for it and nothing else until EOF; the session machine replays it as `TURN_DROPPED`. Fixtures are re-recorded by the lead's local bump (K16) and the diff is reviewed.

As built (W4-T2): the runner lives in `packages/claude-code/test/conformance/` (Vitest project `conformance`, part of `pnpm check` on every OS; `pnpm test:conformance` runs it alone). The expect lines of each recording are in a sibling file `<suite>/<platform>[.<case>].expect.jsonl`, one `conformance.schema.json` expect line per record line: the effects (without events) and the events the session machine emits for that line, with `raw` equal to the line's frame written `<frame>` and strings above 1024 code units written `<text length=N sha256=...>`. The recorded bytes stay as recorded; the recorder never writes expect files. `HUDHUD_CONFORMANCE_UPDATE=1 pnpm test:conformance` writes them from the replay and fails every variant on purpose, so they change only through a reviewed diff (a re-recording is always followed by it). As built (W4-Z ruling 8): only the update mode ignores a stale expect file; the normal mode fails on one: a malformed file or one whose line count differs from the recording fails the load (`loader.test.ts`), and an outdated but well-formed one fails its variant (`staleExpectations` in `expect.ts`, asserted by the runner and tested in `parts.test.ts`). The loader (`loader.ts`, `loadConformanceSuites()`) fails on any drift: the suite set must be exactly the list above plus its two additions, in order (read from this section), every manifest entry needs its recording and expect file and every file a manifest entry, unknown or missing fields, a CLI version other than the pin, a recording whose shape departed from the research, broken gzip, non-UTF-8, BOM, CR, blank lines, lines out of time order, config or exit lines that differ from the manifest, every line checked against `conformance.schema.json`. The replay (`replay.ts`) turns each host write into the hudhud command that makes it (`initialize` into `process.started`, `user` into `cmd.send` with the recorded uuid as the turn id, `interrupt` into `cmd.interrupt` of the oldest live turn, a permission answer into `cmd.permission`, an error answer into `cmd.permission-abort` since hudhud never answers a permission request with a control error, EOF into `cmd.close`), feeds the CLI output as lines with the recorded request ids mapped to the machine's, ends with `stdout.end`, the exit and `ladder.done` after a ladder, and fires armed timers at their deadlines on a fake clock; `<uuid-N>` placeholders become UUIDs. Every step runs through the machine kit's incremental driver (`KitDriver`), so the contract invariants, determinism and JSON stability are checked on every replay; every event is checked against `events.schema.json` (known types), every error against `errors.schema.json`, every write against the strict outbound schema. Each machine write is paired with the recorded host write it stands for; the differences are declared per case in `declarations.ts` with the outcome summary (turns, permissions, controls, ladder, diagnostics, session end). Single-source launch (lead ruling after the first W4-T2 replay showed that the recordings missed the hudhud-pinned `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`): a recorded case declares product input only (how the session starts, hudhud session options such as `claudeCode.includePartialMessages`, `claudeCode.maxTurns` or `env.add`, and whether a permission handler is registered), and the adapter's own `resolveConnectSessionOptions`, `buildArgv` and `buildChildEnv` build the argv and environment, with the sandbox environment as the parent and `claudeCode.configDir` set to the sandbox config directory; nothing is added after them. Test-support may not depend on the adapter, so the builders are injected: the composition root of `pnpm fixtures:record` is `packages/claude-code/test/record/record-fixtures.mjs`. The sandbox spawns such a launch through core `childEnv` after checking it keeps every isolation variable (it may leave out only what the platform never reads: POSIX `TMP`/`TEMP`, Windows `HOME`/`TMPDIR`, which the harness preset does not pass). `test/record/launch.test.ts` fails when the recorder's builder differs from the adapter sources for any case; `test/conformance/recorded-launch.test.ts` fails when a committed recording's argv or environment differs from the product's for its case. Every suite was re-recorded with it (recorder revision `b06d075`) on Windows (subst-drive test root) and on Linux (node:22-bookworm), 37 cases each, 0 egress violations, 0 leaks, 0 outside writes; `resume-duplicate-uuid` is now recorded on both OSes. With the pinned environment the CLI reports `session_state_changed` in every case, so the graceful close (the drain ends stdin once the harness is idle and nothing runs, K13) pairs with the recorder's EOF in every recording except `interrupt-same-write`, where the held interrupt (GH#98713) has no recorded answer and keeps the drain waiting until the recorded exit. Verdict (W4-Z ruling 8): a recording artefact, not a product defect; evidence asserted in `test/conformance/interrupt-same-write.test.ts` on both OSes: the recorder wrote turn 2's user message and its interrupt in the same millisecond (the GH#98713 trigger hudhud never writes) and the CLI answered that interrupt at once (`still_queued` names turn 2, before turn 2's `system/init`); hudhud holds its interrupt until that `system/init` and writes it there, a write the recorder never made, so no answer exists in the recording; the CLI answers an interrupt written after a turn's `system/init` at once (interrupt-midstream on both OSes, `still_queued: []` within a few milliseconds; 05 §7 run 37), and with that answer placed after turn 2's `system/init` the same recording drains at the CLI's idle without the close deadline and ends `closed`. Nothing that is not genuinely pending holds the drain: an interrupt held for a turn that ends before its `system/init` settles with the turn (session unit test). The CLI that never answers a written interrupt is genuinely pending, and the close deadline (K13) bounds it. A dropped message (`TURN_DROPPED`) is followed by `session_state_changed` `idle` in the same millisecond on both OSes, so `close()` after it drains at once (no deadline, outcome `closed`). hudhud writes `interrupt` with an explicit `cancel_queued`; the recorder wrote it bare. Intentionally dropped (W4-Z ruling 8): the scenario "the CLI picks the fork id" (`--resume=U1 --fork-session` without `--session-id`, recorded by W3-T6 as `fork`) is no longer recorded, because the product always names the new id (§2.5: fork passes `--session-id=<new uuid>`) and every case now launches with the product's own argv; `fork` keeps its name and records the product's fork, the same launch as `fork-session-id`. No hudhud API can produce the dropped launch (`extraArgs` may not contain the §2.5 flags, §2.6). No replay showed a machine defect: 74 variants, 0 contract violations.

### 4.4 Integration tests (pinned CLI + in-process mock)

Enforced by `testConnect` and lint: pinned, hash-verified binary only; explicit env map; nonessential variable on and the CONNECT trap active on every run; fake key only; cwd outside the home tree and any `.claude`/`CLAUDE.md`/`.mcp.json` ancestor; native-filesystem `TMPDIR`/`CLAUDE_CODE_TMPDIR`; isolated pre-warmed `CLAUDE_CONFIG_DIR` for concurrency; zero egress violations and zero leaks asserted after each test.

Test root (plan decision): `HUDHUD_TEST_ROOT`, else `RUNNER_TEMP` on CI, else `os.tmpdir()`; a root with a forbidden ancestor fails with instructions (for example a `subst` drive on Windows), never skips. Reason: 05 §13.1 and the rule against silent weakening.

Suites (Wave 6): lifecycle; permissions and interrupt; containment and ladders (Windows job, Windows best-effort, Linux SIGTERM/SIGKILL+sweep, host crash, launcher signal target per K1 with a launcher shaped like 07 §4 `t14-launcher.cjs`); security defaults (argv and env at the child via a probe tool call, setting sources and the C3 redirect with a second mock, the credential guard against real project dirs including ancestors and `--add-dir`, ancestor isolation, posture, auth fail-fast with `errn status=401`, oversized frame with `big`); request-shape snapshots.

Flake policy: no automatic retries; timing bounds with a 3x margin over 05/07 measurements.

As built (W6-T0): the harness every Wave 6 suite uses (`testConnect`, the per-test and per-suite assertions, the composition root, how to write and run a suite) is described in §1.11; `packages/claude-code/test/integration/harness/smoke.test.ts` proves it end to end (connect, create, one text turn against the mock, graceful close with outcome `closed`, zero egress violations, zero leaks).

As built (W6-T3, containment): `packages/claude-code/test/integration/containment/` covers the close-deadline ladder (K13), dispose during a tool, the after-exit sweep, a host crash, the K1 signal target through a launcher (POSIX), containment reporting (K2) and the absence of signal handlers (K22). Two harness additions, both additive: a generated launcher in front of the pinned CLI (`launcher/test-launcher.ts`, `TestSetup.launcher`; a `#!` script shaped like 07 §4 `t14-launcher.cjs`, POSIX only; when a test asks for one it is the only file a launch may run, unchanged and naming the unchanged pinned binary), and a child Node.js host for the host-crash test (`support/crash-host.mjs`, a composition root over the built adapter with the same sandbox seams and launch checks). Job-object tests (§6.5) are not written: the addon is not built, and `reporting.test.ts` asserts the loader's `package-missing` reason, so it fails once the addon is installed. Measured on Windows (ADR-0009 residual): Git Bash (MSYS2) starts a tool's external commands from a forked `bash.exe` copy that exits at once, so they are outside every parent-pid tree; best effort does not end them, and the harness's leak tracker cannot see them, so these suites name each `sleep` workload by a unique argument and settle it themselves (the argument is now the harness's workload tag, §1.11).

As built (Wave 6, W6-Z): the suites are `lifecycle/` (W6-T1), `permissions/` (W6-T2), `containment/` (W6-T3), `security/` (W6-T4) and `request-shape/` (W6-T5), each scenario citing its evidence run in a comment. Request-shape snapshots are per platform (`snapshots/<case>.<platform>.shape`, `linux` and `win32`; the CLI's request differs by platform); the `darwin` set is recorded once the macOS gate (M1) has passed. The canary classifier (`canary/classify.ts`) and the tarball check (`scripts/check-tarball.mjs`, `pnpm check:tarball`) are in place; `check:tarball` is not yet part of `check:full` (§5.9 W7 gate). CI does not run the integration project yet (W7-T1). The Linux recipe of the W6-Z runs, which CONTRIBUTING repeats: `docker run --rm --init -u node` on `node:22-bookworm` (and `node:26-bookworm`) over a fresh clone from a git bundle, pnpm 11.24.0 from `npm i -g --prefix /home/node/bin`, `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm cli:fetch`; `--init` gives the container an init process that reaps orphans, as a CI host's init does, so an orphaned tool process ends as it would on CI (W6-Z ruling 4).

Windows real-tree ladder test (W6-Z, lead item B): `windows.real.test.ts` reported `taskkill:skipped` (`identity-foreign-child`) in 4 of 763 runs of the file (with and without 16 busy processes). The ladder records `taskkill` as skipped for `exited` (the spawned process was seen exited after the identity check), `protected` (the spawned pid is the host's) or `identity-<check>`: `unverified` (no identity, or no snapshot), `changed` (the pid lists another start time), `absent` (the pid is not listed), `foreign-child` (a listed process names a tree member as its parent but started before it). A traced run named the process: `OneDrive.Sync.Service.exe`, started an hour before the tree, whose dead parent's pid the tree's great-grandchild had reused; `taskkill /T` follows parent pids without start times and would have ended it, so the refusal is the product working as designed (unit-tested in `windows.test.ts`). The test now accepts that outcome only when a fresh read still shows such a process, no taskkill call carried `/T`, and the tree still ends with zero survivors.

K15 wall-time samples (Wave 6). The whole integration project, file by file (`pnpm vitest run --project integration`, 20 files, 92 tests, 4 skipped per OS), W6-Z at the closer's head: Windows 11 (16 cores, no job addon), 10 runs, 681.1 / 682.6 / 686.1 s (min / median / max), all green; Linux `node:22-bookworm` with `--init` in Docker on the same host, 10 runs, 163.3 / 163.9 / 165.0 s, all green, and `node:26-bookworm` 1 run, 161.3 s, green; every run zero egress violations and zero leaks. For comparison, the same project with a worker per core on Windows: 340.9 s with 11 of 92 tests failing (8 at the hang guard). Per-task samples (each task's own suite directory, files in parallel, Windows, 10 runs each unless named): W6-T1 lifecycle 50.1-52.0 s; W6-T2 permissions 53.0-54.0 s; W6-T3 containment 25.3-26.0 s; W6-T4 security 57.6-69.6 s (run 6 failed; W6-T4 reported the identity race and the conhost flake, both addressed above); W6-T5 request-shape 22.3-22.7 s, Linux 7.9-8.1 s.

Product defect found in Wave 6 (W6-Z, from the W6-T3 launcher suite on `node:26-bookworm`): after the `SIGKILL` and the sweep the POSIX ladder (`ladder/posix.ts`) built its report from `hasExited()` at once, before Node had reaped the killed child, so `exitedAfter` said `null` ("never exited") for a process it had just ended: 22 of 40 such reports (14 of 20 runs of the launcher suite) on Node 26, none in 20 runs on Node 22. The ladder now waits for the exit after the `SIGKILL`, at most `termGraceMs`, before it reports (`exitedAfter: 'sweep'`, or `'sigkill'` without a verified identity); a unit test on the fake clock reports an exit observed 3 ms after the `SIGKILL`.

### 4.5 Egress trap

The mock is the proxy (`HTTPS_PROXY`, `HTTP_PROXY`, lower-case variants) with `NO_PROXY=127.0.0.1`. Any `CONNECT`, absolute-URI request or non-allowlisted path is a violation (hostname and method, credentials redacted) that fails the test. One test runs with the nonessential variable deliberately off and asserts the trap records and refuses the attempts (05 §2 run 89). The TLS-terminating trap of 07 §0.2 is not ported.

### 4.6 How CI obtains the pinned CLI

`tooling/cli-pin.json` holds, per platform, the package name, the pinned npm `integrity` (sha512), the binary `sha256`, `size` and file name (05 §1 values for `linux-x64` and `win32-x64`; darwin entries filled by M1, marked `pendingGate` until then).

`pnpm cli:fetch` (`tooling/test-support/bin/fetch-cli.mjs`, logic in `src/cli/`):

1. Read the registry document of the exact version from `registry.npmjs.org` only; take `dist.tarball`, refuse any other host.
2. Download to a temp file; compare sha512 with the **pinned** integrity (never the value just fetched).
3. Extract only `package/<file>` with an in-repo ustar reader over `zlib.gunzip` (no `tar` subprocess; `..`, absolute paths, links and devices refused).
4. Compare sha256 and size with the pin; write to `${HUDHUD_CLI_CACHE:-.cache/claude-cli}/<version>/<platform>/<file>` (0755 on POSIX) with a `verified.json` stamp.
5. Each test session re-checks size and the stamp keyed by mtime.

CI caches `.cache/claude-cli` with `actions/cache` keyed on `hashFiles('tooling/cli-pin.json')`, OS and arch; only `main` writes it. The user's install is never used: `testConnect` always passes the cached `binaryPath` and asserts it lies under the cache. The package is never installed through pnpm; the pin changes only through a reviewed PR prepared by the lead (K16).

Canary variant (K16): `cli/newest.ts` resolves the newest published version from the registry, records its `dist.integrity` for that run (written to the job summary), fetches and verifies the tarball against that record, then proceeds as above with a run-local pin.

### 4.7 Cleanup assertions (no leaked processes)

- Every spawned CLI is recorded (pid, start time; Linux `/proc`, Windows the addon's `processTimes` or one CIM query).
- Tree tests sample descendants (Linux `/proc` every 250 ms; Windows `listPids(job)` or CIM every 1 s for best-effort tests).
- After each test (the test's `onTestFinished` hook, §1.11): every root exited; every sampled descendant still matching pid and start time, and every process carrying one of the test's workload tags, is a leak, fails the test, and is then killed by pid plus start time.
- `afterAll`: any process whose command line contains the test root fails the suite (07 §13).

### 4.8 Coverage (100 %) and justified exclusions

| Exclusion | Justification | Compensating control |
|---|---|---|
| `packages/*/src/**/generated/**` | generated | `schema:check` determinism; validators exercised by wire and option tests; tarball check |
| `packages/core/src/process/os/win32.ts` off win32, `os/posix.ts` on win32, `os/darwin.ts` off darwin | thin syscall adapters | OS-scoped coverage: each OS job runs `vitest --coverage` with `include` set to its own adapter and a 100 % threshold (`vitest.os.config.ts`) |
| `native/win32-job/**` (C) | not JavaScript | native tests (§6.5); `/W4 /WX`, `/analyze` clean |

---

## 5. Work breakdown into waves

### 5.1 Rules for every wave

- No two tasks in a wave own the same file. Shared files (barrels, API reports, lockfile, `package.json` files, configs) are owned only by the wave's closer (`W<n>-Z`) or by W0-T1.
- Every task leaves `pnpm check` green on its own; modules are reached by tests through relative paths until the closer exports them.
- Wave end: the lead runs `pnpm check:full` on Windows and in a throw-away `node:22-bookworm` container on a copy of the repository (CONTRIBUTING.md), then makes one push that triggers CI FULL. The next wave starts after the gate is green. Main stays bisectable because each commit is green.
- Each agent prompt names its ADR clauses, the rulings it implements and the listed security concerns. Agents never run the user's `claude`, never read the user's config, never use real credentials, never touch GitHub.

### 5.2 Wave 0 — prelude and lookup spike (parallel)

**W0-T1 Repository prelude** — Opus, M.
Owns: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `vitest.config.ts`, `vitest.os.config.ts`, `eslint.config.js`, `.dependency-cruiser.mjs`, `tsconfig.json`, `.gitignore`, `.prettierignore`, `scripts/api-report.mjs`, `scripts/test/api-report*.test.ts`, `scripts/test/depcruise-rules.test.ts`, `packages/core/package.json`, `packages/claude-code/package.json`, `packages/core/tsconfig.json`, `packages/claude-code/tsconfig.json`, `tooling/test-support/{package.json,tsconfig.json,src/index.ts}`, `CONTRIBUTING.md`.
Work: catalog pins (older than 7 days) for TypeBox (major pinned), `ajv`, `esbuild`, `fast-check`, `@anthropic-ai/sdk` (test-support only); `allowBuilds: { esbuild: false }` with its written reason (K14); workspace `tooling/*`; vitest projects `unit`, `conformance`, `integration`, `scripts` (`passWithNoTests` scoped to empty projects); coverage exclusions of §4.8; the ESLint and depcruise rules of §1.2 including the extension of the sans-IO rules to `packages/claude-code/src/protocol/` with the `@hudhudjs/core/protocol` exception (K3); no new `package.json` scripts (closers add each script when its implementation lands); `api-report.mjs` skips packages without an `exports` field and `.json` subpaths; `exports` gains `"./schemas/*"` in both packages.
Acceptance: `pnpm install --frozen-lockfile && pnpm check` green on Windows and Linux; a scratch build that runs esbuild on both OSes proves it works from its optional platform package without the postinstall (K14; if not, stop and report); depcruise rule tests fail on planted forbidden imports (core to Claude wire vocabulary path, Claude protocol to `@hudhudjs/core/process`, Claude protocol to a Node built-in) and pass on `@hudhudjs/core/protocol`; lockfile diff reviewed.
Security: supply chain, no weakening of existing rules, privacy gate on.

**W0-T2 Settings lookup spike (K5)** — Opus, M. **Done 2026-10-12: [08](../research/08-settings-lookup-spike.md); rulings L1-L4 in 06 §L.**
Owns: `docs/research/08-settings-lookup-spike.md` only (scripts and runs in the scratch workspace, as in 05/07).
Work: with the pinned 2.1.296 binaries (npm pack, integrity and sha256 verified as in 05 §1), the spike mock and the sandbox recipe of 05 §13.2, on Windows and in the Linux container: does the CLI load `.claude/settings.json` and `.claude/settings.local.json` from the cwd only, from the git root, or from every ancestor; does it load them from `--add-dir` directories; does `env` from each location apply (observe `ANTHROPIC_BASE_URL` redirection to a second mock, as 07 §9). Project dirs on `subst` drives on Windows, removed in `finally`; no user config touched.
Acceptance: the report states, per location and OS, loaded or not, with run evidence; the guard of W3-T3 keeps the superset unless the report proves a location is never read. Result: narrowed to cwd, git root and main worktree root (L1).
Security: sandbox isolation, fake key, egress trap, cleanup evidence as in 07 §13.

### 5.3 Wave 1 — independent leaves (parallel)

| Id | Title | Owns | Deps | Tier | Size |
|---|---|---|---|---|---|
| W1-T1 | Schema pipeline, neutral schemas and Claude wire schemas | `packages/core/schema-src/**`, `packages/core/schemas/**`, `packages/claude-code/schema-src/wire*.ts`, `packages/claude-code/schemas/wire-*.schema.json`, `scripts/schema/**`, `scripts/lib/schema/**`, `scripts/test/schema-*.test.ts`, `packages/core/src/protocol/generated/**`, `packages/claude-code/src/protocol/generated/**`, `packages/core/src/protocol/{json,capabilities}.ts`, `packages/core/src/protocol/events/types.ts`, `packages/claude-code/src/protocol/wire/types.ts`, type-equality tests | W0 | Opus | XL |
| W1-T2 | Framer and line encoder | `packages/core/src/process/framer.ts`, `packages/core/src/protocol/encode.ts`, tests | W0 | Opus | M |
| W1-T3 | Error taxonomy | `packages/core/src/protocol/errors.ts`, `packages/core/src/binding/errors.ts`, tests | W0 | Sonnet | M |
| W1-T4 | Bounded queue and fanout | `packages/core/src/binding/{queue,fanout}.ts`, tests | W0 | Opus | M |
| W1-T5 | Observability primitives | `packages/core/src/observability/**`, tests | W0 | Opus | M |
| W1-T6 | Mock API and egress trap | `tooling/test-support/src/mock/**`, tests | W0 | Opus | L |
| W1-T7 | Pinned CLI fetch, verify, cache (and newest-version variant) | `tooling/cli-pin.json`, `tooling/test-support/src/cli/**`, `tooling/test-support/bin/fetch-cli.mjs`, tests | W0 | Opus | L |
| W1-T8 | Process primitives | `packages/core/src/process/{argv,binary-path,cwd,hash}.ts`, tests | W0 | Opus | M |
| W1-T9 | Process tree, ladder types, OS call interfaces | `packages/core/src/process/tree/**`, `packages/core/src/process/ladder/types.ts`, `packages/core/src/process/os/types.ts`, fixtures, tests | W0 | Opus | M |
| A1 | Addon C source and CMake | `native/win32-job/**` | W0 | Opus | M |
| W1-Z | Closer | barrels, `packages/*/api/*.api.md`, smoke tests, `.changeset/*`, `package.json` scripts `schema:build`, `schema:check`, `schema:diff`, `check:no-ajv`, `cli:fetch` (wired into `check`) | all W1 | Sonnet | S |

Acceptance highlights:

- W1-T1: second `schema:build` produces no diff; `schema:check` fails on a hand edit; `schema:diff` fails on each forbidden change class (fixture schemas); `check:no-ajv` passes and fails on a planted `import 'ajv'`; type-equality tests compile; outbound validators reject unknown keys, inbound accept them; core neutrality test passes. Security: no `eval`/`new Function` in generated code, no runtime dependency, esbuild without plugins or network.
- W1-T2: framer property tests (1000+ runs); oversized detection with bounded heap growth. Security: memory exhaustion, UTF-8, no silent truncation.
- W1-T3: every §3.1 code has a class, data round-trip and retryability test.
- W1-T4: bounds property tests; `'block'` documented as able to stall control frames.
- W1-T5: redaction property test; bounded tail. Security: secret leakage (ADR-0016 §1).
- W1-T6: J12 reset test; absolute-URI refusal; allowlist violation fails; trailing `system` message; binds `127.0.0.1` only; no outbound sockets (test patches `net.connect` to throw).
- W1-T7: integrity from the pin; tar reader fuzzed against traversal, links, devices; corrupted download fails; registry host allowlist; newest-version mode records the registry integrity and verifies against it. Security: never executes the binary during fetch.
- W1-T8: argv properties; `.cmd`/`.bat` case variants; 258/259 boundary. Security: argv injection, BatBadBut, planting.
- W1-T9: parser fixtures; nothing kills.
- A1: §6.1.

### 5.4 Wave 2 — Claude sub-machines, neutral contract, process I/O, adapter config, launcher

| Id | Title | Owns | Deps | Tier | Size |
|---|---|---|---|---|---|
| W2-T1 | Claude inbound, outbound, control correlator | `packages/claude-code/src/protocol/wire/{inbound,outbound}.ts`, `packages/claude-code/src/protocol/machine/control.ts`, tests | W1-T1, T2, T3 | Opus | L |
| W2-T2 | Claude permission machine | `packages/claude-code/src/protocol/machine/permission.ts`, tests | W1-T1, T3 | Opus | M |
| W2-T3 | Claude turn machine and interrupt gating | `packages/claude-code/src/protocol/machine/turn.ts`, tests | W1-T1, T3 | Opus | L |
| W2-T4 | Neutral machine contract, outcome classifier, display sanitizer, machine kit | `packages/core/src/protocol/machine/{contract,outcome}.ts`, `packages/core/src/protocol/events/sanitize.ts`, `tooling/test-support/src/machine-kit.ts`, tests | W1-T1, T3 | Opus | M |
| W2-T5 | Claude event normalization | `packages/claude-code/src/protocol/events/{normalize,tool-kind}.ts`, tests | W1-T1 | Sonnet | M |
| W2-T6 | Spawn and process handle | `packages/core/src/process/spawn.ts`, `packages/core/src/process/os/{win32,posix,darwin}.ts`, tests | W1-T2, T5, T8, T9 | Opus | L |
| W2-T7 | POSIX ladder (K1 signal target) and sweep | `packages/core/src/process/ladder/posix.ts`, `packages/core/src/process/sweep.ts`, tests | W1-T9 | Opus | L |
| W2-T8 | Windows ladder (job and best-effort) | `packages/core/src/process/ladder/windows.ts`, `packages/core/src/process/taskkill.ts`, tests | W1-T9 | Opus | M |
| W2-T9 | Claude options, rules, argv, env (K19) | `packages/claude-code/schema-src/options.ts`, `packages/claude-code/schemas/options.schema.json`, `packages/claude-code/src/generated/**`, `packages/claude-code/src/{options,rules,argv,env}.ts`, tests | W1-T1, T8 | Opus | L |
| W2-T10 | Test launcher, leak assertions, fixture recorder | `tooling/test-support/src/{launcher,leaks,fixtures}/**`, tests | W1-T6, T7, T9 | Opus | L |
| M1 | macOS gate harness | `tooling/macos-gate/**`, `.github/workflows/macos-gate.yml` | W1-T6, T7, T9 | Opus | M |
| A2 | Addon platform packages and digest tooling | `packages/win32-job-x64/**`, `packages/win32-job-arm64/**`, `scripts/addon/**`, `scripts/test/addon-*.test.ts` | A1 | Opus | M |
| W2-Z | Closer | barrels, API reports, smoke tests, changesets, `package.json` files | all W2 | Sonnet | S |

Note: W2-T1, T2, T3 and T5 define their own local input and output types and do not depend on the neutral contract; the composition onto the contract (W2-T4) happens in W3-T1. W2-T4 and the Claude sub-machines share no files.

Acceptance highlights:

- W2-T1: every recorded 05/07 frame classifies without `malformed`; unknown subtype answered; silent set unanswered. Security: stdin authority, `workspaceTrust` impossible.
- W2-T2: stripping of `localSettings`, `userSettings`, `projectSettings`, unknown destinations; suggestions passed through unchanged; K12 close and abort behaviour. Security: config writes (R6), untrusted shapes (D17).
- W2-T3: GH#98713 gating with the `interrupt-same-write` order; background turn after EOF.
- W2-T4: `classifyExit` table; `machine-kit` runs against a trivial reference machine; core neutrality test still passes.
- W2-T6: real-process tests with `node -e` children: env exactly the given map, no shell (`&`/`|` literal), backpressure with a slow reader, stderr tail, `ENOENT` mapping, `ENOTCONN` swallowed; a source-tree test asserts no `shell: true` in `packages/*/src`. Security: shell injection, env leakage.
- W2-T7: fake-OS tests for K1 selection and guards; Linux real test with a `node` launcher child that spawns a `node` "CLI" grandchild that ignores nothing and owns a `sleep` group: SIGTERM reaches the grandchild via K1, SIGKILL+sweep path leaves zero survivors, the host group is never signalled. Security: group kills, pid reuse.
- W2-T8: fake-OS tests; Windows real test with `node` child and grandchild: best-effort ladder leaves zero survivors. Security: absolute System32 path, `shell:false`.
- W2-T9: argv snapshot per option row; `--flag=value` everywhere; env per OS and per form; pinned keys refused in `add`/`remove`; posture fields present in `EffectiveOptions`. Security: argv injection, env leakage, `NODE_OPTIONS`.
- W2-T10: forbidden-ancestor refusal; leak detection catches a planted orphan; recorder reproduces the 05 §5 handshake shape on Windows and Linux (lead-run at wave end). Security: sandbox isolation, fake key.
- M1: reproduces the seven gate items with the pinned darwin binary (digests recorded on first run and checked against npm integrity and `manifest.json`), the mock and the ps parser; `workflow_dispatch` only, `permissions: contents: read`, `macos-15` arm64 and an x64 runner if available; artifacts 3 days. Dispatched by the lead.
- A2: §6.2.

### 5.5 Wave 3 — Claude session machine and security assembly

| Id | Title | Owns | Deps | Tier | Size |
|---|---|---|---|---|---|
| W3-T1 | Claude session machine on the neutral contract | `packages/claude-code/src/protocol/machine/{session,index}.ts`, tests | W2-T1..T5 | Opus | XL |
| W3-T2 | Verification and discovery (K7, K8, K9) | `packages/core/src/process/verify/**`, `packages/claude-code/src/{discovery,provenance}.ts`, `packages/claude-code/src/known-binaries.json` (as built: `known-binaries.ts`, W3-Z), tests | W1-T8, W2-T6 | Opus | L |
| W3-T3 | Project credential guard (K5, L1) | `packages/claude-code/src/settings-guard.ts`, tests | W2-T9, W0-T2 report (08) | Opus | M |
| W3-T4 | Security posture (K19, K23) | `packages/core/src/security/**`, `packages/claude-code/src/posture.ts`, tests | W2-T9 | Opus | M |
| W3-T5 | Job addon loader and containment (K2, K17) | `packages/core/src/process/containment/**`, tests | A2, W2-T8 | Opus | M |
| W3-T6 | Golden fixture recording | `packages/claude-code/conformance/**` | W2-T10 | Sonnet | M |
| A3 | Addon prebuild workflow (K17) | `.github/workflows/addon-prebuild.yml`, `scripts/addon/manifest*.mjs` (new files), `native/win32-job/release/**` | A2 | Opus | M |
| W3-Z | Closer | barrels, API reports, changesets, `package.json` files (including `@hudhudjs/win32-job-x64` as an optional dependency of core; arm64 not listed, K17) | all W3 | Sonnet | S |

Acceptance highlights:

- W3-T1: `machine-kit` invariants (2000+ runs on CI, seed logged); every recorded 05/07 sequence replays through `step` with expected effects; K10, K12, K13 behaviours. Security: stdin authority, auth poisoning, permission never silently allowed, oversized handling.
- W3-T2: advisory never spawns a verifier process; strict PowerShell probe by absolute path with the binary path as a separate argument, parsing only `Status`; codesign by absolute path; launcher symlink layout of 01 §4.1 resolved. Security: planting, command injection into the probe.
- W3-T3: scan set per L1 (cwd, git root, main worktree root; ancestor fallback with diagnostic when the git root is unresolved; resolution by filesystem walk, no git spawn), tests of §4.2 incl. linked worktree, nested repo, `.git` file and unresolvable root; real-CLI checks in W6-T4. Security: fail closed, names never values, symlinks, size cap.
- W3-T4: membership test; K23 parser returns booleans only (property test: no input value appears in the output). Security: no weakened default is silent, no secret logging.
- W3-T5: §6.4.
- W3-T6: suites of §4.3 recorded on Windows and Linux.
- A3: §6.3.

As built (W3-Z, 2026-10-13; merged in this order: macOS gate round 2, W3-T5, W3-T2, W3-T3, W3-T4, W3-T1, W3-T6):

- `@hudhudjs/win32-job-x64` is NOT yet an optional dependency of core: the platform package does not exist until A2 lands; the loader resolves it and reports `package-missing` until then. Ruling 1: A1's `processTimes(pid)` must return `{ creationTime: string }` (decimal FILETIME, as `assignProcess`) and `version` must be a string; the loader checks both (§6.1).
- Exports: `@hudhudjs/core/process` gains verification, the version probe, the job addon loader and containment, and `snapshotAtEof`/`sweepAfterExit`; the `@hudhudjs/core` root the posture builder; `@hudhudjs/core/protocol` the `send.rejected` effect and the diagnostic codes `stdin.error` and `permission.duplicate-request-id`. The Claude Code modules of W3 (session machine, discovery, provenance, settings guard, posture) stay internal until W5.
- After the macOS gate round 2 review (research 10): `TURN_DROPPED` and `turn.dropped` for a user message the harness drops (`protocol/machine/turn.ts`, §3.1); the recorder suite `resume-duplicate-uuid`; the `initialize`-first hold kept with its rationale updated; the decisive Keychain canary of gate item 3 (GitHub-hosted runners only, research 10 §2.5).
- Rulings applied: guard variables widened to proxy and TLS-trust names and the user config dir skipped in the ancestor fallback (2); posture inputs and values (3); timeouts as hang guards (4); the graceful close sweep, the `RecordingSession` spawn-time attach, the fake auth-token credential and the K10 fixture, the recorder moved into test-support, the Linux re-recording (5); the session machine rulings (7, 10); the `sha256File` read invariants with injected short reads (8); verification (9); the local-macOS refusal (10).

### 5.6 Wave 4 — generic binding layer and conformance

| Id | Title | Owns | Deps | Tier | Size |
|---|---|---|---|---|---|
| W4-T1 | Generic driver, handles, permission bridge, loopback, clock, adapter registration, host-exit hook | `packages/core/src/binding/{driver,transport,handles,permission-bridge,clock,adapter,loopback,host-exit}.ts`, tests | W2-T4, W1-T4 | Opus | XL |
| W4-T2 | Conformance runner | `packages/claude-code/test/conformance/**` | W3-T1, W3-T6 | Sonnet | M |
| W4-T3 | Claude capabilities, compat, session registry | `packages/claude-code/src/{capabilities,compat,registry}.ts`, tests | W1-T1 | Sonnet | S |
| W4-Z | Closer | barrels, API reports, changesets | all W4 | Sonnet | S |

Acceptance: W4-T1 tests of §4.2 against a test machine (the core never imports the Claude machine outside tests), including "`ask()` resolves while a `'block'` subscriber on another session is stalled"; loopback replays every Claude conformance suite; W4-T2 runs every suite on every OS in `pnpm check`.

As built (W4-T2): see §4.3. Contract for the loopback replay (W4-Z): `loadConformanceSuites()` (`packages/claude-code/test/conformance/loader.ts`) returns every suite in catalogue order with its typed variants (manifest entry, launch, record lines, expect blocks) or throws `ConformanceDataError` listing every problem; `replayVariant(variant, { machine })` (`replay.ts`) drives any `KitMachine` of the Claude session state and config, so the loopback passes `claudeSessionMachine` behind its serialize/deserialize boundary; `projectReplay(result)` (`expect.ts`) must equal `variant.expect`, `summarize(result.effects.flat())` (`summary.ts`) must equal the case's declared summary, and `result.violations`, `result.problems` must be empty. A test in `replay.test.ts` already drives the replay through a JSON boundary and gets the same effects. Security for W4-T1: handler isolation, cancellation always possible, no re-entrancy, bounded memory, no signal handlers (K22).

As built (W4-Z, 2026-10-14; merged in this order: W4-T3, W4-T1, W4-T2; every first-parent commit of the closer passes `pnpm check` on its own):

- Conformance after the merges: the full set (74 variants of 33 suites) replays green over W4-T3's bounded feature parser, and `test/conformance/features.test.ts` asserts that every recorded feature array (`system/init` and the `initialize` response) passes it unchanged and reaches the session facts and every started turn (ruling 3).
- Loopback (ruling 2, the acceptance above): every variant through `createLoopbackDriver`, the public handles and the JSON boundary gives the direct replay's results and its expect file (§1.6, W4-T1 note).
- `@hudhudjs/core/binding` (ruling 6, question 1): the beta entry for adapter authors (§2.1). The Claude user-input encoder (question 2): `encodeClaudeUserInput` (§1.8). `cmd.permission-error` (question 3): §1.4 and §1.6; the driver no longer answers with a deny of its own, and the machine kit checks the fail-closed answer.
- Version policy (ruling 1): `HARNESS_VERSION_KNOWN_BROKEN` (§3.1) and `claudeCode.dangerouslyAllowKnownBrokenVersion` (§2.3, §2.4) are registered and specified (§1.8, ADR-0004 §4 amendment); W5 wires the refusal and the option into `connect`. `untested` stays a warning.
- `session.terminated` (ruling 4): W4-T1 documented `intent` and `outcome` as deterministic and `exitCode`/`signal` as raw observations (event type, ADR-0008, §1.6); the closer adds the same descriptions to `events.schema.json` for other languages.
- Authenticode timing (ruling 5): the CI evidence (run 38464474863: node.exe 1152 and 1504 ms, an unsigned file 398 ms, after `New-Object` was dropped; 19 to 50 s before it) is in the remarks of `os-signature.ts` and in ADR-0011; the 120 s hang bound stays.
- W4-T2 follow-ups (ruling 8): stale expect files fail in the normal mode, `interrupt-same-write` is a recording artefact with the evidence asserted, and the dropped "CLI picks the fork id" scenario is recorded (§4.3).
- Two defects that predate the wave, found by property tests (random seeds) in the closer's per-commit runs, root-caused and fixed in the first two commits after the merges, each with a regression test that fails on the old code: redaction let a known secret split a credential so its rest stayed readable (§1.10, `StderrTail` property), and the turn machine armed an interrupt re-send after stdin had closed (§1.5, turn-machine model check).
- Changesets: one per package for the wave (`wave-4-core`, `wave-4-claude-code`), the inputs' changesets folded in; one per topic for the two fixes.

### 5.7 Wave 5 — adapter assembly and public API

| Id | Title | Owns | Deps | Tier | Size |
|---|---|---|---|---|---|
| W5-T1 | Claude Code adapter | `packages/claude-code/src/{adapter,connect,session-factory}.ts`, `packages/claude-code/src/raw/**`, unit tests with a fake spawner | all previous | Opus | XL |
| W5-Z | Public API closer | `packages/claude-code/src/index.ts`, `packages/hudhud/src/index.ts`, all barrels, all API reports, smoke tests, changesets | W5-T1 | Sonnet | S |

Acceptance: pipeline order tests (validation before filesystem access; guard before spawn; job assignment before `process.started`; one `--version` probe per connect, K4); `pnpm api:check` with reports matching §2; umbrella smoke test. Security: every threat-model row of architecture.md mapped to a test id in the task report.

As built (W5-T1, 2026-10-14; details in §1.8): the assembly is tested over an in-memory host (`packages/claude-code/test/unit/adapter/fake-host.ts`: fake discovery, hashing, identity reads, probe runner, cwd and guard file systems, user settings reader, job addon, process table, signals and a scripted CLI that answers like the recordings; one ordered log of everything): `pipeline-order.test.ts` (each ordering of ruling 8), `errors.test.ts` (§3.1 mapping, abort and dispose at every step), `session.test.ts` (launch, diagnostics, encoder, permission isolation, K10, drift, re-verification, registry rebind, the sweep after the exit), `verification.test.ts` (strict publisher pin, transient verdicts never cached through connect and through a Harness), `raw.test.ts`, `host.test.ts` (the real `nodeHost` with the running Node.js binary as a non-Claude `binaryPath`: discovery, verification and the probe run for real and refuse at the probe; no signal handlers, by run and by source scan), `launch.property.test.ts` (random options: the spawned argv and environment are exactly `buildArgv`/`buildChildEnv`, and the published posture is the computed one), plus `machine/session-drift.test.ts`. No test runs the user's CLI or reads the user's config.

As built (W5-Z, 2026-10-14): the public barrels. `@hudhudjs/claude-code` exports `connect`, `session`, `hudhud`, `CLAUDE_CODE_COMPAT` and the types `ClaudeCodeHarness`, `ConnectOptions`, `ClaudeCodeConnectOptions`, `SessionOptions`, `ClaudeCodeSessionOptions`, `ResumeOptions`, `PermissionMode`, `WorkspaceTrust`, `SettingSource`, `EnvOption`; `@hudhudjs/claude-code/raw` exports `raw`, `createSessionRaw` and the types `RawSession`, `RawSpawnOptions`, `RawFrame`, `RawWireFrame`, `RawGap`, plus type-only re-exports of the root types those signatures name (`ClaudeCodeHarness`, `SessionOptions`, `ResumeOptions`, `ClaudeCodeSessionOptions`, `PermissionMode`, `WorkspaceTrust`, `SettingSource`, `EnvOption`), so the `/raw` API report is self-contained like `@hudhudjs/core/binding`'s; `hudhudjs` is `export *` of `@hudhudjs/core` and `@hudhudjs/claude-code` (no raw tier, no adapter-author entry points). Deviation resolved toward the plan: `SessionOptions.onPermission` was typed with the internal `PermissionCallback`; the public option is now the core `PermissionHandler` as in §2.3, and `PermissionCallback` is `@internal`, no longer public. As built beyond §2.3: `ClaudeCodeHarness` also redeclares `binary` and `compat` (inherited from `Harness`, documented as facts from connect). Smoke tests assert each entry point's exact export list from the built output (`packages/claude-code/test/smoke.test.ts`, `packages/hudhud/test/smoke.test.ts`); the three API reports match §2.3, §2.6 and the umbrella row of §2.1. Changesets of the wave: `wave-5-core`, `wave-5-claude-code`, `wave-5-hudhud`.

### 5.8 Wave 6 — integration against the pinned CLI

| Id | Title | Owns | Deps | Tier | Size |
|---|---|---|---|---|---|
| W6-T1 | Lifecycle | `packages/claude-code/test/integration/lifecycle/**` | W5 | Opus | L |
| W6-T2 | Permissions and interrupt | `.../integration/permissions/**` | W5 | Opus | L |
| W6-T3 | Containment, ladders, host crash, launcher signal target | `.../integration/containment/**` | W5, W3-T5 | Opus | L |
| W6-T4 | Security defaults (guard against real CLI lookup, env forms, posture) | `.../integration/security/**` | W5 | Opus | L |
| W6-T5 | Request-shape snapshots, degradation classifier, tarball check | `tooling/test-support/src/{snapshots,canary}/**`, `scripts/check-tarball.mjs`, `.../integration/request-shape/**` | W5 | Sonnet | M |
| W6-Z | Closer | `package.json` (`check:full`, `test:integration`, `check:tarball`, `cli:bump`), changesets | all W6 | Sonnet | S |

Each task cites the evidence run per scenario (for example W6-T1 `resume-not-found` <- 07 §1 a11; W6-T2 `interrupt-same-write` <- 05 §7 run 36; W6-T3 orphan <- 05 §10 runs 60-72, host crash <- 07 §2 W94, launcher <- 07 §4; W6-T4 C3 <- 07 §9 and the W0-T2 report). Acceptance: `pnpm test:integration` green on Windows and Linux, zero egress violations, zero leaks, and per-job wall-time samples (at least 10 runs per OS) recorded for K15.

### 5.9 Wave 7 — CI, canary, documentation, release readiness

| Id | Title | Owns | Deps | Tier | Size |
|---|---|---|---|---|---|
| W7-T1 | CI integration (K15) | `.github/workflows/ci.yml`, `.github/actions/setup/action.yml`, `scripts/lib/ci-*.mjs` only if tier rules change (with tests) | W6 | Opus | M |
| W7-T2 | Canary (K16) | `.github/workflows/nightly.yml`, `.github/workflows/canary-weekly.yml`, `scripts/nightly-check.mjs`, `scripts/lib/nightly.mjs`, `scripts/lib/canary-weekly.mjs`, `scripts/test/nightly*.test.ts`, `scripts/test/canary-weekly*.test.ts` | W6-T5, W1-T7 | Opus | M |
| W7-T3 | User documentation | `docs/guide/**`, `README.md`, `NOTICE`, every-way registry table | W5 | Sonnet | M |
| W7-T4 | Release readiness | `docs/plan/v1-release-checklist.md`, darwin entries of `tooling/cli-pin.json` and `known-binaries.ts` (and the darwin Team ID pin) from M1, `CLAUDE_CODE_COMPAT` | M1 results, all | Opus | S |

W7-T1 (K15): Linux and Windows jobs run `pnpm check:full`; the Windows job builds the addon x64 from source and writes the digest table before tests; OS-scoped coverage step; CLI cache step; `timeout-minutes` per job set to the measured p95 from W6 times 2, with the measurements and the formula written in the workflow comment and in ADR-0014; until the macOS gate passes, the macOS job runs static checks, unit and conformance only (`pnpm check`), integration on macOS is enabled by W7-T4 after M1 lands.

Wave 6 items for Wave 7 (W6-Z rulings 8 and 10; recorded, not fixed):

- Gate: `pnpm check:tarball` joins `pnpm check:full` once the packages carry a README (W7-T3); the LICENSE (Apache-2.0, ADR-0015 item 10) is in place, so until then it reports only the README as missing.
- `pnpm cli:bump` (§1.11 `canary/bump.ts`, K16) is not built; the W7-T2 bump flow needs it.
- `env.dropped` lists `DISABLE_AUTOUPDATER` although hudhud pins that variable afterwards (§2.5); decide what the report means (names the base dropped, or names absent from the child) and make it say so.
- `cmd.permission-abort` has no public trigger: only the conformance replay reaches it; decide whether an API needs it or the input goes.
- The no-handler fail-closed path (`cmd.permission-error` with `no-handler`) is unreachable with the real CLI: without `onPermission` hudhud passes no `--permission-prompt-tool`, and the CLI denies by itself (tested in W6-T2); it stays covered by unit and conformance tests only.
- K15: the integration wall times of §4.4 (Windows and Linux, the whole project file by file) are the input of the CI timeouts.
- Timing bounds measured on the lead's machine must be re-measured on the CI runners before W7-T1 enables integration there (plan §4.4 flake policy: 3x the measurement on the platform that runs it); first of all the close-deadline overrun in `lifecycle/close-abort.test.ts` (Linux bound 135 ms = 3 x 45 ms, measured in Docker on a fast host; Windows 4176 ms = 3 x 1392 ms).
- Connect hashes the pinned CLI binary (about 260 MB) on every `connect` and session spawn: 0.37 s on an idle host but 18-46 s under full CPU contention (W6-Z trace, 15 integration files at once). Not a defect; consider caching a verified digest keyed by a file identity that cannot be swapped underneath (ADR-0004 TOCTOU rules) and decide with measurements.

W7-T2 (K16): the nightly `should-run` job finds the newest published CLI version; when it is newer than the pin, a Linux job (`contents: read` only, no write token anywhere in scheduled jobs) fetches it through `cli/newest.ts`, records the registry integrity for the run, runs the integration suite against it, re-runs the settings lookup check (the t21 equivalent, L1; any new location fails the canary), and writes a job summary with the version, integrity, results and the degradation classification; a failure turns the run red. It never re-runs the pinned version. The bump PR is prepared by the lead locally with `pnpm cli:bump <version>`. A weekly scheduled canary additionally runs the integration suite on Windows, and on macOS once the macOS gate has passed (Windows only before that), against the newest CLI version whenever a version newer than the pinned one was published since the last weekly run, so every OS sees a new CLI within a week at bounded cost. The weekly workflow (`.github/workflows/canary-weekly.yml`, owned by W7-T2) keeps the date of its last run in its own job summary history and compares publish times from the registry; it also holds only `contents: read`. Cost basis: about 20-30 CLI releases per month (02 §11) gives at most about 30 nightly Linux runs and at most about 4.3 weekly runs per OS per month; with the planning multipliers of 04 §1 (Linux 1x, Windows 2x, macOS 10x) the monthly cost is about 30 x D_linux + 4.3 x 2 x D_windows + 4.3 x 10 x D_macos Linux-equivalent minutes, where D is the measured integration-suite duration per OS; the durations are re-measured after Wave 6 and the estimate recomputed.

### 5.10 Summary table

| Wave | Tasks (parallel) | Model mix | Ends with |
|---|---|---|---|
| 0 | W0-T1, W0-T2 | 2 Opus | local check Win+Linux, CI FULL |
| 1 | W1-T1..T9, A1, W1-Z | 9 Opus, 2 Sonnet | same |
| 2 | W2-T1..T10, M1, A2, W2-Z | 11 Opus, 2 Sonnet | same; lead dispatches M1 |
| 3 | W3-T1..T6, A3, W3-Z | 6 Opus, 2 Sonnet | same; lead dispatches A3 |
| 4 | W4-T1..T3, W4-Z | 1 Opus, 3 Sonnet | same |
| 5 | W5-T1, W5-Z | 1 Opus, 1 Sonnet | same |
| 6 | W6-T1..T5, W6-Z | 4 Opus, 2 Sonnet | same |
| 7 | W7-T1..T4 | 3 Opus, 1 Sonnet | same; v1 checklist |

---

## 6. Windows job-object addon track

A separate track (A1-A3, then W3-T5 and W6-T3) in parallel with the main waves, merging only through wave gates. If x64 is not green by 1.0, v1 ships `'best-effort'` on Windows and the addon becomes v1.x (ADR-0009). Windows arm64 uses `'best-effort'` in v1 (K17).

### 6.1 A1: C source scope

`native/win32-job/src/hudhud_win32_job.c` (200-300 lines), `native/win32-job/src/delay_load_hook.c`, `native/win32-job/CMakeLists.txt`, `native/win32-job/build.mjs`, `native/win32-job/README.md`.

N-API surface (plain C on `node_api.h`, `NAPI_VERSION 8`):

| JS name | Win32 calls | Contract |
|---|---|---|
| `createJob()` -> external | `CreateJobObjectW(NULL, NULL)`; `SetInformationJobObject(JobObjectExtendedLimitInformation)` with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` only (no breakaway flags) | handle **not inheritable** (otherwise the CLI would keep the job alive after host death); finalizer closes the handle (kills the tree, "dies with its owner") |
| `assignProcess(job, pid)` -> `{ creationTime: string }` | `GetCurrentProcessId`, `OpenProcess(PROCESS_SET_QUOTA \| PROCESS_TERMINATE \| PROCESS_QUERY_LIMITED_INFORMATION)`, `GetProcessTimes`, `AssignProcessToJobObject`, `CloseHandle` | called while Node holds the child handle (no pid reuse); creation time as a decimal string of 100 ns units; the host's own pid is refused with `ERR_SELF_ASSIGN` before any handle is opened (lead ruling, A1: in its own `KILL_ON_JOB_CLOSE` job the host would die with the job, and `terminateJob` would kill it; `GetCurrentProcessId` is in the table for this check only) |
| `terminateJob(job, exitCode)` | `TerminateJobObject` | idempotent |
| `closeJob(job)` | `CloseHandle` | idempotent; later use fails with `ERR_JOB_CLOSED` |
| `listPids(job)` | `QueryInformationJobObject(JobObjectBasicProcessIdList)` | buffer bounded at 65536 entries |
| `processTimes(pid)` -> `{ creationTime: string }` | `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`, `GetProcessTimes` | identity for tests and sweeps; same shape and unit as `assignProcess` (W3-Z ruling 1, checked by the loader) |
| `version` | constant string | ABI check against the shipped digest table (a non-string is refused) |

Errors: JS `Error` with `code` `WIN32_<GetLastError>` and the API name; no `FormatMessage`. No other Win32 calls.

Build (CMake 3.28+, MSVC v143, C17): `/W4 /WX /sdl /guard:cf /Qspectre /analyze`; link `/DYNAMICBASE /HIGHENTROPYVA /NXCOMPAT /guard:cf`, `/CETCOMPAT` on x64; `/Brepro`, `/PDBALTPATH:%_PDB%`; import library from `node_api.def` of the pinned `node-api-headers` package (`lib /def:... /machine:x64|arm64`; plan decision: versioned and integrity-checked by pnpm, no nodejs.org download; fallback the Node headers tarball verified against `SHASUMS256.txt` if the package lacks the `.def`); `delay_load_hook.c` maps `node.exe` imports to the host process (Electron hosts). x64 and ARM64 via `cmake -A x64` / `cmake -A ARM64`.

A1 acceptance: `node native/win32-job/build.mjs --arch x64` builds with zero warnings and clean `/analyze`; a native smoke script runs create/assign/list/terminate against a `node -e` child.

As built (A1, 2026-10-16):

- Files as listed, plus `native/win32-job/smoke.mjs`. Toolchain used: VS Build Tools 2022 17.14.37710 (MSVC 19.44.35229, toolset 14.44.35207, v143) with the components `VC.Tools.x86.x64`, `VC.Tools.ARM64`, `VC.Runtimes.x86.x64.Spectre` and `VC.Runtimes.ARM64.Spectre` (all `Microsoft.VisualStudio.Component.` ids), Windows SDK 10.0.26100.0, CMake 4.4.4, `node-api-headers` 1.9.0 (catalog pin, root devDependency; it ships `def/node_api.def`, so the tarball fallback is not needed). ABI `version` `0.1.0`. The build is outside `pnpm check` (A2/A3 wire it).
- Errors: `WIN32_<n>` with the API name in the message, `ERR_JOB_CLOSED`, `ERR_SELF_ASSIGN` (`assignProcess` with the host's own pid, checked before any handle is opened; lead ruling), and the argument errors `ERR_INVALID_ARG_COUNT`, `ERR_INVALID_ARG_TYPE` and `ERR_INVALID_ARG_VALUE` (exact argument count; a pid is an integer in [1, 2^32 - 1], an exit code an integer in [0, 2^32 - 1]). Job externals are tagged with `napi_type_tag_object`. `listPids` uses a single buffer of 65536 entries; a larger job fails with `WIN32_234`.
- Build deviations, each with the same or a stronger effect:
  - `/PDBALTPATH:hudhud_win32_job.pdb` is written as the literal file name, because the Visual Studio generator double-escapes `%_PDB%` and the linker then writes `%%%<name>%%%`. The result equals what `%_PDB%` gives.
  - Added: static runtime `/MT` (no VC++ redistributable needed), `kernel32.lib` as the only default library, `/MANIFEST:NO`, `/OPT:REF /OPT:ICF /INCREMENTAL:NO`, `/utf-8`, MSBuild `/warnaserror`, and CMake `-Werror=author` (`-Werror=dev` before CMake 4.4, which deprecated it).
  - The Visual Studio generator is required: it maps `/Qspectre` to MSBuild's `SpectreMitigation`, which fails the build (MSB8040) when the Spectre-mitigated libraries are missing, instead of linking an unmitigated runtime. The link uses `lib\spectre\<arch>\libcmt.lib` and `libvcruntime.lib`; the UCRT (`libucrt.lib`) has no Spectre variant.
- Blocker removed: the first A1 run stopped because the Spectre-mitigated libraries and the ARM64 tools were missing; the lead installed the components listed above.
- Builds of record (`build.mjs`, two clean builds per architecture in different build directories, identical results; zero warnings; `/analyze` with zero defects):
  - x64: sha256 `fbe7d9ad87241984758c2e708dae0a356323836027f6fdb97e72478f65d069b0`. dumpbin: machine 8664; DLL characteristics High Entropy VA, Dynamic base, NX, Control Flow Guard; extended DLL characteristics CET compatible; load config Guard Flags `10017500` (CF instrumented, FID table, export suppression) and a security cookie; debug directory names only `hudhud_win32_job.pdb`; no resource directory; imports `KERNEL32.dll` plus the delay-loaded `NODE.EXE`; exports `napi_register_module_v1` and `node_api_module_get_api_version_v1`. Smoke test green 3 runs in a row.
  - ARM64: sha256 `a38a74a0691979992369cf5614be7de8d8cc38456427b098183dae4ba3424206`. dumpbin: machine AA64, with the same DLL characteristics, guard flags, debug directory, imports and exports as x64. There is no CET flag: `/CETCOMPAT` marks compatibility with Intel CET shadow stacks, an x64 hardware feature. ARM64 keeps CFG, ASLR, DEP, `/GS`, `/sdl` and `/Qspectre`. Not run (no ARM64 machine; K17: not first-class in v1).

### 6.2 A2: platform packages and digest tooling

`packages/win32-job-x64/package.json`: `os: ["win32"]`, `cpu: ["x64"]`, `files: ["hudhud_win32_job.node", "SHA256SUMS"]`, `exports` for the `.node` file and `package.json`, no scripts, no dependencies, `publishConfig.provenance: true` (effective at open-sourcing, K17). `packages/win32-job-arm64` mirrors it but is not an optional dependency of core and is not published as first-class in v1 (K17; as built it is `private` without `publishConfig`, lead ruling on A2). The `.node` files are never committed.

`scripts/addon/write-digests.mjs` writes `packages/core/src/process/containment/win32-job-digests.json` (`{ "x64": "<sha256>", "version": "<addon version>" }`) from a local or CI build, so the loader's digest check runs in every Windows test.

As built (A2, 2026-10-16):

- Digest table: the as-built mechanism wins over the JSON named above. The table stays the TypeScript module `win32-job-digests.ts` (W3-Z ruling 9: no `resolveJsonModule`), now generated in full by the tool and frozen: `{ version: '0.1.0', x64: 'fbe7d9ad…69b0' }`, the x64 build of record of §6.1. A scripts test keeps the committed file byte-equal to the generator's output. The ARM64 digest is not in the table, because the loader never loads ARM64 (K17). It lives only in that package's `SHA256SUMS`.
- `scripts/addon/write-digests.mjs` is a thin CLI over `scripts/lib/addon-digests.mjs`, which is covered at 100 % like the other script libraries. It reads the build (`native/win32-job/build/<arch>/Release/`, or `--addon <file>` for a CI artifact) and refuses anything but a PE image of the requested machine (0x8664, 0xAA64). It reads `version` by `dlopen` on a Windows host of the same architecture, or else from `--version`; if both are present they must match, and the value must be semver. Without `--check` it rewrites the table for x64. With `--check`, and always for ARM64, it only verifies against the committed table (sha256 for x64, `version` for both) and never edits it. In every mode it stages the exact bytes it hashed as `packages/win32-job-<arch>/hudhud_win32_job.node` with a `SHA256SUMS` line in `sha256sum` format; both files are gitignored (root `*.node` and a `.gitignore` in each package).
- How Windows test runs get the addon: a developer, and later CI (W7-T1), runs `build.mjs --arch x64` and then `write-digests.mjs --arch x64 --check` before `pnpm check`. `pnpm check` runs no native build: on Linux and macOS nothing changes. On Windows x64 the scripts test `addon-loader.test.ts` and the core's host-loader test require the staged addon. They fail, naming both commands, when it is missing or stale; they are never skipped. They prove that a digest match loads the addon through the real `loadJobAddon(hostJobAddonDeps())` (`'job'`, `version` 0.1.0, resolved file = the staged file, `createJob`/`listPids`/`terminate`/`close` and `processTimes` work), and that a tampered copy (one byte of the DOS stub flipped) is refused before `dlopen` with `digest-mismatch (sha256-differs)` and `'best-effort'`. Evidence that the build of record holds: two clean builds in a different checkout path (this worktree) gave exactly `fbe7d9ad…69b0` (x64) and `a38a74a0…4206` (ARM64), so `/Brepro` makes the digest independent of the build directory.
- Resolution: `@hudhudjs/core` now declares `optionalDependencies: { "@hudhudjs/win32-job-x64": "workspace:*" }` (the W3-Z deferral above ends; ARM64 is not listed, K17). pnpm links the workspace package into `packages/core/node_modules`, so the loader's `createRequire(import.meta.url).resolve(WIN32_JOB_ADDON_SPECIFIER)` resolves to `packages/win32-job-x64/hudhud_win32_job.node`, exactly as it will in an installed tree. `pnpm pack` rewrites `workspace:*` to the exact version. No test-only resolution path exists.
- Repository tooling: `api-report.mjs` skips `.node` subpaths, as it skips JSON (no TypeScript API). The tarball check lists `.node` subpaths as `native` entry points: present in the tarball and installed, never imported. It also lists the tarballs of the other platform's packages as optional dependencies of its consumer project. Without that, npm asked registry.npmjs.org for `@hudhudjs/win32-job-x64` (404) on a host that cannot install it; this was observed with `npm install --loglevel http`. The platform packages carry a LICENSE and a short README.
- Lead rulings on A2 (2026-10-16), as built:
  - Windows checks always exercise the real addon. `pnpm addon:stage` runs the build and `write-digests.mjs --arch x64 --check`. CONTRIBUTING lists the prerequisites (VS Build Tools 2022 with the MSVC x64 tools and `VC.Runtimes.x86.x64.Spectre`, a Windows SDK, CMake 3.28+), the command and the failure a contributor sees without it.
  - CI: the `windows` job of `ci.yml` records the toolchain (`cmake --version`, the Visual Studio version, the MSVC toolset, the `cl` banner) and fails with the missing component's name when the image lacks the MSVC x64 tools or the Spectre libraries. It never installs one and never drops `/Qspectre`. Then it runs `pnpm run addon:stage` (which prints the sha256 it built), prints the Windows SDK the build used, and runs `pnpm check`. Whether the windows-2025 build reproduces `fbe7d9ad…69b0` is decided on the first CI run; if it differs, the table is not changed and A3 decides.
  - Integration suites run on Windows under `'job'` by default. The harness's typed `SandboxConnectOptions.jobAddon` (`'host'` or `'unavailable'`; `jobAddonSeam` in `support/harness.ts`, the same seam in `support/crash-host.mjs`) forces the loader's `package-missing`, so `'best-effort'` stays covered. No product switch and no environment variable. The containment suites (`ladder`, `orphan`, `host-crash`, `reporting`) run every case in both modes on Windows x64 (`CONTAINMENT_MODES` in `containment/tree.ts`), with per-mode expectations: under `'job'`, `terminate-job` in the close-deadline ladder and zero survivors, the MSYS2 `sleep.exe` included (ADR-0009 now limits the W6-T3 residual to best effort); under `'best-effort'`, the measured W6-T3 expectations unchanged. On Linux one mode runs, as before.
  - Plan §6.5 rows: "loader unit tests" in `packages/core/test/process/containment/win32-job.test.ts`. "create/assign/list/terminate with child + grandchild", "handle not inherited", "host crash" (native) and "idempotency" in `native/win32-job/smoke.mjs`, which `scripts/test/addon-loader.test.ts` now runs against the staged addon in every Windows x64 check. "CLI Bash tree" (dispose ends in `TerminateJobObject`, zero survivors) in `containment/ladder.test.ts` under `'job'`; the close-deadline case ends in `terminate-job`, and the foreground-dispose case ends on the interrupt and EOF, with the job closed after the exit. "host crash" with the pinned CLI in `containment/host-crash.test.ts` under `'job'`. "digest mismatch" in `scripts/test/addon-loader.test.ts`.
  - `check:tarball`: a native platform package whose `os` excludes the host is reported as `skipped <name> (native, built on win32 only)` and not checked. Its tarball is still packed, unchecked, so that the core's optional dependency on it resolves without the registry. On Windows it must be built and pass (`nativeSkipReason` in `scripts/lib/tarball.mjs`, unit-tested on both paths).
  - `@hudhudjs/win32-job-arm64` is `private` without `publishConfig` (K17), so neither the release flow nor the tarball check treats it as published.

### 6.3 A3: prebuild pipeline in CI (K17)

Workflow `.github/workflows/addon-prebuild.yml`, triggers `workflow_dispatch` and tags `v*` (never `pull_request_target`):

| Job | Runner | Permissions | Steps |
|---|---|---|---|
| `build` (matrix x64, arm64) | `windows-2025` | `contents: read` | checkout (pinned SHA, no persisted credentials); frozen install without scripts; record toolchain (`cmake --version`, `cl` banner, Windows SDK version) into `toolchain.json`; for arm64 first check that the MSVC ARM64 build tools exist on the image and fail with an explicit message if not (K17: stop and report); build; sha256; upload artifact (3 days) |
| `test-x64` | `windows-2025` | `contents: read` | download x64; addon test suite (§6.5) including the pinned-CLI tree test |
| `manifest` | `ubuntu-24.04` | `contents: read` | download both; write `SHA256SUMS` and `manifest.json` (`version`, per arch `sha256`, `size`, `toolchain`); upload |

No arm64 test job while the repository is private: no real arm64 runner is assumed (K17). The lead commits `SHA256SUMS`, `manifest.json` and `toolchain.json` into `native/win32-job/release/<version>/` as the provenance record of the build (K17). Attestations and `npm publish --provenance` are added at open-sourcing. No caches in this workflow.

### 6.4 W3-T5: loader with fallback

`loadJobAddon({ platform, arch, requireResolve, readFile, dlopen, digests })`:

1. Not win32: `unavailable`, `not-windows`.
2. `arch === 'arm64'`: `unavailable`, `arm64-not-first-class` (K17); other non-x64: `unsupported-arch`.
3. Resolve `@hudhudjs/win32-job-x64/hudhud_win32_job.node` via `createRequire(import.meta.url)`; missing: `package-missing`.
4. sha256 against the shipped digest; mismatch or none: `digest-mismatch` (defence in depth only).
5. `process.dlopen` into a fresh module object; failure: `dlopen-failed`.
6. `version` check; mismatch: `abi-mismatch`.

Never throws. Harness capability `processContainment` is `'job'` when loaded, else `'best-effort'` with a `reasons` entry (K2). Per session: `createJob` + `assignProcess` right after spawn, before `process.started` reaches the machine; an assignment failure keeps the session, sets `info.containment` to `'best-effort'` and emits `containment.fallback` (K2). The session holds the job handle and closes it after the process exited.

### 6.5 Addon tests

| Test | Where | Proves |
|---|---|---|
| loader unit tests (all outcomes including arm64) | all OS | fallback never throws |
| create/assign/list/terminate with `node` child + grandchild | Windows x64 | nesting under libuv's job, inheritance (05 §10) |
| handle not inherited | Windows x64 | closing the host-side handle kills the tree |
| host crash | Windows x64 | helper Node host killed with `TerminateProcess`; zero survivors (07 §2 W94 inverted) |
| CLI Bash tree | Windows x64 | pinned CLI with `[[mock:bash cmd=sleep 30]]`, dispose ends in `TerminateJobObject`; zero survivors (05 §10 runs 67-69) |
| idempotency | Windows x64 | double close, terminate after close, `ERR_JOB_CLOSED` |
| digest mismatch | Windows x64 | tampered copy refused, fallback to best-effort |

---

## 7. Risks and de-risking order

| # | Risk | Impact | De-risk action | When |
|---|---|---|---|---|
| R1 | Windows x64 addon not green (1.0 criterion) | v1 ships `'best-effort'` on Windows; host crash orphans Git-Bash trees (07 §2) | A1 in Wave 1, A3 in Wave 3 | Waves 1-3 |
| R2 | macOS behaviour differs (process groups, Keychain hang, zsh snapshot hang, socket path, path identity) | v1 blocked by the macOS gate | M1 in Wave 2, dispatched immediately; results feed W2-T7, W3-T2, error causes | Wave 2 |
| R3 | Session machine interleaving bugs | hangs, double settlement, silent permission | fixtures early (W2-T10 recorder, W3-T6), `machine-kit` model tests, loopback replay | Waves 2-4 |
| R4 | Settings lookup differs from the guard's assumptions | false sense of safety under project sources | W0-T2 spike; guard stays a superset unless narrowed by evidence (K5) | Wave 0 |
| R5 | esbuild without postinstall fails on one OS | schema pipeline blocked | verified in W0-T1; stop and report if it fails (K14) | Wave 0 |
| R6 | CI minutes and time limits with real-CLI integration and ~250 MB binaries per OS | budget overrun, timeouts | cache the binary; measure in W6; size timeouts as p95 x 2 (K15) | Waves 6-7 |
| R7 | CLI drift during development | stale expectations | pinned 2.1.296; nightly canary against the newest version; lead bumps locally (K16) | continuous |
| R8 | Flaky timing tests | red CI without regressions | fake clocks for order, 3x margins, no retries | all waves |
| R9 | Auth fail-fast for `ANTHROPIC_AUTH_TOKEN` and OAuth never observed | narrower protection | fail-fast limited to `ANTHROPIC_API_KEY` until a fixture exists (K10), documented; resolved in W3-Z: the token was observed (`tokenSource`) and is fail-fast; OAuth stays excluded | Wave 3 |
| R10 | Windows arm64 hosts | no containment beyond best-effort | documented capability `'best-effort'` on arm64 in v1 (K17) | v1 |
| R11 | Electron or non-Node hosts load the addon | crash on load | delay-load hook in A1; Electron smoke test deferred, documented | Wave 1 |
| R12 | K3 split leaks Claude vocabulary into the core | multi-harness design broken | neutrality test, depcruise rules, review in every closer | all waves |

Order: R4 and R5 in Wave 0; R1 and R2 in parallel tracks (Waves 1-2); R3 (Waves 2-4); R6 measurement (Wave 6); R7, R8, R12 continuous.

---

## 8. Lead rulings (K1-K23)

Rulings of 2026-10-12 on the open points of the first draft (recorded in 06 §K). Each is applied in the sections cited.

| Id | Ruling | Applied in |
|---|---|---|
| K1 | POSIX SIGTERM goes to `initialize.pid` only when it is in snapshot S1 as a descendant of the spawned pid with a matching start time, otherwise to the spawned pid; containment and sweep are rooted at the spawned pid. | §1.7, W2-T7, W6-T3; ADR-0010 |
| K2 | `HarnessCapabilities.processContainment` is what the Harness can provide; `Session.info.containment` is what the session got; assignment failure falls back to `'best-effort'` with a diagnostic. No new enum value (no custom spawner in v1). | §2.2, §6.4 |
| K3 | Claude Code wire types, Claude schemas and the Claude protocol machines live in `@hudhudjs/claude-code` (`src/protocol/`), under the sans-IO lint and depcruise rules. `@hudhudjs/core` keeps only neutral pieces: event vocabulary and public types, generic NDJSON framer and encoder, bounded queues, error taxonomy, schema pipeline tooling, generic machine contract and handle machinery, process layer, securityPosture model. Core `/protocol` means the neutral protocol. | §1.1-§1.6, §2.1, waves 1-4; ADR-0004, ADR-0005, ADR-0006, architecture |
| K4 | One `claude --version` probe at connect (no network, 05 §1); per-session drift report. | §1.8, W5-T1 |
| K5 | The credential guard applies whenever effective sources include project or local (also via `claudeCode.settingSources`); lookup is cwd and every ancestor up to the filesystem root plus every `--add-dir` directory; superset, fail closed. Narrowed by L1 (spike W0-T2, 08) to cwd, nearest git root and main worktree root; the superset stays the fallback when the git root cannot be resolved. | §1.8, W0-T2, W3-T3, W6-T4; ADR-0012 |
| K6 | `continue` is not in v1. | §2.3 |
| K7 | Discovery: option, native installer launcher, sanitized `PATH`; no `node_modules` probing. | §1.8; ADR-0011 |
| K8 | Committed digest table for the tested window, updated by the bump PR, plus application digests; never fetched at run time. The OS-signature check runs only under `'strict'`; advisory uses the digest table only. | §1.7, §1.8, W3-T2; ADR-0011 |
| K9 | `binaryVerification: 'advisory' \| 'strict'`, default `'advisory'`. | §2.3, §2.4; ADR-0011 |
| K10 | Fail-fast trigger set accepted; 403 is not a trigger; fail-fast applies to `ANTHROPIC_API_KEY` only until the `ANTHROPIC_AUTH_TOKEN` source string is observed in a fixture; documented. Observed in W3-Z (`account.tokenSource`); fail-fast now covers both (lead decision). | §1.5, §4.3; ADR-0012 |
| K11 | Permission modes: `default`, `acceptEdits`, `plan`, `dontAsk`, `auto`, and `bypassPermissions` only with `dangerouslyAllowBypassPermissions`; no `manual` in v1. | §2.3 |
| K12 | Pending permissions on drain get a non-interrupting deny; on abort nothing is written. | §1.5; ADR-0007 |
| K13 | `close()` has a single deadline from the call, default 30 s; documented. | §1.5, §2.2; ADR-0008 |
| K14 | `allowBuilds: { esbuild: false }` is an explicit deny, not a weakening; W0 verifies esbuild works from its optional platform package without the postinstall on Windows and Linux, else stops and reports. | §1.3, W0-T1; ADR-0017 |
| K15 | Timeouts re-sized from W6 measurements (p95 x 2, documented). Before the macOS gate passes, macOS runs static checks, unit and conformance only; integration on macOS after M1 lands. | W7-T1; ADR-0014 |
| K16 | No write tokens in scheduled jobs. The nightly downloads the newest published CLI (integrity recorded from the registry and pinned for that run), runs the integration suite on Linux, and goes red with a job summary on failure. The lead makes the bump PR locally. The nightly tests the new version, never the pinned one. Amended: a weekly canary also runs Windows (and macOS after its gate) against the newest version when one newer than the pin appeared since the last weekly run; cost basis 02 §11, durations re-measured after W6. | §4.6, W7-T2; ADR-0004, ADR-0013, ADR-0014 |
| K17 | While private: x64 built and tested on `windows-2025`; arm64 cross-compiled if the MSVC ARM64 tools exist on the image (else stop and report) but not shipped first-class until it runs on a real arm64 runner; arm64 Windows uses `'best-effort'` until then. Provenance now is the committed sha256 and toolchain manifests; attestations and npm provenance at open-sourcing. Amendment (lead ruling on A2, 2026-10-16): `@hudhudjs/win32-job-arm64` is `private` without `publishConfig` in v1, so it cannot be published by accident; A3 still builds it. | §6; ADR-0004, ADR-0009, ADR-0017 |
| K18 | The transport seam is internal; no public custom spawner in v1. | §1.6, §2.3 |
| K19 | `env` gains `{ preset: 'harness' \| 'inherit', add?, remove? }` alongside the string and map forms; `add` keys reported by name; adding credential or routing variables is allowed and listed in securityPosture. | §2.3-§2.5, W2-T9; ADR-0012 |
| K20 | `harness.compat` plus `compat` replayed as the first event of every session stream. | §2.2 |
| K21 | `ask()`/`turn.done` resolve for error results and reject only for session-level failures. | §2.2, §3 |
| K22 | No signal handlers; terminal Ctrl+C on POSIX ends as `unknown` with `PROCESS_EXITED`; documented. | §1.6, §2.2, §3.3 |
| K23 | Read-only parse of the user's settings files for the posture-relevant `env` keys (`ANTHROPIC_BASE_URL`, provider switches) only; values never logged or stored; never written. | §1.9, W3-T4; ADR-0012 |
