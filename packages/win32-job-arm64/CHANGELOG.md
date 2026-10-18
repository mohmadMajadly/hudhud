# @hudhudjs/win32-job-arm64

## 0.1.0

### Minor Changes

- ecb0bfe: The Windows job-object addon ships (plan §6.2).
  
  - New `@hudhudjs/win32-job-x64`: the prebuilt x64 `hudhud_win32_job.node` with its `SHA256SUMS`; `os: win32`, `cpu: x64`, no scripts, no dependencies.
  - New `@hudhudjs/win32-job-arm64`: the same for ARM64. Not first-class in v1 (K17): it stays private (never published in v1), no package depends on it and the core does not load it.
  - `@hudhudjs/core` depends optionally on `@hudhudjs/win32-job-x64`, and `WIN32_JOB_DIGESTS` now holds the sha256 and `version` (`0.1.0`) of the x64 build. On Windows x64 the loader therefore loads the addon and the Harness reports `processContainment: 'job'`; a missing or tampered addon still falls back to `'best-effort'` with the loader's reason.

### Patch Changes

- 7ea656d: The addon's `NOTICE` now carries a "Microsoft Distributable Code" section: `hudhud_win32_job.node` links the Microsoft C runtime statically (`/MT`), and that Microsoft object code is not under the Apache License 2.0. The section names the Microsoft terms it is redistributed under and the restrictions that pass on to anyone who distributes the file further. hudhud is not affiliated with Microsoft.
