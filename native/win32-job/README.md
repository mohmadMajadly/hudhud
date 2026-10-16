# Windows job-object addon

`hudhud_win32_job.node` is a Node-API addon in plain C. It puts a spawned harness process and all of its descendants into a Windows job object owned by the host process. Closing or terminating the job ends the whole tree, and the tree also ends when the host dies ([ADR-0009](../../docs/adr/0009-process-layer-windows.md), [plan §6.1](../../docs/plan/v1-implementation.md#61-a1-c-source-scope)).

The addon is never loaded directly. `@hudhudjs/core` loads it through `loadJobAddon` (`packages/core/src/process/containment/win32-job.ts`), which first checks its sha256 and `version` and validates every result. When the addon is missing or refused, the core falls back to `'best-effort'` containment.

## API

Plain C on `node_api.h` with `NAPI_VERSION 8`. Every function takes exactly the listed arguments.

| Export                        | Win32 calls                                                                                                                                                                     | Contract                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createJob()`                 | `CreateJobObjectW(NULL, NULL)`, `SetInformationJobObject(JobObjectExtendedLimitInformation)`                                                                                    | Returns an external, type-tagged as a job of this addon. Only `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is set (no breakaway). The handle is not inheritable. The finalizer closes the handle if `closeJob` did not.                                                                                                                                                                               |
| `assignProcess(job, pid)`     | `GetCurrentProcessId`, `OpenProcess(PROCESS_SET_QUOTA \| PROCESS_TERMINATE \| PROCESS_QUERY_LIMITED_INFORMATION)`, `GetProcessTimes`, `AssignProcessToJobObject`, `CloseHandle` | Returns `{ creationTime }`: the FILETIME creation time as a decimal string in 100 ns units. The time is read through the same handle that is assigned. Call it only while you hold the child's own handle, so the pid cannot be reused. The host's own pid is refused with `ERR_SELF_ASSIGN` before any handle is opened: in its own `KILL_ON_JOB_CLOSE` job the host would die with the job. |
| `terminateJob(job, exitCode)` | `TerminateJobObject`                                                                                                                                                            | Idempotent while the job is open. `exitCode` is an integer in [0, 2^32 - 1].                                                                                                                                                                                                                                                                                                                  |
| `closeJob(job)`               | `CloseHandle`                                                                                                                                                                   | Idempotent. Every process still in the job ends (`KILL_ON_JOB_CLOSE`). A failed close is never retried. Any later call with the job throws `ERR_JOB_CLOSED`.                                                                                                                                                                                                                                  |
| `listPids(job)`               | `QueryInformationJobObject(JobObjectBasicProcessIdList)`                                                                                                                        | Returns the job's pids. The buffer holds at most 65536 entries; a larger job fails with `WIN32_234` (`ERROR_MORE_DATA`).                                                                                                                                                                                                                                                                      |
| `processTimes(pid)`           | `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`, `GetProcessTimes`, `CloseHandle`                                                                                              | Returns `{ creationTime }`, with the same shape and unit as `assignProcess`.                                                                                                                                                                                                                                                                                                                  |
| `version`                     | none                                                                                                                                                                            | The ABI version string (`0.1.0`), checked by the loader against the shipped digest table.                                                                                                                                                                                                                                                                                                     |

Errors are JavaScript errors with a `code`:

| Code                                                                         | When                                                                                                                                     |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `WIN32_<n>`                                                                  | A Win32 call failed. `<n>` is `GetLastError()` and the message names the API, for example `OpenProcess failed: WIN32_5`.                 |
| `ERR_JOB_CLOSED`                                                             | The job was closed.                                                                                                                      |
| `ERR_SELF_ASSIGN`                                                            | `assignProcess` was given the host's own pid.                                                                                            |
| `ERR_INVALID_ARG_COUNT`, `ERR_INVALID_ARG_TYPE`, `ERR_INVALID_ARG_VALUE`     | Wrong argument count; not a job external of this addon, or not a number; a pid outside [1, 2^32 - 1], or a value that is not an integer. |
| `ERR_JOB_ADDON_OUTPUT`, `ERR_JOB_NO_MEMORY`, `ERR_JOB_NAPI`, `ERR_JOB_ADDON` | The system returned an impossible pid list; out of memory; a Node-API call failed; formatting failed.                                    |

## Build

Requirements (Windows only; `pnpm addon:stage` runs the build before Windows checks, see CONTRIBUTING):

- Visual Studio 2022 (17.x) or 2026 (18.x), or their Build Tools, with these components:
  - `Microsoft.VisualStudio.Component.VC.Tools.x86.x64`, the MSVC x64 tools;
  - `Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre`, the Spectre-mitigated libraries that `/Qspectre` links against;
  - a Windows 10 or 11 SDK;
  - for ARM64, also `Microsoft.VisualStudio.Component.VC.Tools.ARM64` and `Microsoft.VisualStudio.Component.VC.Runtimes.ARM64.Spectre`.
- CMake 3.28 or newer.
- `pnpm install`. The headers and `node_api.def` come from the pinned `node-api-headers` package; nothing is downloaded.

```sh
node native/win32-job/build.mjs --arch x64
node native/win32-job/build.mjs --arch arm64
node native/win32-job/build.mjs --arch x64 --toolset-of-record
```

`build.mjs` deletes and recreates `native/win32-job/build/<arch>` (gitignored). It then configures that directory with CMake's Visual Studio generator and builds Release with MSBuild warnings as errors. The generator follows the Visual Studio instance: `Visual Studio 17 2022` for 17.x, `Visual Studio 18 2026` for 18.x; any other version is refused. Finally it writes `build/<arch>/toolchain.json` and prints it with the path and sha256 of `build/<arch>/Release/hudhud_win32_job.node`. Add `--build-dir <name>` to use `build/<name>` instead, for example to compare two builds.

`toolchain.json` records what changes the bytes: `arch`, `generator`, `vcToolsVersion` (the MSVC toolset), `clVersion`, `windowsSdkVersion` (the static `/MT` runtime takes the UCRT from the SDK), `cmakeVersion` and `nodeApiHeadersVersion`.

Without `--toolset-of-record` the build uses the instance's default MSVC toolset and the newest Windows SDK, so its bytes depend on the machine. With it, the build pins the MSVC toolset and Windows SDK of the release record that the committed digest table was written from (`-T v143,version=<vcToolsVersion>`, `-DCMAKE_SYSTEM_VERSION=<windowsSdkVersion>`). If that toolset, its Spectre libraries or that SDK is not installed, the build fails and names the Visual Studio component ids to install, for example `Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64` and `Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64.Spectre`. Releases use it (plan §6.3).

Tool lookup:

- CMake is the first `cmake.exe` in an absolute `PATH` entry, or the absolute path in `HUDHUD_CMAKE`.
- Visual Studio is found with `vswhere`.
- If a required component is missing, the build fails and names it. Nothing is ever installed.

The build is reproducible: two builds of the same source with the same toolchain give the same sha256.

Compiler flags:

- C17, `/W4 /WX /sdl /guard:cf /Qspectre /analyze /Brepro /Zi /utf-8`;
- the static runtime (`/MT`), so no Visual C++ redistributable is needed.

Linker flags:

- `/WX /DYNAMICBASE /HIGHENTROPYVA /NXCOMPAT /guard:cf /Brepro /DEBUG /OPT:REF /OPT:ICF /INCREMENTAL:NO /MANIFEST:NO`;
- `/CETCOMPAT` on x64;
- `/PDBALTPATH:hudhud_win32_job.pdb`, the same value `%_PDB%` gives;
- `/DELAYLOAD:node.exe`.

The import library for `node.exe` is generated from `node_api.def` with `lib /def`.

## Release record, digest table and staging

The core loads the addon only when its sha256 and `version` equal the committed digest table, `packages/core/src/process/containment/win32-job-digests.ts`. The table has one source: a release record, `release/<release>/` here, which holds `manifest.json` (the addon `version`, and per architecture the `sha256`, `size` and `toolchain`), and the derived `SHA256SUMS` and `toolchain.json`. Only this command writes the table, never a build:

```sh
node scripts/addon/write-digests.mjs --from-manifest native/win32-job/release/0.0.0-dev/manifest.json
```

`release/0.0.0-dev/` is the local build of record until the first release (plan §6.1: x64 `fbe7d9ad…69b0`, ARM64 `a38a74a0…4206`, Build Tools 17.14 with MSVC 14.44.35207, SDK 10.0.26100.0, CMake 4.4.4). Plan §6.3 describes how a release record is made.

Staging copies a build into its platform package for the tests, and never touches the table:

```sh
node scripts/addon/write-digests.mjs --stage --arch x64
node scripts/addon/write-digests.mjs --stage --arch arm64 --version 0.1.0
node scripts/addon/write-digests.mjs --stage --arch x64 --addon <file> --toolchain <toolchain.json>
```

It reads `build/<arch>/Release/hudhud_win32_job.node` and the `toolchain.json` next to it, or the files given with `--addon` and `--toolchain` (a CI artifact, for example). It refuses a file that is not a PE image of the requested architecture. It reads `version` by loading the addon when the host is Windows with the same architecture, and otherwise takes it from `--version`. If `--version` is given on such a host as well, the two must match. It then writes the exact bytes it read, a `SHA256SUMS` for them and the `toolchain.json` into `packages/win32-job-<arch>/`, all gitignored.

The Windows test suites load the staged addon with the digest from its `SHA256SUMS`, after checking that it names the staged bytes. The committed table must equal the staged addon only when the staged `toolchain.json` equals the record's; on any other toolchain that check is skipped and the differing fields are named (see CONTRIBUTING).

## Security properties

- **No handle inheritance.** The job handle is created without security attributes, so it is not inheritable. libuv creates children with handle inheritance on. An inheritable job handle would therefore let a child keep the job alive after the host closed or lost its own handle.
- **Kill on close, no breakaway.** `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is the only limit, so no process in the job can break away from it. A non-detached Node child is already in libuv's job when it is assigned, and this job nests under that one ([05 §10](../../docs/research/05-empirical-cli.md#10-q7--process-trees)). Descendants inherit the job, including the ones that silently break away from libuv's job ([07 §2](../../docs/research/07-pre-v1-spikes.md#2-host-crash-parent-dies-abruptly)).
- **No pid reuse.** `assignProcess` is called while Node still holds the child's process handle (`ChildProcess`, before its exit is reaped). Windows does not reuse a pid while any handle to the process is open. The creation time is read through the handle that is assigned, so it always belongs to the assigned process.
- **Bounded memory, checked integers.**
  - `listPids` uses one buffer of 65536 entries, whose size is computed at compile time, and refuses a count larger than the buffer.
  - Every pid in the list is checked to be in [1, 2^32 - 1] before it is converted.
  - Arguments are checked for count, type, finiteness, integrality and range before they are converted to a `DWORD`.
- **No type confusion.** Job externals carry a 128-bit `napi_type_tag`. A value that is not an external, or an external this addon did not create, is refused with `ERR_INVALID_ARG_TYPE` before its pointer is read.
- **No leaked handles.** Every handle is closed on every path. On an error path, the first error is reported; a failing cleanup `CloseHandle` cannot replace it.
- **Delay-load hook.** `delay_load_hook.c` resolves the delay-loaded module `node.exe` to the running executable with `GetModuleHandleW(NULL)`, so the addon also works in a host whose executable has another name, such as Electron. That module is the only one that is delay-loaded, and the hook always resolves it. The default helper's `LoadLibrary` path is therefore never taken, and no DLL is ever searched for or loaded by name.
- **Static imports.** `KERNEL32.dll` is the only static import.
- **Exploit mitigations.** The build flags give the binary these; verify them with `dumpbin /headers /loadconfig`:
  - Control Flow Guard;
  - CET shadow stack compatibility on x64;
  - ASLR with high entropy;
  - DEP;
  - `/GS` and `/sdl` checks;
  - Spectre mitigations.

## Smoke test

```sh
node native/win32-job/smoke.mjs [--addon <path>]
```

The default addon path is `build/x64/Release/hudhud_win32_job.node`. Each tree is a `node -e` child that starts a detached grandchild after it was assigned. The cases are:

| Case                                       | What it shows                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Argument validation and error codes        | Bad input is refused with the documented codes.                                                                                                                                                                                                                                                                                        |
| Self-assignment                            | A helper host calls `assignProcess` with its own pid and gets `ERR_SELF_ASSIGN`. The job stays empty, and the helper outlives the termination and closing of the job. A helper that had been assigned would die silently when the job closed, with exit code 0, so the test relies on the helper's complete output, not on exit codes. |
| Control: no job                            | Without a job, the grandchild survives the end of its parent. This case shows that the later cases can fail.                                                                                                                                                                                                                           |
| `create`, `assign`, `list` and `terminate` | The job nests under libuv's job, the grandchild is in the job, and terminating the job ends both.                                                                                                                                                                                                                                      |
| Idempotency                                | Repeated terminate and close succeed, and any use after close throws `ERR_JOB_CLOSED`.                                                                                                                                                                                                                                                 |
| Kill on close                              | Closing the job ends the tree while an unrelated child, spawned after `createJob`, keeps running. This shows that the handle is not inherited.                                                                                                                                                                                         |
| Finalizer                                  | Dropping the job external and running the GC ends the tree.                                                                                                                                                                                                                                                                            |
| Host crash                                 | Killing a helper host that owns the job ends its tree.                                                                                                                                                                                                                                                                                 |
| Renamed host                               | The addon works in a host that is not named `node.exe`, which shows that the delay-load hook works.                                                                                                                                                                                                                                    |

The test only ends processes it spawned: through their own handle, through a job they were assigned to, or after it has verified their pid and creation time.
