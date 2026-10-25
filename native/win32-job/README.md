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

`toolchain.json` records what changes the bytes: `arch`, `generator`, `vcToolsVersion` (the MSVC toolset), `clVersion`, `windowsSdkVersion` (the static `/MT` runtime takes the UCRT from the SDK), `cmakeVersion` and `nodeApiHeadersVersion`. After them comes `identity`, which is diagnostic only and never a gate (ADR-0014 amendment 14):

- `visualStudio`, the instance's `installationVersion`;
- `windowsSdkBuild`, the servicing build of the pinned SDK (`10.1.26100.7705`), or `unpinned`;
- `files`, the sha256 of every file the compiler and the linker read under the MSVC toolset (`msvc/...`), the Windows SDK (`sdk/...`) and node-api-headers (`node-api-headers/...`), from MSBuild's FileTracker logs (`CL.read.*.tlog`, `link.read.*.tlog`), plus `cl.exe`, `c1.dll`, `c2.dll`, `link.exe` and `lib.exe`. The repository's own files and Windows' own files are left out; any other input appears as `other/<file name>`.

The directory names `14.44.35207` and `10.0.26100.0` stay the same when Microsoft services the files inside them, so the version fields alone cannot show such a change. The identity can.

Without `--toolset-of-record` the build uses the latest instance with the default MSVC toolset and the newest installed Windows SDK, so its bytes depend on the machine. With it, the build uses the inputs of the release record that the committed digest table was written from:

- **Visual Studio.** The instance at `HUDHUD_VS_INSTALL`. Without it, the build takes the only complete instance that holds the record's MSVC toolset and its Spectre libraries for the architecture, and refuses when there are several. It never uses "the latest" or the default instance. The release workflow names the runner image's Visual Studio Enterprise instance, whose licence is the basis on which the addon redistributes the static runtime (ADR-0015 item 12).
- **MSVC.** The toolset of the record, `-T v143,version=<vcToolsVersion>`.
- **Windows SDK.** The SDK of [`toolchain-pin.json`](toolchain-pin.json), servicing build `10.1.26100.7705`. `scripts/addon/toolchain.mjs provision-sdk` unpacks it into the directory that `HUDHUD_WINDOWS_SDK` names. The build points MSBuild (`WindowsSdkDir_10`, `UniversalCRTSdkDir_10`, `UCRTContentRoot`) and CMake (`CMAKE_WINDOWS_KITS_10_DIR`) at it, and passes `-DCMAKE_SYSTEM_VERSION=<windowsSdkVersion>`. The machine's own SDK is never read, whatever its servicing build. The variables of a Visual Studio developer prompt (`INCLUDE`, `LIB`, `WindowsSdkDir`, ...) are removed for the build.

If the instance, its toolset or Spectre libraries, or the provisioned SDK is missing, the build fails and says how to provide it. Releases use this mode (see [Releasing](#releasing)).

Tool lookup:

- CMake is the first `cmake.exe` in an absolute `PATH` entry, or the absolute path in `HUDHUD_CMAKE`.
- Visual Studio is found with `vswhere`. For a build of record, `HUDHUD_VS_INSTALL` names the instance.
- For a build of record, `HUDHUD_WINDOWS_SDK` is the directory that `provision-sdk` wrote; its `hudhud-sdk.json` must name this pin.
- If something required is missing, the build fails and names it. `build.mjs` never installs anything.

To provision the pinned SDK on a Windows machine (every download is checked against the pin's size and sha256 before anything runs):

```sh
node scripts/addon/toolchain.mjs provision-sdk --downloads C:\hvdl --out C:\hvsdk
```

It downloads the pin's 9 MSIs and their 38 cabinets, 316 MB from Microsoft's Visual Studio CDN, and unpacks them with an administrative install (`msiexec /a`). That is extraction only: nothing is installed or registered, and it needs no administrator rights. It does nothing when the directory already holds this pin's SDK.

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

`release/0.0.0-dev/` is the local build of record until the first release (plan §6.1: x64 `fbe7d9ad…69b0`, ARM64 `a38a74a0…4206`, Build Tools 17.14 with MSVC 14.44.35207, SDK 10.0.26100.0, CMake 4.4.4). [Releasing](#releasing) describes how a release record is made.

Staging copies a build into its platform package for the tests, and never touches the table:

```sh
node scripts/addon/write-digests.mjs --stage --arch x64
node scripts/addon/write-digests.mjs --stage --arch arm64 --version 0.1.0
node scripts/addon/write-digests.mjs --stage --arch x64 --addon <file> --toolchain <toolchain.json>
```

It reads `build/<arch>/Release/hudhud_win32_job.node` and the `toolchain.json` next to it, or the files given with `--addon` and `--toolchain` (a CI artifact, for example). It refuses a file that is not a PE image of the requested architecture. It reads `version` by loading the addon when the host is Windows with the same architecture, and otherwise takes it from `--version`. If `--version` is given on such a host as well, the two must match. It then writes the exact bytes it read, a `SHA256SUMS` for them and the `toolchain.json` into `packages/win32-job-<arch>/`, all gitignored.

The Windows test suites load the staged addon with the digest from its `SHA256SUMS`, after checking that it names the staged bytes. The committed table must equal the staged addon only when the staged `toolchain.json` equals the record's in every field that can change the bytes; on any other toolchain that check is skipped and the differing fields are named (see CONTRIBUTING). The `generator` field is recorded but never compared, only reported: Visual Studio 17 2022 (the local build of record) and Visual Studio 18 2026 (windows-2025 CI, Addon prebuild run 38947897592) gave byte-identical x64 and ARM64 builds.

## Releasing

The invariant: the bytes a release publishes equal its release record, `release/<release>/manifest.json`, and every rebuild must reproduce that record (plan §6.3). `<release>` is the version of `@hudhudjs/win32-job-x64`, which is versioned by its record, apart from the library packages; a release tag `v<version>` names the version of `hudhudjs`, `@hudhudjs/core`, `@hudhudjs/claude-code` and `@hudhudjs/conformance` and ships the record that the core's digest table names (ADR-0004, ADR-0014 amendment 10). The workflow is [`.github/workflows/addon-prebuild.yml`](../../.github/workflows/addon-prebuild.yml); its tool is `scripts/addon/manifest.mjs`.

1. **Phase 1, CI record.** Dispatch the workflow (`workflow_dispatch`, input `release`) on the commit to release. It builds x64 and arm64 on `windows-2022` with `build.mjs --toolset-of-record`, using:
   - the image's Visual Studio Enterprise 2022 17.14 instance, chosen explicitly with vswhere and passed as `HUDHUD_VS_INSTALL`; nothing is installed into it;
   - the pinned Windows SDK (`toolchain.mjs provision-sdk`, into `C:\hvsdk`), never the image's SDK;
   - the record's exact CMake (`cmakeVersion`), downloaded from Kitware's release of that version, checked against Kitware's SHA-256 list and passed through `HUDHUD_CMAKE`.

   See [Pinned inputs](#pinned-inputs) for why. `test-x64` requires the toolchain of record (`manifest.mjs check-toolchain`) so that the record check runs, then runs the addon tests of plan §6.5 on the x64 build, including the containment suites with the pinned CLI. `manifest` writes the candidate record as the artifact `addon-record` (`manifest.json`, `SHA256SUMS`, `toolchain.json`, in exactly the committed format). The run log prints all three files.

2. **Independent local build.** On a Windows machine with a Visual Studio 2022 17.14 instance or Build Tools that holds the record's MSVC toolset and Spectre libraries, and the pinned SDK provisioned (see [Build](#build)):

   ```sh
   node native/win32-job/build.mjs --toolset-of-record --arch x64
   node native/win32-job/build.mjs --toolset-of-record --arch arm64
   ```

   Set `HUDHUD_WINDOWS_SDK` to the provisioned directory first.

3. **Compare.** Download `addon-record` from the run, then:

   ```sh
   node scripts/addon/manifest.mjs compare --manifest <download>/manifest.json
   ```

   It prints `MATCH` or `MISMATCH` per architecture, with the local and CI sha256 and size. A difference in a toolchain field that can change the bytes is a `TOOLCHAIN MISMATCH`; a different `generator` is reported as information only. On a `MISMATCH` it also names every input whose sha256 differs between the two builds, or that only one of them read. It exits 0 only when every architecture matches in bytes and toolchain. On a mismatch, stop: nothing is committed.

4. **Commit the record and the table.** Copy the three files into `native/win32-job/release/<release>/`, then regenerate the table from them and commit both:

   ```sh
   node scripts/addon/write-digests.mjs --from-manifest native/win32-job/release/<release>/manifest.json
   ```

5. **Version.** Add the changesets and bump the versions (`pnpm changeset`, then `pnpm changeset version`): `@hudhudjs/win32-job-x64` must come out at `<release>`, and the library group at the version the tag will name. The core's optional dependency on `@hudhudjs/win32-job-x64` is `workspace:*`, so `pnpm pack` writes the platform package's exact version into it.
6. **Tag.** Push `v<version>` (the library group's version) on the commit that holds the record, the table and the versions. A later library release that keeps this addon needs no new record: it ships the same record and addon version.
7. **Phase 2, verification.** The tag runs [`release.yml`](../../.github/workflows/release.yml), which calls this workflow again (`workflow_call`, `phase: verify`; ADR-0014 amendment 12). Each build, with the same pinned inputs, must reproduce the record the core's digest table names (`manifest.mjs verify`: sha256 and size per architecture). On a mismatch, `verify` names every input that differs from the record's identity, in the log and in the job summary. `release-verify` stages both builds, builds the core, packs every package, and hashes the packed bytes again (`node scripts/check-tarball.mjs --release-tag v<version>`). The `.node` and `SHA256SUMS` in each platform tarball and the digest table in the core's tarball (source and compiled `dist` module) must equal the record, and the core's optional dependency must name the packed x64 version. The tag must name the packed version of every library package, the x64 package must be packed at `<release>`, the published packages must not be private, no changeset may be left unconsumed, and every published package must name the repository in `repository`, `homepage` and `bugs`. Every failure names both values. It keeps the tarballs of the published packages, runs the full tarball check over exactly those tarballs (`check-tarball.mjs --tarballs`), the staged x64 package included, and uploads them as `release-tarballs`.
8. **Publish.** `release.yml` publishes those tarballs with npm trusted publishing and provenance, after a gate on the tagged commit and the owner's approval of its environment: `@hudhudjs/win32-job-x64` first and `@hudhudjs/core` second, so that the core's exact optional dependency always resolves, then `@hudhudjs/claude-code`, `@hudhudjs/conformance` and `hudhudjs`. `@hudhudjs/win32-job-arm64` stays private (K17). Release binaries come only from this CI build of record; a local build is never published (ADR-0015 item 12). The release runbook is in the release checklist, docs/plan/v1-release-checklist.md §7.

The workflow holds `contents: read` only and references no secret, so the tag run has no write token; only `release.yml`'s publish job, after it, holds `id-token: write`. It reads and writes no cache, and it keeps its artifacts for 3 days (`release-tarballs` 7).

### Pinned inputs

Why. The release dry run of 2026-10-25 (run 40161785779) did not reproduce the record: x64 gave `4a39d9ae…` instead of `fbe7d9ad…`, and arm64 gave `0c798238…` instead of `a38a74a0…`. Every version field was the same as the record's. The cause was the runner image: between 20261007.264 and 20261021.278 it moved the machine-wide Windows SDK from servicing build 10.1.26100.8249 to 10.1.26100.9457, and both builds are installed under the same `10.0.26100.0` directory. The evidence:

- The two x64 binaries differ only in the hint fields of the KERNEL32 import table, plus the timestamp, PDB GUID and repro hash that `/Brepro` derives from the content. The hints moved by +5 because the 9457 `kernel32.lib` was generated from a `kernel32.dll` with five more exports.
- For arm64, the 9457 `libucrt.lib` also changes the UCRT locale data, so `.data` shrinks by 16 bytes and the code moves.
- The proof: the record's own objects, relinked with the 9457 `kernel32.lib` (x64), or with the 9457 `kernel32.lib` and `libucrt.lib` (arm64), give exactly the CI's bytes.

What is pinned, and what is not.

- **Windows SDK: pinned.** The machine-wide SDK cannot simply be installed at another build, because an installer does not downgrade a newer servicing build that is already there. So the SDK is never installed: its MSIs are unpacked into a directory of our own, and the FileTracker logs show every SDK file the compiler and the linker read coming from that directory. `toolchain-pin.json` names the SDK's 9 MSIs and 38 cabinets, each with its URL, size and sha256. They come from package `Win11SDK_10.0.26100` version 10.0.26100.15 of the Visual Studio 17.14 catalog, and their MSI `ProductVersion` is 10.1.26100.7705. They are the MSIs the build needs: the headers, the libraries of both architectures, the MSBuild props, `SDKManifest.xml`, and `rc.exe`, which CMake's compiler check uses.
- **MSVC: not pinned, chosen explicitly and watched.** The MSVC toolset comes from the image's Visual Studio Enterprise 2022 17.14 instance. That instance's licence is the basis for redistributing the static runtime (ADR-0015 item 12), and a separate Build Tools instance would change that basis. The MSVC 14.44 packages (tools 14.44.35229, runtime 14.44.35226) were byte-identical in the Visual Studio 17.14.41, 17.14.42 and 18.11.1 catalogs. The identity names any change of their files.

The evidence: with the pinned 10.1.26100.7705 directory, a local build reproduces `fbe7d9ad…` and `a38a74a0…`. On the same machine, a directory unpacked from the 9457 payloads gives exactly the CI's `4a39d9ae…` and `0c798238…`. The build reads only the SDK it is pointed at.

Changing the pin. A new pin is a new toolset of record, so it needs a new release record (the steps above). The build of an existing record keeps its pin. Steps:

1. Take the new payloads (URL, size and sha256) from a Visual Studio channel catalog.
2. Unpack the SDK locally with `provision-sdk` and rebuild.
3. Compare the bytes and the identity with the record.

The weekly [addon canary](../../.github/workflows/addon-canary.yml) runs `build` against the current record. It shows within a week, before a tag does, and names the inputs involved:

- a pinned download that changes or disappears;
- an MSVC change in the image;
- an image without the Enterprise 17.14 instance.

The 0.1.0 record's identity was added after the record was made, before the release (the record is unpublished). It is the identity of the local builds with the pinned SDK, on Build Tools 17.14.41, whose MSVC packages are the same as the image's Enterprise 17.14.41. These builds reproduce the record's bytes. The original CI build used the image's SDK 10.1.26100.8249 and Visual Studio 18.10.3, and gave the same bytes.

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
