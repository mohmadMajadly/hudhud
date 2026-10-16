---
'hudhudjs': minor
---

Renamed from `hudhud` to `hudhudjs` (ADR-0004 amendment, 2026-10-16): npm refused the unscoped name `hudhud` as too similar to the existing package `hud-hud`. Install and import it as `hudhudjs`; it re-exports `@hudhudjs/core` and `@hudhudjs/claude-code`. Exported names are unchanged.
