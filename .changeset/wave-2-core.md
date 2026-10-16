---
'@hudhudjs/core': minor
'hudhudjs': minor
---

Wave 2 of the harness-neutral core.

- `@hudhudjs/core/protocol`: the neutral machine contract every harness adapter implements (`HarnessMachine`, clock-stamped `MachineInput` of transport reports and application commands, the `MachineEffect` union and its JSON data shapes); `classifyExit`, the total exit classifier over termination intent and exit observation (never infers success from an exit code; `4294967295` is `unknown`); `sanitizeForDisplay` for untrusted harness text (strips terminal escape sequences, C0/C1 and bidi controls).
- `@hudhudjs/core/process`: `spawnHarnessProcess` (no shell, explicit environment, serialized backpressured stdin, pulled stdout, redacted stderr tail; the pid plus start-time identity is read in the background, so the spawn resolves as soon as the child runs, and the ladders await it before acting on any pid); `childEnv` and `WIN32_REQUIRED_ENV_NAMES`, so libuv copies no host variable into a Windows child; `DARWIN_CHILD_SET_ENV_NAMES`, the variable a macOS child sets itself (`__CF_USER_TEXT_ENCODING`, CoreFoundation); `osCallsFor`, the OS seam, with the `OsCalls` interfaces; `snapshotDescendants`; the POSIX abort ladder (`runPosixLadder`, K1 signal target) and its `sweep`; the Windows ladder (`runWindowsLadder`, job or best-effort with `taskkill` and an orphan sweep) and the hardened `taskkill` calls; one `LadderClock` for both ladders.
- `DiagnosticCode` gains the codes of the Claude control, permission and turn machines (`control.*`, `permission.*`, `turn.unmatched-result`); the type and `events.schema.json` stay open.
