# Every way

hudhud's rule is to offer every way of doing one thing, with the most stable and safe way as the default ([ADR-0002](../adr/0002-execution-modes-and-every-way-registry.md)). A way counts as first-class only when it is tested against recorded Claude Code behaviour (golden fixtures), exercised against the real Claude Code (integration suites, which the canary of [ADR-0013](../adr/0013-testing-strategy.md) also runs against each newer published Claude Code version: nightly on Linux, weekly on Windows and macOS arm64; [ADR-0014](../adr/0014-ci-strategy.md#amendments) amendment 3), declared as a capability where one applies, and documented with its default. This page is that registry.

Columns:

- **Selected by**: the option or call that selects the way.
- **Capability**: the `harness.capabilities` entry that declares it, if any.
- **Fixtures**: golden fixtures under `packages/claude-code/conformance/`, recorded from Claude Code 2.1.296 on Windows and Linux.
- **Integration**: suites under `packages/claude-code/test/integration/` that run the way against the pinned Claude Code.

## Registry

### Backend and process

| Goal                | Way                         | Selected by                         | Default        | Capability                                   | Fixtures | Integration                                                               |
| ------------------- | --------------------------- | ----------------------------------- | -------------- | -------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| Claude Code backend | native CLI over stream-json | `backend: 'native'`                 | yes            | -                                            | all      | all                                                                       |
|                     | Agent SDK                   | `backend: 'agent-sdk'`              |                | not offered in v1 (`CAPABILITY_UNSUPPORTED`) | -        | -                                                                         |
| Binary resolution   | explicit path               | `binaryPath`                        |                | -                                            | -        | `harness/smoke`, `lifecycle/connect`                                      |
|                     | discovery                   | (no `binaryPath`)                   | yes            | -                                            | -        | - (discovery is unit-tested; integration always passes the pinned binary) |
| Binary verification | advisory                    | `binaryVerification: 'advisory'`    | yes            | -                                            | -        | `lifecycle/connect`                                                       |
|                     | strict                      | `binaryVerification: 'strict'`      |                | -                                            | -        | - (unit tests)                                                            |
| Process containment | Windows job                 | `@hudhudjs/win32-job-x64` installed | when available | `processContainment: 'job'`                  | -        | `containment/*` (job mode)                                                |
|                     | best effort                 | otherwise                           |                | `processContainment: 'best-effort'`          | -        | `containment/*` (best-effort mode)                                        |
|                     | cgroup                      |                                     |                | not offered in v1                            | -        | -                                                                         |

### Sessions and turns

| Goal               | Way                           | Selected by                                | Default | Capability                                         | Fixtures                                              | Integration                                      |
| ------------------ | ----------------------------- | ------------------------------------------ | ------- | -------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------ |
| Open a session     | one call                      | `session()`                                |         | -                                                  | `handshake`, `text-turn`                              | `lifecycle/close-abort`                          |
|                    | over a shared Harness         | `connect()`, `sessions.create()`           |         | -                                                  | `handshake`, `text-turn`                              | `lifecycle/turns`, `harness/smoke`               |
| Continue a session | resume                        | `sessions.resume(id)`                      |         | `resume`                                           | `resume`, `resume-not-found`, `resume-duplicate-uuid` | `lifecycle/resume-fork`                          |
|                    | fork                          | `sessions.resume(id, { fork: true })`      |         | `fork`                                             | `fork`, `fork-session-id`                             | `lifecycle/resume-fork`                          |
|                    | continue the latest           |                                            |         | not offered (K6: it silently starts a new session) | -                                                     | -                                                |
| Session shape      | long-lived, multi-turn        | (always)                                   | yes     | `multiTurn`                                        | `two-turns`                                           | `lifecycle/turns`                                |
|                    | one-shot                      |                                            |         | not offered in v1                                  | -                                                     | -                                                |
| Run a turn         | await the result              | `session.ask()`                            |         | -                                                  | `text-turn`, `two-turns`, `tool-bash`                 | `lifecycle/turns`                                |
|                    | stream it                     | `session.send()`, iterate the `Turn`       |         | -                                                  | `text-turn`, `two-turns`                              | `lifecycle/turns`, `permissions/interrupt`       |
| Partial messages   | off                           | `claudeCode.includePartialMessages: false` | yes     | -                                                  | `text-turn`                                           | `lifecycle/turns`                                |
|                    | on                            | `claudeCode.includePartialMessages: true`  |         | -                                                  | `partial-messages`, `interrupt-midstream`             | `lifecycle/turns`, `request-shape/request-shape` |
| Input              | text                          | a string                                   |         | -                                                  | `text-turn`, `utf8-arabic`                            | `lifecycle/turns`                                |
|                    | content blocks (text, images) | `{ content: [...] }`                       |         | -                                                  | -                                                     | - (unit tests)                                   |

### Stopping

| Goal          | Way                               | Selected by                              | Default | Capability  | Fixtures                                                              | Integration                                   |
| ------------- | --------------------------------- | ---------------------------------------- | ------- | ----------- | --------------------------------------------------------------------- | --------------------------------------------- |
| Stop one turn | interrupt                         | `turn.interrupt()`                       |         | `interrupt` | `interrupt-midstream`, `interrupt-queued`, `interrupt-same-write`     | `permissions/interrupt`                       |
|               | interrupt and drop queued prompts | `turn.interrupt({ cancelQueued: true })` |         | `interrupt` | `interrupt-cancel-queued`                                             | `permissions/interrupt`                       |
|               | stop waiting                      | `ask()`/`send()` with `signal`           |         | -           | -                                                                     | `permissions/cancellation`                    |
| End a session | drain                             | `session.close()`                        |         | -           | `eof-idle`, `eof-midstream`, `eof-midtool`, `bg-shell-turn-after-eof` | `lifecycle/close-abort`, `containment/orphan` |
|               | abort                             | dispose, `close({ signal })`             |         | -           | -                                                                     | `lifecycle/close-abort`, `containment/ladder` |
|               | abort everything                  | Harness dispose                          |         | -           | -                                                                     | `lifecycle/close-abort`                       |

### Permissions

| Goal                                    | Way                     | Selected by                                                    | Default     | Capability          | Fixtures                                                                                        | Integration                                            |
| --------------------------------------- | ----------------------- | -------------------------------------------------------------- | ----------- | ------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Permission mode                         | explicit mode           | `permissionMode`                                               | `'default'` | -                   | `tool-bash`                                                                                     | `permissions/decisions`                                |
|                                         | change it later         | `session.setPermissionMode()`                                  |             | -                   | -                                                                                               | `permissions/decisions`                                |
|                                         | bypass                  | `'bypassPermissions'` with `dangerouslyAllowBypassPermissions` |             | -                   | -                                                                                               | `permissions/decisions` (refusal)                      |
| Permission questions                    | Claude Code decides     | no `onPermission`                                              | yes         | -                   | `tool-bash`                                                                                     | `permissions/decisions`                                |
|                                         | the application decides | `onPermission`                                                 |             | `permissionsInBand` | `permission-allow`, `permission-deny`, `permission-deny-interrupt`, `permission-error-response` | `permissions/decisions`, `permissions/cancellation`    |
|                                         | cancelled               | interrupt, close, abort                                        |             | `permissionsInBand` | `permission-never-answered-interrupt`, `permission-eof`                                         | `permissions/cancellation`                             |
| Tool rules                              | allow and deny lists    | `claudeCode.allowedTools`, `disallowedTools`                   | none        | -                   | -                                                                                               | `security/child-launch`, `request-shape/request-shape` |
| Settings writes from permission updates | stripped                | (default)                                                      | yes         | -                   | -                                                                                               | `permissions/decisions`                                |
|                                         | kept                    | `dangerouslyAllowConfigWrites: true`                           |             | -                   | -                                                                                               | `security/posture` (posture only)                      |

### Configuration and security

| Goal                     | Way                           | Selected by                                     | Default                   | Capability                                  | Fixtures                                 | Integration                                                   |
| ------------------------ | ----------------------------- | ----------------------------------------------- | ------------------------- | ------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| Config sources and trust | user settings only            | `workspaceTrust: 'none'`                        | yes                       | `workspaceTrust.none`                       | all (`--setting-sources=user`)           | `security/workspace-trust`                                    |
|                          | the repository's settings too | `workspaceTrust: 'full'`                        |                           | `workspaceTrust.full`                       | -                                        | `security/workspace-trust`, `security/project-credential-env` |
|                          | context only                  | `workspaceTrust: 'context'`                     |                           | `workspaceTrust.context`: unsupported in v1 | -                                        | -                                                             |
|                          | explicit sources              | `claudeCode.settingSources`                     |                           | -                                           | -                                        | `security/project-credential-env`                             |
| Project credential guard | refuse                        | `projectCredentialEnv: 'refuse'`                | yes, with project sources | -                                           | -                                        | `security/project-credential-env`                             |
|                          | allow                         | `projectCredentialEnv: 'allow'`                 |                           | -                                           | -                                        | `security/project-credential-env`                             |
| Environment              | allowlist                     | `env: 'harness'`                                | yes                       | -                                           | -                                        | `security/child-launch`                                       |
|                          | inherit                       | `env: 'inherit'`                                |                           | -                                           | -                                        | `security/child-launch`                                       |
|                          | explicit map                  | `env: { NAME: value }`                          |                           | -                                           | -                                        | - (unit tests)                                                |
|                          | preset with changes           | `env: { preset, add, remove }`                  |                           | -                                           | -                                        | `security/child-launch`                                       |
| Config isolation         | the user's config directory   | (default)                                       | yes                       | -                                           | -                                        | - (integration always isolates)                               |
|                          | isolated directory            | `claudeCode.configDir`                          |                           | -                                           | -                                        | all (the harness isolates every run)                          |
|                          | bare mode                     | `claudeCode.bare: true`                         |                           | -                                           | -                                        | - (posture only)                                              |
| Nonessential traffic     | off                           | `nonessentialTraffic: 'disabled'`               | yes                       | -                                           | -                                        | `security/egress`                                             |
|                          | Claude Code's default         | `'harness-default'`                             |                           | -                                           | -                                        | `security/egress`                                             |
| Auto-update              | off                           | `autoUpdate: 'disabled'`                        | yes                       | -                                           | -                                        | `security/child-launch`                                       |
|                          | Claude Code's default         | `'harness-default'`                             |                           | -                                           | -                                        | `security/posture` (posture only)                             |
| Authentication failure   | fail fast                     | `onAuthFailure: 'fail-fast'`                    | yes                       | -                                           | `auth-401-no-retry`, `auth-token-source` | `security/auth-and-frames`                                    |
|                          | let Claude Code retry         | `onAuthFailure: 'harness-retry'`                |                           | -                                           | `auth-401-retries`                       | -                                                             |
| Oversized output line    | fail                          | `onOversizedFrame: 'fail'`                      | yes                       | -                                           | `big-frame-5mb`                          | `security/auth-and-frames`                                    |
|                          | skip                          | `onOversizedFrame: 'skip'`                      |                           | -                                           | -                                        | `security/auth-and-frames`                                    |
| Known-broken versions    | refuse                        | (default)                                       | yes                       | -                                           | -                                        | - (unit tests; no version is listed)                          |
|                          | run anyway                    | `claudeCode.dangerouslyAllowKnownBrokenVersion` |                           | -                                           | -                                        | - (unit tests)                                                |
| Tracing                  | off                           | (no `trace`)                                    | yes                       | -                                           | -                                        | `security/child-launch`                                       |
|                          | propagate                     | `trace`                                         |                           | -                                           | -                                        | `security/child-launch`                                       |

### Events

| Goal                            | Way                           | Selected by                     | Default | Capability | Fixtures                        | Integration                            |
| ------------------------------- | ----------------------------- | ------------------------------- | ------- | ---------- | ------------------------------- | -------------------------------------- |
| Read events                     | per turn                      | iterate the `Turn`              |         | -          | every fixture's expected events | `lifecycle/turns`                      |
|                                 | per session                   | `session.events()`              |         | -          | every fixture's expected events | `lifecycle/turns`, `lifecycle/connect` |
| Event overflow                  | fail the subscriber           | `overflow: 'error'`             | yes     | -          | -                               | - (unit tests; harness-independent)    |
|                                 | drop oldest with a gap marker | `'drop-oldest-with-gap-marker'` |         | -          | -                               | - (unit tests; harness-independent)    |
|                                 | block                         | `'block'`                       |         | -          | -                               | - (unit tests; harness-independent)    |
| Unmodelled Claude Code features | raw frames and control        | `@hudhudjs/claude-code/raw`     |         | -          | -                               | - (unit tests; unstable tier)          |

## Ways without full coverage

ADR-0002 makes the fixture and canary columns a release requirement. These ways have no golden fixture or no integration suite today, as the tables show:

- harness-independent ways, tested by unit tests only: the event overflow policies, the explicit `env` map, content-block input;
- ways the integration harness cannot exercise as such: discovery and the user's own config directory (the harness always passes the pinned binary and an isolated config directory), `claudeCode.bare`;
- `binaryVerification: 'strict'` (unit tests only);
- `dangerouslyAllowConfigWrites: true` and `autoUpdate: 'harness-default'` (their integration run checks the posture, not the effect);
- `onAuthFailure: 'harness-retry'` (fixture only), the known-broken refusal and its opt-in (no version is listed);
- the unstable raw tier.

The registry is updated with every option that is added or changed.
