# ADR-0012: Security defaults, workspace trust and opt-in naming

- Status: Accepted, with two parts pending:
  - Accepted, pending spike G1: the default for `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (Decision 5).
  - Owner decision 1 (2026-10-12): both `'none'` and `'full'` are first-class choices; the default is `'none'` (maps to `--setting-sources` `user` only).
- Date: 2026-10-12
- Negotiation log items: A8, A9, B4, B5, E7, G1, G2, D3, D4, D12-D15, D17 (06 §A, §B, §C, §D, §E, §F, §G)
- Related: [ADR-0008](0008-turn-and-lifecycle-semantics.md), [ADR-0011](0011-spawn-hygiene-and-binary-provenance.md), [ADR-0013](0013-testing-strategy.md); threat model in [architecture.md](../architecture.md#security-model-and-threat-model); defaults table in [architecture.md](../architecture.md#defaults-table)

## Context

Facts that drive this ADR:

- Whoever controls the CLI's stdin has the agent's full authority: `mcp_call` performs no permission check, `update_settings` writes settings files, `apply_flag_settings` can change permissions mid-session, `read_file` reads files (02 §10 item 1).
- Without `--permission-mode`, the session starts in `auto`: mutating Bash commands ran with no `can_use_tool`, even with `--permission-prompt-tool=stdio` (D4, 05 §6). In `default` mode without the stdio prompt tool, mutating commands are auto-denied by the CLI (D3).
- `can_use_tool` is sent only with `--permission-prompt-tool=stdio`; an unanswered request waits forever; there is no CLI-side timeout (05 §6).
- Project/local settings `env` applies at `-p` startup without any trust dialog (01 §4.2). Whether a project `env` can set `ANTHROPIC_BASE_URL` (and so redirect requests and credentials) has NOT been tested (C3, D18; not covered by 05). Treat as a plausible exfiltration path until verified.
- The ancestor leak: with cwd under the user's home, `~/.claude` is also treated as a project `.claude` (skill names reached the API request), even with `CLAUDE_CONFIG_DIR` and HOME redirected. `--setting-sources=user` or empty, `--bare`, or a cwd with no such ancestor prevents it (D13, 05 §13.1).
- Without `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` the CLI opens CONNECT tunnels to `api.anthropic.com:443` directly, ignoring `ANTHROPIC_BASE_URL`; with it, only `POST /v1/messages?beta=true` was observed (D14, 05 §2).
- A 401 is sticky for the whole session; default retries run about 170-184 s before the error result; the 529 cap is 3 attempts regardless of `CLAUDE_CODE_MAX_RETRIES` (D15, 05 §9).
- `permission_suggestions` differ by OS (Linux `subcommandResults`; Windows `blocked_path`, `addDirectories`, `setMode`) (D17, 05 §14).
- Native installs auto-update in the background (01 §4.1).
- By default the entire parent environment, including unrelated secrets, reaches the CLI and every tool it runs (02 §10 item 4).

## Decision

### 1. Config posture (A8)

hudhud uses the user's real config directory with a never-write posture (R6). hudhud never deletes or edits `~/.claude.json`, `settings.json`, `.credentials.json`, plugins, transcripts, or any other file listed in 01 §4.3. An isolated `CLAUDE_CONFIG_DIR` and `--bare` are opt-in only. hudhud never copies credentials into temporary directories (contrast with the SDK's SessionStore resume, 02 §10 item 5).

### 2. Setting sources and workspace trust (A9, B4, F)

`--setting-sources` is always passed explicitly. `settingSources` is a Claude-Code-specific mechanism, so it lives in the harness-namespaced tier as `claudeCode.settingSources`. `workspaceTrust` is the harness-neutral knob and maps to it. Setting both `workspaceTrust` and `claudeCode.settingSources` is a validation error (no silent precedence). `workspaceTrust` is an ordered enum:

| Value | Meaning | `--setting-sources` | Support in v1 |
|---|---|---|---|
| `'none'` (default) | The workspace is not trusted: no project or local configuration is loaded | `['user']` | supported |
| `'context'` | Workspace context is used but executable workspace configuration (hooks, MCP servers, `env`) is not [derived from the B4 fallback design] | n/a | unsupported in v1 (F); capability-gated |
| `'full'` | Workspace configuration is trusted; security-weakening opt-in, listed in securityPosture | `['user','project','local']` | supported |

`'none'` (`--setting-sources` `user` only) also neutralizes the ancestor leak for real users whose projects live under `~` (D13).

Owner decision 1: the application, and through it the user who installed it, is responsible for what it runs. Loading the workspace configuration (`'full'`) is therefore a first-class, documented choice, not a discouraged one; it is one option away and appears in `securityPosture` only because every non-default security setting does. The default stays `'none'` because the default is the safest way (R2).

`'context'` (B4, round 3 and F): if the spike on `initialize.workspaceTrust` (an undocumented field the TS SDK sends, 02 §4.2) confirms native support, it will be `supported` natively. Otherwise the fallback is a fail-closed audit reported as `emulated`: the audit walks parent directories, covers `settings.local.json` and `.mcp.json`, refuses if project settings contain `env`, and is combined with `--strict-mcp-config` and `disableAllHooks`. No CLAUDE.md emulation by injecting text through `appendSystemPrompt` (rejected). F states that `'context'` is `unsupported` in v1.

### 3. Permission mode and prompting (A8, D3, D4)

- `--permission-mode` is always passed explicitly. The `auto` mode is never reached by omission; selecting it is a descriptively named enum opt-in and appears in `securityPosture`. The default is `default` (confirmed).
- `--permission-prompt-tool=stdio` is passed only when the application supplies a permission handler.
- Non-session permission destinations (`localSettings`, `userSettings`, and any other destination that writes to disk) are stripped from permission responses, and `update_settings` is never sent unless the application explicitly opts in.
- `permission_suggestions` are never applied automatically. Their shape is never hard-coded (D17); they are passed through as data.

### 4. Environment (A8)

Environment preset: `'harness'` (default), `'inherit'`, or an explicit map. Variables dropped by the preset are reported as diagnostics by name (never by value). `'inherit'` is a security-weakening opt-in, listed in `securityPosture`. The `'harness'` preset is an allowlist defined by rule; the exact list is finalized in implementation with tests. Allowed: OS essentials (Windows: `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `PATHEXT`, `SystemDrive`, `PATH`, `TEMP`/`TMP`, `USERPROFILE`, `HOMEDRIVE`/`HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`, `ProgramFiles*`; POSIX: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, `TERM`, `XDG_*`); `CLAUDE_*` and `ANTHROPIC_*`; proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` in both cases, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`); provider families only when the matching `CLAUDE_CODE_USE_*` is set (Bedrock: `AWS_*`; Vertex: `GOOGLE_*`, `CLOUD_ML_*`; Foundry: `AZURE_*`, `ANTHROPIC_FOUNDRY_*`). Never inherited by default: `NODE_OPTIONS`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_AGENT_SDK_*`. The sandbox environment of the spike (05 §3) was the starting reference. Always-set variables (unless the opt-in below is used): `DISABLE_AUTOUPDATER=1` via `autoUpdate: 'disabled'` (A8; avoids version-directory races and mid-run replacement, 01 §4.1), `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` ([ADR-0008](0008-turn-and-lifecycle-semantics.md)). Option `autoUpdate: 'disabled' | 'harness-default'` (H16; R2 requires every way) defaults to `'disabled'`; `'harness-default'` is listed in `securityPosture` because an update can replace the binary mid-run (GH#74305, 01 §7). hudhud does not set or alter the entrypoint identity ([ADR-0001](0001-foundation-and-backends.md)).

### 5. Egress and nonessential traffic (E7, G1)

Decision (G overrides E7): the default is `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, an option named in the API, reported in `securityPosture`. Reasons given in the log: ship what you test, determinism, and the fact that the CLI otherwise bypasses `ANTHROPIC_BASE_URL`. The default is gated on a spike:

- (a) list the features that change or disappear when the variable is set;
- (b) if the variable suppresses the fetch of organization-managed policy, do NOT set it by default. Instead set the policy-neutral switches individually (`DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_BUG_COMMAND`, `DISABLE_AUTOUPDATER`), each verified.

Interim rule (lead): no release happens before the G1 gate; the decision is made by the gate, so there is no shipped interim default. The earlier lead position (E7: do not set by default for real users, to respect the user's harness behaviour) was overridden in F/G, and the lead accepted the override.

Tests always set the variable and run an egress trap ([ADR-0013](0013-testing-strategy.md)).

### 6. Authentication failure (G2)

Option `onAuthFailure`: `'fail-fast'` (default) or `'harness-retry'`. hudhud does not override `CLAUDE_CODE_MAX_RETRIES` for this.

- `'fail-fast'` applies only when `account.apiKeySource` from the `initialize` response is `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`.
- `apiKeyHelper` and OAuth with refresh behave as `'harness-retry'`, because a retry can legitimately succeed after a token refresh.
- On fail-fast, the session is marked `poisoned` and a typed error tells the caller to recreate the session (the 401 is sticky, D15). The option is overridable in both directions.
- The detection trigger for fail-fast (for example the first `system/api_retry` with `authentication_failed`) is not specified in the log; it must be fixed in implementation using the observed frames (05 §9).
- `system/api_retry` events are surfaced to the application.

### 7. Opt-in naming and `securityPosture` (B5)

Naming rule (B5, refined by H14). BOOLEAN opt-ins that weaken a security default use the `dangerously` prefix (for example `dangerouslyAllowConfigWrites` for sending `update_settings`, `dangerouslyAllowBypassPermissions`). ENUM values cannot carry a prefix, so security-weakening enum values are named descriptively (`env: 'inherit'`, `workspaceTrust: 'full'`, `permissionMode: 'auto'`, `nonessentialTraffic: 'harness-default'`, `autoUpdate: 'harness-default'`) and are ALWAYS listed in `securityPosture`. The exact final names are decided with the API. `Harness` exposes a `securityPosture` diagnostic at connect listing every security-relevant setting with its effective value and whether it deviates from the default. The rule: no weakened default is silent. Confirmed: Fable explicitly agreed in the final round, part 1 ("dangerously* for opt-ins that weaken security, plus securityPosture at connect"). Backpressure `'block'` is a correctness hazard, not a security weakening, and keeps a plain name ([ADR-0007](0007-event-delivery-backpressure-timeouts.md)).

### 8. Untrusted text and frames

Text fields from the harness (`decision_reason`, `matched_ask_rule`, plugin metadata, model output, tool results) are treated as untrusted data. Fields documented as possibly containing ANSI escapes are sanitized before display by hudhud's own renderers (02 §10 item 7). No public API forwards caller-supplied raw frames to the CLI; arbitrary control frames are only reachable through the unstable `/raw` tier ([ADR-0003](0003-public-api.md)), and the control channel is never exposed to untrusted input.

## Alternatives considered

- Default setting sources `user,project,local`, as the CLI does. Rejected: executes workspace-provided hooks, MCP servers, env and instructions from untrusted repositories (see threat model); also leaks the ancestor `~/.claude` (D13).
- `--bare` as the default. Rejected: changes harness behaviour (skips hooks, skills, plugins, auth via keychain) and is documented to become the default of `-p` in a future release; hudhud insulates from silent default churn by passing flags explicitly (03 §1.1). Kept opt-in.
- Isolated `CLAUDE_CONFIG_DIR` as default. Rejected: the user expects their own login and settings; the isolated directory is a test and sandbox recipe, opt-in (05 §13.2).
- Leaving `--permission-mode` to the CLI's default. Rejected: `auto` runs mutating tools with no host callback (D4).
- Always passing `--permission-prompt-tool=stdio`. Rejected: without a handler the CLI would wait forever on unanswered requests (05 §6).
- `block-as-default` backpressure: see [ADR-0007](0007-event-delivery-backpressure-timeouts.md).
- Overriding `CLAUDE_CODE_MAX_RETRIES` to fail fast. Rejected in F in favour of `onAuthFailure`: it also affects 5xx/429 behaviour, while the 529 cap is independent of it anyway (05 §9).
- Uniform `'fail-fast'` regardless of key source. Rejected (G2): `apiKeyHelper` and OAuth refresh can succeed on retry.
- Emulating workspace context by reading CLAUDE.md and injecting it (B4 option iii). Rejected: Fable contradicted itself on it; resolved as no CLAUDE.md emulation.
- Descriptive names only, with no `dangerously` prefix (B5). Not chosen for boolean opt-ins: the prefix makes unsafe call sites greppable in application code. It cannot apply to enum values, which are named descriptively and always appear in `securityPosture` (H14).
- Setting `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` unconditionally. Not chosen: spike G1 must first show it does not suppress managed policy.

## Consequences

- Applications that want project-level configuration choose `workspaceTrust: 'full'`; it is a single documented option.
- Because `'harness'` env is an allowlist, tools that rely on inherited variables fail until the application adds them; dropped-name diagnostics make this visible.
- Test and production configurations are aligned on egress (the variable is set in both) once G1 completes.
- `securityPosture` becomes API surface that must be kept additive ([ADR-0005](0005-schema-and-validation.md)).

## Evidence

- 02 §10 (security observations), §4.2 (`update_settings`, `apply_flag_settings`, `mcp_call`, `read_file`).
- 05 §6 (permissions, auto mode), §9 (auth failures, retries), §2 (egress), §13.1 (ancestor leak), §13.2 (sandbox recipe), §14 (OS differences), §15.
- 01 §1.3 (permission flags), §4 (state and config), §4.3 (what a controller must not write), §1.1 (`--bare`).
