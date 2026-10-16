# The raw tier

`@hudhudjs/claude-code/raw` reaches Claude Code features that hudhud does not model yet: every wire frame in both directions, and, with an explicit opt-in, control requests and frames written past hudhud's session machine. It is unstable: it may change in any release, without the compatibility promises of the rest of the API ([ADR-0003](../adr/0003-public-api.md#three-api-tiers), [ADR-0004](../adr/0004-packages-and-versioning.md#versioning-layers)). It is not re-exported by `hudhudjs`; add `@hudhudjs/claude-code` as a direct dependency to import it.

```ts
// Raw control carries the agent's full authority; it is off unless opted in.
const harness = await connect({ claudeCode: { dangerouslyAllowRawControl: true } });
try {
  // createSessionRaw is sessions.create plus extra argv and environment.
  const session = await createSessionRaw(harness, { raw: { extraEnv: { MY_TOOL_MODE: 'ci' } } });
  try {
    const wire = raw(session);
    const tap = (async () => {
      for await (const frame of wire.frames({ overflow: 'drop-oldest-with-gap-marker' })) {
        if (frame.kind === 'gap') console.log(`(${String(frame.dropped)} frames dropped)`);
        else console.log(`${frame.direction} ${String(frame.bytes)} bytes`);
      }
    })();

    await session.ask('Say hello.');
    console.log(await wire.controlRequest('mcp_status', {}, { timeoutMs: 10_000 }));

    await session.close();
    await tap;
  } finally {
    await session[Symbol.asyncDispose]();
  }
} finally {
  await harness[Symbol.asyncDispose]();
}
```

## `raw(session)`

Returns the `RawSession` of a session this adapter opened (any other value is refused with `INVALID_OPTIONS`):

| Member                                                  | What it does                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frames(options?)`                                      | Every JSON frame from now on, in both directions, as `{ kind: 'frame', direction: 'in' \| 'out', seq, ts, bytes, frame }`, plus `{ kind: 'gap', seq, ts, dropped }` markers. Bounded like `events()`, with the same options and overflow policies ([Events](events.md#bounded-queues-and-overflow)). Frames are read-only copies. Ends when the session ends. |
| `controlRequest(subtype, body?, { signal, timeoutMs })` | Sends a control request `{ subtype, ...body }` and resolves with Claude Code's answer. Rejects with `CONTROL_REQUEST_FAILED` (an error answer, or `timeoutMs` passed), `ABORTED`, or `SESSION_CLOSED` when the session ends first.                                                                                                                            |
| `writeFrame(frame)`                                     | Writes one frame to Claude Code's input.                                                                                                                                                                                                                                                                                                                      |

`controlRequest` and `writeFrame` act with the agent's full authority: a control request can change settings, permissions and MCP servers. Both are refused with `INVALID_OPTIONS` unless the Harness was connected with `claudeCode.dangerouslyAllowRawControl: true`, which the security posture lists ([ADR-0012](../adr/0012-security-defaults-and-trust.md#8-untrusted-text-and-frames)). Even then hudhud refuses an `initialize` request (it carries the persisted workspace-trust grant), `update_settings`, and permission updates that would write settings files unless `dangerouslyAllowConfigWrites` is set. The outbound size limit applies. Never pass input from untrusted sources to these methods.

The answer to a raw control request is not part of the session's model; the session publishes it as a `control.unknown-response` diagnostic.

## `createSessionRaw(harness, options)`

Like `harness.sessions.create(options)`, plus `options.raw`:

- `extraArgs`: extra command-line arguments, each passed as one argument. Flags hudhud sets itself, and flags that would bypass its controls, are refused with `INVALID_OPTIONS` (`details.rule`, `details.flag`): among them `--permission-mode`, `--setting-sources`, `--settings`, `--resume`, `--continue`, `--session-id`, `--print`, `--system-prompt`, `--dangerously-skip-permissions` and `--project-config-root`.
- `extraEnv`: extra environment variables, set after the `env` option. Variables hudhud sets itself are refused.

Both appear in the security posture by name (`raw.extraArgs` lists flag names, `raw.extraEnv` variable names; never values). On Windows, the 32 000-character command-line limit applies to the whole command line.
