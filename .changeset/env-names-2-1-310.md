---
'@hudhudjs/claude-code': minor
'hudhudjs': minor
---

The child environment follows the rule for Claude Code 2.1.310's new variables. `CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT` (turns off a permission prompt) and `CLAUDE_CODE_DISABLE_ULTRAREVIEW_TRUST_CHECK` (skips a workspace trust check) are never inherited by either preset: a value in your process's environment is dropped and reported in `env.dropped`, and `env.add` or an explicit map still passes it, listed in the security posture. `CLAUDE_CODE_SDK_READS_STARTUP_MARKS`, an Agent SDK switch that makes Claude Code write extra lines before its handshake, is always removed, like `CLAUDE_CODE_SDK_READS_SESSION_STATE`, and an `env` option that names it is refused with `INVALID_OPTIONS`.
