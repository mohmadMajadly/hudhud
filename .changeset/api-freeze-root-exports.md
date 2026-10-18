---
'@hudhudjs/core': minor
'hudhudjs': minor
---

Breaking, before the first release (pre-release review R5-5): the root entry `@hudhudjs/core` (and so `hudhudjs`) no longer exports utilities that are not part of the application API.

- Removed: `UsageEstimator`, `UsageObservation`, `EstimatedUsage`, `estimateUsageDelta` and `sanitizeUsage`. Nothing used them since the Claude Code adapter computes `usage.update.estimatedDelta` itself; the `usage.update` event is unchanged.
- Moved off the root: `StderrTail`, `StderrTailOptions` and `TRUNCATED`. They stay on `@hudhudjs/core/process`, where the process layer uses them.
- `buildPosture` and `PostureEntryInput` are now `@beta`: they are for adapter authors. The application posture helpers (`postureDeviations`, `postureEntry`, `serializePosture`, `parsePosture`) stay stable.
