---
'@hudhudjs/core': minor
---

Renamed from `@hudhud/core` to `@hudhudjs/core` (ADR-0004 amendment, 2026-10-16): the npm scope `@hudhud` belongs to another account. Import it as `@hudhudjs/core`, `@hudhudjs/core/protocol`, `@hudhudjs/core/process` and `@hudhudjs/core/binding`; the schemas are `@hudhudjs/core/schemas/*.json`. `WIN32_JOB_ADDON_SPECIFIER` is now `@hudhudjs/win32-job-x64/hudhud_win32_job.node`. Exported names, error codes and `HUDHUD_*` variables are unchanged.
