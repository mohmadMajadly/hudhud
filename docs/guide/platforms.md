# Platforms

## Support matrix

hudhud is tested end to end, against the real Claude Code 2.1.296 in a sandbox, on Windows x64, Linux x64 and macOS arm64. The table states what holds today.

| Platform      | Status                                                                                  | Process containment                          | Binary digest in the committed table |
| ------------- | --------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------ |
| Windows x64   | Supported and tested                                                                    | `'job'` with the addon, else `'best-effort'` | yes                                  |
| Linux x64     | Supported and tested                                                                    | `'best-effort'`                              | yes                                  |
| Windows arm64 | Not tested on arm64 hardware; the job addon is not shipped for it                       | `'best-effort'`                              | no                                   |
| Linux arm64   | Not tested                                                                              | `'best-effort'`                              | no                                   |
| macOS arm64   | Supported and tested ([below](#macos))                                                  | `'best-effort'`                              | yes                                  |
| macOS x64     | Supported: the macOS gate passed; the integration suites run on arm64 ([below](#macos)) | `'best-effort'`                              | yes                                  |

Without a digest in the committed table, `binary.verification.status` is `'unverified'` in the default advisory mode, and `binaryVerification: 'strict'` refuses the binary unless you supply its digest with `claudeCode.binaryDigests` ([Binary verification](security.md#binary-verification)).

Node.js 22.12.0 or newer is required on every platform. CI runs the unit, conformance and integration tests on Node 22, 24 and 26 on Linux and on Node 22 on Windows x64 and macOS arm64.

## Process containment

Claude Code runs tools as child processes: shells, their commands, MCP servers. Containment is about what happens to those descendants when a session ends. The Harness reports what it can provide in `capabilities.processContainment` (with the reason in `capabilities.reasons.processContainment` when it is `'best-effort'`), and each session reports what it got in `session.info.containment` ([ADR-0009](../adr/0009-process-layer-windows.md), [ADR-0010](../adr/0010-process-layer-posix.md)).

| Value           | Where                                 | Guarantee                                                                                                                                                                                 |
| --------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'job'`         | Windows x64 with the job addon loaded | Claude Code and every descendant run in a Windows job object owned by your process. Ending the session ends the whole tree; if your process dies, the operating system ends the tree too. |
| `'best-effort'` | Every other platform                  | hudhud records the descendants and ends them, checking each process's identity first. Gaps are listed below.                                                                              |
| `'cgroup'`      | Not offered in v1                     | Reserved for a Linux cgroup mode.                                                                                                                                                         |

Measured gaps of `'best-effort'`:

- **Windows:** commands that a Bash tool starts through Git Bash run with a parent process that has already exited, so no process-tree walk reaches them. Such a command can outlive the session, up to its own duration, after an abort, a close or a crash of your process. Only `'job'` closes this gap ([ADR-0009](../adr/0009-process-layer-windows.md#termination-ladder-abort-path)).
- **Linux:** when your process dies, Claude Code sees the end of its input and finishes the tool or reply in flight, then exits without leaving processes behind; a long tool keeps running until it ends by itself. Descendants survive only if Claude Code itself is killed with `SIGKILL` and the sweep cannot run. A process that a tool started after the end of input and that was re-parented away from the tree cannot be identified safely and is not ended ([ADR-0010](../adr/0010-process-layer-posix.md#drain-path)).
- **macOS:** the same mechanism as Linux. The macOS gate saw `SIGTERM` end the tool process groups and `SIGKILL` plus the sweep leave nothing, and the containment suites (orphan, host crash, termination ladder) pass on macOS arm64.

hudhud never signals your own process group and never uses process-group kills on Claude Code's group, so it cannot hit your application's processes.

## Windows

### The job addon

`@hudhudjs/win32-job-x64` contains a small native Node-API addon, written in C, that creates the job object. `@hudhudjs/core` lists it as an optional dependency, so npm installs it on Windows x64 only; you never import it. Before loading it, the core checks that the file's SHA-256 and the addon's version equal the table shipped with that exact core version. If the package is missing (for example after `npm install --omit=optional`) or any check fails, the core uses `'best-effort'` and says why in `capabilities.reasons.processContainment`: `package-missing`, `digest-mismatch`, `dlopen-failed`, `abi-mismatch`, `arm64-not-first-class` or `unsupported-arch`. The addon is linked against the static Visual C++ runtime, so no Visual C++ redistributable is needed.

If assigning a session's process to its job fails, the session continues with `'best-effort'` and publishes a `containment.fallback` diagnostic.

Contributors who build hudhud from source need Visual Studio Build Tools and CMake to build the addon; see [CONTRIBUTING.md](../../CONTRIBUTING.md#the-job-object-addon-on-windows). Applications that install the packages from npm need no compiler.

### Long working directories

Claude Code cannot start in a directory whose path is 259 UTF-16 code units or longer: the spawn fails with a misleading "not found" error, and the `\\?\` long-path prefix makes Claude Code run under the 8.3 short name, which splits transcripts. hudhud checks the resolved path before start and fails with `CWD_TOO_LONG` instead. Use a shorter path, or a `subst` drive or a directory junction with a shorter path, and use it consistently: when you pass the shorter alias as `cwd`, hudhud checks that it is the same directory and uses it ([ADR-0011](../adr/0011-spawn-hygiene-and-binary-provenance.md#spawn-a14)).

### Executables

On Windows, hudhud only starts a real `claude.exe`. A path that contains a `.cmd` or `.bat` file is refused with `BINARY_REFUSED`, and no shell is ever used, because batch files reopen command injection (CVE-2024-27980).

## macOS

The macOS gate, a series of checks against the real Claude Code on macOS (binary provenance, signals and the process tree, the keychain, a hanging login shell, the socket path, resume, the architecture), passed on macOS arm64 and x64 ([research 11](../research/11-macos-gate-run3.md), [ADR-0010](../adr/0010-process-layer-posix.md), [ADR-0014](../adr/0014-ci-strategy.md)). Since then:

- CI runs the integration tests against the real Claude Code on macOS arm64 as on Linux and Windows; macOS x64 is covered by the gate's checks, not by the integration suites;
- the macOS digests of the tested Claude Code build are in the committed table, and strict mode's `codesign` check requires a Developer ID signature of Anthropic's Team ID;
- Claude Code reads the login keychain on macOS ([Security](security.md#macos-keychain)).

## Signals and the host process

hudhud installs no signal handlers. A terminal Ctrl+C reaches Claude Code as well and ends the session with outcome `'unknown'` (`PROCESS_EXITED`). See [Sessions](sessions.md#when-the-host-process-exits-or-is-interrupted).
