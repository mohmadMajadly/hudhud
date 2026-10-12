# Claude Code CLI: programmatic surface map (for hudhud)

Research date: 2026-10-12. Current CLI at research time: **2.1.296** (npm `@anthropic-ai/claude-code` dist-tags: latest/next 2.1.296, stable 2.1.287). Method: read-only. The user's installed `claude` binary was never executed and nothing under `<home>/.claude` was read. All web content treated as data.

## 0. Source key and confidence

| Tag | Source |
|---|---|
| [CLI] | https://code.claude.com/docs/en/cli-reference |
| [HEAD] | https://code.claude.com/docs/en/headless |
| [SESS] | https://code.claude.com/docs/en/sessions |
| [DIR] | https://code.claude.com/docs/en/claude-directory |
| [ENV] | https://code.claude.com/docs/en/env-vars |
| [SET] | https://code.claude.com/docs/en/settings (precedence), https://code.claude.com/docs/en/settings-reference |
| [AUTH] | https://code.claude.com/docs/en/authentication |
| [ERR] | https://code.claude.com/docs/en/errors |
| [PM] | https://code.claude.com/docs/en/permission-modes |
| [MCP] | https://code.claude.com/docs/en/mcp |
| [HOOKS] | https://code.claude.com/docs/en/hooks |
| [SUB] | https://code.claude.com/docs/en/sub-agents |
| [AV] | https://code.claude.com/docs/en/agent-view |
| [MAN] | https://code.claude.com/docs/en/managed-settings |
| [SETUP] | https://code.claude.com/docs/en/setup |
| [SDKDOC] | https://code.claude.com/docs/en/agent-sdk/typescript , /agent-sdk/streaming-vs-single-mode , /agent-sdk/session-storage |
| [CL] | https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md (raw: https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md) |
| [SDKPKG] | npm tarball `@anthropic-ai/claude-agent-sdk@0.3.296` (https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), files `sdk.d.ts` and `sdk.mjs`. Official Anthropic package, but this is source/type definitions, not prose docs. It is the only complete spec of the stdin/stdout wire protocol. I downloaded it with `npm pack` into the scratchpad (not installed; never executed). |
| [GH#n] | https://github.com/anthropics/claude-code/issues/n (community reports, untrusted, UNVERIFIED as to fix status) |

Rules: "UNVERIFIED" = not confirmed by an official doc page. Anything labelled [SDKPKG] is confirmed by shipped Anthropic code but is not a documented/stable contract for the bare CLI. The changelog was processed by extracting all 7,534 bullets and reading the ~1,130 bullets that mention flags, env vars, stream-json, headless/print/SDK, sessions/resume, transcripts, stdin/stdout/stderr, exit codes, config dir or auth, plus a Windows/credential/exit sweep of the rest. I did not read every UI-only bullet (voice, vim, fullscreen, screen-reader, etc.).

---

## 1. CLI flags relevant to programmatic control

Note [CLI]: "`claude --help` does not list every flag, so a flag's absence from `--help` does not mean it is unavailable."

### 1.1 Core print-mode flags

| Flag | Behavior | Since / notes | Source |
|---|---|---|---|
| `-p`, `--print` | Non-interactive. Prompt as positional arg or stdin (stdin capped 10 MB; whitespace-only prompt errors). | pre-1.0. Rejects `--bg`; `--cloud "task"` rejected | [HEAD], [ERR] |
| `--output-format text\|json\|stream-json` | `text` default. `json` = one result object (carries `result`, `session_id`, `total_cost_usd`, per-model `modelUsage`, `structured_output` when schema). `stream-json` = NDJSON, last line is `result`. | stream-json 0.2.66; JSON became nested-message objects 0.2.117 (breaking) | [HEAD], [CL] |
| `--input-format text\|stream-json` | `stream-json` = NDJSON on stdin (see section 2.7). Needs a newline per message; >256M chars without newline exits 1. | stream input without `-p` since 1.0.18 | [CLI], [ERR], [CL] |
| `--verbose` | Required alongside `--output-format stream-json` in every doc example. `--prompt-suggestions` also requires it. | | [HEAD], [CLI] |
| `--include-partial-messages` | Adds `stream_event` frames (raw Anthropic streaming events). Needs `-p` + stream-json. | 1.0.109 | [CLI], [CL] |
| `--include-hook-events` | Adds `hook_started`/`hook_progress`/`hook_response`. SessionStart/Setup hook events always emitted. | | [CLI] |
| `--replay-user-messages` | Echo stdin user messages on stdout (acks). Needs stream-json both ways. | 1.0.86 | [CLI], [CL] |
| `--forward-subagent-text` (or env `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT`) | Emit subagent text/thinking with `parent_tool_use_id` set. | 2.1.211; depth>1 2.1.219; forked-skill-from-prompt 2.1.287 | [CLI], [HEAD] |
| `--prompt-suggestions` | Emit `prompt_suggestion` after turns. | | [CLI] |
| `--json-schema '<schema>'` | Structured output in `result.structured_output`. Invalid schema exits 1 (`Error: --json-schema is not a valid JSON Schema: ...`). `format` keyword = annotation only. | validation 2.1.205 | [CLI], [ERR] |
| `--max-turns N` | Print mode only; exits with an error when hit (result `subtype: error_max_turns`). With stream-json input a queued message starts a new turn with its own limit. Env fallback `CLAUDE_CODE_MAX_TURNS`. | | [CLI], [ENV] |
| `--max-budget-usd N` | Print mode only; client-side estimate; spend can overshoot; stops background subagents. Result `error_max_budget_usd`. | 2.0.28; subagent enforcement 2.1.217 | [CLI], [CL] |
| `--no-session-persistence` | Print mode only; nothing saved, cannot resume. Env `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` does it in any mode. | | [CLI] |
| `--bare` (env `CLAUDE_CODE_SIMPLE=1`) | Skips hooks, skills, commands, subagents, plugins, MCP discovery, auto memory, CLAUDE.md, OAuth/keychain, profiles. Only Bash/Read/Edit tools. Does not run retention sweep. Docs say it "will become the default for `-p` in a future release". Needs `ANTHROPIC_API_KEY` or `apiKeyHelper` in `--settings`. | 2.1.81; tightened 2.1.286 (no system reminders, no bg tasks, only CLI-named MCP servers) | [HEAD], [CLI], [CL] |
| `--safe-mode` (env `CLAUDE_CODE_SAFE_MODE=1`) | Everything customizable off, but auth/model/tools/permissions normal (unlike `--bare`). Managed policy still applies. | 2.1.169 | [CLI] |
| `--restricted` (env `CLAUDE_CODE_RESTRICTED=1`) | For eval harnesses on shared machines: no command/code tools or WebFetch unless named in `--tools`, file tools confined to working dirs, loads only managed settings + `--settings`, refuses `bypassPermissions` and cloud sessions. | 2.1.248 | [CLI], [CL] |
| `--init` / `--init-only` / `--maintenance` | Run Setup (`init`/`maintenance` matcher) / SessionStart hooks. `--init-only` exits after hooks. | 2.1.10 | [CLI], [CL] |

### 1.2 Session flags

| Flag | Behavior | Source |
|---|---|---|
| `-c`, `--continue` | Most recent session in cwd. Skips `-p`/SDK/`/loop` sessions **unless** combined with `-p` (`claude -p --continue` includes them). Opens finished background sessions (2.1.257+). | [CLI], [SESS] |
| `-r`, `--resume [id\|name\|path]` | By session UUID, name (`--name`/`/rename`/generated title), or **absolute path to a `.jsonl`**. ID search: cwd project + its git worktrees, then every other project (only if exactly one other project holds it). `claude -p --resume <name>` since 2.1.101. Not found: exit 1 `No conversation found with session ID: <id>`. | [CLI], [SESS], [ERR] |
| `--session-id <uuid>` | Force the session UUID (must be valid UUID). Combined with `--resume`/`--continue` + `--fork-session` to pick the fork's id (2.0.73). | [CLI], [CL] |
| `--fork-session` | New session id when resuming. | [CLI] |
| `-n`, `--name` | Display name; resumable by name. | 2.1.76 [CL] |
| `--from-pr <n\|url>` | Picker filtered by PR (interactive). | [CLI] |
| `--bg`, `--background` | Start a background (daemon-hosted) session and return immediately; **cannot combine with `-p`**. `--exec` runs a shell command as a PTY job. | [CLI], [ERR] |
| `--system-prompt-snapshot on\|off` | Whether the conversation's first-request system prompt is recorded and reused on resume. Default: recorded; `--bare` turns recording off. | 2.1.257/2.1.267 [CLI] |

NOT restored on resume (must re-pass): `--mcp-config`, `--settings`, `--plugin-dir`, `--fallback-model`, `--add-dir`, `/add-dir` dirs. `--system-prompt*` flags only take effect after compaction/new conversation unless `--system-prompt-snapshot off`. Permission mode on `-p --resume`: starts in whatever a new `-p` run would (except plan-mode restore under conditions). [SESS]

### 1.3 Permissions / tools

| Flag | Behavior | Source |
|---|---|---|
| `--permission-mode default\|manual\|acceptEdits\|plan\|auto\|dontAsk\|bypassPermissions` | `manual` is an alias of `default` (2.1.200). `auto` as starting mode needs an eligible account/model. Wire values (`system/init.permissionMode`): default, acceptEdits, bypassPermissions, plan, dontAsk, auto. | [CLI], [PM] |
| `--dangerously-skip-permissions` | = `--permission-mode bypassPermissions`. Refuses root/sudo on Linux/macOS unless in a recognised sandbox. | [CLI], [PM] |
| `--allow-dangerously-skip-permissions` | Makes bypass available later without starting in it. | [CLI] |
| `--allowedTools`/`--allowed-tools` | Allow rules (permission-rule syntax `Bash(git log *)`, space before `*` matters). Accepts space- or comma-separated (SDK sends comma-joined). | [CLI], [HEAD], [SDKPKG] |
| `--disallowedTools`/`--disallowed-tools` | Deny rules; bare name **removes the tool from context**; `"*"` removes all, `"mcp__*"` all MCP tools. `Task(AgentName)` / `Agent(...)` disables a subagent (2.1.0). | [CLI], [CL] |
| `--tools "<list>"`, `""`, `"default"` | Restrict built-in tools (not MCP). | [CLI] |
| `--permission-prompt-tool <mcp_tool>` | Route permission asks to an MCP tool; CLI waits for that server (MCP_TIMEOUT). Missing tool => run exits 1: `Error: MCP tool mcp__x__y (passed via --permission-prompt-tool) not found. Available MCP tools: none`. Tool cannot approve a `requiresUserInteraction` MCP tool (converted to deny). `PermissionRequest` hooks fire in `--print` since 2.1.268. **The tool's request/response JSON contract is NOT in the current docs** (UNVERIFIED; historically `{tool_name,input}` in, `{"behavior":"allow","updatedInput":{}}` / `{"behavior":"deny","message":""}` out as a JSON text content block). | [CLI], [ERR], [MCP], [CL] |
| `--permission-prompt-tool stdio` (or `=stdio`) | **Undocumented special value** used by the Agent SDK and third-party wrappers: permission asks become `can_use_tool` control_requests on stdout, answered by control_response on stdin. Confirmed in [SDKPKG] (`--permission-prompt-tool=stdio`); also used in [GH#99364]. | [SDKPKG] |
| `--permission-prompts host\|none` | `none` = nobody answers; asks are denied (PermissionRequest hooks still run), Claude is told not to retry; AskUserQuestion tool removed; MCP elicitation cancelled. Denials appear as `permission_denied` system messages + `permission_denials` on result. | 2.1.259 [CLI], [HEAD] |
| `--add-dir <dirs...>` | Extra working dirs (file access; does not load most `.claude/` config; env `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` loads their CLAUDE.md). Refuses UNC/network paths. | [CLI] |
| `--disable-slash-commands` | Disables all skills and commands. | 2.0.60 [CLI] |

`-p` starting permission mode: `default` when the session fetches feature flags; `auto` (2.1.285+) on third-party providers or telemetry-off, `default` earlier. **A controller must always pass `--permission-mode` explicitly.** [PM], [CL 2.1.285]

### 1.4 Prompt, model, agents

| Flag | Notes | Source |
|---|---|---|
| `--system-prompt`, `--system-prompt-file` | Replace default prompt. | [CLI] |
| `--append-system-prompt`, `--append-system-prompt-file` | Append. Since 2.1.283 a flag and its `-file` form may be combined (file text first). Before: exit 1 on the pair. A line `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` splits cacheable/dynamic parts (2.1.275). | [CLI] |
| `--append-subagent-system-prompt[-file]` | Print mode only; the two forms cannot be combined (exit 1). | 2.1.205/2.1.261 [CLI] |
| `--exclude-dynamic-system-prompt-sections` | Move per-user context to first user message (cache reuse). | 2.1.98 [CLI] |
| `--model`, `--fallback-model a,b,c` | Alias or full ID; fallback chain (flag now applies interactively too since 2.1.166). | [CLI] |
| `--effort low\|medium\|high\|xhigh\|max\|ultracode` | `xhigh` 2.1.111; `ultracode` 2.1.203. | [CLI] |
| `--agents '<json>'` / path to JSON file with `-p` | Invalid => exit 1 `Error: Invalid --agents configuration` (since 2.1.242); file form 2.1.281. Fields: prompt, description, tools, disallowedTools, model, permissionMode, mcpServers, hooks, maxTurns, skills, initialPrompt, memory, effort, background, omitClaudeMd, isolation (autoCompactWindow added 2.1.296). | [SUB], [CLI], [CL] |
| `--agent <name>` | Run session as that agent; re-used on resume. | 2.0.59 [CLI] |
| `--advisor <model>` | Server-side advisor tool. | [CLI] |
| `--autocompact auto\|tokens` | Auto-compact window. | 2.1.221 [CLI] |
| `--betas` | API-key users only. | [CLI] |

### 1.5 Config injection

| Flag | Notes | Source |
|---|---|---|
| `--settings <file-or-json>` | Regular file <= 2 MiB (else exit 1). Overrides user/project/local, below managed. Cannot set Managed or Global-config keys. | 1.0.61 [CLI], [SET] |
| `--setting-sources user,project,local` | Which file layers load. (Since 2.1.281 it is forwarded to spawned sessions.) Omitting `user` also changes `cleanupPeriodDays` behavior (fixed 2.1.101). | [CLI], [CL] |
| `--mcp-config <files-or-json...>` | Multiple allowed (1.0.73). With `-p`, CLI waits for pending servers up to `MCP_TIMEOUT` (30 s) (2.1.221). Entries failing validation are skipped, reported in `system/init.mcp_server_errors`. | [CLI], [HEAD] |
| `--strict-mcp-config` | Only `--mcp-config` servers. | [CLI] |
| `--plugin-dir <path>` (repeatable; dir, `.zip`, or folder of plugins), `--plugin-url <url>` | Session-only plugins. Failures in `init.plugin_errors`. `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1` makes `-p` wait for marketplace installs. | [CLI], [HEAD] |
| `--debug[=filter]`, `--debug-file <path>` | `--debug=mcp,startup` (the `=` form binds filter). Debug file implicitly enables debug. Env `CLAUDE_CODE_DEBUG_LOGS_DIR`, `CLAUDE_CODE_DEBUG_LOG_LEVEL`. | [CLI], [ENV] |
| `--chrome`/`--no-chrome`, `--ide`, `--channels`, `--worktree/-w`, `--tmux`, `--teammate-mode`, `--ax-screen-reader`, `--remote-control/--rc`, `--cloud`/`--remote`, `--desktop`, `--teleport`, `--environment`/`--ref` | Mostly interactive/cloud; `--remote-control` is silently ignored in print/stream-json mode [GH#99364]. | [CLI] |

### 1.6 Hidden / undocumented flags (found only in the SDK package source; UNVERIFIED semantics)

Official SDK ([SDKPKG] `sdk.mjs`, `ProcessTransport.initialize`) builds argv from these; none appear in [CLI]:

`--thinking=adaptive|disabled`, `--max-thinking-tokens N`, `--thinking-display summarized|omitted|highlights`, `--task-budget N`, `--session-mirror` (CLI emits `transcript_mirror` frames for SessionStore), `--project-config-root <dir>`, `--await-initialize` (CLI waits for an `initialize` control_request before starting, used to deliver plugins), `--plugin-dir-no-mcp`, `--resume-session-at <uuid>`, `--resume-drops-turn <uuid>` (only the latter appears in SDK docs), `--managed-settings <json-or-file>` (SDK `managedSettings`: policy-tier settings from the host; ignored on machines with admin managed settings unless `parentSettingsBehavior: merge`), `--hard-fail`, `--debug-to-stderr` / `-d2e`, `--rewind-files` (mentioned in changelog 2.1.260), old `--mcp-debug` (0.2.31). Also `--sdk-url` (mentioned 2.1.69 as a remote-control internal; npm-install crash fixed).

**Key observation:** the official SDK does **not** pass `-p/--print`. Its argv starts `--output-format stream-json --verbose --input-format stream-json`, then optional flags. So `--input-format stream-json` alone selects non-interactive streaming mode (changelog 1.0.18 "Added streaming input support without require -p flag"). Third-party wrappers do the same [GH#99364]. Whether to add `-p` is an open empirical question (section 9).

### 1.7 Non-session subcommands useful to a controller

| Command | Purpose | Source |
|---|---|---|
| `claude auth status [--text]` | JSON; exit 0 logged in, 1 not. `authMethod`: none, claude.ai, oauth_token, api_key, api_key_helper, third_party. `configDirectory` field (2.1.268/2.1.268+ doc says v2.1.268). | [CLI] |
| `claude auth login [--email --sso --console]`, `auth logout`, `setup-token` | `setup-token` prints a 1-year OAuth token (not saved); use as `CLAUDE_CODE_OAUTH_TOKEN`. | [CLI], [AUTH] |
| `claude doctor` | Read-only diagnostics (install, settings validation). | [CLI] |
| `claude mcp serve` / `add` / `list` / `get` / `remove` / `login` / `logout` / `add-json` | `mcp serve` exposes Claude Code's tools over stdio MCP (client must handle confirmations). `mcp list` health status. | [MCP], [CLI] |
| `claude plugin ...` (`validate --json`, `install/update/enable/disable --json`, `list --json`, `eval`, `configure --values-stdin`, `prune`, marketplace add/remove) | Plugin management. | [CLI], [CL] |
| `claude agents --json [--all] [--cwd]`, `attach`, `logs`, `stop`, `respawn`, `rm`, `daemon status/logs/run/stop` | Background-session supervisor ("agent view"). `claude agents --json` is "the supported way to read session state from outside". | [AV], [CLI] |
| `claude ultrareview [target] [--json --timeout --post]` | Non-interactive cloud review, exit 0/1. | [CLI] |
| `claude auto-mode defaults/config/reset` | Inspect auto-mode classifier rules. | [CLI] |
| `claude purge [path] [--dry-run -y -i --all]` | Delete all local state for a project (alias earlier `claude project purge`). | [CLI] |
| `claude update`, `install [version\|stable\|latest]` | Native install management. | [CLI] |
| `claude remote-control`, `gateway`, `self-hosted-runner`, `import` | Out of scope for hudhud v1. | [CLI] |

---

## 2. Wire protocol: stream-json

Authoritative spec for the types below is [SDKPKG] `sdk.d.ts` (comments + types), cross-checked with [HEAD] and [SDKDOC]. The bare CLI docs only say "newline-delimited JSON" and document a few `system` subtypes. Treat the full list as **version-coupled to the Claude Code build** (SDK 0.3.296 pairs with CLI 2.1.296; `claude_code_version` is in init). Design the parser as tolerant: unknown `type`/`subtype` must be ignored (the SDK itself does this; control-protocol doc comments repeat "ignore unknown values").

Transport: one JSON object per line (`\n`), both directions. UTF-8 chunk-boundary corruption fixed 2.1.94; CRLF/whitespace-only lines tolerated since 2.1.208; non-JSONL garbage on stdin "fails fast with a clear error" (2.1.257). A line > ~146 KB preceded by another line was reported truncated [GH#58648] (closed, UNVERIFIED fixed).

### 2.1 Stdout message union (`StdoutMessage`)
`SDKMessage | SDKActiveGoalMessage | SDKControlResponse | SDKControlRequest | SDKControlCancelRequest | SDKKeepAliveMessage` [SDKPKG]. Also seen in the SDK reader but not in the union: `transcript_mirror` (with `--session-mirror`), `autocompact_state`, and system subtypes `post_turn_summary`, `task_summary`, `session_metadata`.

`SDKMessage` = assistant | user | user (replay) | result | system(init and others) | stream_event | rate_limit_event | auth_status | conversation_reset | prompt_suggestion | ... (full list below).

### 2.2 `system/init` (per turn, "normally ahead of every other message of that turn")
Fields [SDKPKG `SDKSystemMessage`]: `type:"system"`, `subtype:"init"`, `uuid`, `session_id`, `claude_code_version`, `cwd`, `model`, `permissionMode`, `apiKeySource` (`ANTHROPIC_API_KEY` | `apiKeyHelper` | `/login managed key` | `none`), `tools: string[]`, `mcp_servers: {name,status,source?}[]`, `slash_commands: string[]`, `terminal_slash_commands?`, `skills: string[]`, `agents?: string[]`, `plugins: {name,path,version?}[]`, `plugin_errors?: {plugin,type,message,path?}[]`, `mcp_server_errors?: {name,type,message}[]` (omitted when none; [HEAD]), `output_style`, `betas?`, `fast_mode_state?`, `fast_mode_disabled_reason?`, `effort?` (low..max|null), `view_mode?` ('focus'|'default'), `capabilities?: string[]` (feature detection; seen: `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `queued_notifications`; [HEAD] says v2.1.205+).
Docs note: init is "the first event in the stream unless startup events precede it": `plugin_install` events (with `CLAUDE_CODE_SYNC_PLUGIN_INSTALL`), `hook_started/progress/response` for SessionStart/Setup hooks. [HEAD]

### 2.3 `assistant`
`{type:"assistant", message: BetaMessage, parent_tool_use_id: string|null, uuid, session_id, error?: SDKAssistantMessageError, request_id?, timestamp?, agent_id?, subagent_type?, task_description?, aborted?:true, supersedes?: UUID[], user_message_uuid?, user_message_uuids?, resume_reason?, resumed_from_incomplete_thinking?, context_usage?, usage_report?}`.
- **One assistant message is emitted per completed content block**; several can share `message.id`; `message.stop_reason` is null and `usage` not final on them. Final stop reason/usage are on `result`. [SDKPKG]
- `error` enum: `authentication_failed | oauth_org_not_allowed | account_on_hold | verification_required | billing_error | rate_limit | overloaded | invalid_request | model_not_found | server_error | unknown | max_output_tokens | cloud_credential_error`. [SDKPKG]; the same set (minus verification_required) is documented for `system/api_retry.error` in [HEAD].
- `user_message_uuid(s)`: binds replies to the client-supplied `uuid` of a sent user message.

### 2.4 `user`
Echo of tool results and (with `--replay-user-messages`) replayed stdin messages (`SDKUserMessageReplay`, has `isReplay`; 2.0.5). Fields: `message` (MessageParam), `parent_tool_use_id`, `isSynthetic?`, `tool_use_result?` (structured per-tool output), `priority?`, `origin?`, `shouldQuery?`, `timestamp?`, `client_composed?`, `uuid?`, `pasted_content?`, `inline_pastes?`, `session_id?`, `agent_id?`, `subagent_type?`, `task_description?`. See 2.7 for the input side.

### 2.5 `stream_event` (with `--include-partial-messages`)
`{type:"stream_event", event: BetaRawMessageStreamEvent, parent_tool_use_id, uuid, session_id, ttft_ms?, user_message_uuid?, user_message_uuids?, resume_reason?}`. `event` is the Anthropic streaming event (message_start, content_block_start/delta/stop, message_delta, message_stop, plus `ping` every 30 s during a non-streaming fallback, 2.1.285). Example filter: `select(.type=="stream_event" and .event.delta.type?=="text_delta")`. [HEAD]

### 2.6 `result` (exactly one per turn; the turn-complete signal)
Common: `type:"result"`, `uuid`, `session_id`, `duration_ms`, `duration_api_ms`, `is_error`, `num_turns`, `stop_reason`, `total_cost_usd` (cumulative, **latest wins**, not summed), `usage` (main loop only), `modelUsage` (per-model, cumulative), `permission_denials: {tool_name,tool_use_id,tool_input}[]`, `queued_turn_count?`, `terminal_reason?`, `result_index?` (gaps = lost result), `user_message_uuid(s)?`, `resume_reason?`, `origin?`, `fast_mode_state?`.
- `subtype:"success"`: + `result: string`, `api_error_status?: number|null`, `structured_output?`, `deferred_tool_use?: {id,name,input}`, `ttft_ms?` and many timing fields, `local_command?`. **`is_error:true` can occur with `subtype:"success"`**; then `result` holds the error text. [SDKPKG]
- `subtype: error_during_execution | error_max_turns | error_max_budget_usd | error_max_structured_output_retries`: + `errors: string[]`, `startup_failure_reason?`.
- `terminal_reason`: `blocking_limit | rapid_refill_breaker | prompt_too_long | image_error | model_error | api_error | malformed_tool_use_exhausted | aborted_streaming | aborted_tools | stop_hook_prevented | hook_stopped | tool_deferred | max_turns | background_requested | completed | budget_exhausted | structured_output_retry_exhausted | tool_deferred_unavailable | turn_setup_failed`.
- `startup_failure_reason` (set CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1 to get a zeroed error result before exit on startup failures; 2.1.274): `org_pin_api_key_conflict | provider_not_allowed | org_verify_failed | org_pin_mismatch | managed_settings_invalid | remote_settings_required_unavailable | gateway_signin_required | gateway_access_denied | proxy_invalid | temp_dir_unusable | cwd_unavailable | shell_tool_missing | session_held_by_background | worktree_resume_refused | worktree_unverified | cli_version_too_old | bypass_root | org_config_required_unavailable | org_config_refused`.
- Known quirks (open bugs, UNVERIFIED current): `result` key absent after a control_request interrupt [GH#94741]; empty `result` after TodoWrite (older, closed) [GH#8126]; `result` event missing sometimes [GH#1920] (closed). Hence the parser must not assume `result.result` exists and must synthesize turn-end on process exit.
- Informational system messages may still arrive **after** `result`. [SDKPKG]

### 2.7 Other `SDKMessage` types (full union order from `sdk.d.ts`)
`system` subtypes: `init`, `compact_boundary` (`compact_metadata{trigger manual|auto, pre_tokens, post_tokens?, duration_ms?, preserved_segment?, preserved_messages?}`), `status` (`status: 'compacting'|'requesting'|null`, `permissionMode?`, `compact_result?`), `api_retry` (`attempt,max_retries,retry_delay_ms,error_status|null,error,no_response?`), `control_request_progress`, `model_refusal_fallback`, `model_refusal_no_fallback`, `local_command_output`, `hook_started|hook_progress|hook_response` (`hook_id,hook_name,hook_event,output,stdout,stderr,exit_code?,outcome success|error|cancelled`), `plugin_install`, `task_notification`, `task_started`, `task_updated`, `task_progress`, `background_tasks_changed` (REPLACE semantics), `session_state_changed` (`idle|running|requires_action`; **only with env `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`** [ENV]), `worker_shutting_down`, `commands_changed`, `notification`, `files_persisted`, `elicitation_complete`, `permission_denied` (`tool_name,tool_use_id,agent_id?,decision_reason_type?,decision_reason?,message`), `informational` (`content`, `level info|notice|suggestion|warning`, `prevent_continuation?`, `tag?`), `mirror_error`, `memory_recall`, `thinking_tokens`, `tool_use_summary`; top-level types: `tool_progress`, `auth_status` (`isAuthenticating, output[], error?`), `rate_limit_event` (`rate_limit_info{status allowed|allowed_warning|rejected, resetsAt?, rateLimitType five_hour|seven_day|seven_day_opus|seven_day_sonnet|seven_day_overage_included|overage, utilization?, overage*...}` for claude.ai subscribers), `prompt_suggestion`, `conversation_reset` (`new_conversation_id`, `trigger clear|plan_mode_exit|fresh_session|onboarding`), `active_goal`, `keep_alive`.

### 2.8 Control protocol (bidirectional, over the same pipes)
Envelope [SDKPKG]:
- Request (either direction): `{"type":"control_request","request_id":"<sender-chosen, unique among in-flight>","request":{"subtype":"...", ...}}`
- Response: `{"type":"control_response","response":{"subtype":"success","request_id":"...","response":{...}}}` or `{"subtype":"error","request_id":"...","error":"text"}`; initialize success additionally carries `pending_permission_requests[]` and `pending_user_dialog_requests[]` (always present from v2.1.268).
- Cancel: `{"type":"control_cancel_request","request_id":"..."}` (either side).
- `{"type":"keep_alive"}` either side, ignore.
- Caveat: a bug report uses `request_id` *inside* `request`; the SDK puts it at top level. Use the SDK form. [GH#94741 repro vs SDKPKG]

**Requests the CLI sends to the host** (host must answer or the turn blocks): `can_use_tool` (`tool_name, input, tool_use_id, agent_id?, permission_suggestions?: PermissionUpdate[], blocked_path?, decision_reason?, decision_reason_type? rule|mode|subcommandResults|permissionPromptTool|hook|asyncAgent|sandboxOverride|workingDir|safetyCheck|classifier|other, classifier_approvable?, suppress_always_allow_rule?, default_to_no?, matched_ask_rule?, title?, display_name?, description?, requires_user_interaction?, mcp_server?`), `hook_callback` (`callback_id, input, tool_use_id?`), `mcp_message` (SDK in-process MCP JSON-RPC relay), `elicitation` (`mcp_server_name, message, mode form|url, url?, elicitation_id?, requested_schema?`; answer `{action: accept|decline|cancel, content?}`; unanswered => `{action:"decline"}` in SDK), `request_user_dialog` (`dialog_kind, payload, tool_use_id?`; answer only for kinds you declared in `initialize.supportedDialogKinds`), plus host-integration ones seen in SDK source: `oauth_token_refresh`, `host_auth_token_refresh`, `remote_control_work_secret`, `ui_copy`, `ui_prompt_read/fill/suggest`, `ui_read_selection`.

`can_use_tool` answer (`response` payload): `{"behavior":"allow","updatedInput":{...},"updatedPermissions":[PermissionUpdate],"toolUseID":"..."}` or `{"behavior":"deny","message":"...","interrupt":true?,"toolUseID":"..."}`. `updatedInput` may be omitted since v2.1.207. `PermissionUpdate` = `addRules|replaceRules|removeRules|setMode|addDirectories|removeDirectories` with `destination` (session/userSettings/projectSettings/localSettings...). [SDKPKG; SDKDOC user-input]

**Requests the host sends to the CLI** (`SDKControlRequestInner` union): `initialize` (`hooks, sdkMcpServers, sdkMcpServerConfigs, sdkMcpServerManifests, jsonSchema, systemPrompt: string[], appendSystemPrompt, systemPromptSnapshot, planModeInstructions, toolAliases, excludeDynamicSections, agents, title, skills, promptSuggestions, agentProgressSummaries, forwardSubagentText, supportedDialogKinds, perTaskStopAffordance, plugins`; response: `commands, agents, output_style, available_output_styles, models, account, hooks_applied, plugins_applied, claude_code_version, fast_mode_state`), `interrupt` (`cancel_queued?: bool`; response `{still_queued: uuid[], cancelled?: uuid[]}` when capabilities `interrupt_receipt_v1`/`interrupt_cancel_queued_v1`), `set_permission_mode` (`mode`), `set_model` (`model|null`; applies mid-turn since 2.1.212), `set_max_thinking_tokens` (`max_thinking_tokens, thinking_display`), `rename_session`, `set_color`, `mcp_status`, `mcp_set_servers`, `mcp_reconnect`, `mcp_toggle`, `mcp_call`, `mcp_read_resource`, `get_context_usage` (`detail summary|full`), `get_session_cost`, `get_usage`, `list_models`, `get_binary_version`, `get_settings`, `apply_flag_settings` (`settings{}`: flag-layer settings at runtime), `update_settings` (`source localSettings|userSettings`: **writes to disk**), `get_hooks_listing`, `list_permission_rules`, `rewind_files` (`user_message_id`, `dry_run?`), `cancel_async_message` (`message_uuid`), `read_file` (`path, max_bytes?, encoding?`), `seed_read_state`, `register_repo_root` (`directory, reload_claude_md?, reload_plugins?, reload_skills?`), `reload_plugins`, `reload_skills`, `reload_output_styles`, `stop_task` (`task_id`), `background_tasks`, `get_task_output` (`task_id`), `file_suggestions` (`query`), `elicitation`, `request_user_dialog`. [SDKPKG] Also `side_question` referenced in a progress-message comment.

### 2.9 Interrupts and message priority
- Interrupt = `control_request{subtype:"interrupt"}`. Result of an interrupted turn: `result` with `subtype error_during_execution` and an assistant/`[Request interrupted by user]` text (observed in [GH#98713], UNVERIFIED). Known bugs (open at time of research): interrupt sent immediately after a user message but before that turn's `system/init` is acknowledged yet ignored on every turn after the first (turn runs in full, tokens billed) [GH#98713]; workaround: wait for init before interrupting. Early-turn Stop/interrupt fixed in 2.1.162/2.1.261.
- `SIGINT` to process ends the turn; **SIGTERM => exit code 143**, no result recorded, SessionEnd hooks run, running Bash trees are killed; set `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` to auto-continue an interrupted turn on resume (plus `_MAX_AGE_MS`, `CLAUDE_CODE_RESUME_PROMPT`). [HEAD], [ENV], [CL 2.1.288 SIGCONT fix]
- User-message `priority`: `'next'` (default; picked up in same turn after current tool calls), `'later'` (held until turn ends), `'now'` (interrupts; with `origin:{kind:"human"}` on 2.1.286+ moves shell/subagent/MCP/WebFetch/WebSearch work to background and keeps the turn). [SDKDOC typescript]
- `shouldQuery:false` appends context without a model call; `client_composed:true` disables `@path` and slash expansion (2.1.248+). [SDKDOC]

### 2.10 stdin input format (what hudhud writes)
Verified pieces:
- User turn: `{"type":"user","session_id":"","message":{"role":"user","content":[{"type":"text","text":"..."}]},"parent_tool_use_id":null}` (exact shape the SDK writes; `content` may also be a plain string per [SDKDOC streaming-vs-single-mode]; images as `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}`). Optional `uuid` (echoed on assistant/stream_event/result for correlation). [SDKPKG], [SDKDOC]
- Control messages as 2.8. SDK sends `initialize` first, before any user message. Whether initialize is mandatory for the bare CLI is UNVERIFIED (the GH report in section 2.8 sends only user+control lines and works).
- Ending input: closing stdin (EOF) ends the session after the current/queued work; the SDK calls `processStdin.end()` on close and escalates to SIGTERM/SIGKILL after a grace period (SDK source). `CLAUDE_CODE_EXIT_AFTER_STOP_DELAY=<ms>` exits after idle. Closed-without-EOF hang fixed 2.1.153.
- Whitespace-only message: no model call; informational `Blank prompt — the message was only whitespace, so nothing was sent to the model.` and result text. [ERR]
- Slash commands inside stdin messages work (`/compact`, `/clear`, `/model sonnet`, `/config k=v`, `/output-style x`, `/goal`, ...); unknown ones now error (2.1.147). Earlier bug [GH#4184] closed.

### 2.11 Single-shot `--output-format json`
One result object (fields as 2.6 success variant). Exact shape when `--verbose` is also passed (historically an array of all messages) is UNVERIFIED; verify empirically. [HEAD says: "structured JSON with result, session ID, and metadata"].

---

## 3. Exit codes, errors, stderr

| Situation | Behavior | Source |
|---|---|---|
| Success | exit 0 | [HEAD] |
| Run fails (generic) | non-zero (docs do not enumerate); "When a failure happens inside the run, such as missing authentication, Claude Code prints the failure as the result on stdout." Invalid flag => error on stderr before the run. | [HEAD] |
| Explicit exit 1 | invalid `--agents`; invalid/unparseable `--json-schema`; `--settings` file > 2 MiB; deleted cwd; `--append-subagent-system-prompt` + `-file`; `--resume` id not found or unreadable transcript ("Failed to resume the conversation"); `--permission-prompt-tool` tool missing (on first tool call); stdin stream-json line > 256M chars; whitespace-only `-p` prompt; unparseable managed-settings source; `--dangerously-skip-permissions` as root; interactive `claude` with non-TTY stdin on Windows; `--bg` + `-p`; internal error in `-p`/SDK (2.1.277: "report the error and exit with code 1" rather than hang) | [ERR], [CL] |
| SIGTERM | exit 143, turn left unfinished, no result | [HEAD] |
| Windows quirk | exit code `4294967295` right after a turn completes seen under VS Code on native Windows | [ERR] |
| `--max-turns`/budget | result `subtype error_max_turns` / `error_max_budget_usd`; process exit code UNVERIFIED (probably non-zero) | [CLI] |
| `claude auth status` | exit 0 / 1 | [CLI] |
| `claude ultrareview`, `claude purge`, `daemon status` | exit 0/1 as documented | [CLI], [CL] |

stderr: invalid-flag and fatal errors; `Warning: N MCP server skipped due to invalid config` (only when stderr is a terminal, 2.1.219); `Waiting for background work to finish ...` (only when stderr is a terminal; in json/stream-json only when stdout is not a terminal, 2.1.295); `[claude-code:unrecognized_model]` line for unknown model IDs (2.1.233); deprecated-model warning (2.1.183); policy-helper warnings (2.1.268); debug output goes to a file (1.0.123) unless `--debug-to-stderr` (hidden). Sandbox debug output once contaminated the JSON stream [GH#12056] (closed).

Auth failures: `Not logged in · Please run /login` (Desktop variant `Authentication required · Sign in again to continue`); in `-p`, revoked login begins `Failed to authenticate` (2.1.287); expired: `Login expired · Please run /login`; invalid key: `Invalid API key`; apiKeyHelper: `Your apiKeyHelper script is failing`. Surfaced as `assistant.error = authentication_failed` and/or `system/api_retry` (error `authentication_failed`) and a `result` with `is_error:true` whose `result` text is the message and `api_error_status` 401/403. Retries: 401/403 with apiKeyHelper retried silently twice (2.1.246). [ERR], [HEAD], [SDKPKG]

Rate limits / overload: auto-retry up to 10 times (`CLAUDE_CODE_MAX_RETRIES`, cap 15) with `system/api_retry` events; `CLAUDE_CODE_RETRY_WATCHDOG=1` retries 429/529 forever (fails immediately on spend-limit/out-of-credits 429); `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS`; `CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS`/`_MAX_DELAY_MS`; subscription limits surface as text `You've hit your session limit · resets 3:45pm` / weekly / Opus / Sonnet limit and `rate_limit_event` frames (`status: rejected`); `error: rate_limit | overloaded | billing_error`. Non-streaming mid-response failures continue the turn from the partial response in -p (2.1.246/2.1.288). [ERR], [CL]

---

## 4. State, config and credentials per OS

Default config home `~/.claude` (`%USERPROFILE%\.claude` on Windows). **`CLAUDE_CONFIG_DIR` relocates**: settings, session history/transcripts, plugins, credentials file, daemon/jobs state (separate supervisor instance), IDE lock files, workflows, and (per troubleshoot-install and the SDK's temp-config-dir seeding) the global `~/.claude.json` becomes `$CLAUDE_CONFIG_DIR/.claude.json`. On macOS the Keychain entry is also keyed by config dir. [ENV], [AUTH], [DIR], [AV], [SDKDOC session-storage: "credentials, `.claude.json`, and your user `settings.json`" copied into a temp config dir], https://code.claude.com/docs/en/troubleshoot-install

Honored only from shell env / user / managed settings (NOT project/local settings `env`): `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_TMPDIR`, `TMPDIR/TMP/TEMP`, `HOME`, `XDG_*` (2.1.251). A settings-file value must be an absolute path (no `~`/`$HOME` expansion). [ENV], [SET]

### 4.1 Locations
| Item | Path | Notes / source |
|---|---|---|
| User settings | `~/.claude/settings.json` | [SET] |
| Project shared / local settings | `<proj>/.claude/settings.json`, `<proj>/.claude/settings.local.json` | local is gitignored automatically; in-session "always allow" writes here [SET] |
| Global app state | `~/.claude.json` (inside `CLAUDE_CONFIG_DIR` when set) | OAuth session (non-credential-file case), per-project trust, user/local-scope MCP servers, UI toggles; `backups/` keeps 5 [DIR] |
| Credentials | macOS Keychain (fallback `~/.claude/.credentials.json` mode 0600); Linux `~/.claude/.credentials.json` (0600); Windows `%USERPROFILE%\.claude\.credentials.json` | under `CLAUDE_CONFIG_DIR` when set; keyless Console sign-in profile stored **outside** config dir [AUTH] |
| Anthropic profiles/WIF | `~/.config/anthropic` (mac/Linux), `%APPDATA%\Anthropic` (Windows); `ANTHROPIC_PROFILE` etc. | outside `CLAUDE_CONFIG_DIR`; not read in `--bare` [AUTH] |
| Transcripts | `~/.claude/projects/<project>/<session-id>.jsonl` | `<project>` = cwd with every non-alphanumeric char replaced by `-` (>200 chars: truncate + hash). `CLAUDE_CODE_PROJECT_DIR_NAME` (with `CLAUDE_CONFIG_DIR`, 1-64 `[A-Za-z0-9_-]`) pins it (2.1.234). Entry format "internal, changes between versions". Subagents: `<session>/subagents/`; big tool output: `<session>/tool-results/`; `*.orphaned-*.jsonl`, `*.jsonl.superseded-*` set-aside files [SESS], [DIR] |
| Prompt history | `~/.claude/history.jsonl` | kept until deleted [DIR] |
| Others under config dir | `sessions/` (one small pid file per running session), `session-env/`, `file-history/<session>/`, `plans/`, `debug/`, `paste-cache/`, `tasks/`, `shell-snapshots/`, `backups/`, `plugins/` (`installed_plugins.json`, marketplaces, `synced/`), `agent-memory/`, `jobs/<id>/state.json`, `daemon/roster.json`, `daemon.log`, `stats-cache.json`, `remote-settings.json`, `policy-limits.json`, `cache/changelog.md`, `usage-data/` | [DIR], [AV] |
| Temp / scratchpad | Windows `%TEMP%\claude\<project>\<session-id>\scratchpad\`; Unix `/tmp/claude-<uid>/...`; override `CLAUDE_CODE_TMPDIR` (appends `claude-{uid}`/`claude`); images since 2.1.275 live here too | [DIR], [ENV] |
| Managed settings | macOS `/Library/Application Support/ClaudeCode/managed-settings.json` (+ `managed-settings.d/`, `managed-mcp.json`, MDM profile domain `com.anthropic.claudecode`); Linux/WSL `/etc/claude-code/`; Windows `<C>/Program Files\ClaudeCode\managed-settings.json` and HKLM registry policy (legacy `<C>/ProgramData\ClaudeCode\...` NOT read) | **not affected by `CLAUDE_CONFIG_DIR`**; if present they override your `--settings`; an unparseable managed source => exit 1 [MAN], [CL 2.1.259]. Env `CLAUDE_CODE_MANAGED_SETTINGS_PATH` exists in SDK source (UNVERIFIED) |
| Binary | `~/.local/bin/claude[.exe]` launcher -> `~/.local/share/claude/versions/<ver>`; lock files `~/.local/state/claude/`; staged downloads `~/.cache/claude/staging`; native installs **auto-update in the background** (kills/replaces version dirs; GH#74305-class issues). Set `DISABLE_AUTOUPDATER=1` (or `DISABLE_UPDATES`). | [SETUP], [ENV], [CL] |
| MCP project config | `<proj>/.mcp.json`; scopes local/project/user | [MCP] |

### 4.2 Settings layers (highest wins) [SET]
1. Managed (server-managed, MDM, `managed-settings.json`; highest). 2. `--settings`. 3. `.claude/settings.local.json`. 4. `.claude/settings.json`. 5. `~/.claude/settings.json`. Lists (e.g. `permissions.allow`) **merge** across layers. `--setting-sources` removes layers. Env vars are not a layer (pairwise rules). Settings are hot-reloaded; project/local `env` applies at `-p` startup without any trust dialog.

### 4.3 What a controller must NOT write
Official: "Don't delete `~/.claude.json`, `~/.claude/settings.json`, or `~/.claude/plugins/`" and keep `.credentials.json`, `agent-memory/`, `jobs/`, `daemon/` [DIR]. `.credentials.json` is managed via `/login`/`/logout` only [AUTH]. Transcript `.jsonl` format is internal; the auto-mode classifier has a rule blocking transcript tampering (2.1.205); concurrent processes rewrite `~/.claude.json` (a race that "silently reverted each other's changes" was fixed in 2.1.259, so external writers can still lose/corrupt data). `sessions/*` pid files and `history.jsonl` are bookkeeping. **My recommendation (not in official docs):** hudhud should never write to any of those; to configure, use `--settings`/`--mcp-config`/`--agents`/env vars or an isolated `CLAUDE_CONFIG_DIR` it fully owns. If it must edit `settings.json`, do it only inside its own sandbox config dir. Read access to transcripts (e.g. for history views) is plausible but format-unstable.

### 4.4 Isolated test sandbox recipe (to be validated)
Env for the child process: `CLAUDE_CONFIG_DIR=<abs tmp>/cfg`, `CLAUDE_CODE_TMPDIR=<abs tmp>/tmp`, set `HOME`/`USERPROFILE` to a temp dir too (profiles and `~/.local` live outside config dir), `DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (or `DISABLE_TELEMETRY=1`), unset `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_CHILD_SESSION` and other inherited `CLAUDE_*` vars (nested-session hangs and persistence loss: [GH#26190], [ENV] `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE`), unset `ANTHROPIC_API_KEY`/`AUTH_TOKEN` unless intended, cwd = an empty temp dir **outside any directory tree containing CLAUDE.md/.claude/.mcp.json** (parents are searched), `--setting-sources` (omit `user,project,local` as appropriate) and/or `--bare`/`--safe-mode`. Auth in the sandbox: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`; subscription only; not read in `--bare`) or `ANTHROPIC_API_KEY`, or `apiKeyHelper` via `--settings`. Remember managed settings and HKLM registry policy are outside the sandbox. [ENV], [AUTH], [HEAD]

---

## 5. Multiple ways to do the same thing (hudhud should expose each deliberately)

| Goal | Ways | Notes |
|---|---|---|
| Run non-interactively | `claude -p "<prompt>"`; piped stdin; positional; `--input-format stream-json` (with or without `-p`); `claude --bg` (daemon) | different lifecycle semantics |
| Get results | `--output-format text/json/stream-json`; read transcript `.jsonl`; `claude agents --json`/`claude logs <id>` (bg); hook events (`--include-hook-events`, HTTP hooks); OTEL | |
| Permissions | `--permission-mode`; `--allowedTools`/`--disallowedTools`; `--tools`; settings `permissions.*`; `--permission-prompt-tool <mcp>`; `--permission-prompt-tool stdio` (control protocol); `PermissionRequest` / `PreToolUse` hooks (incl. `defer`); `--permission-prompts none`; `set_permission_mode` control request; `update_settings`/`apply_flag_settings` control requests | |
| System prompt | `--system-prompt[-file]`, `--append-system-prompt[-file]`, `initialize{systemPrompt,appendSystemPrompt}`, CLAUDE.md, output styles (`/output-style`), `--agent`/`--agents` prompts, `--append-subagent-system-prompt` | |
| Model | `--model`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_MODEL`, `model` setting, `set_model` control request, `/model x` in `-p`, `--fallback-model`/`fallbackModel` setting, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` | precedence in [SET] |
| Thinking/effort | `--effort`, `CLAUDE_CODE_EFFORT_LEVEL`, `effortLevel` setting, `/effort`, `MAX_THINKING_TOKENS`, hidden `--thinking`/`--max-thinking-tokens`/`--thinking-display`, `set_max_thinking_tokens` | |
| MCP servers | `--mcp-config`(+`--strict-mcp-config`), `.mcp.json`, `claude mcp add` (user/local), plugin MCP, managed MCP, `mcp_set_servers` control request, SDK in-process servers (`sdkMcpServers` in initialize), `mcp_toggle` | `"type":"sdk"` entries in files are skipped (2.1.274) |
| Subagents | `--agents` (JSON or file), `.claude/agents/`, plugins, `initialize{agents}`, `--agent` | |
| Plugins | `--plugin-dir` (dir/zip/folder), `--plugin-url`, `CLAUDE_CODE_PLUGIN_DIRS`, `CLAUDE_CODE_PLUGIN_SEED_DIR`, `claude plugin install`, `initialize{plugins}` + `--await-initialize`, `reload_plugins` | |
| Config | `--settings` file/inline JSON, `--setting-sources`, `/config key=value` in `-p`, `CLAUDE_CONFIG_DIR`, `apply_flag_settings`, `--managed-settings` (hidden), managed files | |
| Session continuity | `--continue`, `--resume id/name/path`, `--session-id`, `--fork-session`, `/branch`, `--resume-session-at` (hidden), SessionStore mirror (`--session-mirror`), `--from-pr`, `claude attach` | |
| Stop a run | close stdin; `interrupt` control request; SIGINT; SIGTERM (143); `stop_task`; `CLAUDE_CODE_EXIT_AFTER_STOP_DELAY`; `--max-turns`, `--max-budget-usd` | |
| Budgets | `--max-budget-usd`, hidden `--task-budget`, `CLAUDE_CODE_MAX_TURNS`, `--max-turns`, `/goal` | |
| Disable persistence | `--no-session-persistence`, `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`, throwaway `CLAUDE_CONFIG_DIR` | |
| Auth | `claude auth login`, `CLAUDE_CODE_OAUTH_TOKEN` (+`CLAUDE_CODE_OAUTH_REFRESH_TOKEN`/`_SCOPES`), `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper`, Bedrock/Vertex/Foundry env, profiles/WIF, gateway; precedence list in [AUTH] (cloud provider > AUTH_TOKEN > API_KEY > apiKeyHelper > OAUTH_TOKEN > profile > /login) | |
| Minimal/locked-down | `--bare`, `--safe-mode`, `--restricted`, `--tools ""`, `--disallowedTools "*"`, sandbox settings, `permission-mode dontAsk` | |

---

## 6. Unexpected features worth knowing (changelog/docs)

- `PreToolUse` hook decision `"defer"` (2.1.89): headless session pauses at a tool call; result carries `deferred_tool_use`, `terminal_reason: tool_deferred`; continue with `claude -p --resume <id>` (hook re-evaluates). `CLAUDE_CODE_RESUME_PROMPT` overrides the continue text. [HOOKS], [CL]
- `claude mcp serve`: Claude Code itself as an MCP server. [MCP]
- `claude --bg` background sessions + supervisor daemon; `claude agents --json`, `attach`, `logs`, `respawn`; listing `CLAUDE_JOB_DIR`. [AV]
- Goal/loop/scheduling inside `-p`: `/goal`, `/loop`, `CronCreate`, `ScheduleWakeup` (waits at exit; `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, default 10 min idle ceiling), `Monitor` tool, Workflow tool (many subagents), background tasks keep a `-p` run alive after the final turn. A `-p` run may emit several results. [HEAD]
- In-process SDK MCP servers over the control channel (`mcp_message`) and hooks as callbacks (`hook_callback`): a controller can implement MCP tools and hooks in its own process without any external server. [SDKPKG]
- `set_model`, `set_permission_mode`, `apply_flag_settings`, `reload_plugins/skills`, `rewind_files`, `mcp_reconnect/toggle/set_servers` all hot-apply to a live session.
- `read_file` control request (host reads files via the CLI) and `register_repo_root` (adds a repo mid-session; fires `DirectoryAdded` hook). [SDKPKG], [CL 2.1.219]
- `transcript_mirror` stdout frames + SessionStore (external transcript storage; resume from store builds a temp `CLAUDE_CONFIG_DIR`). [SDKDOC session-storage]
- `system/init.capabilities` for feature detection (2.1.205+). `result_index` gap detection. `user_message_uuid(s)` correlation. `terminal_reason`.
- Env knobs: `CLAUDE_CODE_STARTUP_FAILURE_RESULTS`, `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`, `CLAUDE_CODE_MCP_STARTUP_WAIT_MS`, `MCP_CONNECTION_NONBLOCKING=true`, `CLAUDE_CODE_PROCESS_WRAPPER`, `CLAUDE_CODE_SHELL_PREFIX`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, `CLAUDE_CODE_USE_POWERSHELL_TOOL`, `CLAUDE_CODE_GIT_BASH_PATH`, `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC=1`, `CLAUDE_CODE_FORK_SUBAGENT`, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, `CLAUDE_CODE_DISABLE_CRON`, `CLAUDE_CODE_ACCOUNT_UUID/USER_EMAIL/ORGANIZATION_UUID` (give account info synchronously, 2.1.51), `CLAUDE_CODE_SESSION_ID` (injected into Bash/hook/MCP subprocesses), `CLAUDECODE=1` and `CLAUDE_CODE_CHILD_SESSION=1` (set in children). [ENV]
- **Undocumented env names present in the SDK bundle (416 names not in any doc page; semantics UNVERIFIED; do not rely).** Names with possible controller relevance: `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`, `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, `CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR`, `CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR` (secrets via inherited fd instead of env: would be ideal for hudhud if confirmed), `CLAUDE_CODE_HOST_CREDS_FILE`, `CLAUDE_CODE_AUTH_FAIL_EXIT_MS`, `CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES`, `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES`, `CLAUDE_CODE_EMIT_STARTUP_TIMING`, `CLAUDE_CODE_TEE_SDK_STDOUT`, `CLAUDE_CODE_SESSION_LOG`, `CLAUDE_CODE_DIAGNOSTICS_FILE`, `CLAUDE_CODE_DONT_INHERIT_ENV`, `CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG`, `CLAUDE_CODE_MANAGED_SETTINGS_PATH`, `CLAUDE_CODE_REMOTE_SETTINGS_PATH`, `CLAUDE_CODE_NO_MODEL_FALLBACK`, `CLAUDE_CODE_SUPERVISED`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_SESSION_NAME`, `CLAUDE_CODE_RESUME_FROM_SESSION`, `CLAUDE_CODE_SDK_READS_SESSION_STATE`, `CLAUDE_CODE_PROFILE_STARTUP`, `CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER`, `CLAUDE_CODE_MCP_SERVE_AUTH_TOKEN`, `CLAUDE_CODE_USE_GATEWAY` (changelog calls it "undocumented"), `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` (documented), `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_AGENT_SDK_CLIENT_APP`, `DEBUG_CLAUDE_AGENT_SDK`. The SDK sets `CLAUDE_CODE_ENTRYPOINT=sdk-ts` if unset (`sdk-cli`, `sdk-py` also valid; `cli` for interactive); entrypoint is used for telemetry/behavior (e.g. issue #97074 notes headless `sdk-cli` consumes the 5-hour usage window faster; UNVERIFIED).
- Rough edges: `claude --resume <running-bg-session>` attaches instead of loading (exit 1 when flags like `--permission-mode`/`--output-format` are present) [SESS]; `--continue` ignores prior `-p` sessions unless combined with `-p` [CLI].

---

## 7. Windows / Linux / macOS specifics

- Windows native: shell tool is Git Bash if Git for Windows is found (`CLAUDE_CODE_GIT_BASH_PATH`, must be `bash.exe`/`sh.exe`/`bash`/`sh`), else the PowerShell tool; `CLAUDE_CODE_USE_POWERSHELL_TOOL`; PowerShell tool passes `-ExecutionPolicy Bypass` (2.1.143). Credentials in `%USERPROFILE%\.claude\.credentials.json`. Unreadable stdin crashed print mode before 2.1.211 (fixed). Windows signals: Node `kill` semantics; the SDK escalates SIGTERM->SIGKILL after 5 s on Windows by calling `kill("SIGKILL")`. Stdio MCP servers on Windows: stdin closes first, process tree killed after 300 ms (2.1.296). Interactive `claude` with piped stdin exits 1 (use `-p`). UNC / network paths are refused for `--add-dir` (use mapped drive). Managed settings read from `<C>/Program Files\ClaudeCode` and HKLM/HKCU registry; native Windows does not support the command sandbox (WSL2 does) [SETUP].
- Possible hazard: [GH#74305] (closed by bot, reported not fixed): on Windows, running `claude -p` from a separate process while an interactive session runs killed the interactive session and hung the `-p` run (2.1.200/201); [GH#91987]: `-p` hangs at startup when a version-directory lock is contended by a concurrent interactive claude (open). Both suggest a controller on Windows should keep updates disabled and serialize against other claude processes. UNVERIFIED.
- Linux/macOS: `/tmp/claude-<uid>` temp, root refusal for bypass mode, macOS Keychain; launchd/zsh login-shell hang reports [GH#78903].
- Process hygiene: always pass explicit stdin (not inheriting) to avoid `-p` hangs when stdin is not provided (2.1.79 fix); piped stdin cap 10 MB; nested-claude env stripping as in 4.4; add a hard first-byte/idle watchdog because open hangs exist: [GH#99194] (stdout silent while transcript still advances), [GH#39700] (closed), [GH#86074] (no API request timeout; set `API_TIMEOUT_MS`).

---

## 8. Known open issues likely to affect hudhud (all UNVERIFIED re current status; check the issue pages)

| Issue | Summary |
|---|---|
| [GH#98713](https://github.com/anthropics/claude-code/issues/98713) | interrupt right after user msg ignored on later turns (open) |
| [GH#94741](https://github.com/anthropics/claude-code/issues/94741) | `result` key omitted after interrupt (open) |
| [GH#99194](https://github.com/anthropics/claude-code/issues/99194) | stdout silent while transcript still records assistant turns (open) |
| [GH#95726](https://github.com/anthropics/claude-code/issues/95726) | PreToolUse `ask` silently denied in stream-json because PermissionRequest hook never fires (open) |
| [GH#91982](https://github.com/anthropics/claude-code/issues/91982) | cross-session message emits no user frame on stdout (open) |
| [GH#89858](https://github.com/anthropics/claude-code/issues/89858) | MCP elicitation answered `decline` by hosts that never rendered a prompt (open) |
| [GH#99364](https://github.com/anthropics/claude-code/issues/99364) | `--remote-control` ignored in print/stream-json mode (open) |
| [GH#91987](https://github.com/anthropics/claude-code/issues/91987) | `-p` hangs when version-dir lock contended by interactive claude (open) |
| [GH#24594](https://github.com/anthropics/claude-code/issues/24594) | docs gap: `--input-format stream-json` format not documented for the CLI (closed unresolved); confirms hudhud relies on SDK-package knowledge |

---

## 9. Open questions needing empirical verification in a sandbox

1. Does `--input-format stream-json --output-format stream-json --verbose` work without `-p`, and what differs with `-p` added (exit behavior, trust prompts)?
2. Is an `initialize` control_request required on stdin? What happens if the first line is a bare `user` message? What does the CLI emit before/after (is `system/init` per turn or once; confirm it is emitted again each turn).
3. Exact `--output-format json` shape (single object vs array with `--verbose`).
4. Exit codes for: auth failure, `error_max_turns`, `error_max_budget_usd`, `is_error:true` success results, rate limit, stdin EOF mid-turn, SIGINT, kill on Windows.
5. Exact `--permission-prompt-tool <mcp>` request/response schema in 2.1.296 and `--permission-prompt-tool stdio` handshake without the SDK (are `can_use_tool` requests identical to the SDK types above?).
6. Does `CLAUDE_CONFIG_DIR` fully isolate on Windows: where does `.claude.json` land, any writes to `%USERPROFILE%` (`.claude.json`, `.local`, `AppData`), `%APPDATA%\Anthropic`, Credential Manager (`CLAUDE_CODE_FORCE_WINDOWS_CREDMAN` appears in SDK source), `HKCU`? Is `HOME`/`USERPROFILE` override also needed?
7. Which of the hidden flags work in the shipped CLI (`--thinking`, `--max-thinking-tokens`, `--session-mirror`, `--await-initialize`, `--managed-settings`, `--project-config-root`, `--task-budget`, `--debug-to-stderr`) and do the `*_FILE_DESCRIPTOR` env vars deliver secrets by fd (Windows semantics?).
8. Behavior of idle sessions: how long does a stream-json session stay alive with open stdin; `CLAUDE_CODE_EXIT_AFTER_STOP_DELAY`; keep_alive cadence; does the CLI exit on stdin EOF only after queued turns finish.
9. Interrupt semantics: reproduce [GH#98713]/[GH#94741]; whether `cancel_queued` and `still_queued` behave as typed; result subtype after interrupt; whether partial assistant message gets `aborted:true`.
10. Resume matrix: `-p --resume <id>` with different cwd; `--session-id` + `--resume` + `--fork-session`; resume by transcript path; whether `--session-id` on a brand new session honors the exact id for the transcript filename; behavior with `--no-session-persistence`.
11. Whether `--bare` + stream-json + `--permission-prompt-tool stdio` is the cleanest deterministic profile for tests (does `--bare` still emit `system/init` skills etc.; any need for API key in the sandbox).
12. Does the CLI refuse to start or behave differently when system-wide managed settings/registry policy exist on this Windows host (should be checked via `claude doctor`/`claude auth status` inside the sandbox only).
13. Auto-update race: confirm `DISABLE_AUTOUPDATER=1` prevents version-dir changes mid-run; behavior when two controller-spawned processes run concurrently (version lock contention, [GH#91987]).
14. Unicode/large message limits on stdin (the 146 KB report), CRLF line endings, and backpressure behavior (exit drain up to 30 s).
15. Windows process-tree kill: does terminating `claude.exe` leave Git Bash / MCP children orphaned; does closing stdin shut down children cleanly (2.1.296 notes MCP stdio shutdown improvements).
16. `rate_limit_event` frequency and fields for API-key vs subscription accounts; how a `rejected` status interacts with the `result` text.
