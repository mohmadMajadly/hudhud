# ADR-0009: Process layer on Windows (job object, native addon, fallback)

- Status: Accepted — pending addon implementation (the addon is a 1.0 criterion and ships in v1 only if its spike is green; otherwise v1 ships with `processContainment: 'best-effort'`). The host-crash spike (07 §2) reinforces it.
- Date: 2026-10-12
- Negotiation log items: A13, B1 (round 3), D6, D7, C1 (06 §A, §B, §C, §D)
- Related: [ADR-0008](0008-turn-and-lifecycle-semantics.md), [ADR-0010](0010-process-layer-posix.md), [ADR-0011](0011-spawn-hygiene-and-binary-provenance.md), [ADR-0004](0004-packages-and-versioning.md)

## Context

Measured on Windows with CLI 2.1.296 (05 §10):

- `TerminateProcess(claude.exe)` orphans the Git-Bash tool tree (`bash.exe`, `bash.exe`, `conhost.exe`): 4 of 4 runs in the log's summary (D7); 05 §10 lists runs 60, 64, 70, 72. Graceful EOF leaves no orphans because the CLI waits for the tool. A PowerShell tool child did not survive.
- Spawned normally (not detached, so already inside libuv's global job) and then assigned to a second job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: nesting works, the CLI behaves normally, grandchildren inherit the job (no breakaway), and closing the job kills everything.
- Closing the job produces Node exit code 0, so exit 0 does not prove success (05 §9).
- There is an assignment race window between spawn and assign (about 1 s measured, before any tool ran; 05 §10).
- The host-crash case: a job handle owned by the host dies with the host, so the tree dies too. Measured (07 §2, J8): under a Node host on Windows, libuv's own job kills the CLI about 32-35 ms after the host dies (exit code 0, no graceful shutdown, stale `sessions/<pid>.json`), but its Git-Bash tool tree (`bash.exe`, `conhost.exe`) survives, because the grandchildren are not in libuv's job. A detached Windows host and Linux behave differently: the CLI sees stdin EOF and drains gracefully, with no orphans.
- The TS SDK's own close uses `TerminateProcess` on the direct child only; its parent-exit reaper on Windows only ends stdin (02 §6.3).

Node has no built-in API for job objects, so native code is required for containment.

## Decision

### Spawn

`child_process.spawn` with `shell: false`, `windowsHide: true`, not detached (C1 resolved: no `detached` needed). Argv in `--flag=value` form ([ADR-0011](0011-spawn-hygiene-and-binary-provenance.md)).

### Containment

1. After spawn, assign the child to a new job object created with `KILL_ON_JOB_CLOSE`, owned by the host process. The assignment happens before the first stdin write (closing the race window of D7).
2. The addon is `@hudhud/win32-job-x64` / `@hudhud/win32-job-arm64`, optional platform packages ([ADR-0004](0004-packages-and-versioning.md)).
3. Capability `processContainment` is `'job'` when the addon is present and assignment succeeded, otherwise `'best-effort'`. This capability exists from v1.
4. The job is required for host-crash cleanup as well as for abort (J8, 07 §2): libuv's job kills the CLI but lets the tool tree break away, so only hudhud's own nested `KILL_ON_JOB_CLOSE` job, which grandchildren inherit, makes host death kill the whole tree. This reinforces the addon as the 1.0 criterion. Not verified: a Windows host that is not Node/libuv (Python, Bun, .NET).

### Native addon toolchain (B1 = option ii)

Plain C against `node_api.h` (N-API), built with CMake and MSVC for x64 and ARM64, prebuilt-only (no compiler on the consumer's machine), published with npm provenance. About 150 lines of Win32 handle code; the decisive criteria were auditability and the build-toolchain supply chain.

A sha256 check of the addon binary before `dlopen` is documented as defence in depth only. The real guarantees are npm integrity plus provenance.

### Termination ladder (abort path)

1. `interrupt` control request (with `cancel_queued: true`);
2. stdin EOF;
3. `TerminateJobObject` (kills the CLI and all descendants).

Best-effort fallback when no job is available:

1. `interrupt`;
2. EOF;
3. `taskkill /T /F` invoked by absolute `System32` path with `shell: false`;
4. `TerminateProcess`.

Initial, tunable values (lead decision, to be validated by measurement): wait up to 1 s for the `interrupt` response, then EOF, then a 2 s grace, then `TerminateJobObject`; in the best-effort fallback, `taskkill /T /F`, then after 2 s `TerminateProcess`. (The POSIX values, 2 s after EOF then 5 s, are in [ADR-0010](0010-process-layer-posix.md).) `TerminateJobObject` and `TerminateProcess` bypass the CLI's own cleanup, so they are the last step; the drain path ([ADR-0008](0008-turn-and-lifecycle-semantics.md)) never uses them.

All termination records its termination intent first, because a job close surfaces as exit code 0.

## Alternatives considered

- napi-rs (Rust) (B1 option i). Rejected: pulls in a Rust toolchain and a large dependency tree for about 150 lines of Win32 calls; weaker auditability and build supply chain than plain C.
- C++17 with node-addon-api (B1 option iii). Rejected: the C++ wrapper and CMake/MSVC C++ toolchain add surface where plain C against `node_api.h` suffices. The lead initially leaned to (ii) or (iii); round 3 settled on (ii).
- koffi (runtime FFI). Rejected (Fable, round 1): it imports a general "call any C function from JS" capability into a security library for three Win32 calls, and is itself a prebuilt binary we did not build.
- A signed helper executable. Rejected (Fable, round 1): code-signing cost; unsigned executables in `node_modules` trip SmartScreen and EDR more than `.node` files do; it has the same assignment race as the addon plus an extra process hop.
- PowerShell `Add-Type` helper (used in the spike, `job-helper.ps1`, 05 §10). Not suitable for production [derived]: starts a PowerShell process and compiles C# at run time.
- Detached spawn. Rejected: not needed (C1); nesting under libuv's job works.
- `taskkill /T` as the primary mechanism. Rejected: walks the tree after the fact and is racy; kept only as fallback.
- `TerminateProcess` only. Rejected: orphans the tool tree (D7).
- No containment on Windows. Rejected (R6, security): orphaned shells outlive the host.

## Consequences

- Windows CI is mandatory ([ADR-0013](0013-testing-strategy.md), [ADR-0014](0014-ci-strategy.md)); the addon needs MSVC x64 and ARM64 build jobs.
- Spike status: most of the job-object spike is done by 05 §10 (nesting under libuv's job works, grandchildren inherit the job, job close kills all, assign before the first stdin write). Remaining: addon implementation and the arm64 prebuild pipeline. If that work is not green by 1.0, v1 ships `'best-effort'` and the addon becomes v1.x.
- Open observation: in a job, `TerminateProcess(claude.exe)` alone also killed the Git-Bash tree 3 of 3 times (05 §10); the mechanism is unverified. hudhud does not rely on it.
- Assignment must precede any user data on stdin. A crash between spawn and assignment leaves an uncontained child for a very short window; this residual is documented.

## Evidence

- 05 §10 (Windows process tree table, job helper), §9 (exit codes), §15 item 4-5.
- 07 §2 (host crash: job-kill timing, orphaned Git-Bash tree, detached and Linux rows); 06 §J8.
- 02 §6.3 (SDK close ladder, reaper), §10 item 8 (tree cleanup gap).
- 01 §7 (Windows specifics; stdio MCP servers on Windows are killed by tree after 300 ms in 2.1.296).
