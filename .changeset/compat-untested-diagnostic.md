---
'@hudhudjs/core': minor
'@hudhudjs/claude-code': minor
'hudhudjs': minor
---

A session started on a Claude Code version outside the tested window publishes the diagnostic `compat.untested` among its start diagnostics (`data` is the `compat` object: `version`, `minTested`, `maxTested`, `knownBroken`, `status`). It is a warning only: the session runs, as before. `DiagnosticCode` and the events schema list the new code (additive). Before, an untested version showed only in `harness.compat` and the `compat` event.
