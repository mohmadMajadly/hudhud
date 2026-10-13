---
'@hudhud/claude-code': minor
---

The Claude Code adapter gains its capability set, tested window and live session registry (not yet exported; the connect pipeline wires them in Wave 5). `claudeHarnessCapabilities` builds the Harness capabilities, `parseFeatures` validates the feature strings of `system/init` and the `initialize` response (at most 256 entries of at most 128 characters in a restricted alphabet, unknown names kept, the rest dropped), `CLAUDE_CODE_COMPAT` and `compatStatus` give the tested window (a version outside it is reported as `untested` or `known-broken`, never refused), and `SessionRegistry` refuses a second live session id within one Harness with `SESSION_ID_IN_USE`. The session machine now reads feature strings through the same validated parser.
