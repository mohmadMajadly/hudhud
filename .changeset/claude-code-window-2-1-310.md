---
'@hudhudjs/claude-code': minor
'hudhudjs': minor
---

The tested window of the Claude Code adapter now reaches 2.1.310: `CLAUDE_CODE_COMPAT` is `minTested: '2.1.296'`, `maxTested: '2.1.310'`, and every release in between (2.1.299 to 2.1.309) was tested too. The committed digest table holds the official binaries of 2.1.303 to 2.1.310 on linux-x64, win32-x64, darwin-arm64 and darwin-x64, each checked against the npm integrity and the Agent SDK `manifest.json` of the same CLI release, so `binary.verification` is `'verified'` for them without `claudeCode.binaryDigests`. Claude Code changes inside the window that sessions can notice, none of which changes hudhud's API, permissions, interrupt or containment: from 2.1.304 tool search is on behind a custom `ANTHROPIC_BASE_URL` (deferred tools are loaded through `ToolSearch`; tools removed with `disallowedTools` stay out; `ENABLE_TOOL_SEARCH=false` through `env` turns it off), and from 2.1.310 the `Monitor` tool is on by default (its background process holds `close()` like a background shell) and the Bash tool refuses a foreground command that starts with a `sleep` of 25 seconds or more. See the Compatibility guide.
