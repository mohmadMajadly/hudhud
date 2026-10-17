# Permissions

Claude Code decides for each tool call whether it may run. hudhud gives you three ways to steer that, which combine ([ADR-0012](../adr/0012-security-defaults-and-trust.md#3-permission-mode-and-prompting-a8-d3-d4)):

| Way                               | Option                                                  | Default                               |
| --------------------------------- | ------------------------------------------------------- | ------------------------------------- |
| A permission mode                 | `permissionMode`                                        | `'default'`, always passed explicitly |
| A permission handler in your code | `onPermission`                                          | none                                  |
| Tool rules                        | `claudeCode.allowedTools`, `claudeCode.disallowedTools` | none                                  |

## Permission modes

hudhud always starts Claude Code with an explicit `--permission-mode`. Claude Code's own default when the flag is missing is not `default`: without it, mutating commands were observed to run without any question ([ADR-0012](../adr/0012-security-defaults-and-trust.md#context)). The modes are Claude Code's; hudhud passes them through:

| `permissionMode`      | Notes                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `'default'` (default) | Claude Code asks before tools that change something. Without `onPermission` it denies them itself; read-only tools run. |
| `'acceptEdits'`       | Claude Code's mode for accepting file edits without asking. Listed in `securityPosture` as a deviation.                 |
| `'plan'`              | Claude Code's planning mode. Listed in `securityPosture`.                                                               |
| `'dontAsk'`           | Claude Code's mode that does not ask. Listed in `securityPosture`.                                                      |
| `'auto'`              | Mutating commands run without a permission question. Listed in `securityPosture`.                                       |
| `'bypassPermissions'` | Skips Claude Code's permission checks. Refused unless the session also sets `dangerouslyAllowBypassPermissions: true`.  |

See Claude Code's documentation for the exact behaviour of each mode in the version you run. Any mode other than `'default'` appears as a deviation in the session's [security posture](security.md#security-posture).

### Changing the mode during a session

```ts
// Later turns can run in another mode, for example accepting edits.
await session.setPermissionMode('acceptEdits');
```

`setPermissionMode` sends the change to Claude Code; it applies to the turns that follow. It is refused before anything is written with `INVALID_OPTIONS` for an unknown mode, and for `'bypassPermissions'` when the session was not created with `dangerouslyAllowBypassPermissions: true` (that flag authorizes bypass for the whole session, as the initial mode or later). It rejects with `CONTROL_REQUEST_FAILED` when Claude Code refuses the change, and with `ABORTED` when its `signal` aborts.

## The permission handler

Pass `onPermission` and Claude Code sends its permission questions to your application instead of deciding them itself. Without a handler, hudhud does not ask Claude Code to send questions at all.

```ts
const terminal = createInterface({ input: process.stdin, output: process.stdout });

const onPermission: PermissionHandler = async (request, { signal }) => {
  // Every text field comes from the harness: untrusted, sanitize before display.
  const tool = sanitizeForDisplay(request.displayName ?? request.toolName, { singleLine: true });
  const input = sanitizeForDisplay(JSON.stringify(request.input));
  // The signal aborts when the CLI withdraws the question, on interrupt and on close.
  const answer = await terminal.question(`Allow ${tool} with ${input}? [y/N] `, { signal });
  return answer.trim().toLowerCase() === 'y'
    ? { behavior: 'allow' }
    : { behavior: 'deny', message: 'The user declined this tool call.' };
};

const session = await hudhud.session({ permissionMode: 'default', onPermission });
```

`sanitizeForDisplay` comes from `@hudhudjs/core/protocol`; add `@hudhudjs/core` as a direct dependency to import it.

### The request

| Field                                                   | Content                                                                                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `requestId`                                             | The question's id (also in the `permission.requested` and `permission.resolved` events)                                                  |
| `sessionId`, `turnId`                                   | Where the question comes from                                                                                                            |
| `toolName`, `displayName`, `toolUseId`                  | The tool call                                                                                                                            |
| `input`                                                 | The tool's input, as JSON                                                                                                                |
| `suggestions`                                           | Claude Code's permission suggestions, passed through as data and never applied by hudhud. Their shape differs between operating systems. |
| `blockedPath`, `decisionReason`, `title`, `description` | Optional explanations from Claude Code                                                                                                   |
| `raw`                                                   | The whole request frame                                                                                                                  |

Every text field is untrusted: it can contain terminal escape sequences or text written by the model. Pass it through `sanitizeForDisplay` before you show it.

### The decision

| Decision                                         | Effect                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| `{ behavior: 'allow' }`                          | The tool runs                                                         |
| `{ behavior: 'allow', updatedInput }`            | The tool runs with this input instead                                 |
| `{ behavior: 'allow', updatedPermissions }`      | The tool runs, and Claude Code applies the permission updates (below) |
| `{ behavior: 'deny', message }`                  | The tool does not run; `message` is its result and the turn continues |
| `{ behavior: 'deny', message, interrupt: true }` | The tool does not run and the turn is cancelled                       |

hudhud copies and checks the decision: it must be a plain object with exactly these keys and JSON values. Permission updates whose destination is not the session (for example `localSettings` or `userSettings`, which would write settings files) are removed before they reach Claude Code, and a `permission.updates-stripped` diagnostic says so, unless the session sets `dangerouslyAllowConfigWrites: true`.

### Failures fail closed

A handler that throws or rejects, or returns something that is not a valid decision, never results in an allow. hudhud answers Claude Code with a deny and publishes a `permission.handler-failed` or `permission.invalid-decision` diagnostic. Your handler's error text never reaches Claude Code or the model.

### No timeout, always cancellable

hudhud never answers a question on your behalf after a timeout, because a person may be deciding ([ADR-0007](../adr/0007-event-delivery-backpressure-timeouts.md#handler-classes-and-timeouts)). Add your own timeout if you need one. A question is cancelled, and your handler's `signal` aborts, when:

| Cause                                                     | What Claude Code receives                                          | `permission.resolved` |
| --------------------------------------------------------- | ------------------------------------------------------------------ | --------------------- |
| Claude Code withdraws it (for example after an interrupt) | nothing more                                                       | `by: 'harness'`       |
| `session.close()`                                         | a deny with the message "hudhud session closing", so it can finish | `by: 'close'`         |
| The session is aborted or disposed                        | nothing; its interrupt makes Claude Code withdraw the question     | `by: 'abort'`         |

An answer that arrives after the cancellation is dropped. The `stalled` event counts open questions in `pendingPermissions`, so you can see a session waiting on a person.

## Tool rules

`claudeCode.allowedTools` and `claudeCode.disallowedTools` pass Claude Code's tool rules, for example `'Read'` or `'Bash(git status:*)'`. Claude Code splits its rule list on commas and whitespace outside parentheses, so hudhud refuses (with `INVALID_OPTIONS`) any rule that would split, an empty rule, unbalanced parentheses, a leading `-` and control characters ([ADR-0011](../adr/0011-spawn-hygiene-and-binary-provenance.md#spawn-a14)). Both lists appear in the security posture.
