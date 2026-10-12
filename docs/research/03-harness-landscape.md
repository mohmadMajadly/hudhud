# hudhud research 03: Harness landscape, standards, prior art, and event-model design

Research date: 2026-10-12. Method: read-only web research only (WebFetch/WebSearch). No local agent binary was executed; nothing under ~/.claude was touched. All web content treated as untrusted data. Many docs pages were summarized by a fetch-side model, so exact field names should be re-verified against raw schemas before being frozen into hudhud (flagged "VERIFY-RAW" where it matters). Items I could not confirm are marked UNVERIFIED.

---------------------------------------------------------------------
## 0. Executive summary

1. The market has converged on two integration shapes: (a) a headless CLI emitting JSONL (`-p`/`exec --json`), and (b) a long-lived JSON-RPC (or HTTP+SSE) server that supports multi-turn, approvals and cancel. Everything serious now offers (b), and ACP (Agent Client Protocol) is the de-facto neutral flavour of (b).
2. ACP is no longer an experiment: 42 agents are listed as compatible (https://agentclientprotocol.com/overview/agents), including Gemini CLI, Cursor, Copilot CLI, OpenCode, Qwen Code, Goose (as client), Kiro, Junie, Factory Droid, and, via adapters, Claude (claude-agent-acp) and Codex (codex-acp). Official SDKs exist for TS, Rust (both 1.0.0 as of 2026-06-25), Python, Java, Kotlin (https://github.com/agentclientprotocol/agent-client-protocol, https://agentclientprotocol.com/updates).
3. ACP is "editor<->agent". It models the common denominator well (sessions, prompt turns, streamed chunks, tool calls with kind/status, permission requests, cancel, modes, config options, usage) but is thin on things a library-embedder wants (rich cost/usage per turn, structured raw passthrough, fork/rewind, background task state, hooks, subagent trees). The best adapters already smuggle these via `_meta` extensions (JetBrains AIR extensions in claude-agent-acp / codex-acp).
4. Native, richer protocols exist and are what first-party SDKs use: Claude Code stream-json/Agent SDK, Codex app-server (JSON-RPC, threads/turns/items), opencode HTTP+SSE with OpenAPI, Copilot CLI JSON-RPC server. These expose more than ACP.
5. Recommendation (detail in section 7): make hudhud's core model an ACP-compatible *superset*, not ACP itself. Use ACP as (i) a first-class transport adapter (hudhud can drive any ACP agent, and optionally expose itself as an ACP agent) and (ii) the vocabulary reference for naming (tool kinds, statuses, stop reasons, permission option kinds). Keep native adapters for Claude Code and Codex because the ACP adapters for them lose fidelity and have open lifecycle bugs. Do not make the wire schema of hudhud *be* ACP.

---------------------------------------------------------------------
## 1. Per-harness programmatic interfaces

### 1.1 Claude Code (baseline; hudhud's first target)
- Transports: `claude -p` with `--output-format text|json|stream-json`, `--input-format stream-json` for multi-turn over stdin; TS and Python Agent SDKs wrap the same process. Source: https://code.claude.com/docs/en/headless
- Events (stream-json, NDJSON): `system/init` (model, tools, MCP servers, plugins, optional `capabilities` string array for feature detection, v2.1.205+), `system/api_retry` (with enumerated `error` category), `assistant`/`user` messages carrying `parent_tool_use_id` (null for main thread, id for subagents), `stream_event` deltas with `--include-partial-messages`, `permission_denied` system messages, hook events (`hook_started/progress/response`), final `result` (text, `session_id`, `total_cost_usd`, usage, `permission_denials`, `structured_output`). Same source.
- Permissions: permission modes (`default`, `acceptEdits`, `auto`, `dontAsk`, bypass), `--allowedTools` rule syntax, `--permission-prompt-tool` (MCP tool as approval host), SDK `canUseTool` callback, `--permission-prompts none` for unattended runs (v2.1.259+). Same source.
- Sessions: `--continue`, `--resume <id|path-to.jsonl>`; transcripts stored locally as JSONL; sessions findable by id across projects on the machine. Same source.
- Interruption: SIGINT / SDK `interrupt()` ends the turn cleanly; SIGTERM exits 143 and records no result. Same source.
- Auth: subscription login (OAuth/keychain) or `ANTHROPIC_API_KEY`; `--bare` ignores OAuth/keychain, requires API key or provider creds (Bedrock/Vertex/Foundry). Same source.
- Maturity: very high, fast-moving (version-gated behaviors in nearly every paragraph; hudhud must feature-detect via `capabilities`, not version strings).
- Notable: `--bare` is "recommended for scripted and SDK calls and will become the default for -p in a future release" (same source), a direct example of silent default churn hudhud must insulate against.

### 1.2 OpenAI Codex CLI
- `codex exec --json`: JSONL with `thread.started`, `turn.started`, `turn.completed` (token usage), `turn.failed`, `item.started/updated/completed`, `error`. Item types: agent message, reasoning, command execution, file change, MCP tool call, web search, plan update. Source: https://learn.chatgpt.com/docs/non-interactive-mode (redirected from developers.openai.com/codex/noninteractive).
- Sandbox: default read-only; `--sandbox workspace-write|danger-full-access`; `--full-auto` deprecated; requires a git repo unless `--skip-git-repo-check`. Approval flag not covered on that page (UNVERIFIED for exec).
- Resume: `codex exec resume --last|<SESSION_ID>`. Structured output: `--output-schema <file>`, `-o`. Auth: saved CLI auth, `CODEX_API_KEY`; docs warn against exposing keys to repo-controlled CI code. Same source.
- App-server (the rich protocol): JSON-RPC style over stdio, in-process, or WebSocket. Methods `thread/start|resume|fork|list|read|archive|delete|revert`, `turn/start`, `turn/steer`, `model/list`, `account/*`, `mcpServer/*`, `command/exec`, etc. Notifications incl. `thread/started`, turn completion with `turn.error.codexErrorInfo`; clients can opt out of notification methods per connection (`optOutNotificationMethods`). Versioning is capability-based (`initialize.capabilities.experimentalApi`), no formal version number; many methods require the experimental opt-in; unknown capabilities may be silently ignored so clients must probe. Source: https://github.com/openai/codex/tree/main/codex-rs/app-server
- SDKs: TS `@openai/codex-sdk` (`startThread`, `run`, `resumeThread`), Python `openai-codex` (controls local app-server over JSON-RPC; bundles pinned CLI; sandbox presets). Streaming API not described on that page. Source: https://learn.chatgpt.com/docs/codex-sdk
- ACP: `codex-acp` built on the App Server (https://github.com/agentclientprotocol/codex-acp); the older zed-industries/codex-acp is archived (https://github.com/zed-industries/codex-acp).
- Maturity: high; protocol still moving (experimental flags, removed methods e.g. `thread/rollback`).

### 1.3 Gemini CLI
- Headless: `-p` or non-TTY. `--output-format json` (single object: `response`, `stats`, optional `error`) or `stream-json` JSONL with `init`, `message`, `tool_use`, `tool_result`, `error`, `result` (aggregated stats, per-model usage). Exit codes 0, 1, 42 (input error), 53 (turn limit). Source: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md
- ACP: `gemini --acp`; methods initialize, authenticate, newSession, loadSession, prompt, cancel, setSessionMode (approval level), `unstable_setSessionModel`; file access proxied through the client. Source: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md
- Pain points (from issue/PR titles only, bodies not read): headless hang with piped stdin (#29434), duplicate tool results on `-r` resume (#29365), unguarded JSON.parse killing stream (#29308), lost final SSE event (#29059). Source: https://github.com/google-gemini/gemini-cli/issues?q=stream-json
- Maturity: high usage, uneven robustness. Qwen Code is a fork of Gemini CLI v0.8.2 that has since diverged (https://github.com/QwenLM/qwen-code).

### 1.4 opencode (sst/opencode)
- `opencode serve` HTTP server (default 127.0.0.1:4096), OpenAPI 3.1 at `/doc`, SSE at `GET /event` (first event `server.connected`) and `/global/event`; session CRUD/fork/share/revert/abort; `POST /session/:id/message`, `prompt_async`, `command`, `shell`; permission reply `POST /session/:id/permissions/:permissionID`. Auth: optional HTTP basic via `OPENCODE_SERVER_PASSWORD`. Source: https://opencode.ai/docs/server/
- SDK: `@opencode-ai/sdk` (types generated from OpenAPI), `createOpencode()` spawns server+client, structured output via `json_schema` format (`StructuredOutputError`). Source: https://opencode.ai/docs/sdk/
- ACP also supported (listed on the ACP agents page). Known ACP issues (titles from tracker): plan mode "advisory, not enforced" (#54632), slash-command output not streamed (#54371), unknown tool marked completed (#54238), no `session/delete` (#54478). Source: https://github.com/sst/opencode/issues?q=acp (note: that URL slug was the one fetched; the repo may have been renamed, UNVERIFIED which org currently owns it).
- Maturity: high, very fast-moving.

### 1.5 Cursor CLI (`agent`)
- Headless `-p`; formats text/json/stream-json (+ `--stream-partial-output`); stream events include `system` init, `assistant`, `tool_call` (started/completed), final `result` with `duration_ms`. Edits require `--force`/`--yolo`. Auth `CURSOR_API_KEY`. Source: https://cursor.com/docs/cli/headless
- ACP: `agent acp`, JSON-RPC 2.0 over stdio NDJSON; modes `agent|plan|ask`; permission options `allow-once|allow-always|reject-once` (note hyphenated, differs from ACP spec's snake_case `allow_once` -- the page's wording; VERIFY-RAW); extension methods `cursor/ask_question`, `cursor/create_plan` (blocking) and `cursor/update_todos`, `cursor/task`, `cursor/generate_image`. Limitation: team-level dashboard MCP servers unsupported in ACP; `cursor_login` advertised but must pre-authenticate. Source: https://cursor.com/docs/cli/acp
- Maturity: medium-high; session resume in headless not documented on the fetched page (UNVERIFIED).

### 1.6 GitHub Copilot CLI
- ACP server in public preview ("subject to change"): `copilot --acp [--stdio|--port N]`; stdio single client, TCP multi-connection on 127.0.0.1; tool allow/deny and effort are server-wide, not per-`session/new`; slash commands advertised via `available_commands_update`; interactive-only commands unsupported; BYOK via `COPILOT_PROVIDER_*`. Source: https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server
- Separate Copilot SDK (technical preview since ~Jan 2026): TS, Python, Go, .NET clients talking JSON-RPC to the CLI in server mode; `cliUrl` to attach to an external server. Only secondary sources read: https://itbrief.com.au/story/github-unveils-copilot-sdk-to-power-ai-agent-workflows (UNVERIFIED against GitHub's own docs; preview status may have changed).

### 1.7 Amp (Sourcegraph)
- CLI `--execute --stream-json` (per an unofficial Elixir SDK; "smart" mode only supported for stream-json: https://hex.pm/packages/amp_sdk/0.8.0/files, third-party, UNVERIFIED for current behavior).
- Official SDK `@ampcode/sdk` (TS) and Python: `execute({prompt, options, signal})` async generator yielding `system`, `assistant`, `result`; options `mode` (low..ultra), `effort`, `continue` (thread id), `mcpConfig`, `executor` (orb/runner remote), `skills`. Permissions are via a custom *plugin*, not an in-band request/response. Auth `AMP_API_KEY` or `amp login`. Source: https://ampcode.com/manual/sdk
- Observation: Amp's message model deliberately mirrors Claude's (`system/assistant/result`). Amp is also listed as an ACP provider for Goose (https://goose-docs.ai/docs/guides/acp-providers).

### 1.8 Goose (Block; now under Agentic AI Foundation / Linux Foundation)
- Rust; desktop app, CLI, and an API; MCP-based extensions; part of AAIF (https://github.com/block/goose). `goose run -t` for non-interactive. Goose acts primarily as an ACP *client* (uses Claude/Codex/Amp/Pi ACP agents as providers); whether it serves ACP is not stated on the fetched page, although the ACP agents page lists Goose (https://agentclientprotocol.com/overview/agents). ACP providers do not yet support `goose session resume/fork` (https://goose-docs.ai/docs/guides/acp-providers). `goosed` server details UNVERIFIED (docs page 404 on guessed URL).

### 1.9 Aider
- Scripting: `--message/-m`, `--message-file`, `--yes`, `--dry-run`; Python `Coder.run()` API explicitly "not officially supported or documented and could change without backward compatibility". No structured event output. Source: https://aider.chat/docs/scripting.html
- Implication: Aider fits only a degraded "text in, text/diff out, no events" capability tier. Low priority.

### 1.10 Qwen Code
- Gemini CLI fork; `qwen -p`; stream-json not mentioned on README; experimental `qwen serve` daemon (HTTP+SSE, ACP); TS/Python/Java SDKs (Python `query()`); multi-provider auth. Source: https://github.com/QwenLM/qwen-code

### 1.11 Other notable (from the ACP agents list, https://agentclientprotocol.com/overview/agents)
Cline, Augment Code, Factory Droid, Junie (JetBrains), Kiro CLI, Kimi CLI, Mistral Vibe, OpenHands, Qoder CLI, Docker cagent, fast-agent, Pi (via pi-acp), OpenClaw, Hermes Agent, Poolside, VT Code, Stakpak. I did not research their native protocols (UNVERIFIED beyond "claims ACP support").

---------------------------------------------------------------------
## 2. Standards

### 2.1 Agent Client Protocol (ACP)
- Spec: JSON-RPC 2.0; agent is typically a subprocess of the client; stdio NDJSON is the baseline transport (Copilot example uses `acp.ndJsonStream`). Remote transports (WebSocket/HTTP) are being standardized by a Transports Working Group formed 2026-04-22. Sources: https://agentclientprotocol.com/protocol/overview, https://agentclientprotocol.com/updates, https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server
- Baseline agent methods: `initialize`, `authenticate`, `session/new`, `session/prompt`; notification `session/cancel`. Optional: `session/load`, `session/resume` (stable 2026-04-22), `session/close` (04-23), `session/list` (03-09), `session/delete` (06-05), `session/set_mode`, `logout` (05-21), `$/cancel_request` (06-29). Client methods: `session/request_permission` (baseline), `fs/read_text_file`, `fs/write_text_file`, `terminal/*` (create/output/release/wait_for_exit/kill), `elicitation/create` (stable 07-22). Sources: overview + updates pages above.
- `session/update` variants: `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update` (`used`, `size`, optional `cost{amount,currency}`; stable 06-05), plus capability-gated `notice` and `compaction_update`/`compaction_summary_chunk`. Source: https://agentclientprotocol.com/protocol/prompt-turn
- Tool calls: `kind` in read|edit|delete|move|search|execute|think|fetch|switch_mode|other; `status` pending|in_progress|completed|failed; content = text/image/resource, `diff` (path, oldText, newText), or `terminal` (terminalId); `locations` (path, line). Permission options `allow_once|allow_always|reject_once|reject_always`; outcome `selected{optionId}` or `cancelled`. Source: https://agentclientprotocol.com/protocol/tool-calls
- Stop reasons: end_turn, max_tokens, max_turn_requests, refusal, cancelled. Cancel semantics are strict: pending permissions must be answered `cancelled`, agent must return `cancelled` (not an error). Source: prompt-turn page.
- Versioning/extensibility: integer `protocolVersion` negotiated in `initialize` (stable = 1; v2 docs and schema published as Draft 2026-07-20; `schema/v1` and `schema/v2` dirs). Capability objects gate optional features. `_meta` on everything (MUST NOT assume values), custom methods prefixed `_`, enum-like fields accept `_`-prefixed custom values and treat other unknowns as reserved future variants; clients "should keep the raw payload" for unrecognized elicitation modes. Sources: https://github.com/agentclientprotocol/agent-client-protocol, https://agentclientprotocol.com/protocol/schema, https://agentclientprotocol.com/protocol/v2 (page did not describe v1->v2 deltas; UNVERIFIED what breaks).
- Process: RFD-driven; features land as "unstable" then stabilize within days/weeks of each other in 2026 (see updates page); JetBrains' maintainer is a lead (Feb 2026). ACP Registry shipped 2026-03-09.
- Real-world friction (claude-agent-acp issues, titles only, https://github.com/agentclientprotocol/claude-agent-acp/issues): permission requests still firing under bypass mode (#1196); MCP tool annotations not forwarded on permission requests (#1184); `session/load` replays only from last compaction (#1297); `usage_update` wrong context size after load (#1181); idle/turn attribution races (#1144, #1145); turn never answered when a background `task_notification` is lost (#1284); no signal that background tasks continue after turn (#1285); steering failures (#1267, #1280); PostToolUse hook stalls if client not reading `session/update` (#1269). Take-away: ACP's turn model (one `session/prompt` request == one turn) fits poorly with harnesses that have autonomous background work, steering, and subagents. Adapters paper over with `_meta` extensions: JetBrains AIR extensions for diffs, goals, structured failure, subagent sessions (draft `clientCapabilities.subagents`) -- https://github.com/agentclientprotocol/claude-agent-acp, https://github.com/agentclientprotocol/codex-acp.

### 2.2 Other standards
- MCP: agent<->tools. Not for harness control, but every harness takes MCP servers; hudhud should pass MCP config through uniformly (ACP `session/new` carries `mcpServers`). Layering view: https://docs.ag-ui.com/introduction.
- A2A (Agent2Agent): agent-to-agent, opaque agents, donated to Linux Foundation, v1.0 exists; explicitly not a tool-call/sub-agent protocol (https://a2a-protocol.org/latest/). Wrong granularity for steering a local harness (no per-tool permission streaming); relevant only if hudhud ever exposes a harness as a remote peer. Low priority.
- AG-UI: agent<->frontend event stream over HTTP/WebSockets (token streaming, tool streaming, shared state diffs, custom events); does not mention ACP (https://docs.ag-ui.com/introduction). Useful as a *projection target* (hudhud events -> AG-UI for web UIs), not as core model. Event type list not read (UNVERIFIED).
- AI SDK community provider for ACP (`@mcpc-tech/acp-ai-provider`) wraps ACP agents as an AI SDK LanguageModel; limitation: one model object per agent, no model selection (https://ai-sdk.dev/providers/community-providers/acp). Illustrates the impedance mismatch of squeezing an agent into a chat-completion abstraction.

---------------------------------------------------------------------
## 3. Existing multi-harness libraries

| Project | Approach | Notes (all from cited pages; issue-level pain points mostly UNVERIFIED because pages gave little) |
|---|---|---|
| Headless Coder SDK | Core factory + per-backend adapters (Codex SDK, Claude Agent SDK, Gemini CLI); `createCoder`, `startThread`, `thread.run(prompt,{outputSchema})` | Thread/run oriented (request/response, structured output), little on streaming of tool calls/permissions in what I could read; `close` optional per adapter shows uneven lifecycle. https://github.com/openai/codex/discussions/6402 (discussion thread had no technical feedback). |
| Rivet sandbox-agent | Rust daemon in sandbox, HTTP+SSE, per-agent adapters (Claude Code, Codex, OpenCode, Cursor, Amp, Pi per README listings); "universal session schema" for storage/replay; TS+Python SDKs; pluggable persistence | Closest philosophical match to hudhud's event log. OpenCode compat described as experimental by a third-party listing. Field-level schema not read (VERIFY-RAW at https://sandboxagent.dev). Sources: https://cdn.jsdelivr.net/gh/rivet-dev/sandbox-agent@main/README.md (search-result summary), https://www.rivet.dev/changelog/2026-01-28-sandbox-agent-sdk/ |
| AI SDK ACP provider | ACP client -> LanguageModel | Hides tool/permission richness; see 2.2. |
| Goose ACP providers | ACP client inside an agent | No resume/fork over ACP providers yet. https://goose-docs.ai/docs/guides/acp-providers |
| Zed / JetBrains / VS Code ACP clients (e.g. VS Code ACP Client extension, UnityAgentClient, Polaris) | ACP clients | Show the ACP-client ecosystem is real: https://agentclientprotocol.com/get-started/clients, https://dev.to/formulahendry/vs-code-acp-client-extension-conect-to-claude-gemini-codex-opencode-qwen-code-and-so-on-3552 |
| clisweave, agent-multicli, etc. | Thin flag normalizers / MCP wrappers | Small, low maturity (https://github.com/salemaziel/agent-multicli). |

What they got right: adapter-per-backend behind a small core; normalized event log for persistence/replay; treating the harness as a subprocess you supervise.
What they got wrong/risk (inferred from patterns, flagged as analysis not citation): lowest-common-denominator `run(prompt) -> string/json` APIs that drop tool-call/permission/interruption fidelity; no capability negotiation (adapters silently no-op, e.g. optional `close`); schemas that are re-versioned every time a harness changes; coupling to harness version.
I did not find a widely adopted canonical library; I could not retrieve issue trackers for these projects (UNVERIFIED pain points beyond the above).

---------------------------------------------------------------------
## 4. Common denominator vs divergence (comparison table)

Legend: Y = documented, P = partial/extension, N = not offered, ? = UNVERIFIED. Based on sources in sections 1-2.

| Dimension | Claude Code | Codex | Gemini CLI | opencode | Cursor | Copilot CLI | Amp | ACP (spec) |
|---|---|---|---|---|---|---|---|---|
| Headless JSONL | stream-json | exec --json | stream-json | N (HTTP) | stream-json | ? (ACP) | stream-json | N/A |
| Long-lived server/RPC | SDK control protocol over stdio | app-server (stdio/WS) | ACP | HTTP+SSE+OpenAPI | ACP | ACP + SDK JSON-RPC | SDK execute generator | JSON-RPC |
| Text streaming deltas | Y (opt-in partial) | item.updated (P) | message chunks | SSE events | opt-in partial | ACP chunks | ? | agent_message_chunk |
| Thinking/reasoning | in assistant blocks | reasoning item | ? | ? | ? | ? | ? | agent_thought_chunk |
| Tool call lifecycle | tool_use/tool_result blocks | item started/completed | tool_use/tool_result | message parts | tool_call started/completed | ACP tool_call(_update) | in assistant | tool_call + status machine |
| Tool taxonomy | free-form tool names | typed items (command, file change, MCP, web search) | free-form | free-form | free-form | ACP kinds | free-form | fixed `kind` enum |
| Permission prompt in-band | Y (canUseTool / prompt-tool MCP) | Y (app-server approvals; page not detailed) | via ACP; modes | Y (REST reply) | Y via ACP; headless needs --force | Y via ACP | N (plugin) | Y request_permission |
| Permission "remember" | rules/modes | exec policy rules | modes | ? | allow-always | ? | plugin | allow_always/reject_always |
| Pre-set policy modes | default/acceptEdits/auto/dontAsk/bypass | read-only/workspace-write/full-access sandbox | approval via setSessionMode | ? | agent/plan/ask | server-wide tool lists | modes (low..ultra = model tier, not policy) | modes (opaque ids) |
| Interrupt | SIGINT/interrupt() | turn interrupt (app-server) ? | cancel (ACP) | abort endpoint | session/cancel | session/cancel | AbortSignal | session/cancel (strict semantics) |
| Mid-turn steering | stream-json input | `turn/steer` | ? | prompt_async | ? | ? | multi-turn input generator | N (draft/extension) |
| Session resume | --resume id/path | resume id/--last | -r (dup-result bug) | session API | ACP session/load | ACP | continue thread id | session/load, resume, list, close, delete |
| Fork/rewind | partial (not read) | thread/fork, revert | ? | fork, revert | ? | ? | ? | N (RFD) |
| Usage/cost | result.total_cost_usd + usage (client-side estimate) | tokens on turn.completed | stats in result | ? | duration_ms | ? | ? | usage_update used/size + cost (stable 06-05) |
| Error model | result is_error, api_retry categories, exit code | turn.failed, codexErrorInfo | error events, exit codes 1/42/53 | HTTP errors, StructuredOutputError | ? | ? | result.is_error | JSON-RPC errors + stop reasons |
| Structured output | --json-schema | --output-schema | N documented | json_schema format | ? | ? | ? | N |
| Subagents | parent_tool_use_id tree | ? (AIR draft sessions) | ? | ? | cursor/task ext | ? | ? | draft RFD |
| Capability discovery | init.capabilities array | initialize.capabilities (+ probing) | ? | OpenAPI/version | ACP | ACP | ? | initialize capabilities |
| Auth | OAuth/API key/cloud | ChatGPT login/API key | ? | provider creds + basic auth for server | API key/token | GitHub login/BYOK | API key/login | authenticate method |
| Config surface leak risk | hooks/CLAUDE.md/plugins loaded unless --bare | config.toml, rules | settings | opencode.json | .cursor/mcp.json | server-wide | settings file | per-agent |

Common denominator (safe for hudhud v1 core):
1. Session lifecycle: create, send prompt (turn), cancel, optionally resume by id.
2. Streamed assistant text chunks (final text always available).
3. Tool call with id, name/title, input, status (pending -> running -> completed|failed), result text.
4. Permission request with a set of options and an allow/deny reply (even if some harnesses can only express it via modes/flags).
5. Turn end with a reason (completed, cancelled, error, limit).
6. Some usage figure (tokens at minimum).

Divergences needing capability flags: cost reporting, thinking stream, partial deltas, mid-turn steering, fork/rewind, structured output, subagent tree, permission remember scope, background tasks, in-band approval vs policy-only, resume fidelity, MCP injection, model switching, file-system/terminal delegation to client, slash commands, plan/ask modes, remote execution.

---------------------------------------------------------------------
## 5. Design best practices for a harness-neutral, daily-evolving event model

Grounded in what the surveyed protocols themselves do, plus standard practice (analysis, not all cited):

1. Two-layer events: a small *normalized* envelope plus a mandatory `raw` payload. Every normalized event carries `{v, id, seq, sessionId, turnId?, ts, type, harness:{name,version,adapter}, raw?: {format, data}}`. Rationale: ACP `_meta`, "clients should keep the raw payload" (schema page), Claude `capabilities` array, Rivet's persisted universal schema.
2. Open unions: every discriminated union has an `unknown`/`other` arm that preserves `type` string and payload; consumers must `default:` safely. ACP does this for elicitation modes, CompactionStatus, config option values (schema page). Never throw on an unrecognized `type` or enum value; round-trip it.
3. Additive-only evolution within a major: new optional fields, new event types, new enum values. Removals/renames only at major, with the old name kept as alias for a deprecation window. Use string enums (not integer, not closed TS unions at the wire).
4. Version the *schema* separately from the *library* and from the *harness*. ACP negotiates a single integer `protocolVersion` plus capability objects for fine-grained features; Codex relies on capability opt-ins (`experimentalApi`) and has no version number; Claude exposes a `capabilities` string array so clients avoid version sniffing. Take: integer major for the wire schema + capability strings for features + harness version recorded as data only.
5. Capability negotiation both ways: adapter declares what it can do (`steer`, `fork`, `cost`, `thinking`, `permission.inband`, `permission.remember`, `resume`, `subagents`, ...) with tri-state `supported | emulated | unsupported`, plus `degradedReason`. App declares what it can render/handle (notices, compaction, terminals, elicitation) as ACP does (`session.notices`, `session.compaction`).
6. Experimental namespace: `x-` / `_` prefixed types and fields are exempt from compat promises (ACP `_` convention; Codex experimental flags; Gemini `unstable_` method prefix). Promote by rename with alias.
7. Event ordering and correlation: monotonic `seq` per session, stable ids for tool calls, explicit turn open/close events with attribution (the ACP-adapter bugs #1144/#1145/#1284 show the cost of idle/turn races). Model "turn" as a hudhud concept distinct from an RPC request/response so background/autonomous activity after a turn is representable.
8. Idempotent replay: persisted event log must be re-readable by newer library versions (store original `v`), enabling upcasters (old -> new) instead of migrating data in place.
9. Golden-file and contract tests per adapter: record real harness sessions (JSONL fixtures) and run them through the adapter in CI; run a daily canary against latest harness versions (the cited changelogs show behavior shifts like `--bare` becoming default, or Codex removing `thread/rollback`).
10. Pin and detect: prefer feature detection (Claude `capabilities`, Codex initialize probe) over semver checks; keep a min/max tested-version matrix per adapter; surface "untested version" as a warning event, never a hard failure.
11. Error taxonomy: small normalized set (auth, rate_limit/overloaded, billing, invalid_request, model_not_found, cancelled, limit_reached, harness_crash, protocol_violation, unknown) mapped from Claude's enumerated `api_retry` errors, Codex `codexErrorInfo`, Gemini exit codes 1/42/53, ACP stop reasons; always keep raw.
12. Permissions are a first-class state machine with a timeout/cancel path: pending -> answered|cancelled|expired. Cancel must resolve all pending (ACP rule) and the SDK must tolerate unanswered prompts when the process is killed (Claude SIGTERM doc).
13. Process hygiene is part of the contract: stdout reserved for protocol, drain-on-exit (Claude waits up to 30 s for slow consumers), stdin-hang defense (Gemini #29434), config-isolation option (`--bare`, `--ignore-user-config`) exposed as a hudhud "hermetic" flag with per-harness mapping.
14. Language bindings: define schemas in JSON Schema (or TypeSpec/Protobuf) as source of truth and generate types; ACP ships versioned JSON schema artifacts per release, Codex app-server and opencode ship generated/OpenAPI types. Avoid TS-only definitions if non-TS bindings are planned.

---------------------------------------------------------------------
## 6. Interop facts relevant to the ACP decision

- ACP gets hudhud ~30+ harnesses with one adapter, but each ACP agent differs in what it implements (Gemini lists `unstable_setSessionModel`; Cursor adds `cursor/*` methods; Copilot fixes tools server-wide; Goose ACP providers lack resume/fork).
- ACP adapters for Claude/Codex are third-party wrappers over the Agent SDK/app-server (https://github.com/agentclientprotocol/claude-agent-acp) and add a translation layer with documented gaps; going native for those two avoids a dependency stack hudhud does not control, and hudhud's first target is Claude Code itself.
- ACP's agent-side semantic "one prompt request = one turn" and client-side obligations (must implement fs/terminal for full fidelity) are designed around an editor host. A library host can decline fs/terminal capability and let the agent use its own tools, which most agents support (capability-gated) -- UNVERIFIED per agent.
- ACP is moving fast (about 20 stabilizations in 2026, v2 in Draft since 2026-07-20), and the stable/unstable boundary is explicit; this argues for a thin anti-corruption layer rather than re-exporting ACP types.

---------------------------------------------------------------------
## 7. Recommendation on ACP alignment

Adopt "ACP-compatible superset with an anti-corruption layer":

1. Core model is hudhud's own, versioned independently (JSON-Schema-defined), but its vocabulary deliberately mirrors ACP wherever ACP is sound: session/turn/prompt, `tool_call` + `tool_call_update` with ACP `kind` and `status` enums, permission option kinds (`allow_once|allow_always|reject_once|reject_always`), stop reasons, mode/config-option concept, `usage_update` (used/size/cost), `plan`, available commands. This makes the ACP adapter nearly 1:1 and keeps future bindings learnable by people who know ACP.
2. Superset additions that ACP lacks: turn-independent background/autonomous activity events, subagent tree (`parentToolCallId`), richer usage/cost per turn and per model, normalized error taxonomy, mandatory `raw` passthrough, tri-state capability negotiation, fork/rewind/steer as capabilities.
3. Ship three adapter kinds: (a) native adapters (Claude Code stream-json/Agent SDK first; Codex app-server next; opencode HTTP+SSE), (b) a generic ACP *client* adapter (gives breadth: Gemini, Cursor, Copilot, Qwen, Kiro, Goose-style agents), (c) later, an ACP *agent* facade so editors (Zed, JetBrains, VS Code ACP clients) can drive hudhud-managed harnesses. Do (a)+(b) first; (c) optional.
4. Do not expose ACP types in hudhud's public API and do not make ACP wire compatibility a release constraint, because ACP v2 is still Draft and ACP's turn model has open lifecycle issues for harnesses with background work. Pin ACP SDK/protocol version inside the adapter only and map v1 and (later) v2 into the same hudhud events.
5. Reasons: breadth for free (42 listed agents); ACP's design principles (capability negotiation, `_meta`, unknown-variant tolerance) match the evolution goals; but fidelity gaps (cost, subagents, background tasks, permission annotations) and churn risk mean the core must be able to move independently. Also governance risk is low (open, multi-vendor, JetBrains + Zed maintainers) which is why interop is worth the investment, but not enough to bind the core to it.

---------------------------------------------------------------------
## 8. Open items for follow-up (UNVERIFIED / not fetched)
- Raw ACP JSON schema (v1 and v2 Draft): read `schema/v1`, `schema/v2` artifacts and the second half of https://agentclientprotocol.com/protocol/schema (only first 100k of 217k chars were read) to confirm full SessionUpdate list and v1->v2 breaking changes.
- Codex app-server approval request/response message shapes (page I read did not describe them); read the generated schema in the repo.
- Claude Agent SDK control protocol details (canUseTool message shapes, `interrupt_receipt_v1` semantics): https://code.claude.com/docs/en/agent-sdk/typescript#sdksystemmessage.
- Gemini/Cursor/Copilot native stream event field-level schemas and Cursor session resume; Copilot SDK official docs; Amp CLI stream-json first-party docs; Goose `goosed`; Qwen stream-json; Kiro, Junie, Cline, OpenHands native protocols.
- Rivet sandbox-agent universal schema field list (https://sandboxagent.dev) and Headless Coder SDK source for real abstractions and issues; GitHub issue trackers of unifying libraries were not retrieved.
- Windows specifics (process spawning, signal semantics on Windows for interrupt, path handling in ACP "absolute path" requirements) were not researched; Claude docs mention SIGINT/SIGTERM behavior (Unix framing) and a Windows stdin-crash fix pre v2.1.211; hudhud needs its own cross-platform interrupt strategy (probably stdin-protocol interrupt rather than signals).
