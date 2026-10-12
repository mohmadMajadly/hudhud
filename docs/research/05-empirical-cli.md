# 05 — Empirical verification: Claude Code CLI 2.1.296 over stream-json + control protocol

Date: 2026-10-12. Host: Windows 11 Home 10.0.26200, Node 24.19.0, Docker Desktop (Linux engine 29.7.2), Git for Windows bash.
Everything below was observed on the pinned, hash-verified binaries talking to a local mock API. Nothing touched a real API, real credentials, or the user's install.

Paths: `S` = scratchpad root. Driver: `S/sandbox/driver/`. Mock: `S/sandbox/mock-api/`. Raw evidence for every run is in `S/sandbox/run/NN-<name>/` (Windows) and `S/sandbox/run-linux/NN-<name>/` (Linux). Each run dir holds:
- `frames.ndjson`: every stdin, stdout and stderr line with a ms timestamp, plus `meta` (argv, env) and `exit`.
- `report.json`: test result, mock requests seen, outside-the-sandbox diff, and the full file list of the run dir.
- Mock request log: `S/sandbox/mock-api/logs/requests.ndjson`. Full request bodies are in `logs/bodies/`.

---

## 0. Verdict summary

| # | Question | Verdict (both OSes unless noted) |
|---|---|---|
| 1 | stream-json without `-p` | **Works.** It is identical to `-p` for multi-turn sessions: the same frames and the same EOF exit (≈30 ms). `--input-format=stream-json` implies print mode; the error text says "When using --print…". `--verbose` is mandatory (exit 1 without it). |
| 2 | `initialize` required? | **No.** A bare `user` first line works, and all frames are the same except the `control_response`. With no input at all, the CLI is silent indefinitely: no frames and no timeout, and EOF gives exit 0. **`system/init` is emitted once per turn**, after the user message (never at startup). Repeated `initialize` is accepted; each one gets a full response plus `system/background_tasks_changed`. |
| 3 | permissions | `can_use_tool` arrives only with `--permission-prompt-tool=stdio`. **Without `--permission-mode` the session starts in `auto`, and `auto` never asks the host, even with `stdio`.** allow → runs; deny → `is_error` tool_result, turn continues; deny+`interrupt:true` → `error_during_execution`/`aborted_tools`. **No CLI-side timeout** (≥150 s of silence, no keep_alives). An interrupt cancels the pending request (`control_cancel_request`). EOF fails it ("Tool permission stream closed…") and the turn continues. In `default` mode without `stdio`, a mutating Bash command is auto-denied (`system/permission_denied`); read-only `echo` is auto-allowed. |
| 4 | interrupt | Partial assistant (`aborted:true`), then a synthetic user "[Request interrupted by user]", then `result` `error_during_execution` / `terminal_reason:"aborted_streaming"` with `is_error:true`. `still_queued` and `cancel_queued`→`cancelled` work as typed. **GH#98713 reproduced:** on turn ≥2, a user message and an interrupt in the same write → `still_queued:[uuid]`, and the turn runs to completion. A 50 ms gap avoids it. |
| 5 | stdin EOF | Graceful. The CLI finishes the in-flight turn, then all queued turns (including running tools), then exits 0 about 30–60 ms after the last `result`. A pending `can_use_tool` fails on EOF. |
| 6 | exit codes | 0 = last result ok. **1 = the last `result` had `is_error:true`** (an earlier error does not matter). 1 = invalid flag, invalid enum, garbage stdin line, or missing `--verbose`. Windows TerminateProcess → Node reports `signal:'SIGTERM'`; a job close → **code 0**. Linux SIGTERM → 143, SIGHUP → 129, **SIGINT → 0** (no `result` frame), SIGKILL → signal. |
| 7 | process tree | **Windows:** TerminateProcess(claude.exe) **orphans the Git-Bash tool tree** (3/3 runs); the PowerShell tool child did not survive. Graceful EOF leaves no orphans (the CLI waits for the tool). **Job Object + KILL_ON_JOB_CLOSE:** the CLI works normally, grandchildren are in the job, and closing the job kills everything. **Linux:** SIGTERM/SIGINT → the CLI kills its tool tree itself. SIGKILL → bash+sleep survive. **kill(-pgid) also misses them: the Bash tool runs in its own process group.** |
| 8 | sizes / encoding | A 5 MB model text gives three ~5 MB stdout lines (`stream_event` delta, `assistant`, `result`). There is no CLI cap on stdout lines. Tools self-limit: Read refuses over 256 KB; Bash output over ~30 KB is persisted to a file plus a preview. **UTF-8 is clean** in both directions, including Arabic through the Bash and PowerShell tools. CRLF, blank lines, a UTF-8 BOM and multibyte chars split across writes are all tolerated. A 5 MB stdin line → local "Prompt is too long", `is_error`, exit 1. |
| 9 | session_state / keep_alive | **`session_state_changed` is not emitted** without an env var. `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` gives frames without `sdk_host_only`; `CLAUDE_CODE_SDK_READS_SESSION_STATE=1` gives the same frames with `sdk_host_only:true`. **No `keep_alive` from the CLI** in 95 s idle or 150 s blocked on permission. |
| 10 | isolation | The recipe in §10 kept every CLI write inside the run dir on Windows. **Three escapes/leaks to know about:** (a) the user's ancestor `<home>/.claude` is read as a *project* `.claude` (skills leaked into the API request); (b) on Linux the messaging socket falls back to `/tmp/cc-socks-<uid>/` when TMPDIR can't host a Unix socket, and stale `.sock` files remain after SIGKILL; (c) with nonessential traffic enabled, the CLI dials **api.anthropic.com:443 directly**, bypassing `ANTHROPIC_BASE_URL`. |
| 11 | Linux parity | The protocol behavior is **byte-for-byte the same shape** on Linux (Docker, glibc build). The differences are OS-level only: signals, process groups, socket path, and tool set (§11). |

Hashes: all verified (§1).

---

## 1. Pinned binaries and hash verification

Commands, each run in a new empty dir under `S/sandbox/bin/`:
```
npm pack @anthropic-ai/claude-code-win32-x64@2.1.296 --ignore-scripts
npm pack @anthropic-ai/claude-code-linux-x64@2.1.296 --ignore-scripts
npm pack @anthropic-ai/claude-agent-sdk-win32-x64@0.3.296 --ignore-scripts   # for the "is the SDK binary the same?" question
npm view <pkg>@<ver> dist.integrity          # vs: openssl dgst -sha512 -binary <tgz> | base64
tar --force-local -xzf <tgz> -C x            # no install scripts were run (the platform packages have none)
sha256sum x/package/claude[.exe]             # vs S/dl/claude-agent-sdk/package/manifest.json
```

| Artifact | tarball sha512 (registry = local) | binary SHA-256 | manifest.json (2.1.296) |
|---|---|---|---|
| claude-code-win32-x64 2.1.296 | `g2aYBzYM5YTD…uBcVui/VGNw==` ✔ | `76de74f7694a5bdc03378a5f837c9e132827bf004c98c276bc4e9094ff06769a` | win32-x64 ✔ match, size 260489376 ✔ |
| claude-code-linux-x64 2.1.296 | `+m01urgelnI+…jJ600FvLrcj1WWTw==` ✔ | `24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de` | linux-x64 ✔ match, size 257068216 ✔ |
| claude-agent-sdk-win32-x64 0.3.296 | `T71Y/hp0v7Vt…8XjN8M9t/g==` ✔ | `76de74f7…769a` (**byte-identical** to the claude-code one, `cmp` clean) | ✔ |

- The 6-byte package-size difference noted in 02 §13.12 comes from README.md, LICENSE.md and package.json, not from the binary.
- `claude --version` → `2.1.296 (Claude Code)`, exit 0, ~2.1 s on a cold Windows start, with **zero network requests**.
- The extracted copy of the SDK binary was deleted after comparison. Its tarball is kept.

---

## 2. Mock Anthropic API (Docker)

- Source: `S/sandbox/mock-api/server.mjs` (zero dependencies) and `Dockerfile` (FROM `node:24-bookworm-slim`, digest `sha256:0e0ff40c…f6b6`).
- Image: `hudhud-mock-api:dev`. Container: `hudhud-mock-api`, published on **127.0.0.1:47311** only. Logs are bind-mounted to `S/sandbox/mock-api/logs`.

```
docker build -t hudhud-mock-api:dev S/sandbox/mock-api
docker run -d --name hudhud-mock-api -p 127.0.0.1:47311:8080 -v <S>\sandbox\mock-api\logs:/logs --user root hudhud-mock-api:dev
```

**Scripting.** The scenario is chosen by a tag in the most recent user *text*: `[[mock:NAME k=v …]]`. The step index is the number of assistant messages after that user message, so tool round-trips advance the scenario automatically.

| Scenario | Behavior |
|---|---|
| `text`, `echo` | Plain text reply, or echo of the user text |
| `tool name= in=<b64 json>`, `bash cmd=<b64>`, `ps cmd=<b64>` | Tool call, then text quoting the tool_result |
| `loop` | Endless Bash tool calls |
| `slow chunks= ms=` | Streams text in timed chunks |
| `big bytes=` | One very large text block |
| `err status=` | Always returns that error status |
| `errn status= n= key=` | Fails n times, then succeeds |
| `hang` | Accepts the request and never responds |

- Untagged side requests get "ok". Streaming is SSE (`message_start`, `ping`, `content_block_*`, `input_json_delta`, `message_delta`, `message_stop`). Non-streaming is also supported. `/v1/messages/count_tokens` is answered, and every other path is logged and returns 404.
- **HTTP CONNECT handler:** the CLI is launched with `HTTPS_PROXY` pointing at the mock and `NO_PROXY=<mock host>`. Any attempt to reach a non-mock host is logged with its hostname and refused with 403.
- Driver helpers: `GET /__mock/requests?since=N` and `POST /__mock/reset`.

**Mock gotcha (protocol-relevant):** in tool round-trips, 2.1.296 appends a trailing **`role:"system"` message** (`<total_tokens>…</total_tokens>`, beta `mid-conversation-system-2026-04-07`) after the user tool_result message. Any mock or proxy must not assume the last message is `user`.

### Every endpoint the CLI hit

| Condition | Requests |
|---|---|
| With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (all ~100 Windows + ~60 Linux runs) | **Only `POST /v1/messages?beta=true`** (169 requests; the one bare `POST /v1/messages` was my curl smoke test). No `count_tokens`, no `/v1/models`, no OAuth/profile/hello endpoints, and **zero CONNECT attempts**. `--version` made no requests at all. |
| **Without** that variable (`run/89-q10-egress-nonessential-on`) | The same `POST /v1/messages?beta=true` to the mock, **plus ≈11 `CONNECT api.anthropic.com:443`** within 20 s. These go directly to Anthropic, ignoring `ANTHROPIC_BASE_URL`; paths are not visible through TLS. My proxy refused all of them. Without the trap, a sandbox with a real internet connection would send traffic, and possibly the key, to production. |
| Auto-mode classifier | **Never** called the mock. With a third-party base URL it fails closed (§3). |

Request headers the CLI sends (Linux sample):
- `user-agent: claude-cli/2.1.296 (external, sdk-cli)`, `x-app: cli`
- `x-claude-code-session-id`, `x-api-key`, `anthropic-version: 2023-06-01`
- `anthropic-beta: claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,effort-2025-11-24,dangerous-tool-use-2026-09-03,thinking-display-updates-2026-08-18,afk-mode-2026-01-31`
- `x-stainless-*` with `package-version 0.128.0`, `runtime node v26.3.0` (Bun reports itself as node), `x-stainless-timeout: 600`
- The system prompt starts with an `x-anthropic-billing-header: cc_version=2.1.296.<x>` text block.
- Default model `claude-opus-5-5`; 22 tools.

---

## 3. Sandbox launch environment (Windows)

Spawn: `child_process.spawn(<pinned claude.exe>, argv, { cwd: run/work, env, stdio: ['pipe','pipe','pipe'], shell: false, windowsHide: true })`, with argv only in `--flag=value` form (`S/sandbox/driver/lib.mjs`).

**Explicit env (nothing inherited):**
```
PATH=<C>/Windows\System32;<C>/Windows;<C>/Windows\System32\WindowsPowerShell\v1.0
SYSTEMROOT=<C>/Windows  WINDIR=<C>/Windows  COMSPEC=<C>/Windows\System32\cmd.exe  PATHEXT=.COM;.EXE;.BAT;.CMD  SystemDrive=C:
HOME=USERPROFILE=<run>\home   APPDATA=<run>\home\AppData\Roaming   LOCALAPPDATA=<run>\home\AppData\Local
CLAUDE_CONFIG_DIR=<run>\cfg   CLAUDE_CODE_TMPDIR=TMPDIR=TMP=TEMP=<run>\tmp
DISABLE_AUTOUPDATER=1  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ANTHROPIC_BASE_URL=http://127.0.0.1:47311  ANTHROPIC_API_KEY=<fake-key>
HTTPS_PROXY=HTTP_PROXY=http(s)_proxy=http://127.0.0.1:47311  NO_PROXY=no_proxy=127.0.0.1     # egress trap
CLAUDE_CODE_GIT_BASH_PATH=<C>/Program Files\Git\bin\bash.exe     # minimal PATH has no git
```
- Standard flags for tests: `--output-format=stream-json --input-format=stream-json --verbose --setting-sources= --permission-mode=default`, plus `--permission-prompt-tool=stdio` where relevant.
- The ancestor check (existence only) from `run/` up to `<C>/` found **one hit: `<home>/.claude`**, the user's config dir, which is an ancestor of every path under `%TEMP%`. See §10.1.
- `PowerShell` `StartupProfileData-NonInteractive` was written to `<run>/home/AppData/Local/Microsoft/Windows/PowerShell/` when the PowerShell tool ran. Without the `LOCALAPPDATA` redirect, this would have landed in the real profile.

---

## 4. Q1 — no `-p`

Runs `08-q1-noP-two-turns` and `09-q1-withP-two-turns`: initialize, user `text`, user `echo`, then EOF.

```
588ms control_response success init_1 (16944B)
644ms system/init (2875B)
724ms assistant text:"Hello from mock."
737ms system/informational        <- auto-mode classifier billing notice (third-party base URL)
737ms result/success
2253ms system/init               <- again for turn 2
2272ms assistant text:"ECHO:turn two"
2276ms result/success
EOF -> exit 0 after 32ms (with -p: identical sequence, 30ms)
```

- Without `--verbose`: exit 1 and stderr `Error: When using --print, --output-format=stream-json requires --verbose`. This is the same with or without `-p`, so stream-json input is print mode.
- `--output-format=stream-json --verbose` with plain-text stdin and no `-p`: after 3 s the CLI writes `Warning: no stdin data received in 3s, proceeding without it…` and `Error: Input must be provided either through stdin or as a prompt argument when using --print`, then exits 1. A non-TTY stdin forces print mode.
- **No difference observed between `-p` and no `-p`** in stream-json mode on either OS: frames, exits, and multi-turn behavior all match. The SDK convention of omitting `-p` is safe.

## 5. Q2 — handshake

- **User first, no initialize** (`12-q2-user-first-no-init`): the frames are identical to the initialized case, minus the `control_response`. Exit 0.
- **Silent start** (`14-q2-silent-start`): 20 s with nothing on stdin produced **no stdout at all** (no init, no keep_alive) and no timeout. EOF gives exit 0 after 24 ms.
- **Initialize ×3** (`13-q2-init-twice`): every request gets a full success response, each followed by `{"type":"system","subtype":"background_tasks_changed","tasks":[]}`. Initialize after a turn works too.
- **`system/init` is per turn.** It follows the user message about 30–60 ms after the initialize response, and is never sent at startup.

**Initialize request:** `{"type":"control_request","request_id":"init_1","request":{"subtype":"initialize"}}`

**Response** (trimmed; full ≈17 KB, mostly command descriptions):
```json
{"type":"control_response","response":{"subtype":"success","request_id":"init_1","pending_permission_requests":[],"pending_user_dialog_requests":[],
 "response":{"commands":[{"name":"deep-research","description":"…","argumentHint":"","builtin":true},"…(44)"],"agents":["…(5)"],
  "output_style":"default","available_output_styles":["default","Proactive","Concise","Explanatory","Learning"],
  "user_output_styles_dir":"<run>\\cfg\\output-styles",
  "models":[{"value":"default","resolvedModel":"claude-opus-5-5","displayName":"Default (recommended)","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"],"supportsAdaptiveThinking":true,"supportsFastMode":true,"supportsAutoMode":true},"…opus, fable, sonnet, haiku"],
  "account":{"tokenSource":"none","apiKeySource":"ANTHROPIC_API_KEY","apiProvider":"firstParty"},
  "pid":37148,"claude_code_version":"2.1.296","current_permission_mode":"default","feedback_mode":{"kind":"disabled"},"analytics_disabled":true,
  "remote_control_auto_enable":false,"remote_control_auto_connect_default":false,"remote_control_available":false,"remote_control_auto_on_by_default":false,"ide_rc_auto_enable_gate":false,
  "fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required","session_state":"idle","capabilities":["ui_surface_v1"]}}}
```
- `account` exposes **no credential-derived data** with an API key, only the key's *source*.
- `pid` is the CLI's own pid, which is useful for process-tree management.
- Fields not in `sdk.d.ts` 0.3.296: `pid`, `current_permission_mode`, `feedback_mode`, `analytics_disabled`, `remote_control_*`, `ide_rc_auto_enable_gate`, `session_state`, `capabilities`.

**`system/init`** (Windows, trimmed):
```json
{"type":"system","subtype":"init","cwd":"<run>\\work","session_id":"d6e7fffb-…","tools":["Task","Bash","CronCreate","CronDelete","CronList","Edit","EnterWorktree","ExitWorktree","Glob","Grep","ListAgents","NotebookEdit","Read","ReportFindings","ScheduleWakeup","SendMessage","Skill","TaskStop","WebFetch","WebSearch","Workflow","Write"],
 "mcp_servers":[],"model":"claude-opus-5-5","permissionMode":"auto","slash_commands":["…"],"terminal_slash_commands":["doctor","color","focus","reload-plugins"],
 "apiKeySource":"ANTHROPIC_API_KEY","claude_code_version":"2.1.296","output_style":"default","agents":["claude","Explore","general-purpose","Plan","statusline-setup"],
 "skills":["…"],"plugins":[{"name":"cc-plugin-agents-md","path":"builtin","source":"cc-plugin-agents-md@builtin"},{"name":"cc-plugin-plugin-authoring","path":"builtin","source":"cc-plugin-plugin-authoring@builtin"}],
 "capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","interrupt_send_now_v1","msg_lifecycle_v1","request_marker_lists_v1","sdk_mcp_tools_list_changed","sdk_mcp_manifests","mcp_read_resource_v1","mcp_tool_ui_meta_v1","ui_surface_v1"],
 "analytics_disabled":true,"product_feedback_disabled":true,"uuid":"…","memory_paths":{"auto":"<run>\\cfg\\projects\\<proj>\\memory\\"},
 "messaging_socket_path":"\\\\.\\pipe\\LOCAL\\cc-msg-d7b08732db699f1fdbbee445b4819b90","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required",
 "per_turn_effort_active":true,"view_mode":"default","powershell_path":"<C>/\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"}
```
- Tool-set differences:
  - With `--permission-prompt-tool=stdio`, the tool list adds `AskUserQuestion`, `EnterPlanMode` and `ExitPlanMode`.
  - `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` adds `PowerShell`.
- The `claude` agent ("Catch-all … FleetView's default…") is **built-in**: it also appears in the clean Linux container.

**Other stdin and stdout facts:**
- A stdin user message carrying a `uuid` is echoed in `result.user_message_uuid(s)`, and turns on `command_lifecycle` frames: `{"type":"command_lifecycle","command_uuid":"…","state":"queued"|"started"|…}`. The `msg_lifecycle_v1` capability advertises this.
- `content` may be a plain string.
- **The first user message of a session gets a `<system-reminder>` prepended** (git-commit/PR attribution text for "Claude Opus 5.5"). The `echo` scenario shows this; later turns do not get it.

## 6. Q3 — permissions

**`can_use_tool`** (`19-q3-stdio-allow`, `--permission-mode=default --permission-prompt-tool=stdio`, Bash `echo hi && touch marker.txt`):
```json
{"type":"control_request","request_id":"96faf3d7-4d77-4311-839f-a6ddaaec5323","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash",
 "input":{"command":"echo hi && touch marker.txt","description":"mock command"},"description":"mock command",
 "permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"echo hi *"}],"behavior":"allow","destination":"localSettings"},
   {"type":"addDirectories","directories":["<run>\\work"],"destination":"session"},{"type":"setMode","mode":"acceptEdits","destination":"session"}],
 "blocked_path":"<run>\\work\\marker.txt","tool_use_id":"toolu_mock_0002"}}
```
- CLI request ids are UUIDs.
- On Linux the same request carries `decision_reason_type:"subcommandResults"`, has no `blocked_path`, and suggests different rules (§11).

| Host answer | Outcome (frames) | Exit after EOF |
|---|---|---|
| `{behavior:"allow", updatedInput}` and plain `{behavior:"allow"}` (both work) | tool runs (marker created), `user` tool_result `"hi"`, `result/success` | 0 |
| `{behavior:"deny", message:"host says no"}` | tool_result `{"content":"host says no","is_error":true}`, turn continues, `result/success` with `permission_denials:[{tool_name,tool_use_id,tool_input}]` | 0 |
| `{behavior:"deny", …, interrupt:true}` | tool_result "The user doesn't want to proceed…", user text `[Request interrupted by user for tool use]`, `result/error_during_execution` `is_error:true` `terminal_reason:"aborted_tools"` | 1 |
| `control_response` `subtype:"error"` | tool_result "Tool permission request failed: Error: host failed", turn continues | 0 |
| **never answered** (`29-…never-answer`) | **Nothing for 150 s**: no timeout, no `control_cancel_request`, no keep_alive. Then host `interrupt` → `{"type":"control_cancel_request","request_id":"548e5f58-…"}` (the CLI withdraws its own request), the interrupt response `{"still_queued":[]}`, and the same frames as deny+interrupt | 1 |
| never answered, then **EOF** (`30-…`) | tool_result "Tool permission request failed: **AbortError: Tool permission stream closed before response received**", turn continues to `result/success`, process exits 912 ms after start | 0 |

**Without `--permission-prompt-tool`:**
- With `--permission-mode=default`: `can_use_tool` is **never** emitted. A mutating command is denied by the CLI itself:
  ```json
  {"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"toolu_mock_0007","message":"touch in '<run>\\work\\marker.txt' needs approval. The path is inside the working directories for this session (…), and Claude Code asks before a shell command creates, changes or removes files there.","uuid":"…","session_id":"…"}
  ```
  The tool_result carries `tool_result_meta:[{"non_execution_kind":"user-rejected","permission_decision":{"decision":"reject","source":"config"}}]`. A read-only `echo hi` is auto-allowed.
- **Implicit mode is `auto`** (`26-…`, `27-…`). The same `touch marker.txt` **executed without any host involvement, with or without `--permission-prompt-tool=stdio`**.
- A riskier command (`rm -rf ../../../hudhud-nonexistent-dir`, target absent) in auto mode (`28-q3-auto-risky`) produced:
  ```
  system/permission_denied  decision_reason_type:"classifier"
  "Auto mode could not evaluate this action and is blocking it for safety — run with --debug for details. This is not a judgment that the action is unsafe. …"
  ```
  No classifier request reached the mock or any proxy, so with a third-party base URL the classifier fails closed. It was **not** escalated to `can_use_tool`.
- **`--permission-mode` accepted values** (from the error text): `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`. `default` is not listed, but it is accepted and reported as `"default"`.

**hudhud must always pass an explicit `--permission-mode`. Otherwise auto mode silently runs mutating tools and never calls the host's permission callback.**

## 7. Q4 — interrupt

**Mid-stream** (`31-q4-interrupt-midstream`, `--include-partial-messages`): interrupt sent about 1.2 s into a 20-chunk stream.
```
1990ms control_response success int_1  {"still_queued":[]}
1993ms assistant  aborted:true  text:"chunk0 chunk1 chunk2 chu"   (partial text is preserved)
1994ms user [{"type":"text","text":"[Request interrupted by user]"}]
1994ms stream_event content_block_stop / message_delta / message_stop  (synthetic closers)
1996ms result/error_during_execution is_error:true terminal_reason:"aborted_streaming"
       errors:["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"]   <- no `result` key (GH#94741)
```

| Case | Interrupt response | Then |
|---|---|---|
| Queued message (`32`) | `{"still_queued":["…0002"]}` | The queued message runs as the next turn, and its content gets `"[Request interrupted by user]\n\n"` prepended |
| `cancel_queued:true` (`33`) | `{"still_queued":[],"cancelled":["…0002"]}` | The queued message is dropped |
| Idle (`34`) | `{"still_queued":[]}` | Harmless; the next turn is normal |
| During a request with no response bytes (`35`, mock `hang`) | — | Aborts in ~3 ms with `aborted_streaming` |

**GH#98713 reproduced** (`36-q4-gh98713-same-write`): turn 1 completes normally. Turn 2 sends the user message (uuid 2) and the interrupt in **one write**.
```
1746ms control_response success int_2 {"still_queued":["00000000-0000-4000-8000-000000000002"]}
1753ms system/init
5781ms assistant text:"chunk0 … chunk7 "        <- full 4 s stream; the interrupt was ignored
5788ms result/success terminal_reason:"completed"
```
- With a **50 ms gap** (`37`) the interrupt lands after `system/init`, and turn 2 aborts in 69 ms.
- The same single write on **turn 1** (`38`) also answers `still_queued:[uuid1]`, but the turn **does** abort, before any API call.
- Workaround for hudhud: before sending `interrupt`, wait for `system/init` (or `command_lifecycle state:"started"`) of the target turn. Alternatively, treat a `still_queued` that contains the current turn's uuid as "not interrupted" and re-send.

## 8. Q5 — stdin EOF

| Run | Situation | EOF→exit | Last frames |
|---|---|---|---|
| `39` | idle | 34 ms | — |
| `40` | mid-stream | 4094 ms (finished the stream) | `assistant` (full text), `result/success` |
| `41` | mid-tool (`sleep 5`) | 4742 ms (tool completed, model called again) | `system/task_started {task_type:"local_bash",is_backgrounded:false}`, `task_notification {status:"completed"}`, tool_result, `result/success` |
| `42` | 1 running + 1 queued | 2174 ms | **both** turns ran |
| `43` | never anything | 24 ms | — |

All of these exit with code 0 on Windows. Linux matches: 47 / 4153 / 4266 / 2334 / 45 ms.

**EOF means "finish everything, then exit". It is not an abort.** To stop now, send `interrupt` (with `cancel_queued:true`) and then EOF.

## 9. Q6 — exit codes and errors

| Case | Frames | Exit (Win / Linux) |
|---|---|---|
| normal | `result/success` | 0 / 0 |
| `--max-turns=1` + tool loop (`46`) | `result/error_max_turns` `is_error:true` `terminal_reason:"max_turns"` `errors:["Reached maximum number of turns (1)"]` `num_turns:2` | 1 / 1 |
| 401, `CLAUDE_CODE_MAX_RETRIES=0` (`57`) | synthetic `assistant` `error:"authentication_failed"` text "Failed to authenticate. API Error: 401 mock 401", then `result/success` **`is_error:true`** `api_error_status:401` `terminal_reason:"api_error"` | 1 |
| 401, default retries (`58`) | **10 × `system/api_retry`** `{"attempt":n,"max_retries":10,"retry_delay_ms":…,"error_status":401,"error":"authentication_failed"}` with delays 0.6, 1.1, 2.1, 4.8, 8.3, 19.7, 33.8, 36.7, 39.7, 36.2 s. **Result after ≈170–184 s.** | 1 |
| 401 then a good turn (`59`) | **The 401 is sticky.** Turn 2 gets the same synthetic `authentication_failed` result **with no API request** | 1 |
| ok then 500 (`60`) | — | 1 (the last result decides) |
| 529 ×n (`47`, `48`, `62`) | `api_retry` ×2, then "API Error: Repeated 529 Overloaded errors…" `is_error:true` `api_error_status:529`. **The 529 cap is 3 attempts whatever `CLAUDE_CODE_MAX_RETRIES` is** (10, 5 or 2 all behave the same) | 1 |
| 529 ×2 (`61`) | recovers on the 3rd attempt | 0 |
| 529 ×3 + `--fallback-model=sonnet` (`63`) | the 4th request goes to `claude-sonnet-5-5` and succeeds | 0 |
| 429 / 500, `MAX_RETRIES=1` (`49`, `50`) | `api_retry {error:"rate_limit"\|…, retry_delay_ms≈550}`, then `is_error` result "API Error: Request rejected (429) · mock 429" / "API Error: 500 mock 500. …" | 1 |
| invalid flag | stderr `error: unknown option '--definitely-not-a-flag=1'`, no stdout | 1 (≈150 ms) |
| invalid enum | stderr `error: option '--permission-mode <mode>' argument 'bogus' is invalid. Allowed choices are …` | 1 |
| non-JSON stdin line | stderr `Error parsing streaming input line (type=unknown, 16 chars): SyntaxError`, immediate exit | 1 |
| Windows `child.kill()` (TerminateProcess), idle or mid-stream | no further frames; Node reports `{code:null, signal:"SIGTERM"}` | — |
| Windows Job close (KILL_ON_JOB_CLOSE) | no further frames | **code 0** (so exit 0 is not proof of success) |
| Linux SIGTERM idle / mid-stream | no `result` for the in-flight turn | 143 / 143 (41–58 ms) |
| Linux SIGINT mid-stream | `assistant` partial + "[Request interrupted by user]", **no `result` frame**, process exits | **0** |
| Linux SIGHUP | — | 129 |
| Linux SIGKILL | — | signal |

**Rules for hudhud:**
- The exit code reflects only the *last* result's `is_error`.
- Synthesize the turn end on exit, because SIGINT and SIGTERM exits have no `result`.
- Set `CLAUDE_CODE_MAX_RETRIES` deliberately (an auth failure otherwise takes about 3 minutes), and surface `system/api_retry`.
- After an auth error the session is poisoned, so restart the process.

## 10. Q7 — process trees

### Windows (`S/sandbox/driver/t06-tree.mjs`)

The Bash tool tree under `claude.exe` is `conhost.exe` plus `Git\bin\bash.exe` → `Git\usr\bin\bash.exe -c "source <run>/…/shell-snapshot…; sleep 30…"` → `conhost.exe`.

| Case | Survivors (pid + creation time verified 3 s after) |
|---|---|
| TerminateProcess(claude.exe) during `sleep 30` (`60`, `64`, `70`, `72`) | **bash.exe, bash.exe, conhost.exe in 4/4 runs.** Cleaned by pid + creation time. |
| TerminateProcess during a PowerShell tool `Start-Sleep 30` (`66`) | none (powershell.exe died with its parent) |
| Graceful EOF during `sleep 15` (`65`) | none. The CLI waits for the tool (exit 12.3 s after EOF, exit 0). |
| **Job Object**, normal use (`67`) | The CLI works normally (text turn + Bash tool `inside-job`, exit 0). The job's pid list during the tool is `claude.exe, bash.exe, bash.exe, conhost.exe, <sleep>`: grandchildren inherit the job, with no breakaway. |
| Job, TerminateProcess(claude.exe) only, job still open (`68`, `71`, `73`) | **none.** The job list was already empty 2 s later (3/3), so in a job the git-bash tree dies with the CLI before the job is even closed. Mechanism unverified (likely MSYS runtime behavior when the parent job handle disappears); the outcome was consistent. |
| Job close (helper exits) (`69`) | everything killed, claude.exe included. Node reports code 0. |

- Job helper: `S/sandbox/driver/job-helper.ps1`, using PowerShell Add-Type C# with no installs. It runs `CreateJobObject`, sets `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (ExtendedLimitInformation, class 9), and verifies the target by `GetProcessTimes` creation time within 2 ms before `AssignProcessToJobObject`.
- Assignment happened right after spawn (race window ≈ 1 s, before any tool ran). In production, hudhud should create the process suspended in the job, or assign before writing the first stdin line.

### Linux (Docker, `--init`)

Every tool shell has **`pgid == bash pid`**. For example, `{bash pid:2903 ppid:2850(claude) pgid:2903}` and `{sleep pid:2904 pgid:2903}`. The CLI puts each Bash tool in its **own process group**.

| Signal to claude | Exit | Survivors |
|---|---|---|
| SIGTERM | 143 after 127 ms | **none** (the CLI kills its tool groups) |
| SIGINT | 0 after 124 ms | none |
| SIGKILL | signal | **bash, sleep** |
| detached spawn + `kill(-pgid_of_claude, SIGKILL)` | signal | **bash, sleep**. The group kill does not reach tool groups. |
| EOF during `sleep 15` | 0 after 12.6 s | none |

**Implications for hudhud:**
- The escalation should be EOF → (grace) → `interrupt` → SIGTERM on POSIX or Job close on Windows → SIGKILL/TerminateProcess.
- For robust cleanup after a host crash:
  - **Windows:** always run the CLI inside a KILL_ON_JOB_CLOSE job owned by the host process. The job handle dies with the host, so the tree dies too.
  - **Linux:** process groups are **insufficient**. Use a cgroup (systemd scope, container), `PR_SET_CHILD_SUBREAPER` plus a walk of descendants, or record the descendant pgids from `/proc` and kill each group.
  - Never rely on SIGKILL alone.

## 11. Q8 — sizes, encoding, line endings

| Run | Max stdout line | Notes |
|---|---|---|
| 1 MB model text (`74`) | **1,001,566 B** (`result`) | Each of `stream_event content_block_delta`, `assistant` and `result` carries the whole text |
| 5 MB model text (`75`) | **5,001,567 B** | No truncation or splitting; exit 0, ~1 s |
| Read of a 2.8 MB file (`76`) | 16,949 B (the init response is the largest frame) | tool_result "File content (2.7MB) exceeds maximum allowed size (256KB)…" |
| `cat` of a 2.8 MB file via Bash (`77`) | 34,057 B | tool_result `<persisted-output>Output too large (2.7MB). Full output saved to: <run>\cfg\projects\<proj>\<session>\tool-results\<id>.txt` plus a preview |
| Normal sessions | ≈17 KB (initialize response), ≈3 KB `system/init` | — |

So:
- Line size is bounded by **model output**, not by tools. A framer cap must exceed the largest model text by roughly 2×, because the `assistant` and `result` frames both carry the full text.
- 1 MiB (the Python SDK cap) is **too small**. A configurable default of 32–64 MiB is reasonable.

Encoding and line endings:
- **UTF-8 / Arabic** (`78`–`80`):
  - stdin `مرحبا` echoes back exactly.
  - Mock text `رد: مرحبا 👋 é` arrives exactly.
  - `echo مرحبا` via the Bash tool and `Write-Output مرحبا` via the PowerShell 5.1 tool both return `مرحبا`.
  - The raw stdout bytes contain the exact UTF-8 sequence, with 0 U+FFFD and no mojibake.
  - Stdout is a pipe and the child has a hidden console, so the console code page is irrelevant.
- **CRLF** (`81`): `\r\n`-terminated initialize and user lines plus `\r\n   \r\n` blank or whitespace lines are accepted.
- **BOM** (`82`): a UTF-8 BOM before the first line is accepted.
- **Split writes** (`83`): one JSON line in 3 writes, split *inside* an Arabic code point, is reassembled correctly.
- **5 MB stdin line** (`84`): no crash. A local `result` "Prompt is too long", `is_error:true`, no API call, exit 1.

## 12. Q9 — session state and keep_alive

| Env | Frames |
|---|---|
| none (`16-q9-idle-noenv`, 95 s idle after a result) | **no `session_state_changed`, no `keep_alive`** |
| `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` (`17`) | `{"type":"system","subtype":"session_state_changed","state":"running",…}` right after the user message (before `system/init`), and `…"state":"idle"` 3 ms after `result` |
| `CLAUDE_CODE_SDK_READS_SESSION_STATE=1` (`18`) | the same, plus `"sdk_host_only":true` |

- The CLI sent **zero `keep_alive`** frames in any run, including 150 s blocked on `can_use_tool`. The host does not need to send them.
- An idle session with stdin open stays alive indefinitely, with no idle exit observed.
- For hudhud: set `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` to get the reliable "idle" run-end signal, and keep it distinct from `sdk_host_only`.

## 13. Q10 — config isolation

**Every path the CLI wrote on Windows** (union over ~90 runs; counts omitted), all under `<run>/`:
```
cfg/.claude.json   cfg/backups/.claude.json.backup.<ts>   cfg/.last-cleanup
cfg/projects/<proj>/<session>.jsonl   cfg/projects/<proj>/memory/   cfg/projects/<proj>/<session>/tool-results/<id>.txt
cfg/sessions/<pid>.json + <pid>.<sha256>.key      <- removed on clean exit, STALE after kill/TerminateProcess
cfg/session-env/<session>/   cfg/shell-snapshots/snapshot-bash-<x>.sh
tmp/claude/<proj>/<session>/tasks/<id>.output      <- Bash tool output files (CLAUDE_CODE_TMPDIR + "/claude")
tmp/claude/fswatch-probe-<x>/probe                 <- left behind
home/AppData/Local/Microsoft/Windows/PowerShell/StartupProfileData-NonInteractive   <- powershell.exe, via LOCALAPPDATA
```
- `<proj>` is the cwd with non-alphanumerics replaced by `-`; here it is about 190 chars.
- Linux writes the same set with `tmp/claude-1000/` instead of `tmp/claude/`, plus the socket described below.

**Outside the run dir:**
- **Windows:** no new entries in `%TEMP%` or `%TEMP%\claude`. `%APPDATA%\Anthropic` and `%APPDATA%\Claude` were never created. No `HKCU\Software` changes and no Anthropic/Claude keys (`reg query`). No `~/.local/state/claude`, `~/.cache/claude` or `~/.config` changes.
  - `<home>/.claude.json` mtime changed during 4 of ~90 runs, always with the size unchanged.
  - A **control window with no sandbox CLI running** showed the same change (+70 s, size unchanged). The user's own live Claude Code session rewrites that file periodically.
  - The mtime check is therefore confounded on this host, and **no write attributable to the sandbox was observed** (without reading the file).
  - Stronger attribution would need ETW/Procmon (admin), which was not done. The Linux run is the clean proof.
- **Linux** (read-only rootfs, tmpfs `/tmp` and HOME, uid 1000): HOME stayed empty and `/var/tmp` empty. The one escape is the messaging socket:
  - `messaging_socket_path` = `${XDG_RUNTIME_DIR || tmpdir}/cc-socks/<pid>.sock`, falling back to **`/tmp/cc-socks-<uid>/<pid>.sock`**.
  - The fallback is used when the path exceeds 103 bytes (sun_path) or the dir can't host a Unix socket. Here the run dirs were on a Docker Desktop bind mount, so the fallback was taken.
  - With TMPDIR or XDG_RUNTIME_DIR on native tmpfs, the socket stayed inside (`q10-sock-*-native`).
  - The `/tmp/cc-socks-<uid>` dir (0700) remains after exit, and **stale `<pid>.sock` files remain after SIGKILL** (3 seen).
  - On Windows the socket is a named pipe `\\.\pipe\LOCAL\cc-msg-<hex>`, with no filesystem footprint.

### 13.1 Leak: the ancestor `.claude` dir of the real user

With cwd under `%TEMP%`, the ancestor `<home>/.claude` (the user's config dir) is treated as a **project `.claude`**.
- The user-level skill `<user-skill>` appeared in the `initialize` and `system/init` skills and slash commands.
- It was **sent to the API inside the system prompt**: a grep of the captured request body found the name. Only the name was checked; no contents were read.
- `CLAUDE_CONFIG_DIR` and the HOME/USERPROFILE redirect do **not** prevent this.

The leak disappears with any of the following (`03`–`07`): `--setting-sources=user`, `--setting-sources=` (empty), `--bare`, or a cwd with no such ancestor (tested via a temporary `subst Q:` drive, which was removed afterwards).

For hudhud tests and sandboxes: **always pass `--setting-sources=`** (or explicit sources), and put cwd outside the user's home tree. For real users this is normal CLI behavior; a project under `~` sees `~/.claude/skills` as project skills.

### 13.2 Proven sandbox recipe
1. Use the pinned binary verified against the manifest SHA-256.
2. Use the allowlisted env from §3, with no inheritance.
3. `--setting-sources=` plus an explicit `--permission-mode`.
4. cwd = an empty dir outside any `.claude`/`CLAUDE.md` ancestor (or accept §13.1).
5. **TMPDIR/CLAUDE_CODE_TMPDIR on a native filesystem** (needed for the Linux socket).
6. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` **and** a proxy trap (`HTTPS_PROXY` → logger, `NO_PROXY` → mock). Without the variable, the CLI contacts api.anthropic.com directly.
7. Fake key only.
8. Windows: run inside a KILL_ON_JOB_CLOSE job. Linux: run in a container or cgroup.

## 14. Q11 — core scenario on Linux vs Windows

Scenario (`driver/t08-core.mjs`): initialize → user `text` → user `bash` (needs permission) → `can_use_tool` allow → result → EOF.

| | Windows (`run/85-q11-core-win32`) | Linux (`run-linux/01-q11-core-linux`) |
|---|---|---|
| Frame sequence | control_response, init, assistant, result, init, assistant(text), assistant(tool_use), control_request can_use_tool, user tool_result, assistant, result | **identical** |
| Timings (initResp / r1 / can_use_tool / r2) | 581 / 714 / 779 / 1478 ms | 1053 / 1268 / 1414 / 1575 ms |
| EOF→exit, code | 31 ms, 0 | 58 ms, 0 |
| Tool output | `hi` (`uname` missing → `ver` path) | `hi\nLinux` |

OS differences observed:
- `can_use_tool` on Linux: `decision_reason_type:"subcommandResults"`, no `blocked_path`, and `permission_suggestions` = `addRules` for the individual subcommands (`touch marker.txt`, `ver`). On Windows: `blocked_path`, plus `addRules "echo hi *"`, `addDirectories`, and `setMode acceptEdits`. The command-safety analysis differs per OS, so don't hard-code suggestion shapes.
- `system/init` has `powershell_path` on Windows only; the PowerShell tool is opt-in. `messaging_socket_path` is a named pipe on Windows and a Unix socket on Linux (§13).
- Temp layout: `tmp/claude/…` on Windows vs `tmp/claude-<uid>/…` on Linux.
- Signals and process groups (§9, §10): Linux SIGTERM and SIGINT clean the tool tree, while Windows TerminateProcess orphans git-bash.
- Every other test (Q1–Q6, Q8, Q9) produced the same frame-type sequence and exit code on both OSes (`driver/show.mjs` comparison).

## 15. Surprises worth acting on (for hudhud design)

1. **The default permission mode is `auto`** (API key, Opus 5.5). It runs mutating shell commands with **no `can_use_tool`, even with `--permission-prompt-tool=stdio`**. With a gateway or mock base URL, the classifier fails closed for "risky" actions. Always pass `--permission-mode`.
2. **The 401 is sticky for the session**, and default retries take about 3 minutes before the error result. The **529 cap is 3 attempts**, independent of `CLAUDE_CODE_MAX_RETRIES`.
3. **GH#98713 is real in 2.1.296**: an interrupt in the same write as a turn-2 user message is ignored.
4. **Bash tool = its own process group** on Linux, and an **orphaned git-bash tree** on Windows after TerminateProcess. A job, cgroup or subreaper is needed.
5. **Exit code 0 can mean killed**: a Windows job close gives 0, and Linux SIGINT mid-turn gives 0 with no result frame.
6. **The CLI never sends keep_alive**, and never times out a pending `can_use_tool`. The host's watchdog must cover this.
7. The ancestor `.claude` leak (§13.1), the nonessential-traffic direct egress to api.anthropic.com, and the `/tmp/cc-socks-<uid>` socket fallback.
8. 2.1.296 sends `role:"system"` messages mid-conversation, and prepends an attribution `<system-reminder>` to the first user message.
9. `--permission-mode` choices now include `manual`. `default` is accepted but not listed.

## 16. Reproducing

```
# mock
docker build -t hudhud-mock-api:dev S/sandbox/mock-api
docker run -d --name hudhud-mock-api -p 127.0.0.1:47311:8080 -v <S>\sandbox\mock-api\logs:/logs --user root hudhud-mock-api:dev
# Windows tests (each file is a set of scenarios; an optional argv[2] filters by name prefix)
cd S/sandbox/driver && node t02-protocol.mjs q1 && node show.mjs q1
# files: t00-smoke t01-isolation t02-protocol t03-permissions t04-lifecycle t05-exit-extra t06-tree t07-io t08-core t09-socket t09b-socket-native t10-egress
# Linux
docker network create --internal hudhud-net && docker network connect --alias hudhud-mock-api hudhud-net hudhud-mock-api
docker run -d --init --name hudhud-cli-linux --network hudhud-net --user node --read-only --tmpfs /tmp:rw,exec,size=256m --tmpfs /home/node:rw,size=64m \
  -v <S>\sandbox\bin\linux-x64\x\package:/sandbox/bin/linux-x64/x/package:ro -v <S>\sandbox\driver:/sandbox/driver:ro -v <S>\sandbox\run-linux:/sandbox/run-linux \
  -e HUDHUD_MOCK_URL=http://hudhud-mock-api:8080 -e HOME=/home/node node:24-bookworm-slim sleep infinity
MSYS_NO_PATHCONV=1 docker exec -w /sandbox/driver hudhud-cli-linux node t08-core.mjs
```

Driver caveats:
- Run test files **sequentially**. The mock-request attribution in `report.json` is by time window, so concurrent files cross-pollute that field; the frames are unaffected.
- `scenario()` tears down live sessions (EOF, then kill after 5 s). Before that fix, two early 401 runs were left idling and had to be killed by pid + creation time.
- Not covered: `--resume` matrix, SDK-MCP (`mcp_message`), hooks over stdio, `--output-format json` shape, macOS.
