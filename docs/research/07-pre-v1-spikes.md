# 07 — Pre-v1 spikes: Claude Code CLI 2.1.296 (resume, host crash, G1, pid, concurrency, long paths, bg ceiling, hook timeout, C3, workspaceTrust)

Date: 2026-10-12. Host: Windows 11 Home 10.0.26200, Node 24.19.0, Docker Desktop (Linux engine), Git for Windows bash. Linux runs: `node:24-bookworm-slim` container (glibc), same recipe as 05 §14/§16. **No macOS host was available; nothing here is verified on macOS.**

Everything ran on the pinned 2.1.296 binaries (SHA-256 re-verified, §0.1) against local mocks. No real API, no real credentials, no user install or user config was used. The egress trap refused or locally terminated every non-mock connection; nothing was forwarded upstream.

Paths: `S` = scratchpad root. Scripts: `S/sandbox/driver/t11-*.mjs` … `t20-*.mjs`. Raw evidence per run: `S/sandbox/run/NN-<name>/` (Windows) and `S/sandbox/run-linux/NN-<name>/` (Linux), each with `frames*.ndjson` (every stdin/stdout/stderr line, ms timestamps, argv, env), `report.json` (result, mock requests, outside-the-sandbox diff, file list) and, where used, `cli-debug*.log` (the CLI's own `--debug-file`). Run numbers below are `W<nn>` (Windows) and `L<nn>` (Linux).

---

## 0. Summary

| # | Spike | Verdict | Finding (both OSes unless noted) | Gates |
|---|---|---|---|---|
| 1 | Resume/fork matrix | **VERIFIED** | `--resume <id>` and `--continue` reuse the id (`system/init.session_id` = old id) and load history; `--fork-session` gets a new id (or the `--session-id` given) with a full copy of the transcript. **No lock:** a second process can resume a session that another live process holds, and both append to one file; the next resume follows only the last-written branch. `--continue` in a cwd with no history **silently starts a new session** (exit 0). Nonexistent id → `result/error_during_execution` on stdout **before any `initialize` response**, exit 1. | ADR-0008, capability `resume`/`fork` |
| 2 | Host crash | **VERIFIED** | **Windows, Node host, non-detached:** the CLI does not see EOF; it is killed ~32–35 ms after the host dies (exit code 0, no graceful shutdown) because libuv puts children in a kill-on-close job. **Its Git-Bash tool tree survives (orphaned).** Windows detached, and Linux: the CLI sees stdin EOF and behaves exactly like a graceful EOF (finishes stream/tool, then exits 0); no orphans. Stale `cfg/sessions/<pid>.json` after the Windows kill. | ADR-0009, ADR-0010, ADR-0008 |
| 3 | G1 nonessential traffic | **VERIFIED** | **The variable does NOT suppress managed policy.** With the default base URL, `GET /api/claude_code/settings` and `GET /api/claude_code/policy_limits` are fetched with the variable on (and off). What does suppress them is **any custom `ANTHROPIC_BASE_URL`** (ineligible `custom_base_url`), with or without the variable. With the variable off, the CLI also calls `bootstrap`, `penguin_mode`, `mcp-registry`, `eval` (feature flags), `event_logging` and `metrics_enabled` on api.anthropic.com, **bypassing a custom base URL**. The individual switches stop telemetry/flags but not `bootstrap`, `penguin_mode`, `mcp-registry`. | ADR-0012 §5 (E7/G1) |
| 4 | `initialize.pid` | **VERIFIED** | Direct spawn of the native exe: `pid` = spawned pid. Through a launcher (shape of the npm fallback `cli-wrapper.cjs`): `pid` = the real CLI (child of the launcher) ≠ spawned pid. `system/init` carries no pid. | ADR-0011, ADR-0009/0010 root set |
| 5 | Concurrent sessions, one config dir | **VERIFIED** | 4 CLIs × 5–10 turns: all turns succeed, `.claude.json` always valid (0 invalid reads in ~95–184 polls), no leftover lock files, no stderr errors. Cold config dir only: a first-write race logs `[ERROR] Failed to save config with lock` and on Linux `Config lock still held … skipping the unlocked fallback write (save_global)` (a skipped global-config write, gh-73364). Warm config dir: no contention; `.claude.json` byte-identical before/after (print mode writes almost nothing there). | ADR-0012 §1 (shared real config dir) |
| 6 | Windows long-path cwd | **VERIFIED** (this host: `LongPathsEnabled=1`) | Plain spawn works up to **258** chars; from **259** `spawn` fails with a misleading `ENOENT`. With a `\\?\`-prefixed cwd the spawn succeeds but **the CLI's cwd becomes the 8.3 short-name alias** (`<8.3 short-name path>`): transcripts go to a different project key, and the Bash tool refuses writes ("suspicious Windows path pattern"). Write/Read with absolute long paths work. Transcript dir names > 200 chars are truncated + hashed. | ADR-0009, ADR-0011 |
| 7 | `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` | **VERIFIED** (default value from binary + partial experiment) | Default **600000 ms**; `0` = wait indefinitely. The clock starts when stdin is closed and the CLI is otherwise idle. On expiry it **stops background subagents/tasks** and writes a fixed stderr line, exit 0. **It does not bound background Bash shells**: with ceiling 5000 or the default, the CLI waited for a `run_in_background` shell until it finished (45 s; 697 s with the default). | ADR-0008 stdin-close policy |
| 8 | Hook timeout unit | **VERIFIED** | **Seconds**, both for `initialize` hook callbacks and for settings hooks. Callback `timeout:3` → `control_cancel_request` at exactly 3000 ms and the tool is **blocked** (fail-closed). Settings command hook `timeout:3` → cancelled at ~3.0–3.75 s and the tool **runs** (fail-open). `timeout:3000` means 50 minutes. Callback default (no `timeout`): **600 s**. | ADR-0007 (E9) |
| 9 | C3 project `env.ANTHROPIC_BASE_URL` | **VERIFIED — exfiltration path confirmed** | With `--setting-sources=user,project,local` (or no flag), a project `.claude/settings.json` **or** `.claude/settings.local.json` `env.ANTHROPIC_BASE_URL` redirects all `/v1/messages` traffic to the second mock **with the host's `x-api-key`**, even when the host set `ANTHROPIC_BASE_URL` itself. The project can also replace `ANTHROPIC_API_KEY`. With `--setting-sources=user`: no redirect. | ADR-0012 §2 (`workspaceTrust`) |
| 10 | `initialize.workspaceTrust` | **VERIFIED** | Accepted. Shape `{accepted:boolean, directory:<absolute path>}`. It is a **trust grant that is persisted** (`projects[<dir>].hasTrustDialogAccepted:true` in `.claude.json`), reported as `workspace_trust_recorded`. It does **not** restrict loading: with project sources, CLAUDE.md, project hooks, project `.mcp.json` servers and project `env` load **with or without trust**; the only thing trust changed was honouring project `permissions.allow`. It never loads anything that `--setting-sources` excludes. It is not a `'context'` mode. | ADR-0012 §2 (`'context'`, B4) |

### 0.1 Binaries

`sha256sum` before use: `claude.exe` `76de74f7…ff06769a`, Linux `claude` `24972e3b…3370d0de`, both equal to 05 §1. The Linux container re-checked its mounted copy (same hash).

### 0.2 Infrastructure added for this round

- **TLS-terminating egress trap** `S/sandbox/mitm/mitm.mjs` (container `hudhud-mitm`, 127.0.0.1:47313). For G1 the CLI had to run on its **default** base URL, because remote settings and policy limits are skipped for any custom base URL. The trap answers `CONNECT`, terminates TLS with a throwaway test CA (`S/sandbox/mitm/certs/`, 30-day validity, trusted only through `NODE_EXTRA_CA_CERTS` in the sandbox env), logs method, host, path and headers (`x-api-key` redacted), and forwards the decrypted request **only to the local mock**. It never opens a connection to the CONNECT target. Mode `refuse` is the original 403 trap.
- `lib.mjs` additions (append-only): `trapSince`, `trapSeq`, `viaTrapEnv`, `readJson`, `initResp`, `resultAfter`.
- Mock fixes (`S/sandbox/mock-api/server.mjs`, mounted read-only over the image's copy; the image `hudhud-mock-api:dev` itself is unchanged): (1) the CONNECT handler had no socket `error` listener, and a client reset during refusal **crashed the mock** (first Linux G1 refuse run, re-run afterwards); (2) `GET /__mock/body?seq=N` returns a logged request body, so the Linux container can grep bodies.
- A second mock `hudhud-mock-api-2` on 127.0.0.1:47312 for C3.

---

## 1. Resume / fork matrix

**Question.** Semantics of `--resume`, `--continue`, `--fork-session`, `--session-id`; same vs different cwd; nonexistent id; resume while another process holds the session; session id in `system/init`; where transcripts land; interaction with stream-json input.

**Method.** `node t11-resume.mjs` (W90, L70). One shared `CLAUDE_CONFIG_DIR`, cwds `work`, `work2`, `work3`. Every step is its own process: `initialize`, one user message `<marker> [[mock:echo]]`, EOF. The mock logs `n_messages` and `x-claude-code-session-id` per request; full bodies are kept.

**Evidence** (Windows; Linux identical in every column, L70):

| Step | Flags | cwd | exit | `system/init.session_id` | API `n_messages` |
|---|---|---|---|---|---|
| a1 | `--session-id=U1` | work | 0 | U1 | 2 |
| a2 | `--resume=U1` | work | 0 | **U1** | 5 (history loaded) |
| a3 | `--continue` | work | 0 | U1 (most recent in this cwd) | 8 |
| a4 | `--resume=U1 --fork-session` | work | 0 | **new uuid** | 11 |
| a5 | `--resume=U1 --fork-session --session-id=U2` | work | 0 | **U2** | 11 |
| a6 | `--resume=U1 --session-id=U3` | work | 1 | — | — stderr `Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.` |
| a7 | `--session-id=U1` (exists) | work | 1 | — | — stderr `Error: Session ID U1 is already in use.` |
| a8 | `--resume=U1` | **work2** | 0 | U1 | 11; the CLI injects a user block `# Environment update - Primary working directory: …work2` |
| a9 | `--continue` | work2 (after a8) | 0 | **new uuid** | 2 (U1's file stayed under the `work` project dir, so `--continue` in work2 found nothing) |
| a10 | `--continue` | work3 (empty) | 0 | **new uuid** | 2 — **no error**, silently a new session |
| a11 | `--resume=<random uuid>` | work | 1 | — | stdout `{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"session_id":"<that uuid>","errors":["No conversation found with session ID: <uuid>"],…}` **before** any `control_response`; stderr same text |
| a12 | `--resume=ALPHA` (not a uuid, no such title) | work | 1 | — | same frame shape; stderr `Error: --resume requires a valid session ID or session title when used with --print. … "ALPHA" is not a UUID and does not match any session title.` |
| a13 | `--continue --fork-session` | work | 0 | new uuid | 14 |

Concurrency (U4):
```
c1 P1 --session-id=U4, turn 1 "HOTEL", stays alive (stdin open)
c2 P2 --resume=U4 while P1 lives  -> exit 0, sid U4, n_messages 5, no error, no lock message
c1 P1 turn 2 "JULIET"              -> sid U4, n_messages 5 (does not see P2's turn)
c3 P3 --resume=U4 after both       -> n_messages 8; request body contains HOTEL, JULIET, KILO, NOT "INDIA" (P2's turn)
d  two processes start with the same --session-id=U5 at once -> both exit 0, both results ok, one file with 38 lines
```

Transcripts: `cfg/projects/<sanitized cwd>/<session-id>.jsonl`. A fork file is a full copy of the history with every `sessionId` rewritten to the new id (a4 and a5: 29 lines each). `--resume` from another cwd keeps appending to the original project dir. With stream-json input, a resumed session emits nothing before the first user message except the `initialize` response (no replay of history on stdout).

**Verdict.** VERIFIED (Windows and Linux).

**Implications (ADR-0008, capabilities `resume`/`fork`).**
- `--session-id` with a hudhud-generated UUID is safe for new sessions; collisions are rejected (a7), but **two simultaneous starts with the same id are not** (d). hudhud must own id uniqueness.
- The CLI provides **no exclusion on resume**. hudhud needs its own per-session-id lock (process-local registry plus an advisory file lock if multiple hosts may share a config dir), otherwise turns are silently dropped from the resumed branch (c3).
- `--continue` is cwd-scoped and **never fails**. Do not expose `continue` as "resume the last session"; resolve an explicit id instead. If offered, detect a new id in `system/init` and report "nothing to continue".
- A failed resume emits a `result` frame without any `control_response`. The first-frame watchdog and the `initialize` waiter must treat an early `result`/exit as a named failure (`resume_not_found`), not a timeout.
- Fork = new id plus history copy. `fork` capability: supported, with `--fork-session` (and optionally `--session-id` for a hudhud-chosen id).

## 2. Host crash (parent dies abruptly)

**Question.** If the controlling process dies hard: does the CLI notice stdin EOF / stdout EPIPE, how fast does it exit, does it leave descendants, what exit code?

**Method.** `node t12-host-crash.mjs` (Windows W91, W93–W100; Linux L71–L74) plus `t12b-eof-reference.mjs` (W92, L75) for a graceful-EOF baseline. The orchestrator spawns `t12-host.mjs`, which spawns the CLI with pipes and drives it into one of four states: `idle` (after a result), `tool` (Bash `sleep 15`), `stream` (30 chunks × 500 ms), `perm` (blocked on `can_use_tool`). The orchestrator then hard-kills **only the host** (`TerminateProcess` on Windows, `SIGKILL` on Linux) and watches the CLI by pid + creation time. Exit code: Windows, a watcher holding a process handle (`[Diagnostics.Process]::Handle` + `WaitForExit`); Linux, a `/bin/sh` parent that records `$?`. Graceful shutdown is detected by the CLI's debug log line `[uds-messaging] Shutting down` (always present on a graceful EOF, W92/L75). Survivors are cleaned by pid + creation time.

**Evidence.**

| Case | Kill → CLI exit | Exit code | Graceful? | Tool tree after |
|---|---|---|---|---|
| Win non-detached idle (W93) | 34 ms (kill 14:55:41.432Z, exit 41.466Z) | 0 | **no** (last debug line is unrelated, no shutdown lines) | — |
| Win non-detached tool (W94) | 32 ms | 0 | **no** | **bash.exe, bash.exe, conhost.exe survived** (cleaned) |
| Win non-detached stream (W95) | 32 ms | 0 | no | — |
| Win non-detached perm (W96) | 35 ms | 0 | no | — |
| Win detached idle (W97) | 44 ms | 0 | yes | — |
| Win detached tool (W98) | 13.3 s (tool finished, model called, then exit) | 0 | yes | none |
| Win detached stream (W99) | 14.3 s (stream finished) | 0 | yes | — |
| Win detached perm (W100) | 2.07 s; debug `Bash tool permission denied` 5 ms after the kill | 0 | yes | marker not created |
| Linux idle (L71) | 206 ms | 0 (`sh` saw 0) | yes | — |
| Linux tool (L72) | 15.3 s | 0 | yes | none (`bash`/`sleep` pgid 695 finished) |
| Linux stream (L73) | 15.7 s | 0 | yes | — |
| Linux perm (L74) | 2.2 s | 0 | yes | — |
| Graceful EOF reference (W92 / L75) | 58 ms / 168 ms | 0 | yes | — |

- Windows job membership (via `IsProcessInJob`, W93–W96): the CLI is in a job; its Git-Bash children are **not** (`bash.exe:53748:False`). This matches libuv's global job for non-detached children (`KILL_ON_JOB_CLOSE` with silent breakaway for grandchildren): when the Node host dies, the job closes, the CLI is terminated, and the tool tree is left behind.
- Windows non-detached: `cfg/sessions/<pid>.json` and `<pid>.<sha>.key` remain (stale). Detached and Linux: removed.
- EPIPE after the host is gone did not change the outcome in any case: after EOF the CLI kept working (finished the tool, called the model again), wrote frames into a dead pipe, and still exited 0 with a normal shutdown.

**Verdict.** VERIFIED on Windows and Linux. Not verified: a host that is not Node/libuv (Python, Bun, .NET) on Windows. By mechanism it behaves like the "detached" rows unless that runtime also uses a kill-on-close job.

**Implications.**
- ADR-0009: on Windows the host-owned `KILL_ON_JOB_CLOSE` job (without breakaway) is **required** for host-crash cleanup. libuv's own job kills the CLI but explicitly lets grandchildren break away, so the Bash tree is orphaned on every host crash. With the addon job (05 §10: grandchildren inherit it), host death kills the whole tree.
- ADR-0010: on Linux, host death = stdin EOF = graceful drain. The CLI finishes the in-flight tool and turn (up to the tool's duration), then exits 0 with no orphans. The documented residual is narrower than feared: an orphan only arises if the CLI itself is SIGKILLed. A long tool keeps running after the host is gone, up to its own timeout.
- ADR-0008: exit 0 says nothing about success after a host crash (Windows job kill = 0).
- Stale `sessions/<pid>.json` after a Windows host crash: hudhud must not read them as live sessions (it does not write them, R6).

## 3. G1 — `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`

**Question.** (a) Which features change or disappear? (b) Critical: does it suppress fetching organization-managed policy (remote managed settings, policy limits)? Exact endpoints.

### 3.1 Static (binary strings, `S/analysis/linux.txt` extracted from the Linux binary by `S/analysis/extract.mjs`)

- Mode function: `RDt(){ if(CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) return "essential-traffic"; if(DISABLE_TELEMETRY) return "no-telemetry"; if(DO_NOT_TRACK) return "no-telemetry"; return "default" }`; `Tt()` = essential-traffic; `Eq()` = not default. Any non-empty value counts (docs: `0`/`false` still disable).
- Central HTTP client gate: `if(!e.bypassEssentialTrafficOnly && Tt()) return "essential-traffic-only"`. The only caller with `bypassEssentialTrafficOnly:!0` is `/api/claude_code/organizations/metrics_enabled`.
- **Remote managed settings eligibility** (`/api/claude_code/settings`, or `<gateway>/managed/settings`): `k(){ … if(Ie()!=="firstParty") → "third_party_provider"; if(!vi()) → "custom_base_url"; if(entrypoint local-agent/cowork) → "sandboxed_entrypoint"; … if(API key) eligible }`. **No `Tt()` check.**
- **Policy limits eligibility** (`/api/claude_code/policy_limits`): `Mbr(){ if(Ie()!=="firstParty") → "third_party_provider"; if(!skipBaseUrlCheck && !unixSocket && !vi()) → "custom_base_url" }`, then the credential checks. **No `Tt()` check.**
- Docs agree (`S/dl/docs/managed-settings.md` l.147): remote settings are fetched only when authenticating directly to Anthropic's API; "when `ANTHROPIC_BASE_URL` points somewhere other than Anthropic's API, it starts at the next source".

### 3.2 Empirical (`node t13-g1-egress.mjs`; W101–W108, L76–L83)

Each run: `initialize`, one text turn, 25 s idle, EOF, `--debug-file`, `CLAUDE_CODE_MAX_RETRIES=1`. Request counts are from the TLS trap (`mitm`) or from the mock's CONNECT log (`refuse`). Windows and Linux gave the same endpoint sets.

| Run | Base URL | Variable | CONNECTs | Decrypted requests to api.anthropic.com (exact) |
|---|---|---|---|---|
| W101/L76 | mock | **on** | 0 | none. `/v1/messages` to the mock only. No `Remote settings`/`Policy limits` lines in the debug log at all |
| W102/L77 | mock | off | 10 | `POST /api/eval/sdk-zAZezfDKGoZuXXKe` (feature flags), `GET /api/claude_cli/bootstrap?entrypoint=sdk-cli&model=claude-opus-5-5`, `GET /api/claude_code_penguin_mode`, `GET /mcp-registry/v0/servers?version=latest&limit=100&visibility=commercial%2Cgsuite%2Centerprise%2Chealth`, `POST /api/event_logging/v2/batch` ×6 |
| W103/L78 | mock | off; `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_BUG_COMMAND`, `DISABLE_AUTOUPDATER` =1 | 3 | `GET /api/claude_cli/bootstrap…`, `GET /api/claude_code_penguin_mode`, `GET /mcp-registry/v0/servers…` |
| W104/L79 | **default** | **on** | 3 | **`GET /api/claude_code/settings`**, **`GET /api/claude_code/policy_limits`**, `POST /v1/messages?beta=true` |
| W105/L80 | default | off | 15 | settings, policy_limits, messages, eval, bootstrap, penguin_mode, mcp-registry, event_logging ×7, `GET /api/claude_code/organizations/metrics_enabled` |
| W106/L81 | default | off + individual switches | 6 | settings, policy_limits, bootstrap, penguin_mode, messages, mcp-registry |
| W107/L82 | default, refuse trap | on | 16 (all `api.anthropic.com:443`, refused) | — (result `ERR_PROXY_TUNNEL`, exit 1) |
| W108/L83 | default, refuse trap | off | 31 (W) / 31 (L) | — |

Debug log with the variable on and the default base URL (W104):
```
[DEBUG] Remote settings: No settings found (404)
[DEBUG] Remote settings: Saved empty sentinel (404 response)
[DEBUG] Remote settings: Saved to <run>\cfg\remote-settings.json
[DEBUG] Policy limits: fetch failed (http 404) from api.anthropic.com — Request failed with status code 404
[DEBUG] Policy limits: 404 with no cache, no restrictions for this session (not persisted)
```
Both policy requests carry `x-api-key` and `user-agent: claude-code/2.1.296` (trap log `S/sandbox/mitm/logs/trap.ndjson`).

### 3.3 (a) What the variable turns off (union of binary call sites, docs and observation)

Observed on the wire: feature-flag fetch (`/api/eval/…`), first-party telemetry (`/api/event_logging/v2/batch`), `metrics_enabled` probe, `/api/claude_cli/bootstrap`, fast-mode org check (`/api/claude_code_penguin_mode`), MCP registry (`/mcp-registry/v0/servers`). Plus the startup connection warm-up (changelog: "Changed `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` to also skip the startup connection warm-up").

From binary strings and docs (not exercised): auto-updates and release notes; error reporting; `/feedback`, Claude-drafted feedback, transcript sharing; session-quality surveys; PR/MR status badges; plugin archive downloads from claude.ai, plugin directory search, plugin publish; Projects tool, DesignSync/Claude Design, artifact/file uploads; built-in `gh api`; Ultrareview and cloud-session posting; trusted-device enrollment; model catalog fetch; memory sync; auto-mode sibling docs; cross-machine session messaging; Remote Control and the other "features that need feature-flag fetching" (`/auto-mode-setup`, `claude import`, `/skill-doctor`); `--enable-live-preview`; guest vitals; background runs of plugin `command` sources. With flags unfetched, every flag takes its built-in default (relevant to §7: `tengu_tidy_sloth` default true).

Not affected: remote managed settings, policy limits, `/v1/messages`. Official marketplace auto-install has its own switch (docs).

**Verdict.** VERIFIED (static + wire, both OSes) that the variable **does not** suppress managed policy fetches. Not tested: an OAuth/claude.ai login (no credential exists by owner decision 2). Eligibility code also covers OAuth, and there is no `Tt()` there either.

**Implications (ADR-0012 §5).**
- G1(b) does not trigger: **the default `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` is policy-neutral** for both org-policy endpoints.
- The individual switches are **not** an equivalent alternative: they leave `bootstrap`, `penguin_mode` and `mcp-registry` going to api.anthropic.com, including when a custom base URL is set (W103).
- New fact for the threat model: **managed policy is never fetched when `ANTHROPIC_BASE_URL` is custom** (gateway, proxy, mock), whatever the variable says. hudhud should state this in `securityPosture` when a base URL is configured.
- Feature-flag defaults apply under the variable (§7).

## 4. `initialize.pid` versus the spawned pid

**Method.** `node t14-pid.mjs` (W109, L84): spawn the native binary directly, and through `t14-launcher.cjs`, a launcher written for this spike with the same shape as the npm package's fallback `cli-wrapper.cjs` (`spawnSync(binary, argv, {stdio:'inherit'})`). The downloaded wrapper was only read, never executed. The package's `bin` is `bin/claude.exe`; the fallback wrapper is used when postinstall did not place the native binary.

**Evidence.**

| | Windows | Linux |
|---|---|---|
| direct | spawned 49960 = `initialize.pid` 49960 (`claude.exe`) | 1420 = 1420 (`claude`) |
| launcher | spawned 60984 (`node.exe`) ≠ `initialize.pid` 57444 (`claude.exe`, ppid 60984) | 1462 (`node`) ≠ 1469 (`claude`, ppid 1462) |

`cfg/sessions/<pid>.json` is named after `initialize.pid`. `system/init` has no `pid` field (both OSes).

**Verdict.** VERIFIED.

**Implication (ADR-0011, root set).** The process root set = {spawned pid, `initialize.pid`}. They differ whenever anything sits between hudhud and the binary (npm fallback wrapper, shell shims, a user-supplied launcher). Containment must cover the launcher's whole tree (job / descendant snapshot from the spawned pid), and signals meant for the CLI must target `initialize.pid`: a launcher such as `cli-wrapper.cjs` re-raises nothing to its child.

## 5. Concurrent sessions sharing one `CLAUDE_CONFIG_DIR`

**Method.** `node t15-concurrent.mjs` (W110–W112, L85–L87). 4 CLIs start at once, 5 turns each alternating text and Bash `echo` (variant 3: warm config dir, 10 turns). A reader parses `cfg/.claude.json` every 20 ms during the run. Afterwards: JSON validity, keys, backups, lock-like files, transcripts, stderr, and each CLI's debug log grepped for lock/EBUSY/EPERM/parse errors.

**Evidence.**

| Variant | Turns ok | Reader: reads / invalid | `.claude.json` | Lock leftovers | Debug-log errors |
|---|---|---|---|---|---|
| distinct cwds, cold (W110 / L85) | 20/20 | 95 / **0** (W), 106 / 0 (L) | valid, 10 keys, no `projects` key | none | W: one `[ERROR] Failed to save config with lock: Error: ENOENT … lstat '<cfg>\.claude.json'` (first write), three `Lock acquisition took longer than expected - another Claude instance may be running`. L: the ENOENT error in all 4 |
| same cwd, cold (W111 / L86) | 20/20 | 108 / 0, 117 / 0 | valid | none | L: `[ERROR] Failed to save config with lock: Error: Lock file is already being held` ×4 and **`[ERROR] Config lock still held by a live process after retries; skipping the unlocked fallback write (save_global) to avoid clobbering the lock holder. See gh-73364.`** |
| same cwd, warm, 10 turns (W112 / L87) | 40/40 | 110 / 0, 184 / 0 | **byte-identical** to before the run | none | none |

- stderr was empty for every CLI. Every transcript was complete and separate.
- In stream-json/print mode the CLI writes no `projects` entries and no `numStartups` to `.claude.json`. The only writes seen are first-run initialization (`firstStartTime`, `userID`, migrations, `pluginUsage`) and a backup `backups/.claude.json.backup.<ts>`.
- The lock is transient (`.claude.json` lock plus atomic temp-file rename `.claude.json.tmp.<pid>.<rand>`); nothing is left behind.

**Verdict.** VERIFIED: no corruption and no torn reads; a skipped global-config write is possible only on a cold, never-initialized config dir with simultaneous first starts.

**Implications.** Sharing the user's real config dir between concurrent hudhud sessions is safe for print/stream-json use (ADR-0012 §1). If hudhud starts N sessions against a **fresh** isolated config dir, it should start one first (or let one reach `system/init`) before fanning out, to avoid the first-write race. Never treat `.claude.json` as a coordination channel; it is not locked for readers (reads were always valid only because of the atomic rename).

## 6. Windows long-path cwd

**Method.** `node t16-longpath.mjs` (W113–W118) and `node t16b-longpath-boundary.mjs` (W119). Nested directories built under the run dir to exact absolute lengths. Per length: a plain `spawn(claude.exe --version, {cwd})` probe, the same with a `\\?\`-prefixed cwd, then a full session (text, Bash `pwd | wc -c; echo hi > bash.txt`, Write and Read with absolute paths). Host policy `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled` = `0x1` (read only; not changed; admin rights not used).

**Evidence.**

| cwd length | plain spawn | `\\?\` spawn | session |
|---|---|---|---|
| 240 (W113), 252 (W114) | ok | ok | all tools ok; `system/init.cwd` = exact path; transcripts in `cfg/projects/<first 200 sanitized chars>-<6-char hash>/` (207-char dir name) |
| 245–258 (W119) | ok | — | — |
| **259**–262 (W119), 259/261/265/320 (W115–W118) | **`spawn … ENOENT`** (`error.code ENOENT`, misleading; the binary exists) | ok | **`system/init.cwd` is the 8.3 alias**, e.g. `<drive>:\…\<8.3 short-name segments>\…` (117 chars). Transcripts under the short-name project key. Bash `echo hi > bash.txt` → `Claude requested permissions to write to <8.3 path>\bash.txt, which contains a suspicious Windows path pattern that requires manual approval.` Write/Read with the long absolute path succeeded |

Note: an unhandled child-stdout `ENOTCONN` after the failed spawn crashes a naive driver. The first t16 version crashed this way; the pre-spawn probe was added for that reason.

**Verdict.** VERIFIED on this host. Not verified: hosts with `LongPathsEnabled=0`, and volumes with 8.3 name generation disabled (there the prefixed spawn would have no short alias; untested).

**Implications (ADR-0009/0011).**
- hudhud must check the cwd length before spawning on Windows. At ≥ 259 characters it fails with a named error (`cwd_too_long`) instead of surfacing `ENOENT`.
- Do **not** silently "fix" it with `\\?\`: the session would run under a different project key (resume and transcripts split) and with degraded Bash permissions.
- Workarounds for applications: a shorter path, `subst`, or a junction (a junction or `subst` keeps the same transcript key only if always used consistently).
- The 248-character "directory" limit was not a factor for spawn on this host. The effective limit is MAX_PATH-related (258 OK, 259 fails).

## 7. `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`

**Question.** Exact semantics and default.

**Static** (binary): `function X5o(){ return CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS ?? hkt }`, `var hkt=600000`. In the print-mode run loop, once `inputClosed` and nothing is queued, `bgWaitFirstIdle` is set; `ceilingExceeded = ceiling>0 && now-bgWaitFirstIdle >= ceiling`; it is reset whenever input reopens or work is queued. On expiry: stderr `Background tasks still running <dur> after the last turn (<list>); stopping them. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.`, then the running tasks are stopped. `0` disables the ceiling. A separate flag-gated hold, `holdForBackgroundShells` (`tengu_tidy_sloth`, default **true**), keeps background shells out of the sweep. The embedded TS SDK reads the same variable with the same default (`Dd(env)…: hkt`).

**Method.** `node t17-bgwait.mjs` (short cases) and `node t17-bgwait.mjs long` (W120–W126, L88–L89). A turn starts a background task, the turn ends, then EOF. Two task kinds: a Bash `run_in_background` `sleep N`, and a background subagent (Task tool, `run_in_background:true`) whose model request hangs (mock `hang`).

**Evidence.**

| Case | EOF → exit | stderr | Frames after EOF |
|---|---|---|---|
| bg **Bash** `sleep 45`, default (W120) | 42.5 s (shell finished) | — | `task_notification completed`, new turn (`system/init`, `assistant`, `result/success`), exit 0 |
| bg Bash `sleep 45`, ceiling **5000** (W121, L88) | 42.7 s / 43.1 s | — (**not stopped**) | same |
| bg Bash `sleep 45`, ceiling 0 (W122) | 42.6 s | — | same |
| bg Bash `sleep 700`, default (W123) | **697.7 s** (> 600 s ceiling) | — | same |
| bg **subagent** (hanging), ceiling **5000** (W124, L89) | **5.14 s / 5.12 s** | `Background tasks still running 5s after the last turn (subagent "bg agent"); stopping them. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.` | `task_updated`, `task_notification stopped`, `background_tasks_changed`, `session_state_changed idle`, exit 0 (no new turn) |
| bg subagent, ceiling 0 (W125) | still running after 40 s (driver killed it) | — | — |
| bg subagent, default (W126) | still running after 40 s (driver killed it) | — | — |

No background process survived any of these exits.

**Verdict.** VERIFIED: default 600000 ms (binary constant; consistent with W126 not stopping within 40 s), unit ms, `0` = unlimited, applies to background agents/tasks, **not** to background Bash shells under default flag values. PARTIAL for the 600 s subagent expiry itself (not run to completion; inferred from the constant and the 5 s behaviour).

**Implications (ADR-0008 stdin-close policy).**
- Pin `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` explicitly. A sensible pin is the documented default `600000` unless the application chooses otherwise.
- The ceiling is **not** an upper bound on "EOF → exit": a background Bash shell can hold the CLI for the shell's lifetime (observed 697 s). hudhud's drain path therefore needs its own outer bound (a drain deadline that escalates to the abort ladder), or must surface `background_tasks_changed`/`task_*` frames so the application decides.
- After EOF a finished background shell triggers **a new model turn** (`system/init` … `result`). `close()` must keep consuming frames until exit, and turn bookkeeping must accept a turn the host did not start.

## 8. Hook timeout unit (and default)

**Method.** `node t18-hooks.mjs timeout-3` and `node t18-hooks.mjs absent-long` (W127–W131, L90–L93), with `--include-hook-events`.
(A) `initialize` with `hooks:{PreToolUse:[{matcher:"Bash",hookCallbackIds:["hk1"],timeout:T}]}`, a Bash tool call, and the `hook_callback` request **never answered**.
(B) `cfg/settings.json` (`--setting-sources=user`) with a PreToolUse command hook `sleep 30; echo slept`, `timeout:T`.

**Evidence.**

```
A, timeout 3 (W127, L90):
  0 ms     control_request hook_callback {callback_id:"hk1", input:{hook_event_name:"PreToolUse", tool_name:"Bash", …}}
  3000 ms  control_cancel_request
  3003 ms  user tool_result {"content":"PreToolUse hook did not respond before its timeout (host client may be unreachable).
           The tool call was not executed; other configured hooks may not have completed.","is_error":true}
  3039 ms  result/success
A, timeout 3000 (W128, L91): nothing within 30 s.
B, timeout 3 (W129, L92):
  5 ms     system/hook_started
  3753 ms (W) / 3014 ms (L)  system/hook_response {outcome:"cancelled", exit_code:1}
  4412 ms  tool_result "hook-test" is_error:false      <- the tool RAN
B, timeout 3000 (W130, L93): hook_response {outcome:"success", stdout:"slept\n"} at 30.1 s; tool ran.
```

Default for callbacks with no `timeout` (W131, 660 s cap): **600 s**. `control_request hook_callback` at 0 ms, `control_cancel_request` at **600000 ms**, then the same blocking tool_result and `result/success` at 600074 ms. The callback default equals the documented command-hook default.

Docs (`S/dl/docs/hooks.md` l.426): `timeout` is "Seconds before canceling", default 600 for `command`/`http`/`mcp_tool` (30 on UserPromptSubmit and model-switch events, 10 on MessageDisplay); an Agent SDK callback hook that exceeds its timeout blocks the tool call on PreToolUse.

**Verdict.** VERIFIED: the unit is **seconds** for both registration paths, on both OSes; the callback default is 600 s (Windows, W131). Callback timeouts fail closed (tool not executed); command-hook timeouts fail open on PreToolUse. The CLI withdraws its callback with `control_cancel_request` at the deadline.

**Implications (ADR-0007, E9).** hudhud's declared default "60" is 60 **seconds**. Send `timeout` in seconds in `initialize`; never in ms (3000 = 50 min). hudhud's handler timer = declared − 2 s still answers before the CLI's cancel. hudhud must handle `control_cancel_request` for `hook_callback` exactly as for `can_use_tool`. On PreToolUse the CLI is already fail-closed on a callback timeout, so hudhud's fail-closed answer just arrives first, consistently.

## 9. C3 — project `env.ANTHROPIC_BASE_URL`

**Method.** `node t19-c3-baseurl.mjs` (W132, L94). The second mock is `hudhud-mock-api-2` (127.0.0.1:47312). On Windows, project dirs sit on a temporary `subst Q:` drive so no ancestor is the real `~/.claude` (05 §13.1); the mapping was removed in `finally` and checked (`substRemoved: true`; `subst` lists nothing). Each case: one text turn. The host always sets `ANTHROPIC_BASE_URL` = mock 1 and the fake key, except in p6.

**Evidence** (Windows and Linux identical):

| Case | Settings file / env | `--setting-sources` | Requests to mock 1 | Requests to mock 2 |
|---|---|---|---|---|
| p1 | project `settings.json` `{env:{ANTHROPIC_BASE_URL:mock2}}` | `user,project,local` | 0 | `POST /v1/messages?beta=true key=<fake-key> (host key)` |
| p2 | same | `user` | 1 | 0 |
| p3 | `settings.local.json` | `user,project,local` | 0 | 1 (host key) |
| p4 | `settings.local.json` | `user` | 1 | 0 |
| p5 | project `settings.json` | **flag omitted** | 0 | 1 (host key) |
| p6 | project `settings.json`; host did **not** set a base URL | `user,project,local` | 0 | 1 (host key) |
| p7 | project `{ANTHROPIC_BASE_URL:mock2, ANTHROPIC_API_KEY:"<fake-project-key>"}` | `user,project,local` | 0 | 1 with `the project key` |

`initialize.account.apiKeySource` stayed `"ANTHROPIC_API_KEY"` in all cases, including p7. No stderr warning in any case.

**Verdict.** VERIFIED. Without a trust dialog, a repository's settings file can redirect all model traffic, including the host's API key, to any host. It **overrides** the host-provided `ANTHROPIC_BASE_URL`, and it can swap the credential without `apiKeySource` showing it.

**Implications (ADR-0012 §2, threat model row C3).**
- Strong confirmation of `workspaceTrust:'none'` → `--setting-sources=user` as the default. `'full'` must be documented as "the repository can redirect your API traffic and credentials".
- `--setting-sources` must **always** be passed: omitting it loads project and local settings (p5).
- `apiKeySource` cannot be used to detect a project override (p7). If hudhud wants a guard under `'full'`, it has to inspect `.claude/settings*.json` itself (refuse or flag when `env` contains `ANTHROPIC_*`), as in the `'context'` audit design.
- The C3 row in the threat model changes from UNVERIFIED to VERIFIED.

## 10. `initialize.workspaceTrust`

**Question.** Does the CLI accept the field the TS SDK sends, and does it change which project config is loaded? Compare with `settingSources`.

**Static.** Control schema (binary): `workspaceTrust: {accepted: boolean, directory: string}`, documented `@internal`:
- "Host attestation that the user explicitly accepted a trust dialog for the session's working directory before launching it…"
- "Honored once, on the session's first initialize from the process that owns the CLI's stdin: the CLI records the working directory as trusted in the same store the interactive trust dialog writes (the home directory is trusted for the session only and never persisted)…"
- "project permission rules and hooks re-derive in the running process … readers evaluated at launch (project .mcp.json approval, project plugins, agent-frontmatter hooks and MCP servers) see it from the next launch on."
- `directory` must be absolute, resolve to the session cwd's trust key (the git root inside a repository), and not be a network or obfuscated spelling.
- Response field `workspace_trust_recorded`. The SDK option is `workspaceTrust`, passed through unchanged (`S/dl/claude-agent-sdk/package`).

**Method.** `node t20-workspace-trust.mjs` (W133, L95). A marked workspace contains:
- `CLAUDE.md` with a marker string;
- `.claude/settings.json` with `env.HUDHUD_PROJ_ENV`, `permissions.allow ["Bash(touch allowed-by-project-rule.txt)"]` and a PreToolUse command hook that writes `hook-ran env=[$HUDHUD_PROJ_ENV]`;
- `.mcp.json` with a stdio "server" that only writes a marker file.

Each case has its own `CLAUDE_CONFIG_DIR` and project dir (Windows: `subst R:`, removed afterwards). Per case: CLAUDE.md marker searched in the captured `/v1/messages` bodies (`/__mock/body`); Bash `touch allowed-by-project-rule.txt` in `default` mode without a prompt tool (it succeeds only if the project allow rule is honoured); marker files; `.claude.json` after the run.

**Evidence** (Windows and Linux identical):

| Case | sources | `workspaceTrust` | `workspace_trust_recorded` | CLAUDE.md sent | project MCP spawned | project hook ran (env seen) | project allow rule honoured | persisted `projects[<dir>].hasTrustDialogAccepted` |
|---|---|---|---|---|---|---|---|---|
| w1 | user,project,local | absent | (absent) | **yes** | **yes** | **yes** (`env=[proj-env-value]`) | **no**; stderr `Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace has not been trusted. …` | — |
| w2 | user,project,local | `{accepted:true, directory:<cwd>}` | **true** | yes | yes | yes | **yes** (re-derived in-process; the stderr warning was printed at launch, before the grant) | **true** (written to `cfg/.claude.json`) |
| w2b | same cfg+project, 2nd launch | absent | — | yes | yes | yes | yes, no warning | true |
| w3 | user,project,local | `{accepted:false}` | (absent) | yes | yes | yes | no | — |
| w4 | **user** | accepted:true | **true** | no | no | no | no | **true** (still written) |
| w5 | user | absent | — | no | no | no | no | — |
| w6 | user,project,local | accepted:true, `directory` = another project | **false** | yes | yes | yes | no | — |
| w7 | user,project,local | accepted:true, relative `directory` | (absent; ignored) | yes | yes | yes | no | — |
| w8 | `""` (empty) | accepted:true | **true** | no | no | no | no | **true** |

**Verdict.** VERIFIED. The CLI accepts the field. It is a **persisted trust grant**, not a loading filter. In print/stream-json mode, CLAUDE.md, project hooks, project MCP servers and project env load **without any trust** as soon as `--setting-sources` includes `project`/`local`; trust only adds the project permission rules (and, per the schema text, launch-time approvals such as `.mcp.json` approval on the next launch). It never loads what `--setting-sources` excludes. It **writes** to `.claude.json` even when project settings are not loaded (w4, w8).

**Implications (ADR-0012 §2, B4, capability `workspaceTrust.context`).**
- **`'context'` cannot be native via `initialize.workspaceTrust`.** The capability stays `unsupported` (or `emulated` via the audit), as F decided.
- **hudhud must never send `workspaceTrust` by default.** It is a write to the user's real config (`projects[<dir>].hasTrustDialogAccepted:true`, R6 never-write posture) and it widens permissions (project allow rules) for this and future sessions, including interactive ones. If it is ever exposed, it must be a separate, `dangerously*`-named boolean listed in `securityPosture`, and it is not part of `'full'`.
- `'full'` (`--setting-sources=user,project,local`) by itself already runs project hooks, MCP servers and env without trust (w1). The `'full'` documentation must say so explicitly. Untrusted project permission rules are ignored with a stderr notice; hudhud can surface that line as a diagnostic.

---

## 11. Cross-cutting observations

1. **A custom `ANTHROPIC_BASE_URL` disables org policy fetching** (§3): a gateway user gets no server-managed settings and no policy limits. This is harness behaviour, but hudhud's `securityPosture` should report it.
2. **Two different "trust" planes:** `--setting-sources` decides what is loaded; persisted trust (`hasTrustDialogAccepted`) only gates project permission rules and launch-time approvals. The C3 redirect needs no trust.
3. **Exit 0 is not evidence** (Windows host-crash kill = 0; §2), consistent with 05 §9.
4. **Failure frames before `initialize`'s response** (§1 a11/a12): the protocol layer must accept a `result` as the first frame.
5. **Mock robustness:** the 05 mock crashed on a reset CONNECT socket. Fixed (mounted source); the CI mock in hudhud's own test suite must not inherit that bug.
6. Feature-flag defaults change behaviour under the nonessential-traffic variable (for example `tengu_tidy_sloth` keeps background shells alive past the ceiling, §7). Tests and production must run with the same variable setting (already the ADR-0012 rule).

## 12. Not done / limits

- **macOS:** no host available; nothing verified (macOS gate G3 unchanged).
- OAuth/claude.ai login: no credential (owner decision 2). Policy eligibility was read statically for OAuth; the wire evidence is API-key only.
- Hosts on Windows other than Node/libuv for §2; Windows hosts with `LongPathsEnabled=0` or 8.3 names disabled for §6 (changing HKLM needs admin and was out of scope).
- §7: the default 600 s expiry for a background subagent was not waited out (constant plus the 5 s behaviour); the >600 s shell case was run (W123).
- Attribution of the user-profile `.claude.json` mtime changes during W111, W123 and W124: see §13. The same confound as 05 §13 applies.

## 13. Cleanup and isolation evidence

- **Processes.** Every driver killed only processes it had recorded, verified by pid + creation time (`killExact`). After the last batch, `Get-CimInstance Win32_Process` filtered on command lines containing the sandbox path returned **no processes**, and `sleep.exe` count = 0. The Windows host-crash survivors (W94: `bash.exe`×2, `conhost.exe`) were killed by pid + creation time inside the run (`stillAliveAfterCleanup: 0`). In the Linux container, `/proc` listed only `docker-init`, `sleep infinity` and the listing shell before removal.
- **Containers / network.** Removed: `hudhud-cli-linux`, `hudhud-mitm`, `hudhud-mock-api`, `hudhud-mock-api-2`, network `hudhud-net`. Afterwards `docker ps -a --filter name=hudhud` and `docker network ls --filter name=hudhud` are empty. Kept: image `hudhud-mock-api:dev` (`cd0ea2b23775`, unchanged; the patched `server.mjs` was only bind-mounted). Volume `hudhud-pnpm-store` untouched. No other container was touched.
- **Drive mappings.** The `subst Q:` (§9) and `subst R:` (§10) mappings were removed in `finally`; `subst` lists nothing.
- **Writes outside the run dirs (Windows).** `report.outsideChanges` was empty for every run except W111, W123, W124 and W131, where the mtime of the profile-root `.claude.json` changed (W111 also its size, 99889→99785). This is the confound from 05 §13: the user's own live Claude Code instance (the harness running this session) rewrites that file. Evidence that the sandbox did not write it:
  - every CLI ran with `CLAUDE_CONFIG_DIR`, `HOME`, `USERPROFILE`, `APPDATA` and `LOCALAPPDATA` redirected;
  - all **211** `… written atomically` lines in the 31 sandbox debug logs name `<run>\cfg\.claude.json`, and no debug log mentions the profile path;
  - the last change (15:41:28Z) came after the last sandbox CLI had exited, at the moment the harness processed a background-task completion;
  - a 120 s control window with no sandbox process showed no change.

  The file's contents were never read. No new entries appeared in `%TEMP%`/`%TEMP%\claude`, there were no `HKCU\Software` changes, and no `%APPDATA%\Anthropic`.
- **Linux.** `/home/node` stayed empty. `/tmp` held only the known `cc-socks-1000` socket dir (05 §13). The container and its tmpfs are deleted.
- **Egress.** No connection left the machine: on the mock base URL with the variable on there were 0 CONNECTs; every other CONNECT went to the refusing trap or to the TLS trap, which only forwards to the local mock. Hosts attempted: **only `api.anthropic.com:443`** (no statsig/sentry/datadog/other hosts in any run). Only the fake key was ever sent.
- **Real install / real config.** Never executed or read; only the pinned binaries under `S/sandbox/bin` were run. Files under `S/dl` were read as data only. `S/dl/claude-code/package/cli-wrapper.cjs` was read, not run.
- One driver artifact outside S: two small temp text files written by this session's own shell into Git Bash's `/tmp` while editing the report. They contained report text only and were deleted immediately.

## 14. Reproducing

```
# services (from S/sandbox)
docker network create --internal hudhud-net
docker run -d --name hudhud-mock-api   -p 127.0.0.1:47311:8080 -v <S>\sandbox\mock-api\logs:/logs  -v <S>\sandbox\mock-api\server.mjs:/app/server.mjs:ro --user root hudhud-mock-api:dev
docker run -d --name hudhud-mock-api-2 -p 127.0.0.1:47312:8080 -v <S>\sandbox\mock-api\logs2:/logs -v <S>\sandbox\mock-api\server.mjs:/app/server.mjs:ro --user root hudhud-mock-api:dev
docker run -d --name hudhud-mitm -p 127.0.0.1:47313:8080 -e MODE=mitm -e MOCK_URL=http://hudhud-mock-api:8080 \
  -v <S>\sandbox\mitm\mitm.mjs:/app/mitm.mjs:ro -v <S>\sandbox\mitm\certs:/certs:ro -v <S>\sandbox\mitm\logs:/logs --user root node:24-bookworm-slim node /app/mitm.mjs
for c in hudhud-mock-api hudhud-mock-api-2 hudhud-mitm; do docker network connect --alias $c hudhud-net $c; done
# throwaway CA (S/sandbox/mitm/certs): openssl req -x509 … CN=hudhud-spike-test-CA; leaf with the SAN list in leaf.cnf
# Windows (one command per spike)
cd S/sandbox/driver
node t11-resume.mjs; node t12-host-crash.mjs; node t12b-eof-reference.mjs; node t13-g1-egress.mjs; node t14-pid.mjs
node t15-concurrent.mjs; node t16-longpath.mjs; node t16b-longpath-boundary.mjs; node t17-bgwait.mjs; node t17-bgwait.mjs bgagent
node t17-bgwait.mjs long; node t18-hooks.mjs timeout-3; node t18-hooks.mjs absent-long; node t19-c3-baseurl.mjs; node t20-workspace-trust.mjs
# Linux: container as in 05 §16, plus -v <S>\sandbox\mitm\certs\ca.pem:/sandbox/mitm/certs/ca.pem:ro -e HUDHUD_TRAP_URL=http://hudhud-mitm:8080
MSYS_NO_PATHCONV=1 docker exec -w /sandbox/driver hudhud-cli-linux node t11-resume.mjs     # etc.
MSYS_NO_PATHCONV=1 docker exec -e HUDHUD_MOCK2_URL=http://hudhud-mock-api-2:8080 -w /sandbox/driver hudhud-cli-linux node t19-c3-baseurl.mjs
```
Run the files sequentially (mock attribution is by time window, 05 §16).
