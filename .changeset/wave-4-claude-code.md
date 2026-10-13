---
'@hudhud/claude-code': minor
---

Wave 4 of the Claude Code adapter (not yet exported; the connect pipeline wires these modules in Wave 5).

- The capability set, tested window and live session registry (W4-T3). `claudeHarnessCapabilities` builds the Harness capabilities; `parseFeatures` validates the feature strings of `system/init` and the `initialize` response (at most 256 entries of at most 128 characters in a restricted alphabet, unknown names kept, the rest dropped), and the session machine reads feature strings through it; `CLAUDE_CODE_COMPAT` and `compatStatus` give the tested window (a version outside it, or not parseable, is `untested` and only reported; a listed one is `known-broken`, which the Wave 5 connect refuses with `HARNESS_VERSION_KNOWN_BROKEN` unless `claudeCode.dangerouslyAllowKnownBrokenVersion` is set); `SessionRegistry` refuses a second live session id within one Harness with `SESSION_ID_IN_USE`.
