# ADR-0008: Turn and lifecycle semantics

- Status: Accepted
- Spikes: the G4 items touching this ADR (stdin-close ceiling, resume/fork, host-crash behaviour, `initialize.pid`) are done; results in 07 §1, §2, §4, §7 and 06 §J5-J9. No gate remains open here.
- Date: 2026-10-12
- Negotiation log items: A11, A8 (session id), E8, E10 (framer), D2, D5, D6, D11 (06 §A, §D, §E, §F)
- Related: [ADR-0007](0007-event-delivery-backpressure-timeouts.md), [ADR-0009](0009-process-layer-windows.md), [ADR-0010](0010-process-layer-posix.md), [ADR-0012](0012-security-defaults-and-trust.md)

## Context

Measured behaviour of CLI 2.1.296 (05):

- `initialize` is optional; with nothing on stdin the CLI is silent forever; `system/init` is emitted once per turn after the user message, never at startup (05 §5).
- Interrupt sent in the same write as a turn-2 user message is ignored (GH#98713 reproduced); a 50 ms gap after `system/init` fixes it (05 §7).
- EOF means "finish everything, then exit 0"; it is not an abort (05 §8).
- Exit code is 1 iff the last `result` has `is_error`; a Windows job close yields code 0; Linux SIGINT yields 0 with no `result` frame; SIGTERM yields 143, no `result` (05 §9). Exit 0 can therefore mean "killed".
- `session_state_changed` frames appear only with `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` (05 §12).
- A `result` ends a turn, not necessarily the run; closing stdin early makes later control requests fail with "Stream closed" (02 §6.1).

## Decision

### Session start

1. hudhud always generates a session UUID and passes `--session-id` (A8). Collisions with an existing id are rejected by the CLI, but two simultaneous starts with the same id are not (07 §1 d), so hudhud owns id uniqueness.
2. hudhud always sends `initialize` first, even though the CLI does not require it (F amendment to A11). Reasons recorded in the log or implied by it: the first-frame watchdog is armed on the `initialize` write; `initialize.pid`, `claude_code_version`, `account.apiKeySource` and capability data come from its response; `initialize.pid` selects the POSIX SIGTERM target behind a launcher, while containment and the sweep stay rooted at the spawned pid (K1, 06 §K; [ADR-0010](0010-process-layer-posix.md), [ADR-0011](0011-spawn-hygiene-and-binary-provenance.md)); `onAuthFailure` depends on `apiKeySource` ([ADR-0012](0012-security-defaults-and-trust.md)).
3. `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` is always set (not `CLAUDE_CODE_SDK_READS_SESSION_STATE`, which adds `sdk_host_only` marking), pinning the reliable "idle" run-end signal (D11).
4. Every user message carries a `uuid`. The CLI echoes it in `result.user_message_uuid(s)` and in `command_lifecycle` frames; hudhud uses it to correlate turns and interrupts (05 §5).
5. Every depended-on behaviour is pinned by an explicit flag or environment variable, never by an unrecorded default (A8; see [ADR-0012](0012-security-defaults-and-trust.md) for the table).

### Resume, continue and fork (J6, J7; 07 §1)

- The CLI has no session lock. Two processes resuming one session both append to one transcript, and the next resume follows only the last-written branch (07 §1 c1-c3). hudhud refuses a second live resume or create of the same session id within one `Harness` with a typed error, and documents the cross-process hazard.
- `--resume <id>` keeps the id (`system/init.session_id` equals the old id) and loads history. `--fork-session` gives a new id, or the one passed with `--session-id`, and a full copy of the transcript. A live-process `--session-id` combined with `--resume` but without `--fork-session` is an error (07 §1 a6).
- `--continue` is cwd-scoped and never fails: in a cwd with no history it silently starts a new session (exit 0). hudhud's `continue` therefore compares the id in `system/init` with the expected one and reports `resumed: false` when a new session was started.
- A nonexistent id yields a `result/error_during_execution` frame on stdout BEFORE any `initialize` response, followed by exit 1. The protocol layer accepts a `result` frame before the `initialize` response (J7), and the first-frame watchdog and the `initialize` waiter map it to a typed `SessionNotFound` error, not a timeout.
- With stream-json input, a resumed session emits nothing before the first user message except the `initialize` response.
- `resume` and `fork` capabilities are `supported` (Windows and Linux; macOS is untested until its gate).

### First-frame and idle watchdogs

- First-frame watchdog: armed when `initialize` is written; default 60 s (initial, tunable, to be validated by measurement; MCP startup can take up to `MCP_TIMEOUT` 30 s). If no response arrives it fails with a named cause (distinguishing, for example, spawn failure, early exit, silent hang; on macOS a headless Keychain prompt, see the macOS gate). The list of named causes is defined in the implementation.
- Idle watchdog: emits a `stalled` event after 300 s without frames while a turn is running (initial, tunable, to be validated by measurement); it never auto-kills by default (A11). The CLI itself never times out, so this is the host's only protection (05 §15 item 6).

### Turns and interrupts

- Interrupt is gated: `turn.interrupt()` is queued until that turn's `system/init` has been observed, then sent (workaround for GH#98713, D5). `cancel_queued` is available.
- Turn end is synthesized when the `result` frame is absent: from `session_state_changed` `idle`, or from process exit (SIGINT and SIGTERM exits carry no `result`, 05 §9).
- After an interrupt the `result` is `error_during_execution` with `terminal_reason:"aborted_streaming"` or `"aborted_tools"`; hudhud normalizes this to a cancelled outcome and keeps the raw frame.

### Stdin-close policy

Modelled on the SDK's "bidirectional needs" rule (02 §6.1): stdin stays open while the session has pending handlers or work; it is closed when the CLI reports `idle` after a result, or when a ceiling expires. The ceiling is `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` (J5, 07 §7):

- Default 600000 ms; `0` means wait indefinitely. The clock starts when stdin is closed and the CLI is otherwise idle. hudhud pins the documented default explicitly and does not change it by default; an option to set it exists.
- On expiry the CLI stops background subagents and tasks (and writes a fixed stderr line), exit 0. It does NOT bound background Bash shells: a `run_in_background` shell held the CLI until it finished (697 s with the default ceiling).
- The ceiling is therefore not an upper bound on "EOF to exit". Drain on `close()` has its own hudhud deadline, `closeTimeoutMs` (default 30 s), a single deadline measured from the `close()` call that covers both the wait for `idle` and the wait for exit (K13, 06 §K; a turn still running when it expires is aborted), after which the abort ladder of [ADR-0009](0009-process-layer-windows.md) / [ADR-0010](0010-process-layer-posix.md) runs. `background_tasks_changed` and `task_*` frames are surfaced so the application can decide earlier.
- After EOF a finished background shell triggers a new model turn (`system/init` ... `result`) that the host did not start. `close()` keeps consuming frames until exit, and turn bookkeeping accepts such a turn.

### Close and dispose

| Operation | Meaning | Mechanism |
|---|---|---|
| `session.close()` | Drain | Keep stdin open until idle, then EOF; wait for exit; one deadline `closeTimeoutMs` (default 30 s) runs from the `close()` call (K13), then the abort ladder; pending permissions resolve `cancelled` and the CLI receives a non-interrupting deny ([ADR-0007](0007-event-delivery-backpressure-timeouts.md), K12) |
| `session[Symbol.asyncDispose]` / `AbortSignal` | Abort | The termination ladder of [ADR-0009](0009-process-layer-windows.md) / [ADR-0010](0010-process-layer-posix.md), starting with `interrupt{cancel_queued:true}` |

### Termination intent and exit-code semantics (E8)

hudhud never infers success from an exit code. Turn and session outcomes are derived from frames plus hudhud-observed kill reasons: before any signal or job termination, hudhud records the termination intent (for example `abort`, `dispose`, `watchdog`, `close-timeout`). hudhud installs no signal handlers in the host (K22, 06 §K), so it cannot record a host-signal intent: a terminal Ctrl+C that reaches the non-detached CLI on POSIX (exit 0, no `result`) is classified as outcome `unknown` and surfaces as a process-exited error; this is documented. On exit, the outcome is classified from (last `result`, recorded intent, exit code or signal). Exit code `4294967295` (seen under VS Code on native Windows, 01 §3) maps to `unknown`.

### Framer

Inbound NDJSON framer: bounded and UTF-8 safe, per-line cap 64 MiB by default and configurable (E10; D9). On overflow the default `onOversizedFrame: 'fail'` fails the session with a protocol error; `'skip'` is an explicit opt-in. Silent truncation never happens. Outbound frames have a cap as well (F): 32 MiB by default (initial, tunable; Messages API request-size ceiling class).

## Alternatives considered

- Send interrupt immediately and rely on the CLI. Rejected: reproduced bug, billed tokens (05 §7).
- Make `initialize` optional on hudhud's side, as the CLI allows. Rejected (F): per-session facts hudhud needs come from its response.
- Trust the exit code. Rejected (E8): job close gives 0, SIGINT gives 0 (05 §9).
- Close stdin as soon as a `result` arrives. Rejected: breaks follow-up turns woken by background agents (02 §6.1).
- Auto-kill on idle. Rejected (A11): a long human wait is legitimate; `stalled` is informational.
- 1 MiB frame cap as in the Python SDK. Rejected: a 5 MB model text yields three ~5 MB lines (05 §11); unbounded buffering as in the TS SDK is also rejected (02 §10 item 6).
- `CLAUDE_CODE_SDK_READS_SESSION_STATE`. Not used (D11).

## Consequences

- Every session pays one `initialize` round trip (the response is about 17 KB, 05 §5).
- The outcome classifier needs a table of (intent, exit) combinations; it is part of the sans-IO core and covered by fixtures.
- Host-crash behaviour (07 §2): exit 0 says nothing about success after a host crash (a Windows job kill gives 0); on Linux, host death is stdin EOF and the CLI drains gracefully. After a Windows host crash, stale `sessions/<pid>.json` files must not be read as live sessions (hudhud does not write them, R6).
- `close()` takes at most `closeTimeoutMs` plus the abort ladder; applications that need a shorter bound use `dispose` / `AbortSignal` or a smaller `closeTimeoutMs`. Long-running turns that must finish need a larger `closeTimeoutMs` (K13).

## Evidence

- 05 §5, §7, §8, §9, §11, §12, §15.
- 07 §1 (resume/fork matrix), §2 (host crash), §7 (background wait ceiling), §11 item 3-4; 06 §J5-J8.
- 02 §6.1 (stdin close), §6.3 (SDK close ladder).
- 01 §2.9 (interrupt and priority), §3 (exit codes), §7 (hang reports: GH#99194, GH#86074).
