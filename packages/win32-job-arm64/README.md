# @hudhudjs/win32-job-arm64

The prebuilt Windows ARM64 job-object addon of hudhud, `hudhud_win32_job.node`, built from the same source as `@hudhudjs/win32-job-x64`.

It is not first-class yet and is not published in v1 (the package is private): no hudhud package depends on it, and `@hudhudjs/core` does not load it. On Windows ARM64 the core reports `'best-effort'` containment until the addon has been tested on real ARM64 hardware.

The package contains the addon and a `SHA256SUMS` file. It has no scripts and no dependencies. The C source, the build flags and the security properties of the addon are in `native/win32-job/` of the hudhud repository.

Licensed under the Apache License 2.0.
