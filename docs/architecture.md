# hudhud architecture

Status: design document, 2026-10-12. Nothing described here is implemented yet. Every section links to the ADR(s) that carry the decision and its rationale; the ADRs are authoritative ([ADR index](adr/README.md)). Research snapshots are in [research/](research/README.md).

Conventions used in this document:

- "UNVERIFIED" marks facts that were not confirmed by an experiment or an official source.
- "Pending spike X" marks decisions that are accepted but gated on a spike listed in [Pre-v1 spikes](#pre-v1-spike-list-g4).
- Identifiers in code blocks that do not appear in the negotiation log (06) are illustrative.

## Contents

1. [Goals and owner rules](#goals-and-owner-rules)
2. [Layers and packages](#layers-and-packages)
3. [Public API sketch](#public-api-sketch)
4. [Protocol and wire model](#protocol-and-wire-model)
5. [Sans-IO core](#sans-io-core)
6. [Process layer per OS](#process-layer-per-os)
7. [Security model and threat model](#security-model-and-threat-model)
8. [Defaults table](#defaults-table)
9. [Capability model](#capability-model)
10. [Versioning](#versioning)
11. [Testing strategy](#testing-strategy)
12. [CI](#ci)
13. [Scope: v1, v1.1, later](#scope-v1-v11-later)
14. [Pre-v1 spike list (G4)](#pre-v1-spike-list-g4)
15. [macOS gate list](#macos-gate-list)
16. [Owner decisions](#owner-decisions)

## Goals and owner rules

hudhud is a TypeScript library that drives locally installed agent harnesses (Claude Code first) on behalf of applications. It is security-sensitive: other sensitive projects build on it. It is private now and planned to be open source later.

The owner's binding rules (06 header):

| Rule | Statement | Where it shows up |
|---|---|---|
| R1 | Quality and security above time | Spike-gated v1 ([ADR-0018](adr/0018-scope-and-roadmap.md)); safe defaults ([ADR-0012](adr/0012-security-defaults-and-trust.md)) |
| R2 | "Provide every way": anything doable more than one way is offered in all ways, first-class; default is the most stable, professional, safe option; simple by default, fully customizable | Every-way registry, "first-class is operational" ([ADR-0002](adr/0002-execution-modes-and-every-way-registry.md)) |
| R3 | TypeScript primary; Windows, Linux, macOS from day one; importable library; multi-harness design (Claude Code first); future bindings for other languages | Sans-IO core, JSON-only boundary, daemon-ready ([ADR-0006](adr/0006-sans-io-core-and-daemon-readiness.md)); process layer per OS ([ADR-0009](adr/0009-process-layer-windows.md), [ADR-0010](adr/0010-process-layer-posix.md)) |
| R4 | No owner preference for any language or tool; technology choices on technical merit only | Merit-based choices recorded in each ADR (for example [ADR-0009](adr/0009-process-layer-windows.md) addon toolchain, [ADR-0017](adr/0017-toolchain.md) pnpm) |
| R5 | Services (if ever needed) run in Docker, never installed on the host; toolchains may be installed | Mock API in-process on CI, Docker only for local Linux runs ([ADR-0013](adr/0013-testing-strategy.md)) |
| R6 | Never damage the harness or its configuration | Never-write posture, no credential copying, unmodified binary ([ADR-0012](adr/0012-security-defaults-and-trust.md), [ADR-0015](adr/0015-legal-and-provenance.md)) |
| R7 | GitHub Actions minutes are limited: risk-tiered CI, never at the expense of quality | Tiers, gate job, macOS policy ([ADR-0014](adr/0014-ci-strategy.md)) |

Foundation: hudhud implements the stream-json + control protocol itself against the user's installed, unmodified CLI ([ADR-0001](adr/0001-foundation-and-backends.md)). The Claude Agent SDKs are subprocess wrappers over the same protocol (02 §0).

## Layers and packages

```
 Application
    |
    v
+---------------------------------------------------------------------+
| hudhud (umbrella: zero-code re-export, exact-version deps)          |
+---------------------------------------------------------------------+
| @hudhud/claude-code            Claude Code adapter                  |
|   backends: native | agent-sdk (optional peer, never redistributed) |
|   /raw  (unstable tier)                                             |
+---------------------------------------------------------------------+
| @hudhud/core                                                        |
|   /protocol   sans-IO state machines: protocol, turn, permission    |
|               (state, input) -> (state, effects[]); injected        |
|               clock and ids; JSON-only boundary                     |
|   schemas/    committed JSON Schema 2020-12 (the contract)          |
|   /process    ordinary async code: spawn, framer, termination       |
|               ladders, sweep, binary resolution/verification        |
|   binding layer: closures, timers, AbortSignal, subscribers         |
+---------------------------------------------------------------------+
| @hudhud/win32-job-x64 | @hudhud/win32-job-arm64                     |
|   optional, prebuilt plain-C N-API addon (Windows job objects)      |
+---------------------------------------------------------------------+
    |  duplex byte stream (stdin / stdout NDJSON; stderr separately)
    v
 claude (user-installed, unmodified)  -->  tools, MCP servers, shells
```

Later: a daemon (JSON-RPC 2.0 over NDJSON on a local authenticated channel, never TCP by default) with thin generated clients for other languages. Packages, versioning and `adapterApiVersion`: [ADR-0004](adr/0004-packages-and-versioning.md). Toolchain: [ADR-0017](adr/0017-toolchain.md).

Session to process binding is adapter-internal and may be one-to-many ([ADR-0003](adr/0003-public-api.md)).

## Public API sketch

Design intent only; not implemented. Names taken from the negotiation log: `connect`, `Harness`, `Session`, `Turn`, `ask`, `send`, `events`, `interrupt`, `done`, `sessions.create/resume`, `hudhud.session()`, `capabilities`, `binary`, `securityPosture`, `compat`, `workspaceTrust`, `claudeCode.settingSources`, `onAuthFailure`, `onOversizedFrame`, `processContainment`, `adapterApiVersion`. Everything else is illustrative. Decision: [ADR-0003](adr/0003-public-api.md).

```ts
// ---- illustrative: design intent, NOT implemented ----------------------

type Capability = 'supported' | 'emulated' | 'unsupported';

interface HarnessCapabilities {
  multiTurn: Capability;                     // one-shot Sessions report 'emulated' (via --resume)
  resume: Capability;                        // gated on the resume/fork spike
  fork: Capability;
  permissionsInBand: Capability;             // stdio permission prompting
  workspaceTrust: { none: Capability; context: Capability; full: Capability };
  processContainment: 'job' | 'best-effort' | 'cgroup';
  // ...further capability strings come from system/init.capabilities
}

interface BinaryInfo {
  path: string;                              // resolved (symlinks followed)
  version: string;                           // initialize.claude_code_version
  verification: {                            // advisory; never blocking by default
    status: 'verified' | 'unverified' | 'failed';
    method: 'os-signature' | 'sha256-manifest' | 'none';
  };
}

interface SecurityPosture {                  // emitted at connect
  entries: Array<{ setting: string; value: unknown; defaultValue: unknown; deviates: boolean }>;
}

// Open event union: unknown 'type' values are legal, raw frame always present
type HudhudEvent =
  | { type: 'turn.started'; seq: number; ts: string /* ISO-8601 */; turnId: string; raw: unknown }
  | { type: 'permission.requested'; seq: number; ts: string; requestId: string; raw: unknown }
  | { type: 'stalled'; seq: number; ts: string; raw?: unknown }
  | { type: 'compat'; seq: number; ts: string; minTested: string; maxTested: string; knownBroken: string[]; raw?: unknown }
  | { type: string & {}; seq: number; ts: string; raw: unknown };   // open arm

interface Turn extends AsyncIterable<HudhudEvent> {   // filtered to this turn
  readonly id: string;
  readonly done: Promise<TurnResult>;                 // never depends on subscribers
  interrupt(opts?: { cancelQueued?: boolean }): Promise<void>;  // queued until the turn's system/init
}

interface Session extends AsyncDisposable {           // dispose = abort
  ask(prompt: string, opts?: { signal?: AbortSignal }): Promise<TurnResult>;
  send(input: UserInput, opts?: { signal?: AbortSignal }): Turn;
  events(opts?: {
    maxEvents?: number; maxBytes?: number;
    overflow?: 'error' | 'drop-oldest-with-gap-marker' | 'block';   // default 'error'; 'block' documented-dangerous
  }): AsyncIterable<HudhudEvent>;                     // opt-in, per-subscriber bounded queue
  close(opts?: { signal?: AbortSignal }): Promise<void>;           // drain
}

interface Harness extends AsyncDisposable {
  readonly capabilities: HarnessCapabilities;
  readonly binary: BinaryInfo;
  readonly securityPosture: SecurityPosture;
  readonly sessions: {
    create(opts?: SessionOptions): Promise<Session>;
    resume(id: string, opts?: SessionOptions): Promise<Session>;
  };
}

interface ConnectOptions {
  backend?: 'native' | 'agent-sdk';           // default 'native'; 'agent-sdk' from v1.1
  binaryPath?: string;
  claudeCode?: ClaudeCodeOptions;            // harness-namespaced tier, e.g. { settingSources?: Array<'user'|'project'|'local'> }; setting both this and workspaceTrust is a validation error
  signal?: AbortSignal;
}

interface SessionOptions {
  cwd?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'auto';  // always passed explicitly; 'auto' is a descriptively named opt-in, always listed in securityPosture
  workspaceTrust?: 'none' | 'context' | 'full';                      // harness-neutral; default 'none' -> ['user']; 'full' -> ['user','project','local'] and is a security-weakening opt-in listed in securityPosture
  env?: 'harness' | 'inherit' | Record<string, string>;              // 'inherit' is a security-weakening opt-in, listed in securityPosture
  onPermission?: (req: PermissionRequest, ctx: { signal: AbortSignal }) => Promise<PermissionDecision>;
  onAuthFailure?: 'fail-fast' | 'harness-retry';                     // default 'fail-fast' (where applicable)
  onOversizedFrame?: 'fail' | 'skip';                                // default 'fail'
  maxFrameBytes?: number;                                            // default 64 MiB
  autoUpdate?: 'disabled' | 'harness-default';                       // default 'disabled' (DISABLE_AUTOUPDATER=1); 'harness-default' listed in securityPosture
  nonessentialTraffic?: 'disabled' | 'harness-default';              // default 'disabled', decided by gate G1; 'harness-default' is always listed in securityPosture
}

declare function connect(opts?: ConnectOptions): Promise<Harness>;
declare const hudhud: { session(opts?: ConnectOptions & SessionOptions): Promise<Session> };
```

Tiers: stable (`hudhud`, `@hudhud/core`, `@hudhud/claude-code`), harness-namespaced options, unstable `@hudhud/claude-code/raw` (exempt from compatibility promises). `Symbol.asyncDispose` and `AbortSignal` are supported everywhere.

## Protocol and wire model

Source of truth for frames hudhud depends on: observed behaviour of CLI 2.1.296 ([05](research/05-empirical-cli.md)), cross-checked with the MIT Python SDK; nothing copied from proprietary SDK files ([ADR-0001](adr/0001-foundation-and-backends.md), [ADR-0015](adr/0015-legal-and-provenance.md)).

Transport: NDJSON, one JSON object per line, both directions, over the child's stdin/stdout. `--output-format=stream-json --input-format=stream-json --verbose` are required (stream-json without `--verbose` exits 1; `-p` is not needed, 05 §4). stderr carries diagnostics only.

Two multiplexed traffic classes on the same pipes (02 §0):

1. Conversation frames: stdin `user` messages; stdout `system` (including `init`, `api_retry`, `session_state_changed`, `permission_denied`, `informational`, `background_tasks_changed`, task frames), `assistant`, `user` (tool results), `stream_event` (with partial messages), `command_lifecycle`, `result`.
2. Control protocol: `control_request`, `control_response` (`success` / `error`), `control_cancel_request`, and `keep_alive` (never sent by the CLI in 05 §12).

Control requests that hudhud sends in v1 (host to CLI): `initialize` (first, always), `interrupt` (`cancel_queued?`; response `{still_queued, cancelled?}`), `set_permission_mode` (only when explicitly used). Requests the CLI sends (host must answer): `can_use_tool` (only with `--permission-prompt-tool=stdio`); in v1.1 also `hook_callback` and `mcp_message`. Control subtypes such as `update_settings`, `apply_flag_settings`, `mcp_call`, `read_file` carry the agent's authority and are not sent unless an explicit opt-in applies ([ADR-0012](adr/0012-security-defaults-and-trust.md)).

Observed handshake and turn rules (05):

- `initialize` is optional for the CLI; hudhud always sends it first and arms its first-frame watchdog on that write ([ADR-0008](adr/0008-turn-and-lifecycle-semantics.md)). Response carries `pid`, `claude_code_version`, `account.apiKeySource`, `models`, `commands`, `capabilities`.
- `system/init` is emitted once per turn, after the user message, never at startup. It carries `session_id`, `permissionMode`, `capabilities` (for example `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `msg_lifecycle_v1`) used for feature detection.
- A user message with a `uuid` is echoed in `result.user_message_uuid(s)` and turns on `command_lifecycle` frames.
- `result` is the turn-complete signal; it can be absent (SIGINT/SIGTERM), in which case hudhud synthesizes the turn end.
- `session_state_changed` (`running`, `idle`) only appears with `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, which hudhud always sets.
- Line sizes are bounded by model output (a 5 MB text yields three ~5 MB lines), hence the 64 MiB default cap ([ADR-0011](adr/0011-spawn-hygiene-and-binary-provenance.md)).
- UTF-8 is clean in both directions; CRLF, BOM and split multibyte writes are tolerated (05 §11).

hudhud's core vocabulary mirrors ACP where it is sound (tool kind and status, permission option kinds, stop reasons, `usage_update`) while remaining an independent, versioned superset; ACP types never appear in the public API ([ADR-0003](adr/0003-public-api.md)). hudhud's own event model on top of the frames: normalized events with a mandatory raw payload, ISO-8601 timestamps, monotonic `seq`, string ids, open enums, additive-only evolution, `x-` experimental namespace. Validation: strict public inputs, strict outbound frames, lenient envelope-only inbound ([ADR-0005](adr/0005-schema-and-validation.md), [ADR-0003](adr/0003-public-api.md)). Event delivery, backpressure and handler timeouts: [ADR-0007](adr/0007-event-delivery-backpressure-timeouts.md).

## Sans-IO core

The protocol, turn and permission state machines are pure: `(state, input) -> (state, effects[])`, with injected clock and ids, no I/O imports (enforced by lint and dependency-cruiser). Application callbacks are id-correlated request/response messages with optional deadline and cancel; TS closures live in the binding layer. The core boundary is JSON-only: ISO timestamps plus `seq`, string ids, no `bigint`/`Date`/class instances, base64 binary, optional means absent, errors as data. A loopback binding in v1 proves the boundary. Golden fixtures are language-neutral JSONL conformance suites. The process layer and binding layer are ordinary async code (sans-IO is not forced onto them). Later multi-language support is a daemon with generated clients, not native ports. Decision: [ADR-0006](adr/0006-sans-io-core-and-daemon-readiness.md).

## Process layer per OS

General: `shell: false`, `windowsHide: true`, stdio pipes, explicit environment, non-detached, all flags as `--flag=value` ([ADR-0011](adr/0011-spawn-hygiene-and-binary-provenance.md)). Drain (`close()`) is not a ladder: stdin stays open until idle, then EOF ([ADR-0008](adr/0008-turn-and-lifecycle-semantics.md)). Abort (`dispose`, `AbortSignal`) uses the ladders below. Termination intent is recorded before any signal, because exit codes mislead (Windows job close gives 0; Linux SIGINT gives 0 with no `result`; SIGTERM gives 143).

### Windows ([ADR-0009](adr/0009-process-layer-windows.md))

Evidence: `TerminateProcess(claude.exe)` orphans the Git-Bash tool tree (4 of 4); EOF leaves none; a second `KILL_ON_JOB_CLOSE` job nested under libuv's job works and grandchildren inherit it (05 §10).

Containment: spawn (not detached), assign to a host-owned job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` before the first stdin write. The addon is `@hudhud/win32-job-{x64,arm64}`: plain C on `node_api.h`, CMake/MSVC, prebuilt-only, provenance; a pre-`dlopen` sha256 check is defence in depth only. Capability `processContainment: 'job'` (addon is a 1.0 criterion; job nesting, inheritance and job-close kill are already proven by 05 §10; remaining work: addon implementation and the arm64 prebuild pipeline), otherwise `'best-effort'`.

Ladder with job:

```
interrupt{cancel_queued:true} (wait <= 1 s) -> stdin EOF -> 2 s grace -> TerminateJobObject
```

Ladder, best-effort fallback:

```
interrupt (wait <= 1 s) -> stdin EOF -> 2 s grace -> taskkill /T /F  (absolute System32 path, shell:false) -> 2 s -> TerminateProcess
```

Initial, tunable values (lead decision, to be validated by measurement): wait up to 1 s for the `interrupt` response, then EOF, then a 2 s grace, then `TerminateJobObject`. Best-effort fallback: `taskkill /T /F`, then after 2 s `TerminateProcess`.

### Linux and macOS ([ADR-0010](adr/0010-process-layer-posix.md))

Evidence: each Bash tool runs in its own process group; `SIGTERM`/`SIGINT` to the CLI cleans tool groups; `SIGKILL` to the CLI or `kill(-pgid of the CLI)` leaves bash and sleep alive (05 §10). The original A12 plan (process-group kill) is replaced.

Abort ladder (non-detached; never `kill(-pgid of the CLI)`, which is the host's own group):

```
1. interrupt {cancel_queued:true}
2. stdin EOF
3. wait 2 s  -> snapshot S1 (descendants: pid, ppid, pgid, start time); SIGTERM to the CLI only
4. wait 5 s  -> snapshot S2; SIGKILL the CLI; sweep(S1 U S2)
```

Sweep: kill only processes whose pid and start time still match the snapshot (pid+starttime guard); `kill(-pgid)` for groups led by a descendant. Linux: scan `/proc/<pid>/stat`. macOS: `/bin/ps` by absolute path with `LC_ALL=C`. POSIX reports `processContainment: 'best-effort'` in v1; host death is a documented residual. A cgroup spawner (`'cgroup'`) is planned for v1.x. `PR_SET_CHILD_SUBREAPER` is rejected (global side effect on the host process, zombie accumulation). macOS is untested until the macOS gate.

## Security model and threat model

Principle: whoever controls the CLI's stdin has the agent's full authority; the control channel is trusted by the CLI (`mcp_call` has no permission check; `update_settings` writes settings files; `apply_flag_settings` changes permissions; `read_file` reads files, 02 §10). hudhud keeps stdin private to its process and never forwards untrusted input as raw frames. Decisions: [ADR-0012](adr/0012-security-defaults-and-trust.md), [ADR-0011](adr/0011-spawn-hygiene-and-binary-provenance.md).

| Threat | Mechanism and evidence | Mitigation |
|---|---|---|
| Stdin authority | Control channel fully trusted (02 §10 item 1). | stdin private to the hudhud process; no API forwards caller frames verbatim except the unstable `/raw` tier; dangerous control subtypes never sent without explicit opt-in. |
| Untrusted workspace (project settings, hooks, MCP, instructions) | Project/local settings `env` applies at `-p` startup without any trust dialog (01 §4.2); project `.mcp.json`, hooks and skills load by default. | Default `workspaceTrust 'none'` (maps to `--setting-sources` `user` only; owner decision 1); `'context'` unsupported in v1; `'full'` is a first-class choice of the application, listed in securityPosture. |
| Project env redirects `ANTHROPIC_BASE_URL` to exfiltrate prompts and credentials | UNVERIFIED: not tested (C3, D18). A project `env` is applied without a trust dialog; the documented list of variables honoured only from user/managed settings does not include `ANTHROPIC_BASE_URL` (01 §4). | Same as above (project settings not loaded by default). In the `'context'` fallback design the audit refuses when project settings contain `env`. Spike required before relaxing. |
| Ancestor `~/.claude` leak | With cwd under the user's home, `~/.claude` is also read as a project `.claude`; skill names reached the API request; not prevented by `CLAUDE_CONFIG_DIR` or HOME redirect (05 §13.1). | `--setting-sources` always explicit, default `user` only; tests use a cwd outside the home tree. |
| Config write via control channel | `update_settings` (writes `localSettings`/`userSettings`), `apply_flag_settings`, `set_permission_mode` (bypass needs `--allow-dangerously-skip-permissions`) (02 §4.2). | `update_settings` never sent without explicit opt-in; non-session permission destinations stripped; `permission_suggestions` never auto-applied; hudhud never writes harness files (R6). |
| Implicit `auto` permission mode | Without `--permission-mode` mutating tools ran with no host callback, even with stdio prompting (05 §6). | `--permission-mode` always explicit; `auto` is a named opt-in listed in `securityPosture`. |
| Env leakage | The whole parent environment reaches the CLI and every tool and MCP server (02 §10 item 4). | Env preset `'harness'` (allowlist) by default; dropped names reported; `'inherit'` is a security-weakening opt-in, listed in securityPosture. |
| Argv injection | Dash-leading values are parsed as flags; tokenizer splits rule strings (02 §2.4). | `--flag=value` always; rule/skill strings validated; large values via `initialize` or private files. |
| `.cmd` / `.bat` (BatBadBut, CVE-2024-27980) | Windows batch spawning (02 §10 item 3). | `shell: false`; `.cmd`/`.bat` refused; prefer real `.exe`. |
| Egress | Without `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` the CLI CONNECTs to `api.anthropic.com:443`, ignoring `ANTHROPIC_BASE_URL` (05 §2). | Default disabled, pending spike G1 (if it suppresses managed policy: individual policy-neutral switches instead). Tests: variable plus CONNECT trap. |
| Binary planting / tampering | Resolution via PATH or `node_modules` is trusted by the SDKs (02 §10 item 9). | Explicit resolution, symlink resolution, advisory verification (OS signature first, hash fallback), `binary.verification` exposed. |
| Unbounded frames / memory | TS reader has no cap; Python caps at 1 MiB (02 §3); real frames reach MBs (05 §11). | 64 MiB inbound cap (configurable), outbound cap, `onOversizedFrame: 'fail'` default. |
| Slow consumer stalls control frames | One stdout pipe carries control and conversation frames (05 §6, §12). | stdout always drained; per-subscriber bounded queues; `'error'` overflow default ([ADR-0007](adr/0007-event-delivery-backpressure-timeouts.md)). |
| Untrusted text in protocol fields | `decision_reason` etc. may carry ANSI; non-JSON stdout lines exist (02 §10 item 7). | Treat as data, sanitize before rendering, skip non-JSON lines, never execute them. |
| Orphaned processes after abort or host crash | Windows and POSIX trees survive a kill (05 §10). | Job object on Windows; ladder plus sweep on POSIX; residuals documented ([ADR-0009](adr/0009-process-layer-windows.md), [ADR-0010](adr/0010-process-layer-posix.md)). |
| Credential handling | The SDK's SessionStore resume copies credentials into a temp dir (02 §10 item 5). | hudhud never copies credentials; never collects or proxies OAuth tokens ([ADR-0015](adr/0015-legal-and-provenance.md)). |
| Sticky auth failure burning time | 401 is sticky; default retries take about 3 minutes (05 §9). | `onAuthFailure: 'fail-fast'` where `apiKeySource` is `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`; session marked `poisoned` (G2). |

Out of scope for the threat model: a compromised harness binary that passes verification, a malicious host application, and kernel-level isolation (the Linux sandboxing of the command tool is the harness's feature; native Windows does not support it, 01 §7).

## Defaults table

Every default decided in the negotiation log. "securityPosture" says whether the setting is reported in the `securityPosture` diagnostic at connect. The log does not enumerate posture membership; the rule applied here is: security-relevant defaults and every security-weakening opt-in appear, operational tuning does not. Naming rule (H14): boolean opt-ins that weaken security use the `dangerously*` prefix (for example `dangerouslyAllowConfigWrites`, `dangerouslyAllowBypassPermissions`); enum values cannot carry a prefix, so security-weakening enum values are named descriptively (`env: 'inherit'`, `workspaceTrust: 'full'`, `permissionMode: 'auto'`, `nonessentialTraffic: 'harness-default'`) and are always listed in `securityPosture` ([ADR-0012](adr/0012-security-defaults-and-trust.md)).

| Default | Value | How to opt out or change | In securityPosture | ADR |
|---|---|---|---|---|
| Backend | `native` (confirmed); `agent-sdk` is available from v1.1 | `backend: 'agent-sdk'` (needs the optional peer installed by the user) | no | [0001](adr/0001-foundation-and-backends.md) |
| Config directory | user's real config dir, never-write posture | isolated `CLAUDE_CONFIG_DIR` or `--bare` (opt-in) | yes | [0012](adr/0012-security-defaults-and-trust.md) |
| Setting sources | `--setting-sources` always passed explicitly; derived from `workspaceTrust` (`'none'` gives `['user']`; owner decision 1) | `workspaceTrust`, or the Claude-Code-specific `claudeCode.settingSources`; setting both is a validation error | yes | [0012](adr/0012-security-defaults-and-trust.md) |
| Workspace trust | `'none'` (owner decision 1); `'context'` unsupported in v1 | `'full'` (maps to `['user','project','local']`; a first-class choice, security-weakening, listed in securityPosture) | yes | [0012](adr/0012-security-defaults-and-trust.md) |
| Permission mode | explicit `--permission-mode` always; value `default` (see Note 1) | choose another mode; `auto` is a descriptively named opt-in listed in securityPosture; bypass needs the boolean `dangerouslyAllowBypassPermissions` | yes | [0012](adr/0012-security-defaults-and-trust.md) |
| Permission prompting | `--permission-prompt-tool=stdio` only when a handler is supplied | supply a handler | yes | [0012](adr/0012-security-defaults-and-trust.md) |
| Settings writes | `update_settings` never sent; non-session permission destinations stripped | boolean `dangerouslyAllowConfigWrites` | yes | [0012](adr/0012-security-defaults-and-trust.md) |
| `permission_suggestions` | never auto-applied | application applies them itself | yes | [0012](adr/0012-security-defaults-and-trust.md) |
| Environment | preset `'harness'`: allowlist by rule (see Note 2); dropped names (never values) reported in diagnostics | `'inherit'` (security-weakening opt-in, listed in securityPosture), or explicit map | yes | [0012](adr/0012-security-defaults-and-trust.md) |
| Auto-update | `autoUpdate: 'disabled'` (sets `DISABLE_AUTOUPDATER=1`) | `autoUpdate: 'harness-default'` (an update can replace the binary mid-run, GH#74305) | yes (when `'harness-default'`) | [0012](adr/0012-security-defaults-and-trust.md) |
| Nonessential traffic | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, pending spike G1 | option; if G1(b) triggers, individual switches `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_BUG_COMMAND`, `DISABLE_AUTOUPDATER` instead | yes | [0012](adr/0012-security-defaults-and-trust.md) |
| Auth failure | `onAuthFailure: 'fail-fast'` only when `account.apiKeySource` in {`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`}; `apiKeyHelper` and OAuth-with-refresh behave as `'harness-retry'`; `poisoned` session | `'harness-retry'`; overridable both ways | no | [0012](adr/0012-security-defaults-and-trust.md) |
| Session id | hudhud generates a UUID and passes `--session-id` | none | no | [0008](adr/0008-turn-and-lifecycle-semantics.md) |
| `initialize` | always sent first | none | no | [0008](adr/0008-turn-and-lifecycle-semantics.md) |
| User message `uuid` | on every user message | none | no | [0008](adr/0008-turn-and-lifecycle-semantics.md) |
| Session state events | `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` | none (hudhud depends on it) | no | [0008](adr/0008-turn-and-lifecycle-semantics.md) |
| Stdin-close ceiling | `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` pinned (value pending spike) | configurable | no | [0008](adr/0008-turn-and-lifecycle-semantics.md) |
| Interrupt gating | queued until the turn's `system/init` | none | no | [0008](adr/0008-turn-and-lifecycle-semantics.md) |
| First-frame watchdog | armed on `initialize` write; 60 s (initial, tunable; MCP startup can take up to `MCP_TIMEOUT` 30 s); named failure causes | configurable | no | [0008](adr/0008-turn-and-lifecycle-semantics.md) |
| Idle watchdog | emits `stalled` after 300 s without frames while a turn is running (initial, tunable); never kills by default | configurable | no | [0008](adr/0008-turn-and-lifecycle-semantics.md) |
| Exit code semantics | never infers success from exit code; `4294967295` maps to `unknown` | none | no | [0008](adr/0008-turn-and-lifecycle-semantics.md) |
| Stop | `close()` = drain; `dispose` / `AbortSignal` = abort ladder | caller chooses | no | [0008](adr/0008-turn-and-lifecycle-semantics.md) |
| Inbound frame cap | 64 MiB per line | `maxFrameBytes` (illustrative name) | no | [0011](adr/0011-spawn-hygiene-and-binary-provenance.md) |
| Oversized frame | `onOversizedFrame: 'fail'` (session fails with a protocol error) | `'skip'` | no | [0011](adr/0011-spawn-hygiene-and-binary-provenance.md) |
| Outbound frame cap | 32 MiB (initial, tunable; Messages API request-size ceiling class) | configurable | no | [0011](adr/0011-spawn-hygiene-and-binary-provenance.md) |
| Spawn | `shell:false`, `windowsHide:true`, non-detached, `--flag=value`, `.cmd`/`.bat` refused | no opt-out | no | [0011](adr/0011-spawn-hygiene-and-binary-provenance.md) |
| Binary provenance | advisory, OS signature first, hash fallback; `binary.verification` exposed; never blocking | strict mode (opt-in, name not fixed) | yes | [0011](adr/0011-spawn-hygiene-and-binary-provenance.md) |
| Process containment | Windows `'job'` (addon) else `'best-effort'`; POSIX `'best-effort'` | `'cgroup'` later (v1.x) | yes (capability) | [0009](adr/0009-process-layer-windows.md), [0010](adr/0010-process-layer-posix.md) |
| Subscriber overflow | `'error'`, scoped to that subscriber; per-subscriber queue 10,000 events or 64 MiB, whichever first (initial, tunable) | `'drop-oldest-with-gap-marker'`; `'block'` (plain name; can stall control frames) | no | [0007](adr/0007-event-delivery-backpressure-timeouts.md) |
| Permission handler timeout | none; always cancellable; pending resolve `cancelled` on close | application-side timeouts | no | [0007](adr/0007-event-delivery-backpressure-timeouts.md) |
| Hook / tool handler timeout (v1.1) | declared timeout 60 s (initial, tunable); hudhud's handler timer = declared timeout minus 2 s margin (E9); fail-closed for `PreToolUse` / `PermissionRequest`, continue for informational events | configure the single timeout value | no | [0007](adr/0007-event-delivery-backpressure-timeouts.md) |
| Diagnostics | redaction mandatory | no opt-out | no | [0016](adr/0016-observability.md) |
| Trace propagation | off | opt-in `TRACEPARENT` | no | [0016](adr/0016-observability.md) |
| Entrypoint identity | honest default of stream-json mode (`sdk-cli`); no spoofing | none | no | [0001](adr/0001-foundation-and-backends.md) |
| Live test suite | none | deferred: no credential exists yet (owner decision 2) | no | [0013](adr/0013-testing-strategy.md) |

Note 1: the log requires an explicit `--permission-mode` and makes `auto` a named opt-in. The default value `default` is confirmed by the lead (it is also the mode used in every spike scenario, in which mutating commands are not silently executed, 05 §6).

Note 2: the `'harness'` environment preset is an allowlist defined by rule; the exact list is finalized in implementation with tests. Allowed: OS essentials (Windows: `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `PATHEXT`, `SystemDrive`, `PATH`, `TEMP`/`TMP`, `USERPROFILE`, `HOMEDRIVE`/`HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`, `ProgramFiles*`; POSIX: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, `TERM`, `XDG_*`); `CLAUDE_*` and `ANTHROPIC_*`; proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` in both cases, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`); provider families only when the matching `CLAUDE_CODE_USE_*` is set (Bedrock: `AWS_*`; Vertex: `GOOGLE_*`, `CLOUD_ML_*`; Foundry: `AZURE_*`, `ANTHROPIC_FOUNDRY_*`). Never inherited by default: `NODE_OPTIONS`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_AGENT_SDK_*`.

## Capability model

Capabilities are declared by the adapter at connect and gate every optional feature. Values are tri-state `supported | emulated | unsupported`, with a degraded reason where applicable (03 §5 item 5; `emulated` and `unsupported` are used in the log for workspace trust and one-shot). Feature detection uses `system/init.capabilities` and `initialize` response data, not version sniffing; the adapter additionally reports a tested window (`minTested`, `maxTested`, `knownBroken`) in a `compat` event ([ADR-0004](adr/0004-packages-and-versioning.md)).

| Capability | Values | Notes |
|---|---|---|
| `processContainment` | `'job'` \| `'best-effort'` \| later `'cgroup'` | Windows job requires the addon ([ADR-0009](adr/0009-process-layer-windows.md)); POSIX best-effort in v1 ([ADR-0010](adr/0010-process-layer-posix.md)) |
| `workspaceTrust.context` | `supported` \| `emulated` \| `unsupported` | `unsupported` in v1; native only if `initialize.workspaceTrust` is confirmed by a spike; otherwise the fail-closed audit is `emulated` |
| `multiTurn` | `supported` \| `emulated` | one-shot Sessions: `emulated` via `--resume` ([ADR-0002](adr/0002-execution-modes-and-every-way-registry.md)) |
| `resume`, `fork` | gated on the resume/fork spike | |
| Harness feature strings | from `system/init.capabilities` | for example `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `msg_lifecycle_v1` (05 §5) |
| `binary.verification` | `verified` \| `unverified` \| `failed` | advisory ([ADR-0011](adr/0011-spawn-hygiene-and-binary-provenance.md)) |

"First-class" is operational: a capability is declared only if it has fixtures, canary coverage and documentation ([ADR-0002](adr/0002-execution-modes-and-every-way-registry.md)). The application can also declare what it can handle (for example whether a permission handler is supplied).

## Versioning

Library semver per package; a wire-schema integer plus capability strings; an integer `adapterApiVersion` negotiated at adapter registration; per-adapter `minTested` / `maxTested` / `knownBroken` emitted as a `compat` event; the `/raw` tier is exempt. Additive-only schema evolution is enforced by a diff linter on the committed JSON Schema. Standing duty: changelog triage on every CLI release. The umbrella package has exact-version dependencies and no logic. Decisions: [ADR-0004](adr/0004-packages-and-versioning.md), [ADR-0005](adr/0005-schema-and-validation.md).

Schema and validation: TypeBox authoring (build time only, major pinned, documented fallback `json-schema-to-typescript`), committed JSON Schema 2020-12, Ajv standalone precompiled validators with runtime helpers bundled by esbuild, a CI check that `dist` contains no `ajv` import, a tarball-install check, open enums, `x-` experimental namespace ([ADR-0005](adr/0005-schema-and-validation.md)).

Toolchain: pnpm (install scripts blocked, `onlyBuiltDependencies` allowlist, `minimumReleaseAge`, catalogs), Node `>=22.12.0`, CI on 22/24/26, ESM-only, Changesets, API Extractor ([ADR-0017](adr/0017-toolchain.md)).

## Testing strategy

Detail: [ADR-0013](adr/0013-testing-strategy.md).

- In-process Node mock API on `127.0.0.1` on all three OS runners; Docker only for local Linux runs.
- CONNECT trap in the mock plus `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` on every test run; fake key only; cwd outside the home tree; native-filesystem `TMPDIR`.
- Request-shape structural snapshots (fail on semantic change, warn on additive, normalized); endpoint allowlist.
- Hand-authored responses typed and validated against `@anthropic-ai/sdk` types (or a published spec); pluggable response provider; scenario matching on user-message markers only; the mock never assumes the last message is `user`.
- Degradation-signal assertions classify a red canary as `mock-inadequate` or `protocol-regressed`.
- Pinned, hash-verified CLI; golden JSONL fixtures; SDK differential oracle (from v1.1); canary against `latest` / `stable` / pinned with auto-bump PRs; fast-check; Windows CI mandatory.
- Opt-in live suite only with an owner-provided dedicated credential; deferred, none exists yet (owner decision 2).

## CI

Detail: [ADR-0014](adr/0014-ci-strategy.md). Tiers decided by a unit-tested default-FULL classifier: LIGHT (docs only), STANDARD (one Linux job), FULL (Linux, then Windows and macOS). The only required check is the `ci-gate` job. macOS runs on the FULL tier only; a one-off macOS `workflow_dispatch` spike runs before v1; nightly full runs happen when main changed or a new CLI version was published, gated by a cheap Linux registry check (G3). Billing multipliers (1/2/10) and merge-queue availability are UNVERIFIED (04 §1, §2).

## Scope: v1, v1.1, later

Detail: [ADR-0018](adr/0018-scope-and-roadmap.md).

| Release | Content |
|---|---|
| v1 | native backend only; spawn/handshake, send/stream, permissions, interrupt, resume/fork (gated on its spike), shutdown, capabilities, errors, subscriptions, best-effort containment; Windows job addon (1.0 criterion) |
| v1.1 | `agent-sdk` backend and the SDK differential oracle; hooks; in-process tools (minimal MCP subset over `mcp_message`, pluggable full server); one-shot |
| Later | session-file reading, prewarm, daemon with generated clients, ACP client adapter, ACP facade; cgroup spawner (planned v1.x) |

## Pre-v1 spike list (G4)

Accepted decisions that wait on these results ([ADR-0018](adr/0018-scope-and-roadmap.md)):

1. `--resume` / `--fork-session` matrix.
2. Host-crash EOF/EPIPE behaviour.
3. E7 gate: effect of `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (features that change; whether it suppresses org-managed policy fetch; if so, individual policy-neutral switches each verified).
4. `initialize.pid` versus spawned pid with a native launcher.
5. Concurrent sessions sharing a config directory.
6. Windows long-path cwd.
7. `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` pinned.
8. Hook timeout unit and default (E9).

Gates stated elsewhere in the log: the Windows job addon (A13; mostly de-risked by 05 §10, remaining: implementation and arm64 prebuild pipeline); `initialize.workspaceTrust` (B4); project-env `ANTHROPIC_BASE_URL` (C3, never tested); and, before v1.1, `mcp_message` in-process MCP, hooks over stdio and `--output-format json` (not covered by 05 §16).

## macOS gate list

Ratified by the lead (from the final negotiation round, part 1). Required before v1, via the one-off `workflow_dispatch` macOS spike (G3):

1. Binary provenance: darwin-arm64 and darwin-x64 hashes against npm integrity and `manifest.json`; `/usr/bin/codesign --verify` as the OS-signature-first path; a Gatekeeper/quarantine spawn failure is mapped to a named cause.
2. Process tree: Bash tools in their own process groups as on Linux; SIGTERM cleans them; SIGINT exits 0 without a `result`; the `/bin/ps` sweep with `LC_ALL=C` and start-time verification works end to end.
3. Keychain: with API-key auth and an isolated `CLAUDE_CONFIG_DIR`, confirm there is NO Keychain access headless (a GUI prompt would hang forever; the first-frame watchdog must name this cause).
4. zsh login-shell snapshot hang (GH#78903) on a default macOS runner leads to the idle-watchdog `stalled` path.
5. Socket path: `$TMPDIR` is `/var/folders/.../T/`; confirm `cc-socks/<pid>.sock` stays under the 104-byte `sun_path` limit for hudhud's isolated temp dirs, and test the fallback.
6. Path identity: `/tmp` is `/private/tmp` and APFS may be case-insensitive; hudhud passes a realpath'd cwd consistently, otherwise resume breaks.
7. CI: darwin-arm64 is a mandatory runner; darwin-x64 is declared in `maxTested` only when it has run.

See [ADR-0014](adr/0014-ci-strategy.md#macos-gate-list).

## Owner decisions

Decided by the owner on 2026-10-12.

1. **Workspace trust: both ways are first-class.** The application (and through it the user who installed it) is responsible for what it runs, so loading project configuration is a supported, documented choice, not a discouraged one: `workspaceTrust: 'full'` loads project and local settings, hooks, MCP servers and env; `'none'` loads none of them. The library default stays `'none'` under rule R2 (the default is the safest way); `'full'` is one option away and is reported in `securityPosture` like every other non-default security setting. ([ADR-0012](adr/0012-security-defaults-and-trust.md))
2. **Live test credential: none for now.** No test calls the real API; the opt-in live suite is deferred until the owner provides a dedicated low-limit credential. ([ADR-0013](adr/0013-testing-strategy.md))
3. **npm names: the owner reserves `@hudhud` and `hudhud` later**, before the first publish. Until then the names are working names; nothing is published. Risk accepted: a third party could take a name in the meantime; the package names are confined to `package.json` files and the docs, so a rename is mechanical. ([ADR-0004](adr/0004-packages-and-versioning.md))
4. **Legal review: done.** The owner confirmed the legal review; the engineering policy in ADR-0015 stays binding. ([ADR-0015](adr/0015-legal-and-provenance.md))
