---
'@hudhudjs/core': minor
'@hudhudjs/claude-code': minor
'hudhudjs': minor
---

The stability promise is now exact (pre-release review R5-1, ADR-0004 amendment). Stable, under semver: the root entries of `hudhudjs`, `@hudhudjs/core` and `@hudhudjs/claude-code` (except the adapter-author items `defineAdapter`, `AdapterDefinition`, `buildPosture` and `PostureEntryInput`), the schemas, and from `@hudhudjs/core/protocol` the application helpers `sanitizeForDisplay`, `SanitizeForDisplayOptions`, `parseErrorData`, `ErrorDataFailure` and `isRetryable`. Beta, for adapter authors, and free to change in a minor version: `@hudhudjs/core/process` (which was documented as stable), the rest of `@hudhudjs/core/protocol` (the machine contract, the JSON line helpers, exit classification, `ERROR_RETRYABLE`, `makeErrorData`, `isHudhudErrorCode`), `@hudhudjs/core/binding`, and the raw tier `@hudhudjs/claude-code/raw`, which also stays exempt from compatibility promises. Nothing was renamed or removed; only the release tags (`@public` to `@beta`) and the documentation changed.
