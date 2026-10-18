---
'@hudhudjs/core': patch
'@hudhudjs/claude-code': patch
---

A `system/init` that Claude Code repeats while a turn it started itself is still open (no `result` or `idle` in between) no longer opens another harness turn: it belongs to the open turn, and the new diagnostic `turn.repeated-init` (added to `DiagnosticCode` and the events schema) reports the protocol drift once per such turn. Before, each repeat opened a new `bg-<n>` turn that stayed until an `idle`, so a harness repeating it could grow the turn table without bound. Claude Code itself is not known to do this.
