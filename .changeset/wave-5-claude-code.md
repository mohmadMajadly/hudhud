---
'@hudhudjs/claude-code': minor
---

The Claude Code adapter assembly (Wave 5), now the public API of the package root and of `/raw`.

- `connect`, `session`, `hudhud` and the `ClaudeCodeHarness` (`sessions.create`, `sessions.resume`): validation, the project credential guard, the cwd, discovery, verification with the pinned publisher, exactly one `--version` probe per connect, the version policy, the security posture and the capabilities; per session the spawn gate (a changed binary is verified and probed again before it runs), the registry claim, the spawn with the job assignment inside it, and the session driver with the Claude session machine, the user-input encoder and the sweep after a graceful close. Every failure maps to its public error class; nothing is left running when a call rejects.
- Version policy: every known-broken listing carries a committed reason (`details.reason`); a known-broken probed version is refused with `HARNESS_VERSION_KNOWN_BROKEN` unless `claudeCode.dangerouslyAllowKnownBrokenVersion: true` (new option, listed in `securityPosture`); a session whose harness drifted to a known-broken version fails closed, and every drift emits `binary.version-changed`.
- Under `projectCredentialEnv: 'allow'` the guard's scan still runs (`scanProjectSettings`): its findings feed `managedPolicy` and the diagnostic `settings-guard.allowed`.
- Public API (W5-Z). The root exports `connect`, `session`, `hudhud`, `CLAUDE_CODE_COMPAT` and the types `ClaudeCodeHarness`, `ConnectOptions`, `ClaudeCodeConnectOptions`, `SessionOptions`, `ClaudeCodeSessionOptions`, `ResumeOptions`, `PermissionMode`, `WorkspaceTrust`, `SettingSource` and `EnvOption`; `/raw` exports `raw`, `createSessionRaw` and the types `RawSession`, `RawSpawnOptions`, `RawFrame`, `RawWireFrame` and `RawGap`, with type-only re-exports of the root types its signatures name. `SessionOptions.onPermission` is typed with the core `PermissionHandler`.
- The raw tier: `raw(session)` (frames in both directions; raw control requests and frames only with `claudeCode.dangerouslyAllowRawControl`) and `createSessionRaw` (spawn extras without the reserved flags or pinned variables).
