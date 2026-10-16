---
'@hudhudjs/claude-code': minor
---

Renamed from `@hudhud/claude-code` to `@hudhudjs/claude-code` (ADR-0004 amendment, 2026-10-16): the npm scope `@hudhud` belongs to another account. Import it as `@hudhudjs/claude-code` and, for the unstable tier, `@hudhudjs/claude-code/raw`; the schemas are `@hudhudjs/claude-code/schemas/*.json`. It depends on `@hudhudjs/core`. Exported names (`connect`, `session`, `hudhud`, ...), error codes and `HUDHUD_*` variables are unchanged.
