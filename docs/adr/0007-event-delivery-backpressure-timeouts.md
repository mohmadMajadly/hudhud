# ADR-0007: Event delivery, backpressure and handler timeouts

- Status: Accepted
- Date: 2026-10-12
- Negotiation log items: A10, B3, B6, E9, F (A10, E9 amendments) (06 §A, §B, §C round 3, §E, §F)
- Related: [ADR-0003](0003-public-api.md), [ADR-0008](0008-turn-and-lifecycle-semantics.md), [ADR-0011](0011-spawn-hygiene-and-binary-provenance.md)

## Context

The CLI multiplexes conversation frames and control frames on one stdout pipe. If hudhud stops reading stdout (a slow consumer), control requests from the CLI (`can_use_tool`, hook callbacks, MCP messages) stop being dispatched, and the CLI waits forever: it has no timeout on an unanswered `can_use_tool` and never sends `keep_alive` (05 §6, §12). Pausing stdout therefore stalls the whole session, including permission answers.

Interrupting a pending permission makes the CLI withdraw its own request with `control_cancel_request` (05 §6).

## Decision

### Stdout is always drained

hudhud reads stdout continuously and dispatches control frames independently of event consumers. `ask()` and `turn.done` never depend on a subscriber being attached or fast.

### Subscribers

The event firehose (`Session.events()`) is opt-in. Each subscriber has its own bounded queue limited in both count and bytes: default 10,000 events or 64 MiB, whichever comes first (initial, tunable, to be validated by measurement). Overflow policy per subscriber:

| Policy | Behaviour | Default |
|---|---|---|
| `'error'` | The overflow raises an error scoped to that subscriber only (its iterator fails); the session and other subscribers continue | yes |
| `'drop-oldest-with-gap-marker'` | Oldest events are dropped and a gap marker event records how many | opt-in |
| `'block'` | The producer waits for the subscriber. Documented as dangerous: it can stall control-frame dispatch | opt-in, documented-dangerous |

`'block'` is offered because of rule R2 (B3 option ii). It is never the default, and its documentation states the stall hazard explicitly. `'block'` keeps its plain name: it is a correctness hazard (it can stall control-frame dispatch), not a security weakening, so the security-weakening naming rule of [ADR-0012](0012-security-defaults-and-trust.md) does not apply. Its documentation states that it can stall control frames.

### Handler classes and timeouts

| Handler | Timeout | Cancellation |
|---|---|---|
| Permission handlers (`can_use_tool`) | No default timeout | Always cancellable: by CLI `control_cancel_request`, by `AbortSignal`, and on session close; pending permissions resolve `cancelled` on close |
| Hooks and in-process tools (v1.1) | Default timeout | Honour `control_cancel_request` |

Permission handlers have no default timeout because a human may answer; the application owns any timeout it wants. The application is responsible for answering or cancelling; hudhud guarantees that a pending permission can always be cancelled.

### Hook timeout failure policy (B6)

When a hook handler times out: fail-closed for `PreToolUse` and `PermissionRequest` (the tool call is denied), continue for informational events. A uniform error response was rejected.

### Single source for the hook timeout (E9, amended by F)

The declared hook/in-process-tool timeout defaults to 60 s (initial, tunable, to be validated by measurement). hudhud's handler timer is the declared timeout minus a 2 s margin, so it is strictly shorter and hudhud answers (fail-closed) before the CLI gives up. There is a single configured value; both numbers derive from it. The CLI-side behaviour was verified by spike (07 §8, J4):

- The unit is seconds, both for `initialize` hook callbacks and for settings hooks (`timeout: 3000` means 50 minutes). hudhud passes the timeout in seconds, never milliseconds.
- The CLI's callback default (no `timeout`) is 600 s, so hudhud's 60 s default is always sent explicitly.
- A callback timeout blocks the tool (fail-closed): at the deadline the CLI sends `control_cancel_request` and returns a blocking tool result. hudhud must handle `control_cancel_request` for `hook_callback` exactly as for `can_use_tool`. hudhud's own fail-closed answer, from the shorter timer, arrives first and is consistent with the CLI's.
- A settings command-hook timeout is fail-open on `PreToolUse` (the tool runs). This applies to hooks configured in settings files, not to hudhud's callbacks.

## Alternatives considered

- `block` as the default policy, or `block` forbidden. Round 3 decided against both: forbidding contradicts R2; defaulting to it lets one slow consumer stall control frames (B3 option i versus ii).
- Unbounded subscriber queues. Rejected: memory exhaustion; frames can be tens of MB (05 §11).
- Session-wide error on subscriber overflow. Rejected: a slow debugging subscriber must not kill the session.
- A default permission timeout. Rejected (A10): a default deny after N seconds silently changes the meaning of "ask the user".
- Uniform error response on hook timeout (B6 option ii). Rejected: for security-relevant hooks, a timeout must not result in "allow".
- Letting the CLI's `keep_alive` or timeouts protect us. Not available: the CLI sends no `keep_alive` and has no timeout (05 §12, §6).

## Consequences

- hudhud needs a bounded queue implementation that accounts bytes as well as counts, and a gap-marker event type.
- Session close must resolve every pending permission and cancel every pending handler.
- The application is responsible for avoiding unbounded pending permission prompts; the stalled-session watchdog ([ADR-0008](0008-turn-and-lifecycle-semantics.md)) emits `stalled` rather than killing.

## Evidence

- 05 §6 (never-answered permission, interrupt cancel), §12 (no `keep_alive`).
- 07 §8 (hook timeout unit, default and failure direction); 06 §J4.
- 05 §11 (frame sizes).
- 02 §3 (message routing; concurrent handlers with one AbortController per request id), §4.1 (cancel semantics).
- 03 §5 item 12 (permissions as a state machine with a cancel path).
