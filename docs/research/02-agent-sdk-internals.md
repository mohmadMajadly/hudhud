# 02 — Claude Agent SDK internals: is it a wrapper over the `claude` CLI subprocess?

Research date: 2026-10-12. Author: research agent for **hudhud**.
Scope: `@anthropic-ai/claude-agent-sdk` (TS), `claude-agent-sdk` (Python), `@anthropic-ai/claude-code` (CLI npm wrapper).
Method: tarballs downloaded with `npm pack --ignore-scripts` into empty directories and extracted with `tar`. Python SDK cloned from GitHub. **Nothing downloaded was executed or installed. The user's installed `claude` was not run, and `~/.claude` was not touched.**

---

## 0. TL;DR

**Yes. `query()` in both official SDKs spawns the Claude Code CLI as a child process.** The two sides exchange newline-delimited JSON (NDJSON) over stdin and stdout, multiplexing two things on the same stream:

- conversation messages (`user`, `assistant`, `system`, `result`, `stream_event`, ...);
- a bidirectional **control protocol** (`control_request`, `control_response`, `control_cancel_request`, `keep_alive`).

Since TS SDK 0.2.113 (2026-04-17), the CLI is a **native binary**. It is no longer bundled JS (`cli.js`). The SDK installs the binary as a per-platform optional dependency and pins it to the exact matching CLI version.

The SDK adds no inference or agent logic of its own on this path. It contributes:

- binary resolution;
- mapping options to argv, env and the `initialize` request;
- callback registries (permissions, hooks, in-process MCP, elicitation, dialogs, OAuth refresh);
- run-lifecycle logic that decides when stdin may be closed;
- error mapping and process cleanup;
- typed message definitions;
- helpers that read and write the session JSONL files directly.

Bottom line: hudhud can build on the raw subprocess protocol. The SDK's `sdk.d.ts` is the most complete public specification of that protocol. The Python SDK (MIT) is the most readable reference implementation.

---

## 1. Artifacts examined (exact versions and integrity)

| Package | Version | `dist.integrity` (npm, verified locally by re-hashing the tgz) | Published |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | **0.3.296** | `sha512-Y+cZ2BT8X94mQ9GJOVyIqhjC/nWGvwozUVLjdkzX7aSt+zuo5tgk7Hdv9V7tEUQ9fKnEuiL6moYNWDeHqCD4Lw==` | 2026-10-09T16:59Z |
| `@anthropic-ai/claude-code` | **2.1.296** | `sha512-OX/k/rpcthMqnFKOWcpNcbiLsMKtAjLOpQNJHlYiDCFUznWCIwdRTyl/p9SdHVrsrzZuPMCNqZjnpakIni6upw==` | 2026-10-09 |
| `@anthropic-ai/claude-agent-sdk-win32-x64` (metadata only, not downloaded) | 0.3.296 | `sha512-T71Y/hp0v7VtRzTOoxAsIkPa68JpB1d/VvCKTTE9GzTkbjQZHjs3S1DM06LDxSpwjITF7OCVJq14+XjN8M9t/g==` (unpacked 260,489,952 B) | |
| `@anthropic-ai/claude-code-win32-x64` (metadata only, not downloaded) | 2.1.296 | `sha512-g2aYBzYM5YTDio0ulAoGIGgtGRMa08WAecer4wuOUrKPwVPRfyRdmoZI01BNS8jF9yupDmQycBMuBcVui/VGNw==` (unpacked 260,489,946 B) | |
| Python `claude-agent-sdk` (git) | **0.2.165** (`_version.py`), bundles CLI **2.1.296** (`_cli_version.py`) | commit `b6e9d12fe1cc98dde988ab7b7713c1feeee50c6c` (2026-10-09, "chore: bump bundled CLI version to 2.1.296") | |

Local paths (scratchpad, untrusted data):

- `dl/claude-agent-sdk/package/` holds `sdk.mjs` (minified, 1.24 MB), `sdk.d.ts` (10,044 lines, readable), `core*.mjs`, `bridge.mjs`, `browser-sdk.js`, `extractFromBunfs.js`, `manifest.json` and `manifest.zst.json`.
- `dl/claude-code/package/` holds `bin/claude.exe` (a 500-byte shell stub), `install.cjs`, `cli-wrapper.cjs` and `sdk-tools.d.ts`.
- `dl/py/claude-agent-sdk-python/` is the Python SDK clone.
- `dl/web/` holds `ts-changelog.md`, `ts-license.md`, `ts-readme.md`, `legal.md` and `sdk-times.json`.

**Citation conventions.**
- `sdk.mjs` is minified (148 physical lines), so citations use `sdk.mjs L<line> @<char offset>`. Offsets were obtained by regex search.
- `sdk.d.ts` and the Python files use ordinary `file:line`.

`package.json` of the SDK declares `"claudeCodeVersion": "2.1.296"`. The SDK minor version tracks the CLI patch version (0.3.**296** ↔ 2.1.**296**). The changelog line on every release is "Updated to parity with Claude Code v2.1.N".

---

## 2. How the CLI is located and launched

### 2.1 The `@anthropic-ai/claude-code` npm package itself (2.1.296)

- The package contains no JS CLI. `package.json` `bin: {"claude": "bin/claude.exe"}`, and `optionalDependencies` lists `@anthropic-ai/claude-code-<platform>` for 8 platforms (`claude-code/package/package.json`).
- `bin/claude.exe` is a 500-byte shell-script **stub** that prints "claude native binary not installed" (`claude-code/package/bin/claude.exe`).
- The `postinstall` (`install.cjs`) hard-links or copies the platform binary over that stub (`install.cjs:105-145`, `:232-246`).
  - The comment explains the `.exe` trick: *"The .exe extension + no-shebang stub makes npm's cmd-shim … emit a direct exec on Windows"* (`install.cjs:232-235`).
- Fallback launcher: `cli-wrapper.cjs` runs `spawnSync(binaryPath, argv, {stdio:'inherit', env:{...process.env, CLAUDE_CODE_INSTALLED_VIA_NPM_WRAPPER:'1'}})` (`cli-wrapper.cjs:131-136`).
- Engines: `node >=22` for the CLI wrapper; `node >=18` for the SDK.

### 2.2 TS SDK binary resolution

**Default: the SDK's own platform package. There is no PATH lookup.**

- If `options.pathToClaudeCodeExecutable` is unset, `query()` calls `xq(resolve)`. That function resolves `@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]/claude[.exe]` via `createRequire(import.meta.url).resolve` (`sdk.mjs L136 @1156059`).
  - On Linux it tries musl first or glibc first, depending on `process.report` glibc detection (`mGe`).
- If resolution fails, it throws *"Native CLI binary for ${platform}-${arch} not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable."* (`sdk.mjs L142`, near `v_=d.pathToClaudeCodeExecutable`).
- **The TS SDK never falls back to a globally installed `claude`.** (Verified: there is no `which`/PATH logic near the resolver.)
- **Native versus JS (`cGe`):** if the path ends in `.js/.mjs/.ts/.tsx/.jsx`, the SDK runs `executable` (default `"bun"` under Bun, otherwise `"node"`) with `[...executableArgs, path, ...args]`. Any other path is executed directly with `[...executableArgs, ...args]` (`sdk.mjs L136 @1154122`, `getDefaultExecutable` @~1145000).
- **Spawn call** (`spawnLocalProcess`, `sdk.mjs L136 @~1145300`):
  - Code: `spawn(command, args, { cwd, stdio: ["pipe","pipe","pipe"], signal, env, windowsHide: true })`. This uses `child_process.spawn` (`import{spawn as tGe}from"child_process"`, `@1133715`).
  - **No `shell` option.** Node's default is `shell:false`, so no cmd.exe hop on Windows.
  - Consequence: a `.cmd` shim would be refused by Node itself (EINVAL, after the CVE-2024-27980 fix). That case cannot arise with the default resolver. **UNVERIFIED** for user-supplied `.cmd` paths.
- `spawnClaudeCodeProcess(opts)` is an option that replaces local spawning entirely (VMs, containers, remote hosts). It must return a `SpawnedProcess` (stdin, stdout, kill, exit events) (`sdk.d.ts:2453-2463`, `:9542`). The SDK's protocol logic therefore needs only a duplex byte stream.
- `bun build --compile` users must extract the binary themselves and pass the path explicitly (`README.md`, `/extract` export).

### 2.3 Python SDK binary resolution (`subprocess_cli.py`)

Lookup order in `_find_cli` (`subprocess_cli.py:255-339`):

1. The bundled binary at `claude_agent_sdk/_bundled/claude[.exe]` (`:341-354`). Platform wheels ship it.
2. `shutil.which("claude")`. On Windows a native `.exe`/`.com` is preferred over a `.cmd` shim (`:262-283`).
3. Well-known locations. On Windows only `~/.local/bin/claude.exe` (`:285-296`). On POSIX: `~/.npm-global/bin`, `/usr/local/bin`, `~/.local/bin`, `~/node_modules/.bin`, `~/.yarn/bin`, `~/.claude/local/claude` (`:298-305`).

Windows hardening:

- `.bat`/`.cmd` is refused anywhere in the path (BatBadBut, CVE-2024-27980) (`:366-448`).
- cmd.exe metacharacters `&|<>^%!"` and CR/LF are rejected in `resume`, `session_id`, `resume_session_at` and `resume_drops_turn` (`:450-471`).

Version probe:

- Runs `[cli, "-v"]` with a 2 s timeout before the real spawn and warns if the version is below 2.0.0 (`:1164-1224`).
- Skipped when `CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK` is set (`:809`).

Spawn:

- Code: `anyio.open_process(cmd, stdin=PIPE, stdout=PIPE, stderr=PIPE-or-inherit, cwd=cwd, env=env, user=options.user)` (`:873-881`). There is no shell.
- stderr is piped only if a `stderr` callback was given (`:870-871`).

> hudhud implication: the Python SDK *can* end up running the user's globally installed `claude.exe` (e.g. `<home>/.local/bin/claude.exe`). The TS SDK runs only its own pinned binary unless told otherwise.

### 2.4 argv built by the SDK

The TS SDK builds argv in `ProcessTransport.initialize()` (`sdk.mjs L136 @1144305`). Python builds it in `_build_command` (`subprocess_cli.py:570-795`).

**Always passed:**
- TS: `--output-format stream-json --verbose --input-format stream-json`.
- Python: `--output-format stream-json --verbose … --input-format stream-json`.
- The SDK **always runs in streaming-input mode**, even for a string prompt. The prompt is written to stdin as a `user` message after `initialize` (`_internal/client.py:177-198`).

**Options mapped to flags (TS):**

| SDK option | CLI flag |
|---|---|
| thinking | `--thinking=adaptive` / `--thinking=disabled` / `--max-thinking-tokens=N` |
| thinking display | `--thinking-display=` |
| effort | `--effort=` |
| maxTurns | `--max-turns=` |
| maxBudgetUsd | `--max-budget-usd=` |
| taskBudget | `--task-budget=` |
| model | `--model=` |
| agent | `--agent=` |
| betas | `--betas=` |
| JSON schema | `--json-schema=` |
| debug | `--debug` / `--debug-file=` |
| **canUseTool set** | **`--permission-prompt-tool=stdio`** (this is what makes the CLI send `can_use_tool` control requests) |
| permissionPromptToolName | `--permission-prompt-tool=<mcp tool>` (mutually exclusive with canUseTool) |
| permissionPrompts | `--permission-prompts=` |
| continue | `--continue` |
| resume | `--resume=` |
| channels | `--channels=` |
| allowedTools | `--allowedTools=a,b` |
| disallowedTools | `--disallowedTools=` |
| tools | `--tools=` / `--tools=default` |
| non-SDK MCP servers | `--mcp-config {"mcpServers":{...}}` |
| settingSources | `--setting-sources=` |
| strictMcpConfig | `--strict-mcp-config` |
| permissionMode | `--permission-mode=` |
| allowDangerouslySkipPermissions | `--allow-dangerously-skip-permissions` |
| fallbackModel | `--fallback-model=` |
| includeHookEvents | `--include-hook-events` |
| includePartialMessages | `--include-partial-messages` |
| session store | `--session-mirror` |
| projectConfigRoot | `--project-config-root=` |
| additionalDirectories | `--add-dir=` (repeated) |
| plugins | `--await-initialize` (plugins then go via `initialize`), or `--plugin-dir=` / `--plugin-dir-no-mcp=` |
| forkSession | `--fork-session` |
| resumeSessionAt | `--resume-session-at=` |
| resumeDropsTurn | `--resume-drops-turn=` |
| sessionId | `--session-id=` |
| persistSession false | `--no-session-persistence` |
| managedSettings | `--managed-settings` |
| settings (merged with sandbox) | `--settings <json|path>` |
| extraArgs | arbitrary `--k[=v]` |

**Injection guard:** named options use the `--flag=value` form (`je()`). Free-form values use `p_()`, which switches to `=` form if the value starts with `-` (`sdk.mjs L136 @1138542`). This was introduced in 0.3.295 (changelog: "values of its named options are now sent in the same argument as their flag"). Python does the same for `--resume`, `--session-id` and dash-leading `extra_args` (`subprocess_cli.py:642-655`, `:740-755`).

**Skill names** are validated before being formatted into `Skill(name)` rules, because the `--allowedTools` tokenizer splits on commas and spaces outside parentheses (`sdk.mjs L136 @1139274`; `subprocess_cli.py:71-160`). Python changelog 0.2.129 calls the previous behaviour an `--allowedTools` injection.

**Python differences:**
- When `system_prompt` is `None`, Python passes `--system-prompt ""` (no default Claude Code prompt), along with `--system-prompt-file` / `--append-system-prompt`.
- Python passes in-process ("sdk") MCP servers **inside** `--mcp-config` as `{"type":"sdk","name":…}` with `instance` stripped (`:667-692`).
- TS instead keeps SDK servers out of `--mcp-config` and lists them in `initialize.sdkMcpServers` (`sdk.mjs L142 @1213597`, `PT` vs `IT`).
- Both mechanisms are accepted by CLI 2.1.296. **UNVERIFIED** which one is canonical going forward.

**Large config via stdin:** agents, hooks, the system prompt (TS), skills and (optionally) plugins go in the `initialize` control request rather than argv. The comment in `subprocess_cli.py:233-235` and TS `buildInitializeRequest` give the reason: command-line length limits on Windows.

### 2.5 Environment

TS (`sdk.mjs L136 @1144305` tail and `L142 @1213597`):

- `env` defaults to `{...process.env}`. If `options.env` is given it **replaces** `process.env` entirely (changelog 0.2.113, "Breaking").
- `CLAUDE_CODE_ENTRYPOINT=sdk-ts` is set if absent.
- `CLAUDE_AGENT_SDK_VERSION=0.3.296` is set.
- `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true` is set if checkpointing is enabled.
- `CLAUDE_CODE_SDK_READS_SESSION_STATE=1` is set unless the caller set it. It asks the CLI for `session_state_changed` frames marked `sdk_host_only`.
- Set when the corresponding callbacks exist: `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH=1`, `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH=1`.
- AskUserQuestion knobs: `CLAUDE_CODE_QUESTION_*`.
- OTEL `TRACEPARENT` / `TRACESTATE` are injected from the active span.
- `CLAUDE_CONFIG_DIR` (and on Windows `CLAUDE_SECURESTORAGE_CONFIG_DIR`) when a config dir is set.
- **`NODE_OPTIONS` is deleted.** `DEBUG` is deleted unless `DEBUG_CLAUDE_AGENT_SDK` is set.

Python (`subprocess_cli.py:814-868`):

- Inherits `os.environ` **minus `CLAUDECODE`** (so the child does not think it is nested), sets `CLAUDE_CODE_ENTRYPOINT=sdk-py`, merges `options.env`, then sets `CLAUDE_AGENT_SDK_VERSION`.
- Sets `CLAUDE_CODE_SDK_READS_SESSION_STATE=1`, optional checkpointing, OTEL context, and `PWD=cwd`.

### 2.6 Working directory and stdio

- `cwd` is `options.cwd`, or the inherited cwd if unset. Python also sets `PWD`.
- stdio is `pipe/pipe/pipe` (TS). Python pipes stderr only with a callback.
- TS keeps a 2,048-char stderr tail (`eT=2048`) that it appends to exit errors (`formatStderrTail`). It forwards stderr chunks to `options.stderr` and to its debug log.
- TS defers the "exit" event until stderr has drained, or 200 ms (`iGe`) after exit (`sdk.mjs L136 @1138772`).

---

## 3. Stream framing and parsing

- **Format:** NDJSON in both directions, one JSON object per line, terminated by `\n`. `sdk.d.ts:9640` (`StdoutMessage`) states: *"exactly one StdoutMessage per line, as a single JSON object. Besides the SDKMessage members this includes the control protocol - control requests the CLI originates, control responses to the client's requests, cancellations and keep-alives."*

**TS reader** (`readMessages`, `sdk.mjs L136 @1150230`+):
- Uses Node `readline.createInterface({input: stdout})`.
- Skips blank lines. Non-JSON lines are **logged and skipped** (`Non-JSON stdout: …`).
- **No max line length.** readline buffers unbounded, so a huge line grows memory (**UNVERIFIED** as a practical risk).
- After EOF it awaits process exit and raises the exit error.

**Python reader** (`subprocess_cli.py:163-221`, `:1101-1162`):
- A custom `_LineFramer` reassembles lines across chunk boundaries.
- Lines not starting with `{` are skipped (e.g. `[SandboxDebug]`, issue #347). A line that starts with `{` but fails to parse **raises** `CLIJSONDecodeError`.
- **`max_buffer_size` defaults to 1 MiB per message** (`:36`, `:1110-1127`). Exceeding it raises.
- A trailing partial line at EOF is dropped if unparseable.
- A non-zero exit code raises `ProcessError`.

Writes (both SDKs): `JSON.stringify(obj) + "\n"` to stdin. Python serialises writes with a lock (`:1063-1087`).

Message routing on stdout (TS `Query.readMessages`, `sdk.mjs L136 @1162283`; Python `query.py:388-506`):

| `type` | Action |
|---|---|
| `control_response` | Resolve the pending request by `response.request_id`. TS keeps a bounded LRU of unmatched responses. |
| `control_request` | Dispatch to a handler (§4.3). Concurrent; one AbortController per request_id; duplicate in-flight ids are ignored. |
| `control_cancel_request` | Abort the in-flight handler for that request_id. No response is written. |
| `keep_alive` | Ignore. |
| `transcript_mirror` | Hand to the SessionStore batcher; not yielded. |
| `system/session_state_changed` | Track `idle` / `running` / `requires_action`. Swallowed if `sdk_host_only:true`. |
| `result` | Turn ended. Decides whether the *run* ended (§6). Records error text. |
| everything else | Yielded to the caller as `SDKMessage`. |

---

## 4. The control protocol — full message catalog

Unless noted otherwise, every shape below comes from `sdk.d.ts` (TS 0.3.296). Python's subset is in `types.py:2790-2895`.

### 4.1 Envelopes (`sdk.d.ts:380-420`, `5026-5086`, `3921-3930`, `5313-5318`)

```jsonc
// either direction
{"type":"control_request","request_id":"<sender-chosen, unique among its in-flight>","request":{"subtype":"...", ...}}
// reply (exactly one per request, except documented exceptions)
{"type":"control_response","response":{"subtype":"success","request_id":"...","response":{...}?, "pending_permission_requests"?:[...], "pending_user_dialog_requests"?:[...]}}
{"type":"control_response","response":{"subtype":"error","request_id":"...","error":"human text", /* error_code? (TS checks /^[a-z][a-z0-9_]{0,63}$/) */}}
// withdraw own in-flight request; no reply
{"type":"control_cancel_request","request_id":"..."}
// heartbeat, either side, ignore
{"type":"keep_alive"}
```

Request ids:
- TS uses `Math.random().toString(36).substring(2,15)` (`sdk.mjs L138 @1182557`).
- Python uses `req_<counter>_<8 hex>` (`query.py:719-720`).
- Hook callback ids are `hook_<n>`.

Timeouts:
- TS has **no default timeout** on control requests. It supports an AbortSignal, which sends `control_cancel_request`. `startup()` and `prewarm()` accept `initializeTimeoutMs`.
- Python times out at 60 s by default; `initialize` uses `max(CLAUDE_CODE_STREAM_CLOSE_TIMEOUT/1000, 60)` s (`_internal/client.py:131-135`, `query.py:706-751`).

Before `initialize` is written, TS queues every other write behind it (`writeAfterInitialize`, `initializeWritten`).

### 4.2 Host → CLI requests (SDK-originated)

"Public" means the subtype is in `SDKControlRequestInner` (`sdk.d.ts:5040`). "Internal" means it appears only in `sdk.mjs` (`subtype:"…"` literals), so its shape is **UNVERIFIED**.

| subtype | Request fields | Success `response` | Notes / source |
|---|---|---|---|
| `initialize` | `hooks?: {Event: [{matcher?, hookCallbackIds[], timeout?}]}`, `sdkMcpServers?: string[]`, `sdkMcpServerConfigs?`, `sdkMcpServerManifests?`, `sdkMcpServerManifestsOrigin?`, `jsonSchema?`, `systemPrompt?: string[]`, `appendSystemPrompt?`, `systemPromptSnapshot?`, `planModeInstructions?`, `toolAliases?`, `excludeDynamicSections?`, `agents?`, `title?`, `skills?`, `promptSuggestions?`, `agentProgressSummaries?`, `forwardSubagentText?`, `supportedDialogKinds?`, `perTaskStopAffordance?`, `plugins?` | `commands[]`, `agents[]`, `output_style`, `available_output_styles[]`, `models[]`, `account`, `hooks_applied?`, `plugins_applied?`, `sdk_mcp_manifests_parked?`, `claude_code_version?`, `fast_mode_state?` (`sdk.d.ts:4501-4638`). The envelope also carries `pending_permission_requests` / `pending_user_dialog_requests` (CLI ≥ 2.1.268). | Mandatory first request. Idempotent since 0.3.161. A repeat re-registers hooks over stdio. TS also sends undocumented fields `appendSubagentSystemPrompt`, `webSearchIsolationExemptMcpServers`, `rapidFollowupPreempt`, `forwardNestedSubagentToolCalls`, `workspaceTrust` (`sdk.mjs L138 @1172883`). Python sends only `hooks`, `agents`, `excludeDynamicSections`, `systemPromptSnapshot`, `skills`, `forwardSubagentText` (`query.py:309-363`). |
| `interrupt` | `cancel_queued?: boolean` | `{still_queued: string[], cancelled?: string[]}` (capability `interrupt_receipt_v1` / `interrupt_cancel_queued_v1`) | `sdk.d.ts:4643-4670` |
| `set_permission_mode` | `mode: 'default'\|'acceptEdits'\|'bypassPermissions'\|'plan'\|'dontAsk'\|'auto'` | `{}` | `bypassPermissions` requires launch with `--allow-dangerously-skip-permissions` (`sdk.d.ts:5139-5146`) |
| `set_model` | `model?: string\|null` (`null`, omitted or `'default'` resets) | `{}` | Invalid models rejected since 0.3.200 |
| `set_max_thinking_tokens` | `max_thinking_tokens?: number\|null`, `thinking_display?` | `{}` | `sdk.d.ts:5117-5121` |
| `apply_flag_settings` | `settings: Record<string,unknown>` | `{}` | Merges into the flag settings layer (`:3897`) |
| `update_settings` | `source: 'localSettings'\|'userSettings'`, `settings` | `{}` | **Writes settings files.** Allowlisted keys only (`:5159-5166`). |
| `get_settings` | – | effective plus per-source settings | `:4241` |
| `mcp_status` | – | MCP server statuses | `:4814` |
| `mcp_set_servers` | `servers: Record<name, McpServerConfig>` | status | Replaces dynamically managed servers (`:4803`) |
| `mcp_reconnect` | `serverName` | `{}` | camelCase on the wire (`:4795`) |
| `mcp_toggle` | `serverName`, `enabled` | `{}` | `:4821` |
| `mcp_call` | `tool: "mcp__srv__tool"`, `arguments?`, `expires_at?`, `timeout_ms?`, `input_files?`, `output_files?` | tool result (+ `staging`) | **"No permission check (control channel is trusted)"**. SDK-type servers are rejected (`:4697-4744`). |
| `mcp_read_resource` | `serverName`, `uri` (`ui://` only) | `{contents[]}` | `:4761-4790` |
| `mcp_message` (host→CLI) | `server_name`, `message: JSONRPCMessage` | empty ack | Used by the SDK to deliver *server-initiated* MCP messages from an in-process server (`sendMcpServerMessageToCli`, `sdk.mjs L141 @1191414`) |
| `rewind_files` | `user_message_id`, `dry_run?` | – | Needs checkpointing enabled (`:5091`) |
| `cancel_async_message` | `message_uuid` | `{cancelled: boolean}` (**UNVERIFIED**) | `:3916` |
| `seed_read_state` | `path`, `mtime` | `{}` | `:5100` |
| `stop_task` | `task_id` | `{}` (success even if already gone) | `:5151` |
| `background_tasks` | `tool_use_id?` | `{backgrounded?: boolean}` | Ctrl+B equivalent (`:3905`) |
| `get_task_output` | `task_id` | `{output, total_bytes, truncated}` | Last 8 KiB (`:4248-4272`) |
| `get_context_usage` | `detail?: 'summary'\|'full'` | large breakdown (`:3975-4080`) | |
| `get_usage` | `skip_behaviors?` | session cost plus plan rate limits (`:4277-4496`) | Experimental |
| `get_session_cost` | – | formatted text | `:4234` |
| `get_hooks_listing` | – | hooks listing (`:4085-4229`) | |
| `list_models` | – | model catalog | `:4675` |
| `list_permission_rules` | – | `{state:{rules, workspaceDirectories, originalCwd, managedOnly, errors?}}` | `:4682-4899` |
| `get_binary_version` | – | version | `:3968` |
| `file_suggestions` | `query` | suggestions | `:3960` |
| `read_file` | `path`, `max_bytes?`, `encoding?` | `{contents, absPath, truncated?, encoding?}` | Gated by Read permission rules (`:4904-4927`) |
| `register_repo_root` | `directory`, `reload_*?` | – | `:4932` |
| `reload_plugins` | `hold_on_cache_impact?` | commands, agents, plugins, mcpServers, … | `:4957-4994` |
| `reload_skills` | – | `{skills}` | `:4999` |
| `reload_output_styles` | – | `{available_output_styles}` | `:4943` |
| `rename_session` | `title`, `source?`, `session_id?` | `{}` | `:5013` |
| `set_color` | `color` | `{}` | `:5109` |
| **Internal** (in `sdk.mjs`, not in the public union) | | | `set_mcp_permission_mode_override` (public method `setMcpPermissionModeOverride`, `sdk.d.ts` Query), `set_cwd`, `set_prompt_suggestions_paused`, `side_question` (has `system/control_request_progress`), `generate_session_title`, `export_conversation`, `get_plan`, `get_status`, `get_*_dialog` (skills/sandbox/memory/chrome), `get_chrome_browsers`, `select_chrome_browser`, `set_chrome_browser_hints`, `claude_authenticate`, `claude_oauth_callback`, `claude_oauth_wait_for_completion`, `mcp_authenticate`, `mcp_oauth_callback_url`, `mcp_clear_auth`, `claim_session`, `channel_enable`, `remote_control`, `submit_feedback`, `message_rated`, `ultrareview_launch`, `rewind_conversation` (changelog 0.3.186). Shapes **UNVERIFIED**: treat as unstable. |

### 4.3 CLI → host requests (the host must answer)

| subtype | Request fields | Host reply (`response`) | SDK mapping |
|---|---|---|---|
| `can_use_tool` | `tool_name`, `input`, `tool_use_id`, `permission_suggestions?: PermissionUpdate[]`, `blocked_path?`, `decision_reason?` (may contain ANSI; sanitize), `decision_reason_type?`, `classifier_approvable?`, `suppress_always_allow_rule?`, `default_to_no?`, `matched_ask_rule?`, `title?`, `display_name?`, `description?`, `agent_id?`, `mcp_server?`, `requires_user_interaction?` (`sdk.d.ts:4830-4879`) | `{behavior:'allow', updatedInput?, updatedPermissions?, toolUseID?}` or `{behavior:'deny', message, interrupt?, toolUseID?}` (`sdk.d.ts:2526-2538`). Over 4,096 `updatedPermissions` counts as a deny (0.3.295). | TS `canUseTool(name, input, {signal, suggestions, …, requestId})`. TS appends `toolUseID`. Python fills `updatedInput` with the original input when it is `None` (`query.py:586-638`). **Only sent if launched with `--permission-prompt-tool=stdio`.** |
| `hook_callback` | `callback_id`, `input: HookInput`, `tool_use_id?` | `HookJSONOutput`, i.e. `{continue?, suppressOutput?, stopReason?, decision?, systemMessage?, reason?, hookSpecificOutput?}` or async form (`sdk.d.ts:9719+`) | Callback looked up by id registered in `initialize.hooks`. Python renames `async_`/`continue_` (`query.py:113-129`). |
| `mcp_message` | `server_name`, `message` (JSON-RPC request or notification) | `{mcp_response: <JSON-RPC response>}`. For notifications TS returns `{jsonrpc:'2.0',result:{},id:0}`, Python `{jsonrpc:'2.0',result:{}}`. | Routed to the in-process MCP server (§5) |
| `elicitation` | `mcp_server_name`, `message`, `mode?`, `url?`, `elicitation_id?`, `requested_schema?`, `title?`… (`:3935`) | `ElicitationResult` (e.g. `{action:'accept'\|'decline'\|'cancel', content?}`) | Without `onElicitation`, TS answers `{action:'decline'}` |
| `request_user_dialog` | `dialog_kind`, `payload`, `tool_use_id?` (`:5064`) | dialog-specific | Only kinds declared in `initialize.supportedDialogKinds` are sent. An unhandled kind must **not** be answered (TS stays silent). |
| `oauth_token_refresh` (internal) | – | `{accessToken, reason?}` | `getOAuthToken` callback. Env `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH=1`. |
| `host_auth_token_refresh` (internal) | – | `{authToken}` | `getHostAuthToken` |
| `remote_control_work_secret` (internal) | `session_id` | `{work_secret}` | remote-control |
| `ui_copy`, `ui_prompt_read`, `ui_prompt_fill`, `ui_prompt_suggest`, `ui_read_selection` (internal) | – | – | `uiHost` |
| `remote_tool_call`, `remote_plumbing_call`, `remote_tools_probe`, `remote_tools_reannounce` | – | **left unanswered** by the SDK on purpose (`Pq`, `sdk.mjs L136 @1156059`) | |

Source: TS dispatcher `processControlRequest` (`sdk.mjs L136 @1166362`).
- An unknown subtype gets `error: "Unsupported control request subtype: …"`.
- A handler that throws gets `subtype:"error"`.
- A handler that returns the sentinel `lc` gets no reply at all.

### 4.4 Other stdin and stdout frames relevant to the protocol

- **stdin `user` message.** Shape (`sdk.d.ts:6311+`; Python `_internal/client.py:184-189`):
  ```json
  {"type":"user","message":{"role":"user","content":"..."|[blocks]},"parent_tool_use_id":null,"session_id":""}
  ```
  - Optional fields: `uuid`, `priority:'now'|'next'|'later'`, `client_composed:true` (verbatim: no `@path` expansion or slash commands, CLI ≥ 2.1.248), `shouldQuery`, `isSynthetic`, `pasted_content` (max 1000), `agent_id`.
- **`system/init`.** Carries `session_id`, `cwd`, `tools`, `mcp_servers`, `model`, `permissionMode`, `apiKeySource`, `claude_code_version`, and `capabilities?: string[]` (e.g. `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `mcp_read_resource_v1`, `sdk_mcp_manifests`). Use these to feature-detect instead of checking the version (`sdk.d.ts:5973-6080`).
- **`result`.** `subtype: 'success' | 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries'`, plus `is_error`, `errors[]`, `result`, usage and cost (`sdk.d.ts:5731`, `5789`).
- **Others:** `system/session_state_changed` (`idle` / `running` / `requires_action`), `system/control_request_progress`, `stream_event` (with `--include-partial-messages`), and the hook / task / rate-limit / `command_lifecycle` frames in the `SDKMessage` union (`sdk.d.ts:5383`).

### 4.5 Handshake sequence (observed in code)

1. The host spawns the CLI with the flags above. Stdin stays open.
2. The host writes the `control_request` `initialize` (TS: immediately in the `Query` constructor; Python: after `start()`).
3. The CLI replies with a `control_response` success carrying commands, models, account and so on.
   - With in-process MCP servers, the CLI may interleave `mcp_message` requests (`initialize`, `tools/list`) before or after this point. TS can pre-capture manifests so these round trips are skipped.
4. The host writes `user` message(s).
5. The CLI streams `system/init`, `assistant`, `user` (tool results), `stream_event`, …, then `result`. It interleaves `can_use_tool`, `hook_callback` and `mcp_message` control requests and waits for their responses.
6. The host closes stdin when the run is over (§6). The CLI flushes the session file and exits 0. A non-zero exit follows an `is_error` result.

---

## 5. In-process ("SDK") MCP servers

- **API:** `tool(name, description, zodShape, handler)` plus `createSdkMcpServer({name, version, tools})` yields `{type:'sdk', name, instance: McpServer}` (`sdk.d.ts:619`, `:9821`).
- **TS bridge** (`sdk.mjs L136 @1156059`, class `oT`; `L141 @1191414`):
  - A minimal MCP `Transport` whose `send()` turns the server's outbound JSON-RPC into a host→CLI `control_request{subtype:'mcp_message'}`. Responses are matched to pending requests by `${server}:${id}`.
  - Inbound `mcp_message` from the CLI is delivered with `transport.onmessage(msg)`. For requests the SDK awaits the server's response and returns `{mcp_response}`.
  - MCP protocol version `"2025-11-25"`. clientInfo is `claude-code`.
- **Manifest pre-capture (TS only, 0.3.281+):**
  - The SDK runs `initialize` + `notifications/initialized` + `tools/list` against its own server.
  - It sends the results in `initialize.sdkMcpServerManifests`, so the CLI answers its own MCP client from that cache (`sdk.d.ts:4516-4531`).
  - The host must still answer `mcp_message` normally.
- **Python bridge** (`_internal/sdk_mcp_bridge.py`):
  - Runs a real `mcp.server.Server` over mcp's in-memory streams.
  - Server-initiated notifications are **dropped**, and server-initiated requests (sampling, roots, elicitation) are **refused** (`sdk_mcp_bridge.py:97-106`). The TS SDK forwards them.
- **Per-server tool timeout:** `sdkMcpServerConfigs[name].timeout` (ms, ≥ 1000), otherwise the `MCP_TOOL_TIMEOUT` env var.
- **What this means for hudhud:** hosting tools in-process needs only (a) an MCP server implementation, (b) answering `mcp_message`, and (c) declaring the server. Declaring is done either with `initialize.sdkMcpServers: [name]` (TS style) or with `{"type":"sdk","name":…}` in `--mcp-config` (Python style). Nothing requires the SDK.

---

## 6. Run lifecycle, abort, interrupt, termination

### 6.1 When to close stdin

This is the subtlest part, and it is the SDK's main value-add.

A `result` ends one **turn**, not necessarily the **run**. Background agents can wake the session for follow-up turns, and those turns need stdin to answer `can_use_tool`, `hook_callback` and `mcp_message`. Closing stdin early makes those requests fail CLI-side with **"Stream closed"** (issues #1088 and #1190; changelog 0.1.64 and 0.3.284).

The SDK keeps stdin open while it has "bidirectional needs". It closes stdin when:

- the CLI reports `session_state_changed: idle` after a result; or
- a "run-end ceiling" expires. The ceiling is `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, default 600,000 ms, `0` meaning unlimited. It counts only between turns.

The ceiling is paused by `requires_action` and by tracked `local_agent`/`local_workflow` tasks. Sources:
- TS: `sdk.mjs L140 @1188678` (`streamInput`, `endRun`, `armRunEndCeiling`) and `L136 @1159003` (`hasBidirectionalNeeds` = SDK MCP servers ∥ hooks ∥ canUseTool ∥ onElicitation ∥ onUserDialog ∥ OAuth / host-auth / work-secret callbacks).
- Python: `query.py:38-60`, `:870-1091`.

For a single string prompt (`isSingleUserTurn`), TS closes stdin as soon as the run ends.

### 6.2 Interrupt

`control_request {subtype:'interrupt'}` aborts the current turn without killing the process. Queued messages survive unless `cancel_queued:true` is set.

### 6.3 Abort and close (TS `ProcessTransport.close()`, `sdk.mjs L136 @1150230`)

1. `stdin.end()`. EOF is the graceful shutdown signal.
2. After **2,000 ms** (`sGe`), if the child is still alive:
   - **POSIX:** `kill('SIGTERM')`, then after 5,000 ms `kill('SIGKILL')`.
   - **Windows:** wait a further 5,000 ms, then `kill('SIGKILL')`. Node implements this as `TerminateProcess` on the **direct child only**.
3. No process-group or process-tree kill exists anywhere. On Windows, grandchildren (shell tools, stdio MCP servers) rely on the CLI's own cleanup. **UNVERIFIED** whether any orphans remain.
4. `abortController` abort leads to `close()`. The SDK also passes `signal` to `spawn`; Node's abort-kill sends `SIGTERM` by default.
5. **Parent-exit reaper** (`Rq`, `sdk.mjs L136 @1138772`): `process.on('exit')`. On POSIX it sends `SIGTERM` to tracked children. **On Windows it only ends stdin** (`e.stdin.end()`).
6. `Query.cleanup` aborts in-flight handlers, rejects pending requests ("Query closed before response received"), closes the MCP transports, and waits ≤ 2 s for exit.

### 6.4 Python `close()` (`subprocess_cli.py:962-1061`)

- Runs under a shielded cancel scope.
- Closes stdin, waits 5 s, then `terminate()`, waits 5 s, then `kill()`, waits 5 s (~20 s worst case).
- An `atexit` handler sends SIGTERM (`terminate` on Windows) to live children (`:54-68`).

### 6.5 Error mapping

| Condition | TS | Python |
|---|---|---|
| Non-zero exit | `Error("Claude Code process exited with code N. stderr: <tail>")`, errorClass `process_exited_nonzero` | `ProcessError(exit_code, stderr)` |
| Killed by signal | `…terminated by signal SIGX` | – |
| Spawn ENOENT | "native binary not found at …" (`executable_not_found`) | `CLINotFoundError` |
| Exists but cannot launch | libc-mismatch hint (`executable_launch_failed`) | – |
| Abort | `AbortError` ("Claude Code process aborted by user") | – |
| Exit after an `is_error` result | The exit error is **replaced** with `Error("Claude Code returned an error result: <result or errors[]>")` (`sdk.mjs L136 @1162283`) | `ResultError` (`query.py:512-554`) |
| Control-request failure | `Error(msg)` with optional `errorCode` (`control_request_failed`) | Plain `Exception(msg)` |
| Write after exit | "Cannot write to terminated process" | `CLIConnectionError` |
| Bad JSON line | skipped | `CLIJSONDecodeError` |

Python additionally has `CLIConnectionError`.

Usage-limit and policy texts are exported as string prefixes (`USAGE_LIMIT_ERROR_PREFIXES`, etc., `sdk.d.ts:9916-9934`). These are string matching, which is brittle.

---

## 7. Sessions

- **Persistence lives in the CLI.** It writes JSONL transcripts under `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<sanitized-cwd>/<session-id>.jsonl` (`sdk.mjs` `ct()=join(configDir,"projects")`).
- **Resume and fork** are CLI flags: `--resume`, `--continue`, `--fork-session`, `--session-id`, `--resume-session-at`, `--no-session-persistence`.
- **SDK helpers that read and write JSONL directly, without the CLI:**
  - `listSessions`, `getSessionInfo`, `getSessionMessages`, `listSubagents`, `getSubagentMessages`.
  - `renameSession` and `tagSession` *append* entries to the JSONL. Also `deleteSession`, `forkSession`, `importSessionToStore` (`sdk.d.ts:676-1156`, `3276`, `9752`).
  - These couple to the CLI's private on-disk format. **UNVERIFIED** whether that format is versioned.
- **SessionStore** (alpha): the SDK passes `--session-mirror`, and the CLI emits `transcript_mirror` frames that the SDK batches into a pluggable store.
  - On resume from a store, the SDK materialises a temp config dir `os.tmpdir()/claude-resume-<random>`. It writes `projects/<key>/<id>.jsonl` with mode `0700` and **copies `.credentials.json`** (or keychain-derived credentials), `.claude.json` and `settings.json` there (`sdk.mjs L142 @1208245`). See §10.

---

## 8. What the SDK adds on top of the raw CLI protocol

1. **Binary distribution and version lockstep.** Per-platform optional dependency, with SDK 0.3.N pinned to CLI 2.1.N.
   - Python wheels bundle the binary. The test matrix `manifest.json.sdkCompat.testedWrapperVersions` lists 0.3.261-0.3.285.
   - `manifest.json` carries SHA-256 checksums of the platform binaries, but **the SDK does not read it at runtime** (no references in any `.mjs`).
2. **Option model and validation.** Options are mapped to argv, env and `initialize`. Guards cover `--flag=value` injection, skill names, Windows batch files, cmd metacharacters, conflicting options (`canUseTool` with `permissionPromptToolName`, `fallbackModel` equal to `model`), and sandbox/settings merging (`Eq`).
3. **Callback bridges.** canUseTool, hooks (callback-id registry), elicitation, user dialogs, OAuth and host-auth refresh, `uiHost`.
4. **In-process MCP hosting.** MCP SDK transport bridge plus manifest pre-capture.
5. **Run-lifecycle and stdin-close logic** (§6.1), using `CLAUDE_CODE_SDK_READS_SESSION_STATE` and task tracking.
6. **Process lifecycle.** Graceful close with escalation, parent-exit reaper, abort propagation, stderr tail capture, deferred spawn (`startup()`/`prewarm()` warm processes, `WarmQuery`/`SpareProcess`).
7. **Error normalisation** (§6.5) and typed exceptions.
8. **Typed protocol** (`sdk.d.ts`, 10k lines). This is the de facto spec and is exportable for reuse in hudhud.
9. **Session file utilities and SessionStore mirroring** (§7).
10. **Extras.** `resolveSettings()` / `filterEscalatingDefaultMode()` (a settings resolver bundled from CLI code); OTEL trace propagation; `prewarm`.
11. **Alternative transports that are *not* subprocesses:**
    - `@anthropic-ai/claude-agent-sdk/browser` runs `query()` over WebSocket or SSE+POST against remote "CCR" sessions (`browser-sdk.d.ts`).
    - `/bridge` provides session handles for claude.ai remote-control (`bridge.d.ts`).
    - The CLI side of these appears to be `--sdk-url` (changelog 0.3.142: "Headless `--sdk-url` sessions … remote transport"). **UNVERIFIED** for local use.

### What the CLI exposes that the SDK does not (or exposes only via escape hatches)

- **Interactive TUI** and the non-stream output formats (`-p` with `text` / `json`).
- **CLI subcommands** (`claude mcp …`, config, update, and similar). Not inspected; the binary was not run.
- **`--permission-prompt-tool <mcp tool>`.** The SDK supports this only as an alternative to canUseTool.
- **Any flag** not modelled by the SDK. Reachable through `extraArgs` / `extra_args`.
- **Undocumented control subtypes** (§4.2 "Internal"). The SDK *does* send many of them, through internal or alpha methods. The CLI's full handler set can only be known from the closed-source binary, so **the CLI surface is ≥ the SDK surface by construction**.
- **Python gaps.** The Python SDK implements only a subset of host→CLI subtypes (`interrupt`, `set_permission_mode`, `set_model`, `rewind_files`, `mcp_reconnect`, `mcp_toggle`, `stop_task`, `mcp_status`, `get_context_usage`) and of CLI→host subtypes (`can_use_tool`, `hook_callback`, `mcp_message`). It does **not** handle `elicitation` or `request_user_dialog` (`query.py:577-677`). It sets `signal=None` in permission and hook contexts (TODO, `query.py:594`, `:651`).

---

## 9. Licensing and terms (quoted exactly)

**TS SDK npm `LICENSE.md`** (`claude-agent-sdk/package/LICENSE.md`); the same text is in `claude-code/package/LICENSE.md`:
> © Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.

**`package.json`:** `"license": "SEE LICENSE IN README.md"`.

The banner in `sdk.mjs` line 2:
> // (c) Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.

And line 6:
> // Want to see the unminified source? We're hiring!

**TS GitHub repo `LICENSE.md`** (https://github.com/anthropics/claude-agent-sdk-typescript, fetched to `dl/web/ts-license.md`):
> © Anthropic PBC. All rights reserved. Use is subject to Anthropic's [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms).

**Python SDK `LICENSE`** (MIT):
> MIT License
>
> Copyright (c) 2025 Anthropic, PBC
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software … to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software …

`pyproject.toml:11` has `license = {text = "MIT"}`. However, the Python `README.md:375-377` and the TS repo README say:
> Use of this SDK is governed by Anthropic's [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms), including when you use it to power products and services that you make available to your own customers and end users, except to the extent a specific component or dependency is covered by a different license as indicated in that component's LICENSE file.

**Legal and compliance page** (https://code.claude.com/docs/en/legal-and-compliance, fetched 2026-10-12), relevant excerpts verbatim:
> Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms of Service and complying with the conditions below:
> * **The Claude Code binary must not be modified.** Claude Code must be installed and run as published by Anthropic, and customers may not remove, disable, or restrict any authentication method built into it (including methods that permit signing in with a Claude account or the user's own API key).
> * **Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf.** Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential …

> **Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.

> … Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?* above.

> **Using the Claude Code name and logo.** … you can't use the Claude Code or Anthropic names or logos as part of your own product, feature, or company name …

### Assessment for hudhud (not legal advice; **UNVERIFIED** interpretation)

- **The TS SDK is proprietary ("All rights reserved").** An open-source library can *depend on* it as an optional peer, where users install it themselves under Anthropic's terms. It must **not vendor, copy or redistribute** its code, including the minified `sdk.mjs` or `sdk.d.ts` type definitions.
- **The Python SDK code is MIT.** Reading it, and porting ideas or even code with attribution, is permitted under MIT. Its README still says *use* is governed by the Commercial ToS.
- **Implementing the stdin/stdout JSON protocol independently** means talking to an unmodified CLI binary installed by the user. Nothing quoted forbids it. The legal page's conditions concern not modifying the binary, not removing auth methods, not intermediating or reselling usage, and not handling Claude.ai credentials.
- **What hudhud must NOT do:**
  - bundle or redistribute the `claude` binary;
  - collect, store or proxy OAuth tokens (note the SDK's `getOAuthToken` and `claude_authenticate` features);
  - use "Claude Code" in the product name.
- The library name "hudhud" is fine. Describing it plainly as running Claude Code is allowed.
- **Recommendation:** derive hudhud's protocol types independently, informed by observed behaviour plus the MIT Python SDK. Do not copy from `sdk.d.ts`. Get a legal opinion before release.

---

## 10. Security-relevant observations

1. **The control channel is fully trusted.**
   - `mcp_call` performs **no permission check**: "control channel is trusted, same as other subtypes" (`sdk.d.ts:4697`).
   - `update_settings` writes settings files, which feed hook and permission loading (`:5157`). `apply_flag_settings` can change permissions mid-session. `set_permission_mode` can switch to `bypassPermissions` if launched with `--allow-dangerously-skip-permissions`. `read_file` reads files.
   - Whoever controls the CLI's stdin has the agent's full authority. hudhud must keep stdin private to its process and never forward untrusted input as raw frames.
2. **argv injection.**
   - Use `--flag=value` for every value; a dash-leading value is otherwise parsed as a new flag. Python documents this injection (`subprocess_cli.py:642-646`), and TS switched every named option in 0.3.295.
   - Values formatted into `--allowedTools` need tokenizer-safe validation.
3. **Windows BatBadBut.** Never spawn `.cmd`/`.bat`, and never use `shell:true`. Resolve to a real `claude.exe`. Node ≥ 18.20.2 refuses `.cmd` without a shell; Python's `subprocess` does not refuse it, which is why the Python SDK checks explicitly.
4. **Environment leakage.**
   - By default the whole parent environment, including unrelated secrets, is passed to the CLI and on to every tool and MCP server it runs.
   - TS `env` replaces the environment entirely. TS removes only `NODE_OPTIONS`/`DEBUG`; Python removes `CLAUDECODE`. hudhud should offer an allowlist mode.
5. **Credential copying.** SessionStore resume copies `.credentials.json` (or keychain-derived credentials) into `os.tmpdir()/claude-resume-*` (`sdk.mjs L142 @1208245`).
   - The directory is created with mode `0700`; on Windows mode bits are ignored and ACLs are inherited. **UNVERIFIED** whether cleanup happens on crash.
   - Avoid replicating this design.
6. **Unbounded line buffering in TS** (readline, no max) versus Python's 1 MiB cap. hudhud should cap line size: configurable, with a safe default above the largest legitimate frames. MCP results can reach 500k-char texts and 8 MB `structuredContent` (changelog 0.3.295).
7. **Untrusted text in protocol fields.**
   - `decision_reason`, `matched_ask_rule`, plugin versions and so on are documented as "may carry ANSI escapes; sanitize before rendering" or "plugin-author-controlled — validate before trusting" (`sdk.d.ts:4838`, `:4859`, `:4976`).
   - Model output and tool results are untrusted.
   - Non-JSON stdout lines exist (e.g. `[SandboxDebug]`); skip them, but never execute them.
8. **Process-tree cleanup gap.** There is no tree kill. On Windows the parent-exit reaper only closes stdin. The binary runs shells and MCP servers as grandchildren, so a crash of the host can orphan them. Consider Windows Job Objects (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) or POSIX process groups. **UNVERIFIED** how the CLI itself handles EOF and SIGTERM for grandchildren.
9. **Binary provenance.**
   - The TS SDK trusts whatever `require.resolve` finds in `node_modules`.
   - Python trusts PATH and a bundled file. It deliberately avoids probing driveless `/usr/local/bin` on Windows because of binary planting (`subprocess_cli.py:286-296`).
   - hudhud should resolve explicitly, log the resolved path and version, and optionally verify a SHA-256 against Anthropic's published `manifest.json` checksums.
10. **Python's version probe runs the binary an extra time** (`claude -v`) before the session.
11. **`--permission-prompt-tool=stdio` is the switch for host-side permission decisions.** Without it, and without hooks, the CLI applies its own settings-based rules, and `permissionMode` defaults apply.

---

## 11. Changelog analysis: protocol stability

- **Cadence.** The TS SDK has had 321 npm versions from 2025-09-27 (0.0.4) to 2026-10-09 (0.3.296), roughly 20-30 releases per month, in lockstep with CLI releases (`dl/web/sdk-times.json`). Python has 171 changelog sections and bundles CLI updates.
- **Pre-1.0 versioning.** Breaking changes are announced inline as "**Breaking:**" entries.

Notable breaking or protocol changes (TS `CHANGELOG.md`):

| Version (date) | Change |
|---|---|
| 0.1.0 (2025-09-29) | Renamed from Claude Code SDK. **No default system prompt**, and no filesystem settings loaded by default (`ts-changelog.md:1762-1763`). |
| 0.1.64 | Fixed stdin being closed too early for SDK MCP, hooks and canUseTool. The origin of the run-lifecycle logic. |
| 0.2.76 / 0.2.83 | `cancel_async_message` and `seed_read_state` subtypes added. |
| **0.2.113 (2026-04-17)** | **The SDK spawns the native binary via a per-platform optional dependency instead of bundled JS.** **Breaking:** `options.env` replaces `process.env` again. |
| **0.3.142 (2026-05-14)** | **Breaking:** v2 session API (`unstable_v2_*`) removed. MCP servers connect in the background by default. `TodoWrite` replaced by `Task*` tools. |
| 0.3.161 | `initialize` became idempotent; `pending_permission_requests` added. |
| 0.3.186 | `agent_id` added to `can_use_tool` (background agents forward prompts); `rewind_conversation`. |
| 0.3.195 / 0.3.238 | `reinitialize()`; `hooks_applied`. |
| 0.3.206 | `command_lifecycle` frames. |
| 0.3.219 | `interrupt.cancel_queued` (capability `interrupt_cancel_queued_v1`). |
| 0.3.261 | `pluginDelivery:'initialize'` (`--await-initialize`), to fix Windows command-line length failures. |
| 0.3.268 | `initialize` always includes `pending_permission_requests`. |
| 0.3.281 / 0.3.286 | In-process MCP handshake moved into the SDK; `sdkMcpServerManifests`. |
| 0.3.283 | `set_max_thinking_tokens` semantics changed (omitting the field now leaves the budget unchanged). |
| 0.3.284 | Stdin no longer closed before follow-up turns woken by background agents (`session_state`). |
| 0.3.295 | All named options now sent as `--flag=value`; payload caps (4,096 permission updates, MCP result truncation). |
| 0.3.296 | `claude_code_version` added to the `initialize` response. |

Stability signals:

- **Positive:** the envelope (`control_request` / `control_response` / `request_id` / `subtype`) and the core subtypes (`initialize`, `can_use_tool`, `hook_callback`, `mcp_message`, `interrupt`, `set_permission_mode`, `set_model`) have been stable since 0.1.x.
- **Additive evolution:** new fields are optional and "a CLI that predates it ignores it". Capability flags in `system/init` exist specifically for feature detection.
- **Negative:** high churn; many undocumented or internal subtypes; semantic changes to existing requests (e.g. 0.3.283). Session-file helpers depend on a private disk format. Python lags TS in coverage.
- **Minimum versions:** Python enforces CLI ≥ 2.0.0 as a warning and ≥ 2.1.248 for `client_composed`.

---

## 12. Recommendation for hudhud's architecture (inference)

- **Foundation: a raw subprocess transport.**
  - `spawn(claude.exe, ["--output-format=stream-json", "--input-format=stream-json", "--verbose", ...])` with `shell:false`, `windowsHide:true` and explicit env.
  - NDJSON framer with a size cap.
  - Control-protocol router: request/response correlation, cancel, keep_alive, concurrent handlers with AbortSignals.
  - Feature detection from `system/init.capabilities` and `initialize.claude_code_version`.
  - Run-lifecycle and stdin-close policy modelled on §6.1.
  - Escalating termination plus Job Object / process-group tree cleanup.
- **Pluggable transport interface** (duplex NDJSON stream), so that:
  - (a) local `child_process`,
  - (b) a user-supplied spawner (container or SSH),
  - (c) an optional adapter that delegates to `@anthropic-ai/claude-agent-sdk`'s `query()` when the user installs it themselves (peer or optional dependency; no redistribution)

  can be swapped.
- **Binary resolution policy:** the user's configured path, then the user's native install, then an SDK platform package if present. Refuse `.cmd`/`.bat`. Report the resolved path and version.

---

## 13. Open questions requiring empirical sandbox verification

Run against an *isolated* CLI install with an isolated `CLAUDE_CONFIG_DIR` and an API key; do not use the user's real install or config.

1. Does CLI 2.1.296 accept a `user` message on stdin **before** an `initialize` control request? What happens when no `initialize` is ever sent (raw `-p`-like streaming)? Is there a timeout?
2. Exact `initialize` success payload on Windows, and whether `account` exposes any credential-derived data.
3. Behaviour of SDK servers declared Python-style (`--mcp-config {"type":"sdk"}`) versus TS-style (`initialize.sdkMcpServers`). Are both stable? Ordering of `mcp_message` relative to the `initialize` response.
4. Without `--permission-prompt-tool=stdio`, does the CLI ever emit `can_use_tool`? What happens in `default` mode with no host callback (auto-deny? hang?).
5. What happens when the host never answers a `can_use_tool` or `hook_callback`? Is there a CLI-side timeout? Does `control_cancel_request` from the CLI arrive on interrupt?
6. **Process tree on Windows.** After `stdin.end()`, and after `TerminateProcess` on `claude.exe`, do child shells (bash, pwsh) and stdio MCP servers survive? Does a Job Object approach break anything (e.g. CLI self-update or background "daemon" features like `CLAUDE_BG_*`)?
7. Maximum observed stdout line size in practice (large tool results, `stream_event` deltas, images), to size the framer cap.
8. Is `session_state_changed` emitted without `CLAUDE_CODE_SDK_READS_SESSION_STATE=1`? Does `sdk_host_only` vary by version?
9. Exit codes: 0 after stdin EOF; 1 after an `is_error` result; others? stderr content on auth failure, and `startup_failure_reason`.
10. Encoding on Windows. Confirm UTF-8 on stdin/stdout regardless of console code page; check BOM and CRLF behaviour (Python strips `\r`).
11. Does `--resume=<title>` accept arbitrary titles? Confirm the `=` form prevents flag injection for values starting with `-`.
12. Is the binary in `@anthropic-ai/claude-agent-sdk-win32-x64` byte-identical to `@anthropic-ai/claude-code-win32-x64` and to the native-installer build? Package sizes differ by 6 bytes, and `manifest.json` lists one checksum per platform; compare the SHA-256 of both against `manifest.json` (`76de74f7…769a` for win32-x64).
13. What `keep_alive` cadence does the CLI use, and must the host send keep-alives on long idle sessions?
14. Do undocumented subtypes (e.g. `side_question`, `get_plan`, `export_conversation`) work over plain stdio, and with what shapes? Avoid them in hudhud v1 unless verified.
15. How long does the CLI take to flush and exit after stdin EOF? The Python SDK cites lost last messages under SIGTERM (#625), so measure it to tune the grace period (SDK defaults: 2 s TS, 5 s Python).
