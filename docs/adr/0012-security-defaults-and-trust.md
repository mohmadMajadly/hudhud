# ADR-0012: Security defaults, workspace trust and opt-in naming

- Status: Accepted. Spikes G1, C3 and the `initialize.workspaceTrust` check are done (07 §3, §9, §10; 06 §J). Owner decision 1 (2026-10-12): both `'none'` and `'full'` are first-class choices; the default is `'none'` (maps to `--setting-sources` `user` only).
- Date: 2026-10-12
- Negotiation log items: A8, A9, B4, B5, E7, G1, G2, D3, D4, D12-D15, D17 (06 §A, §B, §C, §D, §E, §F, §G)
- Related: [ADR-0008](0008-turn-and-lifecycle-semantics.md), [ADR-0011](0011-spawn-hygiene-and-binary-provenance.md), [ADR-0013](0013-testing-strategy.md); threat model in [architecture.md](../architecture.md#security-model-and-threat-model); defaults table in [architecture.md](../architecture.md#defaults-table)

## Context

Facts that drive this ADR:

- Whoever controls the CLI's stdin has the agent's full authority: `mcp_call` performs no permission check, `update_settings` writes settings files, `apply_flag_settings` can change permissions mid-session, `read_file` reads files (02 §10 item 1).
- Without `--permission-mode`, the session starts in `auto`: mutating Bash commands ran with no `can_use_tool`, even with `--permission-prompt-tool=stdio` (D4, 05 §6). In `default` mode without the stdio prompt tool, mutating commands are auto-denied by the CLI (D3).
- `can_use_tool` is sent only with `--permission-prompt-tool=stdio`; an unanswered request waits forever; there is no CLI-side timeout (05 §6).
- Project/local settings `env` applies at `-p` startup without any trust dialog (01 §4.2). VERIFIED (C3, 07 §9): a project or local `env.ANTHROPIC_BASE_URL` redirects all model traffic, with the host's `x-api-key`, to any host; it overrides a base URL the host set; a project `env.ANTHROPIC_API_KEY` replaces the credential; `initialize.account.apiKeySource` does not reveal either. `--setting-sources=user` blocks it; omitting the flag does not (07 §9 p5).
- `initialize.workspaceTrust` is a persisted trust grant, not a loading filter (07 §10): it writes `projects[<dir>].hasTrustDialogAccepted` to the user's `.claude.json` and widens project permission rules, while CLAUDE.md, project hooks, project MCP servers and project `env` load without any trust as soon as `--setting-sources` includes `project`/`local`. Untrusted project `permissions.allow` entries are ignored with a stderr notice.
- The ancestor leak: with cwd under the user's home, `~/.claude` is also treated as a project `.claude` for skills, CLAUDE.md and `.mcp.json`, not for settings files (L2, 08); skill names reached the API request, even with `CLAUDE_CONFIG_DIR` and HOME redirected. `--setting-sources=user` or empty, `--bare`, or a cwd with no such ancestor prevents it (D13, 05 §13.1).
- Without `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` the CLI opens CONNECT tunnels to `api.anthropic.com:443` directly, ignoring `ANTHROPIC_BASE_URL`; with it, only `POST /v1/messages?beta=true` was observed (D14, 05 §2).
- A 401 is sticky for the whole session; default retries run about 170-184 s before the error result; the 529 cap is 3 attempts regardless of `CLAUDE_CODE_MAX_RETRIES` (D15, 05 §9).
- `permission_suggestions` differ by OS (Linux `subcommandResults`; Windows `blocked_path`, `addDirectories`, `setMode`) (D17, 05 §14).
- Native installs auto-update in the background (01 §4.1).
- By default the entire parent environment, including unrelated secrets, reaches the CLI and every tool it runs (02 §10 item 4).
- Harness fact (macOS gate run 1, research 09; lead decision recorded by W3-Z): the pinned CLI calls `security(1)` on the user's login keychain even when `ANTHROPIC_API_KEY` is set. For a real user this is the harness's own behaviour on the user's own keychain; hudhud neither causes nor blocks it, and documents it in the threat model (a session on macOS may touch the login keychain). No hudhud variable isolates the keychain; isolation is possible only if the `CFFIXED_USER_HOME` probe of the next gate run proves it. For tests, real-CLI suites (integration, fixture recordings, the gate) run on GitHub-hosted runners only and are refused on a local macOS host unless `HUDHUD_ALLOW_LOCAL_MACOS_REAL_CLI=1` is set ([ADR-0013](0013-testing-strategy.md)).

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

`'context'` (B4, round 3, F, J3): the spike on `initialize.workspaceTrust` (an undocumented field the TS SDK sends, 02 §4.2) ruled out a native path: the field is a persisted trust grant, not a loading filter (07 §10). `'context'` is therefore `unsupported` in v1. Only the fail-closed audit, reported as `emulated`, remains possible later: the audit walks parent directories, covers `settings.local.json` and `.mcp.json`, refuses if project settings contain `env`, and is combined with `--strict-mcp-config` and `disableAllHooks`. No CLAUDE.md emulation by injecting text through `appendSystemPrompt` (rejected).

The CLI field `initialize.workspaceTrust` (J3, 07 §10): hudhud NEVER sends it by default, because it writes to the user's real config (R6) and widens permissions for this and future sessions, including interactive ones. Exposing the grant is deferred to v1.x as a separate boolean with a `dangerously*` name, listed in `securityPosture`, and never part of `'full'`. The CLI ignores untrusted project `permissions.allow` entries with a stderr notice; hudhud surfaces that notice as a diagnostic.

#### `'full'` and the project credential guard (J2, 07 §9)

Documentation of `'full'` must state plainly: project hooks, MCP servers and `env` run without any trust dialog, and without the guard the repository could redirect API traffic and credentials.

The option `projectCredentialEnv: 'refuse' | 'allow'` defaults to `'refuse'` and applies whenever the effective setting sources include `project` or `local`, whether they come from `workspaceTrust: 'full'` or from `claudeCode.settingSources` (K5, 06 §K). Before spawn hudhud reads `.claude/settings.json` and `.claude/settings.local.json` in the cwd, in the nearest git root and in the main worktree root (a `.git` file is followed through gitdir/commondir), and fails with a typed error if their `env` sets any credential, routing, interception or TLS-trust variable (the rule below), in any case; or if the top-level `apiKeyHelper` is set.

The refused names (review R1-1, amending the first-party list of W3 and the lead ruling on W3-T3) are defined by family, not by an exact list, so that a variable a newer CLI adds to a family is refused without a change in hudhud:

1. Provider and API families, refused whole: `ANTHROPIC_*`, `AWS_*`, `GOOGLE_*`, `GCLOUD_*`, `CLOUDSDK_*`, `CLOUD_ML_*`, `VERTEX_*`, `AZURE_*`, `CCR_*` and `CLAUDE_CODE_USE_*`. The one allowlist is model selection: `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_MODEL`, `ANTHROPIC_DEFAULT_<FAMILY>_MODEL` and `ANTHROPIC_CUSTOM_MODEL_OPTION`, each with its `_NAME`, `_DESCRIPTION` and `_SUPPORTED_CAPABILITIES` companions. These name a model, never a host or a credential; the top-level `model` setting, which the guard does not read, selects a model the same way.
2. In the CLI's own namespace, `CLAUDE_*`, every name with a credential, routing or configuration-location segment: `TOKEN`, `KEY`, `SECRET`, `PASSWORD`, `PASSPHRASE`, `CRED`, `CREDS`, `CREDENTIAL(S)`, `AUTH`, `OAUTH`, `AUTHENTICATE`, `AUTHORIZATION`, `BEARER`, `CERT`, `URL`, `URI`, `HOST(S)`, `ENDPOINT`, `SOCKET`, `GATEWAY`, `PORT`, `REGION`, `HEADER(S)`, `CONFIG`, `SETTINGS` (whole segments: `CLAUDE_CODE_MAX_OUTPUT_TOKENS` passes).
3. Proxies: any name with a `PROXY` segment, except the `NO_PROXY` forms, which only narrow proxying.
4. TLS trust: any name with an `SSL`, `TLS`, `CA`, `CERT`, `CERTS`, `CAINFO` or `CAPATH` segment, and `SSLKEYLOGFILE`.

Why families. The first list named only the first-party set. The pinned CLI (static reading of the 2.1.296 bytes, never executed; review R1-1) also builds provider hosts by interpolating environment strings into the host part of a URL: `https://${CLOUD_ML_REGION}-aiplatform.googleapis.com/v1` (and the per-model `VERTEX_REGION_CLAUDE_*` overrides), `https://bedrock-runtime.${AWS_REGION}.amazonaws.com`, `https://${ANTHROPIC_FOUNDRY_RESOURCE}.services.ai.azure.com/anthropic/`; and it takes credentials from `AWS_BEARER_TOKEN_BEDROCK`, `CLAUDE_CODE_OAUTH_TOKEN` and the provider SDKs' own variables. The CLI's own project-scope env filter strips none of them. A project `CLOUD_ML_REGION` of `evil.example/x?` therefore sends every request, with the Google access token and the prompt, to `evil.example`: the C3 redirect for a third-party provider. Each provider family both routes and authenticates, and the CLI's 2.1.296 strings name more than 900 `CLAUDE_*` variables and dozens per provider family, with new ones in most releases; an exact list goes stale with each release and fails open. A family rule fails closed: a new provider variable is refused until someone decides otherwise. The cost is that a repository setting an unrelated variable of a refused family (an `AWS_PROFILE` for its own scripts) is refused too; `projectCredentialEnv: 'allow'`, or the application setting the variable itself through `env.add`, lifts it. Rule 2 is a segment rule rather than a family rule because the `CLAUDE_*` namespace mostly holds ordinary settings (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_DISABLE_*`) that repositories legitimately commit; the segments catch every credential, endpoint and configuration-location variable among the 2.1.296 names (`CLAUDE_CODE_API_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_SKIP_*_AUTH`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_MANAGED_SETTINGS_PATH`) and a few harmless ones (`CLAUDE_CODE_API_KEY_HELPER_TTL_MS`), which refuse safely. Not covered: variables outside these families that change what the CLI sends rather than where (`OTEL_*` telemetry exporters, model ids, which can steer a request path within the provider's own host); under `'full'` the repository can run code anyway (see Consequences). The names the guard refuses are also listed in `securityPosture` when an application sets them explicitly, so the two lists cannot drift apart.

The ancestor fallback never reads the user's config directory (`claudeCode.configDir`, else `CLAUDE_CONFIG_DIR`, else `~/.claude`, compared by physical path): its settings are user settings; it is reported as skipped, and an unresolvable config directory skips nothing (fail closed). Unparseable files refuse (fail closed). The scan set is narrowed by the Wave-0 spike (L1, 08): the CLI reads project `settings.json` only from the cwd and `settings.local.json` from the cwd and, on POSIX, the canonical git root; ancestors, outer repos and `--add-dir` `env` are never applied, so they are not scanned. hudhud scans the git roots on every OS (harmless on Windows). If the git root cannot be resolved the guard falls back to the cwd and every ancestor and reports a diagnostic. The narrowing is tied to the tested CLI version: the newest-version canary re-runs the lookup check and fails on any new location. `--add-dir` settings files are read by the CLI for plugin and marketplace entries (never `env`); plugins can carry hooks and MCP servers, an open item for the plugin posture that this guard does not cover (L3). hudhud never passes the undocumented `--project-config-root` flag, and `/raw` rejects it (L4). The check is best-effort: the files can change between the check and the CLI's read (TOCTOU), and this is documented. `'allow'` is security-weakening and always listed in `securityPosture`. `apiKeySource` cannot be used for detection (07 §9 p7). `--setting-sources` is always passed; omitting it loads project and local settings.

### 3. Permission mode and prompting (A8, D3, D4)

- `--permission-mode` is always passed explicitly. The `auto` mode is never reached by omission; selecting it is a descriptively named enum opt-in and appears in `securityPosture`. The default is `default` (confirmed).
- `--permission-prompt-tool=stdio` is passed only when the application supplies a permission handler.
- Non-session permission destinations (`localSettings`, `userSettings`, and any other destination that writes to disk) are stripped from permission responses, and `update_settings` is never sent unless the application explicitly opts in.
- `permission_suggestions` are never applied automatically. Their shape is never hard-coded (D17); they are passed through as data.

### 4. Environment (A8)

Environment preset: `'harness'` (default), `'inherit'`, an explicit map, or the object form `{ preset: 'harness' | 'inherit', add?: Record<string,string>, remove?: string[] }` (K19, 06 §K: the preset, then `remove`, then `add`). Variables dropped by the preset and names added or removed are reported as diagnostics by name (never by value). Adding credential or routing variables (`ANTHROPIC_*`, `CLAUDE_CODE_USE_*`, provider families) through `add` is allowed, as the application's own choice, and those names are listed in `securityPosture`; hudhud's pinned variables cannot be added or removed. `'inherit'` (as a string or as the object preset) is a security-weakening opt-in, listed in `securityPosture`. The `'harness'` preset is an allowlist defined by rule; the exact list is finalized in implementation with tests. Allowed: OS essentials (Windows: `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `PATHEXT`, `SystemDrive`, `PATH`, `TEMP`/`TMP`, `USERPROFILE`, `HOMEDRIVE`/`HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`, `ProgramFiles*`; POSIX: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, `TERM`, `XDG_*`); `CLAUDE_*` and `ANTHROPIC_*`; proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` in both cases, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`); provider families only when the matching `CLAUDE_CODE_USE_*` is set (Bedrock: `AWS_*`; Vertex: `GOOGLE_*`, `CLOUD_ML_*`; Foundry: `AZURE_*`, `ANTHROPIC_FOUNDRY_*`). Never inherited by default: `NODE_OPTIONS`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_AGENT_SDK_*`. The sandbox environment of the spike (05 §3) was the starting reference. Always-set variables (unless the opt-in below is used): `DISABLE_AUTOUPDATER=1` via `autoUpdate: 'disabled'` (A8; avoids version-directory races and mid-run replacement, 01 §4.1), `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` ([ADR-0008](0008-turn-and-lifecycle-semantics.md)). Option `autoUpdate: 'disabled' | 'harness-default'` (H16; R2 requires every way) defaults to `'disabled'`; `'harness-default'` is listed in `securityPosture` because an update can replace the binary mid-run (GH#74305, 01 §7). hudhud does not set or alter the entrypoint identity ([ADR-0001](0001-foundation-and-backends.md)).

### 5. Egress and nonessential traffic (E7, G1)

Decision (G overrides E7, confirmed by spike G1, J1): the default is `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, an option named in the API, reported in `securityPosture`. Reasons given in the log: ship what you test, determinism, and the fact that the CLI otherwise bypasses `ANTHROPIC_BASE_URL`. The gate was a spike with two questions; both are answered (07 §3):

- (a) The features that change or disappear are listed in 07 §3.3 (feature-flag fetch, first-party telemetry, `metrics_enabled`, `bootstrap`, `penguin_mode`, MCP registry, startup warm-up, and the further items from binary strings and docs). With flags unfetched every flag takes its built-in default, so tests and production must use the same setting.
- (b) The variable does NOT suppress the fetch of organization-managed policy: `GET /api/claude_code/settings` and `GET /api/claude_code/policy_limits` are fetched with the variable on (07 §3.2 W104/L79), and the eligibility code has no check for it (07 §3.1). The default is therefore policy-neutral and stays.

Facts that follow from the spike:

- The individual switches (`DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_BUG_COMMAND`, `DISABLE_AUTOUPDATER`) are not an equivalent alternative: they leave `bootstrap`, `penguin_mode` and `mcp-registry` going to `api.anthropic.com`, including when a custom base URL is set (07 §3.2 W103).
- Any custom `ANTHROPIC_BASE_URL` disables managed-policy fetching (ineligible `custom_base_url`), whatever the variable says. When a base URL is configured, `securityPosture` reports `managedPolicy: 'not-fetched-custom-base-url'`. A base URL can also come from the `env` of the user's settings file, which is always loaded; to report it, hudhud parses the user's settings files read-only for `ANTHROPIC_BASE_URL` and the provider switches (`CLAUDE_CODE_USE_*`) only. Values are never logged or stored (only presence leaves the parser), and the files are never written (K23, 06 §K; R6). The user settings file read is `<config dir>/settings.json` only, the one user-scope file whose `env` the CLI applies (08).
- `managedPolicy` values (W3-T4 as ruled by W3-Z): `'fetched-if-eligible'` (default), `'not-fetched-custom-base-url'`, `'not-applicable-third-party-provider'`, `'unknown-raw-settings'` (the `/raw` `extraArgs` pass `--settings`, whose content hudhud does not read) and `'unknown-user-settings-unreadable'` (the user settings file exists but cannot be read or parsed). A known base URL wins, then a known third-party provider, then the two unknowns. Under `projectCredentialEnv: 'allow'` the guard's findings in project and local settings feed the same decision: `ANTHROPIC_BASE_URL` there gives `'not-fetched-custom-base-url'`, a named `CLAUDE_CODE_USE_*` gives `'not-applicable-third-party-provider'` (wired by the adapter assembly). Amendment (lead review of W5-T1, Q6, fail safe): a project or local settings file that the scan under `'allow'` cannot read or parse gives `'unknown-project-settings-unreadable'`, never `'fetched-if-eligible'`. Precedence: known base URL, known provider, raw settings, unreadable project settings, unreadable user settings. Raw settings come first among the unknowns because the application handed the CLI a whole settings file past hudhud; unreadable project settings come before the user file because they are repository content, the redirection vector of C3, while the user file is the user's own configuration.
- Not tested: an OAuth/claude.ai login (no credential, owner decision 2); eligibility was read statically for it.

The earlier lead position (E7: do not set by default for real users) was overridden in F/G and the lead accepted the override.

Tests always set the variable and run an egress trap ([ADR-0013](0013-testing-strategy.md)).

### 6. Authentication failure (G2)

Option `onAuthFailure`: `'fail-fast'` (default) or `'harness-retry'`. hudhud does not override `CLAUDE_CODE_MAX_RETRIES` for this.

- `'fail-fast'` applies only when `account.apiKeySource` from the `initialize` response is `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`. The string that `apiKeySource` reports for `ANTHROPIC_AUTH_TOKEN` has not been observed; until a recorded fixture shows it, fail-fast applies to `ANTHROPIC_API_KEY` only, and this is documented (K10, 06 §K). Observed since (fixture `auth-token-source`, Windows and Linux, CLI 2.1.296, W3-Z): with only `ANTHROPIC_AUTH_TOKEN` set, `account.apiKeySource` is `"none"` and the token appears as `account.tokenSource: "ANTHROPIC_AUTH_TOKEN"`; a 401 yields the same `authentication_failed` assistant frame and `api_error_status: 401` as with a key. Decision (lead decision after the `auth-token-source` fixture (W3-Z review): a static env credential that got a 401 does not succeed on retry, for the token as for the key): fail-fast applies when `account.apiKeySource` or `account.tokenSource` is `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` (the default `authFailFastSources`); the session records `tokenSource` beside `apiKeySource`, and the poison error names the credential that triggered (`details.credentialSource`).
- `apiKeyHelper` and OAuth with refresh behave as `'harness-retry'`, because a retry can legitimately succeed after a token refresh.
- On fail-fast, the session is marked `poisoned` and a typed error tells the caller to recreate the session (the 401 is sticky, D15). The option is overridable in both directions.
- The trigger (K10, from the observed frames of 05 §9) is the first of: a `system/api_retry` with `error: "authentication_failed"`, an `assistant` frame with `error: "authentication_failed"`, or a `result` with `api_error_status: 401`. A 403 is not a trigger.
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
- Individual switches instead of `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Not chosen: spike G1 showed the variable is policy-neutral and the switches leave `bootstrap`, `penguin_mode` and `mcp-registry` going out (07 §3).
- Native `'context'` through `initialize.workspaceTrust`. Rejected: it is a persisted trust grant, not a loading filter (07 §10).
- Only documenting a project `env` credential redirect under `'full'`. Not chosen: the redirect is verified (07 §9), so `'full'` carries the `projectCredentialEnv` guard, default `'refuse'`.

## Consequences

- Applications that want project-level configuration choose `workspaceTrust: 'full'`; it is a single documented option.
- Because `'harness'` env is an allowlist, tools that rely on inherited variables fail until the application adds them; dropped-name diagnostics make this visible.
- Test and production configurations are aligned on egress (the variable is set in both; G1 is complete).
- `'full'` refuses repositories whose settings set credential or routing variables, unless the application opts into `projectCredentialEnv: 'allow'`. The guard is best-effort (TOCTOU) and its limits are documented.
- The guard stops configured redirection only; it is not a boundary between the repository and the credentials (review R1-2). Under `'full'` the repository's hooks, MCP servers and helper commands (`awsAuthRefresh`, `awsCredentialExport`, `otelHeadersHelper`, `statusLine` and the like; only `apiKeyHelper` is refused) run as the user, with Claude Code's environment, including the API key or provider credentials, and can read the credential files. `'full'` is for repositories the user trusts to run code, and the security guide says so where it presents the guard.
- `securityPosture` also reports the managed-policy state when a custom base URL is configured.
- `securityPosture` becomes API surface that must be kept additive ([ADR-0005](0005-schema-and-validation.md)).

## Evidence

- 02 §10 (security observations), §4.2 (`update_settings`, `apply_flag_settings`, `mcp_call`, `read_file`).
- 05 §6 (permissions, auto mode), §9 (auth failures, retries), §2 (egress), §13.1 (ancestor leak), §13.2 (sandbox recipe), §14 (OS differences), §15.
- 07 §3 (G1: managed policy endpoints, individual switches, custom base URL), §9 (C3: project `env` redirect), §10 (`initialize.workspaceTrust`), §11 items 1-2 (two trust planes); 06 §J1-J3.
- 01 §1.3 (permission flags), §4 (state and config), §4.3 (what a controller must not write), §1.1 (`--bare`).
