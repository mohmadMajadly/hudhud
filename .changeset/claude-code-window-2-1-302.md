---
'@hudhudjs/claude-code': minor
'hudhudjs': minor
---

The tested window of the Claude Code adapter spans several releases: `CLAUDE_CODE_COMPAT` is `minTested: '2.1.296'`, `maxTested: '2.1.302'`, and every release in between (2.1.299, 2.1.300, 2.1.301) was tested too. Users on any of them get `compat.status: 'tested'` instead of `'untested'`. The committed digest table holds the official binaries of all five releases on linux-x64, win32-x64, darwin-arm64 and darwin-x64, each checked against the npm integrity and the Agent SDK `manifest.json` of the same CLI release, so `binary.verification` is `'verified'` for them without `claudeCode.binaryDigests`. From 2.1.299 on, Claude Code no longer sends the `anthropic-beta` value `mid-conversation-system-2026-04-07`; nothing in hudhud depends on it.
