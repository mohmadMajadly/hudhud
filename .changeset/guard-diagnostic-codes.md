---
'@hudhudjs/core': minor
'hudhudjs': minor
---

`DiagnosticCode` and the events schema list the two codes the project credential guard already published: `settings-guard.git-root-unresolved` (the git root could not be resolved, so the guard read the cwd and every ancestor) and `settings-guard.symlink-followed` (a settings file is reached through a link). The diagnostics guide documents both, and the security guide documents the ancestor fallback, link handling and the read-failure refusals (`details.problems`).
