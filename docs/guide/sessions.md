# Sessions and turns

The public API has four handles ([ADR-0003](../adr/0003-public-api.md)):

| Handle    | What it is                                                    | How you get it                                        |
| --------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| `Harness` | One verified Claude Code binary, its capabilities and posture | `connect()`                                           |
| `Session` | One conversation with Claude Code, under one session id       | `harness.sessions.create()`, `.resume()`, `session()` |
| `Turn`    | One prompt and everything the agent does to answer it         | `session.send()`                                      |
| events    | A bounded stream of everything a session or a turn reports    | `session.events()`, iterating a `Turn`                |

`hudhud` is a namespace object with the two entry points, `hudhud.connect` and `hudhud.session`; they are the same functions as the named exports `connect` and `session`.

## `connect()` or `session()`

`session(options)` is the one-call form: it connects, opens one session, and disposes its private `Harness` when that session ends. It takes the options of `connect()` and of a session in one object (the `claudeCode` options of both are merged).

Use `connect()` when an application opens more than one session: the binary is found, verified and probed once, and every session of the `Harness` uses it.

```ts
const harness = await connect();
try {
  const { binary, compat, capabilities } = harness;
  console.log(`Claude Code ${binary.version} at ${binary.path} (found by: ${binary.source})`);
  console.log(`verification: ${binary.verification.status} (${binary.verification.method})`);
  console.log(`compat: ${compat.status}, tested ${compat.minTested} to ${compat.maxTested}`);
  console.log(`process containment: ${capabilities.processContainment}`);
  for (const [capability, reason] of Object.entries(capabilities.reasons)) {
    console.log(`  ${capability}: ${reason}`);
  }
  for (const entry of postureDeviations(harness.securityPosture)) {
    console.log(`security posture deviates: ${entry.setting} = ${JSON.stringify(entry.value)}`);
  }

  const session = await harness.sessions.create({ cwd: process.cwd() });
  try {
    const { info } = session;
    console.log(`session ${info.id}: pid ${String(info.pid)}, containment ${info.containment}`);
    const result = await session.ask('What is 6 times 7?');
    console.log(result.text);
  } finally {
    await session.close();
  }
} finally {
  // Disposing the Harness also disposes every session it still has.
  await harness[Symbol.asyncDispose]();
}
```

`connect()` does, in order: validate the options, find the binary, verify it, run `claude --version` once, then build the `securityPosture` and the capabilities. Each step finishes before the next starts, and nothing is spawned before validation passed.

### What a `Harness` tells you

| Property          | Content                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `binary`          | `path` (resolved), `requestedPath` (when it differs), `version` (from the probe), `source` (`'option'`, `'native-install'` or `'path'`), `verification` ([Security](security.md#binary-verification))   |
| `compat`          | The tested version window and where the probed version falls in it ([Compatibility](compatibility.md))                                                                                                  |
| `capabilities`    | What this Harness supports: `multiTurn`, `resume`, `fork`, `interrupt`, `permissionsInBand`, `workspaceTrust.none`/`context`/`full`, `processContainment`, and `reasons` for anything not `'supported'` |
| `securityPosture` | Every security-relevant connect setting with its value and whether it deviates from the default ([Security](security.md#security-posture))                                                              |

Each capability is `'supported'`, `'emulated'` or `'unsupported'`. The Claude Code adapter reports every capability as `'supported'` except `workspaceTrust.context`, which is `'unsupported'` in v1. `processContainment` is `'job'` or `'best-effort'` ([Platforms](platforms.md)).

### Sessions of a Harness

- `harness.sessions.create(options?)` starts a new session under a fresh UUID that hudhud generates.
- `harness.sessions.resume(sessionId, options?)` continues an existing session ([below](#resume-and-fork)).
- Disposing the Harness (`await harness[Symbol.asyncDispose]()`, or `await using harness = await connect()`) aborts sessions that are still starting, disposes the live ones and refuses new ones with `HARNESS_DISPOSED`.

A session's `info` holds what it learned at start: `id`, `mode` (`'create'`, `'resume'` or `'fork'`), `forkedFrom`, `pid` (the process hudhud spawned), `cliPid` (the pid Claude Code reports, which differs behind a launcher), `version`, `apiKeySource`, `tokenSource`, `features` and `containment` (what this session actually got). `session.closed` is a promise that resolves when the session has ended, for whatever reason; it never rejects.

## `ask()` and `send()`

Both send one prompt and start one turn.

- `session.ask(prompt, { signal })` resolves with the turn's `TurnResult`.
- `session.send(input, { signal, events })` returns a `Turn` at once: `turn.id`, `turn.done` (the same `TurnResult` promise), `turn.interrupt()`, and the turn's own events when you iterate it ([Events](events.md)).

A `TurnResult` is returned for every turn that ends, including turns that end with an error: `isError`, `outcome` (`'completed'`, `'error'`, `'cancelled'`, `'max-turns'`, `'max-budget'`, `'unknown'`, or a newer value), `text`, `stopReason`, `terminalReason`, `errors`, `apiErrorStatus`, `usage`, `permissionDenials`, `raw` (the CLI's own result frame), and `synthesized` (`true` when hudhud built the result itself because the CLI ended the turn without a result frame, for example on an interrupt or a process exit). `ask()` and `turn.done` reject only when the session fails, for example with `PROCESS_EXITED` or `AUTHENTICATION_FAILED` ([Troubleshooting](troubleshooting.md)).

Prompts sent while a turn runs wait in Claude Code's queue (each has its own `Turn`, announced by a `turn.queued` event). Claude Code runs them after the current turn and may merge several queued prompts into one turn; every `Turn` it covers then settles with that turn's result.

### Input

A prompt is a string, or an object with content blocks:

| Block   | Fields                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------- |
| `text`  | `{ type: 'text', text }`                                                                                            |
| `image` | `{ type: 'image', mediaType, dataBase64 }`, `mediaType` one of `image/png`, `image/jpeg`, `image/gif`, `image/webp` |

hudhud copies the input when you call `ask` or `send`, so changing the object afterwards has no effect. Input that does not have this shape is refused with `INVALID_OPTIONS`; an encoded prompt larger than `maxOutboundFrameBytes` (32 MiB by default) is refused with `OUTBOUND_FRAME_TOO_LARGE` and nothing is written.

## Resume and fork

```ts
const first = await harness.sessions.create();
const sessionId = first.id;
await first.ask('Remember the word "lantern". Reply with OK.');
await first.close();

// Same id, same history.
const resumed = await harness.sessions.resume(sessionId);
console.log((await resumed.ask('Which word did I ask you to remember?')).text);
await resumed.close();

// A copy of the history under a new id; the original stays unchanged.
const forked = await harness.sessions.resume(sessionId, { fork: true });
console.log(`fork ${forked.id} of ${forked.info.forkedFrom ?? '?'}`);
await forked.close();
```

- Session ids are UUIDs. `resume` refuses anything else with `INVALID_OPTIONS`; session titles are not identities.
- `resume(id)` keeps the id and loads the history. `resume(id, { fork: true })` copies the history into a new session whose id hudhud chooses; `info.forkedFrom` names the original.
- An id Claude Code does not know fails with `SESSION_NOT_FOUND`, and nothing is left running.
- Within one `Harness`, a second live session with the same id is refused with `SESSION_ID_IN_USE`. Claude Code itself has no lock: two processes (or two Harnesses) that resume the same session both append to one transcript, and a later resume follows only the last-written branch ([ADR-0008](../adr/0008-turn-and-lifecycle-semantics.md#resume-continue-and-fork-j6-j7-07-1)). Do not resume one session from two places at once.
- Claude Code's `--continue` ("the most recent session in this directory") is not offered: it silently starts a new session when there is none. Keep the session id and resume it.

Resume and fork are tested against the real Claude Code on Windows x64, Linux x64 and macOS arm64 ([Platforms](platforms.md#support-matrix)).

## Stopping: interrupt, close, abort and dispose

| You want to                               | Call                                                                                              | What happens                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Stop one turn, keep the session           | `turn.interrupt()`                                                                                | The turn ends with outcome `'cancelled'`; the session stays usable                                 |
| Give up waiting for one turn              | `ask(prompt, { signal })`, `send(input, { signal })`                                              | The call rejects at once with `ABORTED`; the turn is interrupted and settles in the background     |
| End a session and let its work finish     | `session.close()`                                                                                 | Drain: running and queued turns finish, then input ends and the CLI exits, within `closeTimeoutMs` |
| End a session now                         | `session[Symbol.asyncDispose]()`, `await using`, or `close({ signal })` with a signal that aborts | Abort: the termination ladder below                                                                |
| Give up while a session is still starting | the `signal` option of `create`, `resume` or `session()`                                          | The call rejects with `ABORTED` after the process was stopped; nothing is left running             |
| End everything                            | `harness[Symbol.asyncDispose]()`                                                                  | Every session of the Harness is disposed                                                           |

```ts
// 1. Interrupt one turn; the session stays usable.
const session = await hudhud.session();
const turn = session.send('Count slowly from 1 to 500, one number per line.');
await sleep(2000);
await turn.interrupt();
const interrupted = await turn.done;
console.log(`outcome: ${interrupted.outcome}`); // 'cancelled' when the interrupt took effect

// 2. Abort a single ask() with a signal: it rejects at once with ABORTED,
//    the turn is interrupted and settles in the background.
try {
  await session.ask('Write a long essay about rivers.', { signal: AbortSignal.timeout(5000) });
} catch (error) {
  if (!isHudhudError(error, 'ABORTED')) throw error;
  console.log('ask() aborted after 5 s');
}

// 3. Close drains: queued and running turns finish (bounded by closeTimeoutMs,
//    30 s by default), then the CLI exits on end of input.
await session.close();
```

### Interrupt

`turn.interrupt()` is held until Claude Code has actually started that turn and then sent; sending it earlier can make the CLI ignore it (Claude Code issue 98713, [ADR-0008](../adr/0008-turn-and-lifecycle-semantics.md#turns-and-interrupts)). `turn.interrupt({ cancelQueued: true })` also asks Claude Code to drop the prompts queued behind it; turns it drops end as cancelled. Interrupting a turn that already ended does nothing. A failed interrupt rejects with `CONTROL_REQUEST_FAILED`.

### Close (drain)

`close()` waits until nothing runs and Claude Code reports idle, ends its input and waits for it to exit. One deadline, `closeTimeoutMs` (default 30 000 ms), runs from the `close()` call and covers all of it; when it expires, the abort ladder runs and a turn still running ends cancelled ([ADR-0008](../adr/0008-turn-and-lifecycle-semantics.md#close-and-dispose)). A permission question still open when `close()` is called is answered with a deny ("hudhud session closing") so the CLI can reach idle, and the application's handler sees its signal abort. After Claude Code exits by itself, hudhud ends the processes it left behind (on Linux it was observed to leave a file-search child running).

Background work can outlive a turn: a background shell keeps Claude Code busy after the input ended, and when it finishes Claude Code may start a turn of its own (`turn.started` with `origin: 'harness'`). `close()` keeps reading until the exit. `claudeCode.backgroundWaitCeilingMs` (default 600 000 ms) bounds how long Claude Code waits for background subagents and tasks after its input ended; it does not bound background shells ([ADR-0008](../adr/0008-turn-and-lifecycle-semantics.md#stdin-close-policy)). Use a shorter `closeTimeoutMs` or dispose when you need a hard bound.

### Abort and dispose

Disposing a session, or aborting the signal of `close({ signal })` (which then rejects with `ABORTED`), runs the termination ladder. The `signal` in the options of `create`, `resume` and `session()` covers only the start: once the session is open, it has no effect. Each step of the ladder runs only if Claude Code is still running:

| Step | Windows with `'job'` containment                                                           | Windows `'best-effort'`                                       | Linux and macOS                                                                                               |
| ---- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1    | `interrupt` (wait up to `termination.interruptWaitMs`, 1 s)                                | same                                                          | same                                                                                                          |
| 2    | End of input                                                                               | End of input                                                  | End of input                                                                                                  |
| 3    | After `termination.eofGraceMs` (2 s): terminate the job, which ends the whole process tree | After 2 s: `taskkill /T /F`                                   | After 2 s: `SIGTERM` to Claude Code (behind a launcher: to the real CLI)                                      |
| 4    |                                                                                            | After `termination.taskkillGraceMs` (2 s): `TerminateProcess` | After `termination.termGraceMs` (5 s): `SIGKILL`, then a sweep of the descendants recorded before the signals |

hudhud records why it ends a session before it sends anything, and reports it as `intent` in the final `session.terminated` event, with the classified `outcome` (`'closed'`, `'aborted'`, `'failed'`, `'crashed'`, `'killed-externally'` or `'unknown'`). Decide on `outcome`, not on the exit code: a job termination exits with code 0 ([ADR-0008](../adr/0008-turn-and-lifecycle-semantics.md#termination-intent-and-exit-code-semantics-e8)).

What survives an abort depends on the platform's containment; see [Platforms](platforms.md#process-containment).

### When the host process exits or is interrupted

- hudhud installs no signal handlers. While at least one session is live it keeps exactly one `process.once('exit')` listener, which ends every session's input so Claude Code finishes as on a graceful end of input.
- A terminal Ctrl+C reaches Claude Code too (it is not detached). The session then ends with outcome `'unknown'` and `PROCESS_EXITED`. Handle `SIGINT` in your application if you want a graceful close.

## Watchdogs

- `firstFrameTimeoutMs` (default 60 000 ms): the time Claude Code has to answer hudhud's first request after start. On expiry, `create` or `resume` fails with `HANDSHAKE_TIMEOUT` and the process is stopped.
- `idleStallMs` (default 300 000 ms): while a turn runs and nothing arrives for this long, the session emits a `stalled` event (`silentForMs`, `pendingPermissions`). It never stops anything: a person may be answering a permission question.

## Changing the permission mode

`session.setPermissionMode(mode)` changes the mode for the following turns. It is described in [Permissions](permissions.md#changing-the-mode-during-a-session).
