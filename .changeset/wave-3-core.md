---
'@hudhudjs/core': minor
'hudhudjs': minor
---

Wave 3 of the harness-neutral core.

- `@hudhudjs/core/process`: binary verification (K8, K9): `verifyBinary` (`'advisory'` compares the committed digest table only and starts no process; `'strict'` runs the OS signature check first, Authenticode through the in-box PowerShell by absolute path or `/usr/bin/codesign`, and on Windows passes only the pinned publisher subject, `PublisherPin`), the per-Harness `VerificationCache`, `settleProbedVersion`, `recheckBinary` and `assertSpawnable` before every spawn, and `assertSpawnableOrReverify`, which re-resolves and fully re-verifies once when the file was replaced and refuses a second change with `BINARY_VERIFICATION_FAILED`. The K4 version probe `runVersionProbe` runs in a new empty directory of its own under the temp directory, removed afterwards, with a timeout and an output cap (`runBoundedCommand`).
- `@hudhudjs/core/process`: the Windows job addon loader (`loadJobAddon`, never throws; `arm64` is not first class in v1, K17; sha256 of the addon checked before `dlopen`) and per-session containment (`createSessionContainment`: the job is created and the process assigned before the first write; an assignment failure keeps the session as `'best-effort'` with a `containment.fallback` diagnostic, K2). `@hudhudjs/win32-job-x64` is not a dependency yet: the addon package lands with the addon track.
- `@hudhudjs/core/process`: `snapshotAtEof` and `sweepAfterExit`, the sweep of the graceful close path: after a normal exit, descendants recorded when stdin was ended that are still the same processes are killed (POSIX `SIGKILL` through the ladder sweep; Windows best effort, one `taskkill /F /PID` each).
- `@hudhudjs/core`: the neutral security posture builder (`buildPosture`, which computes `deviates` itself, `parsePosture`, `serializePosture`, `postureDeviations`, `postureEntry`).
- `@hudhudjs/core/protocol`: the machine effect `send.rejected` (a send refused for its turn id, bound to that command, never ending a live turn; the binding passes a fresh UUID per send). `DiagnosticCode` gains `stdin.error` and `permission.duplicate-request-id`.
