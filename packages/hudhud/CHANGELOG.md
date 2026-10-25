# hudhudjs

## 0.1.0

### Minor Changes

- c42acf0: The stability promise is now exact (pre-release review R5-1, ADR-0004 amendment). Stable, under semver: the root entries of `hudhudjs`, `@hudhudjs/core` and `@hudhudjs/claude-code` (except the adapter-author items `defineAdapter`, `AdapterDefinition`, `buildPosture` and `PostureEntryInput`), the schemas, and from `@hudhudjs/core/protocol` the application helpers `sanitizeForDisplay`, `SanitizeForDisplayOptions`, `parseErrorData`, `ErrorDataFailure` and `isRetryable`. Beta, for adapter authors, and free to change in a minor version: `@hudhudjs/core/process` (which was documented as stable), the rest of `@hudhudjs/core/protocol` (the machine contract, the JSON line helpers, exit classification, `ERROR_RETRYABLE`, `makeErrorData`, `isHudhudErrorCode`), `@hudhudjs/core/binding`, and the raw tier `@hudhudjs/claude-code/raw`, which also stays exempt from compatibility promises. Nothing was renamed or removed; only the release tags (`@public` to `@beta`) and the documentation changed.
- 313366c: Breaking, before the first release (pre-release review R5-5): the root entry `@hudhudjs/core` (and so `hudhudjs`) no longer exports utilities that are not part of the application API.
  
  - Removed: `UsageEstimator`, `UsageObservation`, `EstimatedUsage`, `estimateUsageDelta` and `sanitizeUsage`. Nothing used them since the Claude Code adapter computes `usage.update.estimatedDelta` itself; the `usage.update` event is unchanged.
  - Moved off the root: `StderrTail`, `StderrTailOptions` and `TRUNCATED`. They stay on `@hudhudjs/core/process`, where the process layer uses them.
  - `buildPosture` and `PostureEntryInput` are now `@beta`: they are for adapter authors. The application posture helpers (`postureDeviations`, `postureEntry`, `serializePosture`, `parsePosture`) stay stable.
- a99a908: The tested window of the Claude Code adapter spans several releases: `CLAUDE_CODE_COMPAT` is `minTested: '2.1.296'`, `maxTested: '2.1.302'`, and every release in between (2.1.299, 2.1.300, 2.1.301) was tested too. Users on any of them get `compat.status: 'tested'` instead of `'untested'`. The committed digest table holds the official binaries of all five releases on linux-x64, win32-x64, darwin-arm64 and darwin-x64, each checked against the npm integrity and the Agent SDK `manifest.json` of the same CLI release, so `binary.verification` is `'verified'` for them without `claudeCode.binaryDigests`. From 2.1.299 on, Claude Code no longer sends the `anthropic-beta` value `mid-conversation-system-2026-04-07`; nothing in hudhud depends on it.
- e4f9fe6: A session started on a Claude Code version outside the tested window publishes the diagnostic `compat.untested` among its start diagnostics (`data` is the `compat` object: `version`, `minTested`, `maxTested`, `knownBroken`, `status`). It is a warning only: the session runs, as before. `DiagnosticCode` and the events schema list the new code (additive). Before, an untested version showed only in `harness.compat` and the `compat` event.
- 19ef5d6: The committed digest table holds the darwin-arm64 and darwin-x64 binaries of CLI 2.1.296 (sha256 and size recorded by the macOS gate, cross-checked against the npm integrity and the Agent SDK `manifest.json`; research 10 §5, research 11). A pinned darwin binary is now `verified` in advisory and strict mode without `claudeCode.binaryDigests`.
- 6c52857: Strict binary verification on macOS requires the pinned publisher (macOS gate, research 11).
  
  - `@hudhudjs/core/process`: `PublisherPin.darwinTeamId` (new). The macOS signature check runs `/usr/bin/codesign --verify --strict -R <requirement>`, where the requirement is a Developer ID designated requirement whose leaf organizational unit is the pinned Team ID (`anchor apple generic`, a Developer ID intermediate, a Developer ID Application leaf). A valid signature by another team fails (`codesign failed: exit 3`). Without a Team ID, or with one that is not 10 upper-case letters or digits, the check fails without running codesign, as the Windows check fails without a pinned subject. The verification cache is keyed by the Team ID.
  - `@hudhudjs/claude-code`: `CLAUDE_CODE_PUBLISHER.darwinTeamId` is `Q6L2SF6YDW` (Anthropic PBC, recorded from the signed darwin-arm64 and darwin-x64 binaries of CLI 2.1.296).
- ac1c875: New `isEventType(event, type)` type guard and `HudhudEventOf<T>` type (also on `@hudhudjs/core/protocol`). `HudhudEvent` is an open union, so `switch (event.type)` or `event.type === 'tool.call'` does not narrow an event; `isEventType(event, 'tool.call')` narrows it to the `tool.call` event, and for a type that a later version adds, to the open arm with that `type`. `HudhudEventOf<'tool.call'>` names the event of one type (a union of types gives the union of their events). Additive; nothing else changed.
- f3eac6e: `DiagnosticCode` and the events schema list the two codes the project credential guard already published: `settings-guard.git-root-unresolved` (the git root could not be resolved, so the guard read the cwd and every ancestor) and `settings-guard.symlink-followed` (a settings file is reached through a link). The diagnostics guide documents both, and the security guide documents the ancestor fallback, link handling and the read-failure refusals (`details.problems`).
- 3b3194f: K10: auth fail-fast covers `ANTHROPIC_AUTH_TOKEN` as well as `ANTHROPIC_API_KEY` (lead decision after the recorded `auth-token-source` fixture: a static env credential that got a 401 does not succeed on retry). The CLI reports the token as `account.tokenSource: "ANTHROPIC_AUTH_TOKEN"` with `apiKeySource: "none"`, so `SessionInfoData` and the `session.started` event gain the optional `tokenSource`; fail-fast matches `apiKeySource` or `tokenSource` against `authFailFastSources` (default both env credentials), and the `AUTHENTICATION_FAILED` details name the triggering credential (`credentialSource`). OAuth and `apiKeyHelper` stay excluded because they can refresh.
- 969f751: macOS gate run 1 fixes (research 09).
  
  - `@hudhudjs/core/process`: the macOS `ps` contract is `pid=,ppid=,pgid=,stat=,lstart=,comm=`; `parsePsOutput(output, dialect)` strips exactly the column padding of macOS (`bsd`, `lstart` width 28, the default) or procps (`procps`), so process names no longer carry 4 leading spaces. `ProcessRecord.zombie` marks a zombie (state `Z` from `stat` or `/proc/<pid>/stat`); `planSweep` never signals a zombie by pid (skip reason `zombie`) and still counts it as a verified group member. New type `PsDialect`.
  - `@hudhudjs/core/protocol`: `classifyExit` maps intent `none`, exit code 0 after an error result with no open turn (macOS SIGINT from outside: `result/error_during_execution`, then exit 0) to `unknown` with `PROCESS_EXITED`, as for the Linux SIGINT shape; it was `crashed`.
- 0f009a8: Six more environment variables never reach Claude Code from your process's environment, in either preset (`'harness'` and `'inherit'`). Each loads code or configuration, re-routes traffic or weakens a protection in Claude Code 2.1.302:
  
  - `CLAUDE_CODE_REMOTE`
  - `CLAUDE_CODE_ENVIRONMENT_KIND`
  - `CLAUDE_CODE_REMOTE_MCP_CONFIG`
  - `CLAUDE_CODE_DESKTOP_SKILLS_PLUGIN_DIR`
  - `CLAUDE_CODE_SANDBOX_LEAVE_DENIES_TO_SRT_WIN`
  - `CLAUDE_CODE_CCR_WORKER_SOCKET`
  
  When your environment holds one, it is reported in `env.dropped`. To pass one on, set it with `env.add` or an explicit map; the security posture then lists it in `env.credentialAndRoutingVariables`.
- c289751: Breaking, before the first release (pre-release review R5-4, ADR-0005 §6): every value from a fixed list that hudhud gives applications is now an open enum, so a later minor version can add a value without breaking your code. Newly open, in the types and in `events.schema.json` and `capabilities.schema.json`: `CompatInfo.status`, `session.started`'s `mode`, `turn.started`'s `origin`, the `status` of `tool.call` and `tool.result`, `permission.resolved`'s `behavior` and `by`, `Capability` and `ProcessContainment`; in the types only: `SessionInfo.mode`, `BinaryInfo.source`, `BinaryVerification.status` and `BinaryVerification.method`. Each keeps its known values and also accepts any string (`| (string & {})`). Code that switches over one of them exhaustively needs a `default` branch. Values hudhud emits are unchanged.
- a5696c7: Renamed from `hudhud` to `hudhudjs` (ADR-0004 amendment, 2026-10-16): npm refused the unscoped name `hudhud` as too similar to the existing package `hud-hud`. Install and import it as `hudhudjs`; it re-exports `@hudhudjs/core` and `@hudhudjs/claude-code`. Exported names are unchanged.
- dbbdda5: A turn whose user message the harness drops now fails instead of waiting forever (research 10 §3, lead decision after macOS gate run 2). Claude Code 2.1.296 answers a user message whose `uuid` the session transcript already holds with `command_lifecycle` `completed` and never starts a turn for it. The turn machine correlates `command_lifecycle` frames strictly by the turn's `uuid`, before or after `system/init`, and fails a queued turn that reports `completed` without `started` with the new error code `TURN_DROPPED` (class `TurnDroppedError`, retryable: a new send carries a fresh id; `details.turnId`, `details.lifecycle`) and the new diagnostic `turn.dropped` with the observed states. Every other turn is untouched, and a `result` that arrives first still settles the turn once. Both codes are additive in the errors and events schemas.
- 83115cd: Wave 1 foundations of the harness-neutral core.
  
  - `@hudhudjs/core`: neutral JSON, capability, security-posture and event types; the closed `HudhudErrorCode` table with one `HudhudError` subclass per code and an open `ErrorData` (unknown codes accepted on read, ADR-0005 §6); `SubscriberOptions` and `OverflowPolicy`; redaction (`redactText`, `redactJson`, `secretsFromEnv`, `credentialEnvNames`), the bounded redacted `StderrTail` and usage estimation; `wireSchemaVersion`.
  - `@hudhudjs/core/protocol`: `parseJsonLine` and own-property JSON accessors that keep `__proto__` inert, `encodeJsonLine` with the 32 MiB outbound cap, errors as data (`makeErrorData`, `parseErrorData`, retryability).
  - `@hudhudjs/core/process`: the bounded NDJSON framer (64 MiB default cap, fail-fast oversized lines), `formatFlag` and reserved-flag guard, `resolveExecutable` (refuses `.bat`/`.cmd`), `validateCwd` (Windows 258-unit limit), identity-bound `sha256File`, process-table parsers (Linux `/proc`, macOS `ps`, Windows CIM with start times in microseconds) and termination-ladder types.
  - Committed JSON Schemas (`@hudhudjs/core/schemas/*`) for events, errors, capabilities, posture and conformance fixtures, with precompiled validators and no run-time schema dependency.
  - `hudhudjs` re-exports the new `@hudhudjs/core` root exports.
- 57d4fb0: Wave 2 of the harness-neutral core.
  
  - `@hudhudjs/core/protocol`: the neutral machine contract every harness adapter implements (`HarnessMachine`, clock-stamped `MachineInput` of transport reports and application commands, the `MachineEffect` union and its JSON data shapes); `classifyExit`, the total exit classifier over termination intent and exit observation (never infers success from an exit code; `4294967295` is `unknown`); `sanitizeForDisplay` for untrusted harness text (strips terminal escape sequences, C0/C1 and bidi controls).
  - `@hudhudjs/core/process`: `spawnHarnessProcess` (no shell, explicit environment, serialized backpressured stdin, pulled stdout, redacted stderr tail; the pid plus start-time identity is read in the background, so the spawn resolves as soon as the child runs, and the ladders await it before acting on any pid); `childEnv` and `WIN32_REQUIRED_ENV_NAMES`, so libuv copies no host variable into a Windows child; `DARWIN_CHILD_SET_ENV_NAMES`, the variable a macOS child sets itself (`__CF_USER_TEXT_ENCODING`, CoreFoundation); `osCallsFor`, the OS seam, with the `OsCalls` interfaces; `snapshotDescendants`; the POSIX abort ladder (`runPosixLadder`, K1 signal target) and its `sweep`; the Windows ladder (`runWindowsLadder`, job or best-effort with `taskkill` and an orphan sweep) and the hardened `taskkill` calls; one `LadderClock` for both ladders.
  - `DiagnosticCode` gains the codes of the Claude control, permission and turn machines (`control.*`, `permission.*`, `turn.unmatched-result`); the type and `events.schema.json` stay open.
- edc649b: Wave 3 of the harness-neutral core.
  
  - `@hudhudjs/core/process`: binary verification (K8, K9): `verifyBinary` (`'advisory'` compares the committed digest table only and starts no process; `'strict'` runs the OS signature check first, Authenticode through the in-box PowerShell by absolute path or `/usr/bin/codesign`, and on Windows passes only the pinned publisher subject, `PublisherPin`), the per-Harness `VerificationCache`, `settleProbedVersion`, `recheckBinary` and `assertSpawnable` before every spawn, and `assertSpawnableOrReverify`, which re-resolves and fully re-verifies once when the file was replaced and refuses a second change with `BINARY_VERIFICATION_FAILED`. The K4 version probe `runVersionProbe` runs in a new empty directory of its own under the temp directory, removed afterwards, with a timeout and an output cap (`runBoundedCommand`).
  - `@hudhudjs/core/process`: the Windows job addon loader (`loadJobAddon`, never throws; `arm64` is not first class in v1, K17; sha256 of the addon checked before `dlopen`) and per-session containment (`createSessionContainment`: the job is created and the process assigned before the first write; an assignment failure keeps the session as `'best-effort'` with a `containment.fallback` diagnostic, K2). `@hudhudjs/win32-job-x64` is not a dependency yet: the addon package lands with the addon track.
  - `@hudhudjs/core/process`: `snapshotAtEof` and `sweepAfterExit`, the sweep of the graceful close path: after a normal exit, descendants recorded when stdin was ended that are still the same processes are killed (POSIX `SIGKILL` through the ladder sweep; Windows best effort, one `taskkill /F /PID` each).
  - `@hudhudjs/core`: the neutral security posture builder (`buildPosture`, which computes `deviates` itself, `parsePosture`, `serializePosture`, `postureDeviations`, `postureEntry`).
  - `@hudhudjs/core/protocol`: the machine effect `send.rejected` (a send refused for its turn id, bound to that command, never ending a live turn; the binding passes a fresh UUID per send). `DiagnosticCode` gains `stdin.error` and `permission.duplicate-request-id`.
- 0f4bd1e: Wave 4 of the harness-neutral core.
  
  - `@hudhudjs/core`: the generic, harness-neutral binding layer (W4-T1). The root gains the public handle types `Session`, `Turn`, `Harness`, `SessionInfo`, `BinaryInfo`, `BinaryVerification`, `VerificationMode`, `UserInput`, `UserContentBlock` and the permission types `PermissionRequest`, `PermissionDecision`, `PermissionHandler`, plus `defineAdapter` and `AdapterDefinition` (beta), which refuse an unsupported `adapterApiVersion` at definition time. Behind them: a session driver that runs any neutral machine over a transport (one input at a time; stdout always read; `ask()` and `turn.done` never wait on a subscriber; only a `'block'` subscriber can hold input, and abort or dispose cut through it), a permission bridge (one `AbortSignal` per request, strict copy of the decision; a missing, failing or invalid handler is answered with the new contract input `cmd.permission-error` and a fixed reason, so the machine fails closed with its own answer, never an allow), the process transport (graceful close: snapshot, then EOF, then the sweep after the exit; the platform ladders on abort), the loopback binding with its JSON round-trip check, manual and system clocks, and a single host-exit hook (no signal handlers, K22). New diagnostic codes `stdout.error`, `termination.ladder`, `termination.sweep-after-exit` and `binding.machine-error` (additive in the events schema). The `session.terminated` event documents that `intent` and `outcome` are deterministic while `exitCode` and `signal` are raw observations: decide on `outcome`.
  - `@hudhudjs/core/binding` (new entry point, beta, for adapter authors): the session driver (`SessionDriver`, `openSession`), the process transport (`createProcessTransport`) and the loopback binding (`createLoopbackDriver`, `LoopbackTransport`, `loopbackMachine`), the clocks and id sources (`systemClock`, `ManualClock`, `cryptoIds`, `counterIds`), the host-exit hook, `createSession`, `HarnessBase` and `normalizeUserInput`, plus type-only re-exports of the process and protocol types they name. Applications keep using the root entry.
  - `@hudhudjs/core/protocol`: the neutral machine contract gains the command input `cmd.permission-error` (`requestId`, `reason`: `PermissionErrorReason`, one of `no-handler`, `handler-failed`, `invalid-decision`, never handler text). A machine must answer it fail-closed: its step resolves the ask as a deny, never an allow (a contract invariant).
  - `@hudhudjs/core`: error code `HARNESS_VERSION_KNOWN_BROKEN` (class `HarnessVersionKnownBrokenError`, not retryable; `details.version`, `details.reason`), additive in the errors schema. An adapter refuses a harness version its tested window lists as known-broken with it, unless the application opts in (Claude Code: `claudeCode.dangerouslyAllowKnownBrokenVersion`, wired in Wave 5); an untested version stays a warning (ADR-0004 §4 amendment).
- 9c35bc5: The umbrella re-exports `@hudhudjs/claude-code` (`connect`, `session`, `hudhud`, `CLAUDE_CODE_COMPAT` and the option types) next to `@hudhudjs/core`. The unstable `raw` tier and the adapter-author entry points stay out of it.
- bbd4ed9: Wave 6 (integration against the pinned CLI).
  
  - `isHudhudError(value, code?)`: the optional `code` narrows to a hudhud error with that code (plan §2.2), for example `isHudhudError(error, 'SESSION_NOT_FOUND')`. Without it the function is unchanged.
  - Fix: the POSIX abort ladder reported a process it had ended with `SIGKILL` as never exited (`exitedAfter: null` in the `termination.ladder` diagnostic) whenever Node had not yet reaped the child when the report was built (seen on Node 26). After the `SIGKILL` the ladder now waits for the exit, at most `termGraceMs`, and reports `exitedAfter: 'sweep'` (or `'sigkill'` without a verified identity); `null` again means the process did not exit within that wait.
- 7fcc03d: The child environment follows the rule for Claude Code 2.1.310's new variables. `CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT` (turns off a permission prompt) and `CLAUDE_CODE_DISABLE_ULTRAREVIEW_TRUST_CHECK` (skips a workspace trust check) are never inherited by either preset: a value in your process's environment is dropped and reported in `env.dropped`, and `env.add` or an explicit map still passes it, listed in the security posture. `CLAUDE_CODE_SDK_READS_STARTUP_MARKS`, an Agent SDK switch that makes Claude Code write extra lines before its handshake, is always removed, like `CLAUDE_CODE_SDK_READS_SESSION_STATE`, and an `env` option that names it is refused with `INVALID_OPTIONS`.
- a79d942: `tool.call` events of Claude Code's `Monitor` tool, which Claude Code 2.1.310 turns on by default, now carry `kind: 'execute'` instead of `'other'`: `Monitor` starts a command in the background and reports each line it prints, as a Bash call with `run_in_background` does. The Events guide now lists which Claude Code tools map to which kind and the rule behind it (a tool gets the kind of its effect on your machine; tools whose effect stays inside Claude Code are `'other'`).
- 0d38796: The tested window of the Claude Code adapter now reaches 2.1.310: `CLAUDE_CODE_COMPAT` is `minTested: '2.1.296'`, `maxTested: '2.1.310'`, and every release in between (2.1.299 to 2.1.309) was tested too. The committed digest table holds the official binaries of 2.1.303 to 2.1.310 on linux-x64, win32-x64, darwin-arm64 and darwin-x64, each checked against the npm integrity and the Agent SDK `manifest.json` of the same CLI release, so `binary.verification` is `'verified'` for them without `claudeCode.binaryDigests`. Claude Code changes inside the window that sessions can notice, none of which changes hudhud's API, permissions, interrupt or containment: from 2.1.304 tool search is on behind a custom `ANTHROPIC_BASE_URL` (deferred tools are loaded through `ToolSearch`; tools removed with `disallowedTools` stay out; `ENABLE_TOOL_SEARCH=false` through `env` turns it off), and from 2.1.310 the `Monitor` tool is on by default (its background process holds `close()` like a background shell) and the Bash tool refuses a foreground command that starts with a `sleep` of 25 seconds or more. See the Compatibility guide.

### Patch Changes

- 6dc860a: Every option and every public member of the stable entry points now has documentation in the types, so editor hover shows its meaning, default, units and limits (pre-release review R5-8): for example that `SessionOptions.signal` covers only the start of a session, that `closeTimeoutMs` runs from the `close()` call, and the range of every size and duration option. The types themselves are unchanged.
- 67ee66a: `isHudhudError` now recognizes errors from another copy of `@hudhudjs/core` in the same process (pre-release review R5-3). Every hudhud error carries a hidden brand from the global symbol registry (`Symbol.for('hudhudjs.error')`), and `isHudhudError(value, code?)` accepts either an `instanceof` match or a branded error whose `code` this version knows. Before, it used `instanceof` only, so when a dependency installed a second copy of the core, every error from that copy failed the check, and code-based handling such as retry loops stopped working.
- 420e443: Every package now ships the repository's `NOTICE` file next to its `LICENSE` (Apache-2.0 §4(d)). No code changed.
- 6833599: Every published package's `package.json` now names its source: `repository` (this repository and the package's directory), `homepage` and `bugs`. npm trusted publishing requires `repository.url` to match the repository the package is published from. No code changed.
- 1a8c8cf: Redaction no longer leaves part of a credential readable when a known secret sits inside it. Every rule of `redactText`, `redactJson` and the stderr tail now matches on the original text and the union of all matches is masked at once, each run of overlapping or adjacent matches by one `<redacted>`. Before, known secrets were masked first and the shape rules stopped at the inserted marker, so the rest of an `sk-ant-` key, a `Bearer` token, a `name=value` value or a URL userinfo around a known secret stayed readable (found by the `StderrTail` property test).
- 2aba9a4: The schemas now import by their file names, as documented (pre-release review R5-6): `@hudhudjs/core/schemas/events.schema.json` and `@hudhudjs/claude-code/schemas/options.schema.json` resolve to those files. Before, the `exports` map added `.json` to every specifier, so the `.json` form looked for `events.schema.json.json` and failed with `ERR_MODULE_NOT_FOUND`. The form without `.json` still works. Import a schema with the attribute `{ type: 'json' }`.
- 1c8fcf7: `NOTICE` now says that a package lists its third-party code after the repository's notice. `@hudhudjs/claude-code` lists the MIT-licensed code its generated validators include (Ajv's runtime helpers and fast-deep-equal), with their license texts. No code changed.
- Updated dependencies [ecb0bfe]
- Updated dependencies [c42acf0]
- Updated dependencies [313366c]
- Updated dependencies [6dc860a]
- Updated dependencies [662086f]
- Updated dependencies [603845c]
- Updated dependencies [0f4eed6]
- Updated dependencies [7e6cd2a]
- Updated dependencies [2b5620f]
- Updated dependencies [a99a908]
- Updated dependencies [73835c0]
- Updated dependencies [e4f9fe6]
- Updated dependencies [19ef5d6]
- Updated dependencies [6c52857]
- Updated dependencies [ac03c87]
- Updated dependencies [ac1c875]
- Updated dependencies [c63d27f]
- Updated dependencies [f3eac6e]
- Updated dependencies [c965807]
- Updated dependencies [7d01f08]
- Updated dependencies [967da52]
- Updated dependencies [a91a3d0]
- Updated dependencies [70dbfdd]
- Updated dependencies [67ee66a]
- Updated dependencies [3b3194f]
- Updated dependencies [969f751]
- Updated dependencies [0f009a8]
- Updated dependencies [420e443]
- Updated dependencies [c289751]
- Updated dependencies [6833599]
- Updated dependencies [f58ea1e]
- Updated dependencies [66f6b43]
- Updated dependencies [1a8c8cf]
- Updated dependencies [a5696c7]
- Updated dependencies [a5696c7]
- Updated dependencies [4b8c497]
- Updated dependencies [966c2dd]
- Updated dependencies [bafa718]
- Updated dependencies [011f035]
- Updated dependencies [88ef13b]
- Updated dependencies [645d5ec]
- Updated dependencies [f9cd970]
- Updated dependencies [be3d47f]
- Updated dependencies [2aba9a4]
- Updated dependencies [418134e]
- Updated dependencies [1c8fcf7]
- Updated dependencies [134b91e]
- Updated dependencies [dbbdda5]
- Updated dependencies [8cdccc4]
- Updated dependencies [83115cd]
- Updated dependencies [83115cd]
- Updated dependencies [57d4fb0]
- Updated dependencies [57d4fb0]
- Updated dependencies [edc649b]
- Updated dependencies [edc649b]
- Updated dependencies [0f4bd1e]
- Updated dependencies [0f4bd1e]
- Updated dependencies [bf49874]
- Updated dependencies [23fcb97]
- Updated dependencies [bbd4ed9]
  - @hudhudjs/core@0.1.0
  - @hudhudjs/claude-code@0.1.0
