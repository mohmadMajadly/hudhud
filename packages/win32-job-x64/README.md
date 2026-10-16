# @hudhudjs/win32-job-x64

The prebuilt Windows x64 job-object addon of hudhud, `hudhud_win32_job.node`. It puts a spawned harness process and all of its descendants into a Windows job object owned by the host process, so the whole tree ends when the session closes or the host dies.

Do not install or load this package yourself. `@hudhudjs/core` lists it as an optional dependency, so npm installs it on Windows x64 only. The core then loads it only after checking that its sha256 and its `version` equal the digest table shipped with that exact core version. If the package is missing or the check fails, the core falls back to `'best-effort'` containment and says why in its capabilities.

The package contains the addon and a `SHA256SUMS` file. It has no scripts and no dependencies. The C source, the build flags and the security properties of the addon are in `native/win32-job/` of the hudhud repository.

Licensed under the Apache License 2.0.
