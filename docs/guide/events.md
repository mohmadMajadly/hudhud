# Events

Everything a session observes is published as a `HudhudEvent`. You can read events in two ways:

- **A turn's events:** iterate the `Turn` returned by `session.send()`. You get the events of that turn only; the iterator ends after its `turn.completed`, and rejects with the turn's error if the turn fails.
- **A session's events:** `session.events(options)`. You get every event of the session from the moment you subscribe, after a replay of what happened before the session was handed to you (below). The iterator ends after the session's last event, `session.terminated`.

Subscribing is optional. `ask()` and `turn.done` never depend on a subscriber, and hudhud keeps reading Claude Code's output whether or not anyone reads events ([ADR-0007](../adr/0007-event-delivery-backpressure-timeouts.md)).

```ts
// Text deltas are only produced with includePartialMessages (default false).
const session = await hudhud.session({ claudeCode: { includePartialMessages: true } });
try {
  const turn = session.send('Write a haiku about pipes.');
  for await (const event of turn) {
    if (isEventType(event, 'message.delta') && event.deltaType === 'text') {
      process.stdout.write(event.text ?? '');
    } else if (isEventType(event, 'tool.call')) {
      console.log(`\n[tool ${event.toolName}, kind ${event.kind}]`);
    }
    // Every other event, including types added in later versions, is skipped.
  }
  const result = await turn.done;
  console.log(`\noutcome: ${result.outcome}, stop reason: ${result.stopReason ?? 'none'}`);
} finally {
  await session.close();
}
```

A `Turn` buffers its events from the moment `send()` returns, so nothing is lost between `send()` and the start of the loop.

## Reading events in TypeScript

`HudhudEvent` is an open union: besides the event types listed below, it has an arm for event types that later versions of hudhud or Claude Code add (`type: string`, with `raw`). Code that reads events must therefore skip types it does not know, and must never fail on them ([ADR-0003](../adr/0003-public-api.md#event-model)).

The open arm means that `switch (event.type)` and `event.type === 'tool.call'` do not narrow `event` to the matching type. Use the type guard `isEventType(event, type)` instead; `HudhudEventOf<'tool.call'>` names the event of one type, for example as a parameter type. Both are exported by `hudhudjs` and `@hudhudjs/core`. For a type a later version adds, the guard narrows to the open arm with that `type`, so `raw` is all you can read.

```ts
/** One line about a tool call. */
function describeToolCall(event: HudhudEventOf<'tool.call'>): string {
  return `${event.toolName} (${event.kind}), input ${JSON.stringify(event.input)}`;
}

/** Logs tool calls and their results; skips every other event. */
export function logTools(event: HudhudEvent): void {
  if (isEventType(event, 'tool.call')) {
    console.log(describeToolCall(event));
  } else if (isEventType(event, 'tool.result')) {
    console.log(`${event.toolUseId}: ${event.status}`);
  }
  // Every other type, including types added in later versions, is skipped.
}
```

The same holds for other open values: `ToolKind`, `StopReason`, `TurnOutcome`, `DiagnosticCode`, `session.state` and `message.delta`'s `deltaType` each list the known values and accept new ones.

## Event types

Every event has `seq` (a gapless number per session, starting at 0), `ts` (an ISO-8601 time) and `sessionId`. Events built from a Claude Code frame carry that frame as `raw`, unchanged; text in it, as in every text field, comes from the agent and must be treated as untrusted ([Security](security.md#untrusted-text)).

| `type`                 | When                                                                                    | Fields besides `raw`                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compat`               | First event of every `events()` stream (`seq` 0)                                        | `compat`: the tested window and the status of the running version ([Compatibility](compatibility.md))                                                                             |
| `session.started`      | The session answered the handshake                                                      | `mode`, `pid`, `cliPid`, `version`, `apiKeySource`, `tokenSource`, `permissionMode`                                                                                               |
| `turn.queued`          | A prompt was sent and waits for its turn                                                | `turnId`                                                                                                                                                                          |
| `turn.started`         | Claude Code started a turn                                                              | `turnId`, `origin` (`'application'`, or `'harness'` for a turn Claude Code started itself), `features`, `model`                                                                   |
| `message.assistant`    | A complete assistant message                                                            | `turnId`, `text`, `aborted`                                                                                                                                                       |
| `message.delta`        | A streamed piece of a message (only with `claudeCode.includePartialMessages: true`)     | `turnId`, `index`, `deltaType` (`'text'`, `'thinking'`, `'input_json'`, ...), `text`                                                                                              |
| `tool.call`            | The agent called a tool                                                                 | `turnId`, `toolUseId`, `toolName`, `kind` (`'read'`, `'edit'`, `'delete'`, `'move'`, `'search'`, `'execute'`, `'think'`, `'fetch'`, `'other'`, ...), `status: 'pending'`, `input` |
| `tool.result`          | A tool call finished                                                                    | `turnId`, `toolUseId`, `status` (`'completed'` or `'failed'`)                                                                                                                     |
| `permission.requested` | Claude Code asked the application for permission ([Permissions](permissions.md))        | `requestId`, `turnId`, `toolName`, `toolUseId`                                                                                                                                    |
| `permission.resolved`  | The question was answered or cancelled                                                  | `requestId`, `behavior` (`'allow'`, `'deny'`, `'cancelled'`), `by` (`'application'`, `'harness'`, `'close'`, `'abort'`)                                                           |
| `permission.denied`    | Claude Code denied a tool call itself                                                   | `toolName`, `toolUseId`, `reasonType`                                                                                                                                             |
| `api.retry`            | Claude Code retries a model request                                                     | `attempt`, `maxRetries`, `retryDelayMs`, `errorStatus`, `error`                                                                                                                   |
| `usage.update`         | Claude Code reported token usage or cost                                                | `turnId`, `reported` (cumulative, as Claude Code reports it), `estimatedDelta` (hudhud's estimate of the change, marked `estimate: true`)                                         |
| `turn.completed`       | A turn ended                                                                            | `turnId`, `result` (the `TurnResult`)                                                                                                                                             |
| `session.state`        | Claude Code changed state                                                               | `state` (`'idle'`, `'running'`, `'requires_action'`, ...)                                                                                                                         |
| `background.tasks`     | Claude Code's background tasks changed                                                  | (only `raw`)                                                                                                                                                                      |
| `stalled`              | No output for `idleStallMs` while a turn runs ([Sessions](sessions.md#watchdogs))       | `silentForMs`, `turnId`, `pendingPermissions`                                                                                                                                     |
| `diagnostic`           | hudhud reports something about itself ([Diagnostics](diagnostics.md#diagnostic-events)) | `code`, `message`, `data`                                                                                                                                                         |
| `gap`                  | Events were dropped for this subscriber (below)                                         | `dropped`                                                                                                                                                                         |
| `session.terminated`   | The session ended; always the last event                                                | `intent`, `outcome`, `exitCode`, `signal` ([Sessions](sessions.md#abort-and-dispose))                                                                                             |
| `harness.frame`        | A Claude Code frame that maps to none of the types above                                | `frameType`, `subtype`                                                                                                                                                            |

No frame is dropped silently: a frame hudhud does not model arrives as `harness.frame`.

## What a new subscriber receives first

Some events happen before `create()` or `resume()` has returned the session to you, for example `session.started` and the diagnostics about the environment and the security posture. hudhud keeps them, and every `events()` subscriber receives, in `seq` order:

1. the `compat` event (`seq` 0);
2. the events from before the session was handed to you (at most a bounded number; if more were produced, the newest are dropped and a `events.pre-handshake-truncated` diagnostic says how many);
3. every event published after the subscription started.

Events published after the session was returned and before you subscribed are not replayed. Subscribe right after `create()` to see everything.

## Bounded queues and overflow

Each subscriber, and each `Turn` iterator, has its own queue, bounded by count and by bytes. You set the limits per subscriber, or for a session's subscribers in the session option `events`:

| Option      | Default             | Meaning                                                                                           |
| ----------- | ------------------- | ------------------------------------------------------------------------------------------------- |
| `maxEvents` | 10 000              | Events the queue holds                                                                            |
| `maxBytes`  | 67 108 864 (64 MiB) | Bytes the queue holds: an event counts the size of the Claude Code frame it carries, or 256 bytes |
| `overflow`  | `'error'`           | What happens when the queue is full (below)                                                       |
| `signal`    | none                | Aborting it ends this subscription with `ABORTED`                                                 |

| `overflow`                      | When the queue is full                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `'error'` (default)             | This subscriber's iterator rejects with `SUBSCRIBER_OVERFLOW`. The session and every other subscriber go on. |
| `'drop-oldest-with-gap-marker'` | The oldest events are dropped; the subscriber receives a `gap` event with the number dropped.                |
| `'block'`                       | hudhud waits for the subscriber before it reads more output.                                                 |

`'block'` is dangerous: while it waits, Claude Code's control requests (including permission questions) and hudhud's own timers wait too, so one slow subscriber can stall the session. Results of turns already settled are not held, and disposing or aborting the session always cuts through (a waiting `'block'` subscriber then rejects with `SESSION_CLOSED`). Use it only when losing an event is worse than a stall ([ADR-0007](../adr/0007-event-delivery-backpressure-timeouts.md#subscribers)).

```ts
async function watch(session: Session): Promise<void> {
  // A slow consumer loses the oldest events and sees a `gap` marker instead
  // of failing its iterator (the default policy is 'error').
  const events = session.events({ overflow: 'drop-oldest-with-gap-marker', maxEvents: 1000 });
  for await (const event of events) {
    if (isEventType(event, 'compat')) {
      console.log(`[compat] Claude Code ${event.compat.version}: ${event.compat.status}`);
    } else if (isEventType(event, 'diagnostic')) {
      console.log(`[diagnostic] ${event.code}: ${event.message}`);
    } else if (isEventType(event, 'api.retry')) {
      console.log(`[api.retry] attempt ${String(event.attempt)}: ${event.error ?? 'unknown'}`);
    } else if (isEventType(event, 'stalled')) {
      console.log(`[stalled] no output for ${String(event.silentForMs)} ms`);
    } else if (isEventType(event, 'gap')) {
      console.log(`[gap] ${String(event.dropped)} events dropped`);
    } else if (isEventType(event, 'session.terminated')) {
      console.log(`[end] intent ${event.intent}, outcome ${event.outcome}`);
    }
  }
  // The iterator ends after the session's last event.
}
```

To stop reading early, `break` out of the loop (the subscription ends quietly) or abort its `signal` (the iterator rejects with `ABORTED`).
