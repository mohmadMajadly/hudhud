---
'@hudhudjs/claude-code': patch
---

The project credential guard resolves the user's config directory from Claude Code's own environment, as the security posture does. Before, with an explicit `env` map that did not pass the parent's `CLAUDE_CONFIG_DIR` on, the guard skipped the parent's directory while Claude Code used `~/.claude`, so the guard's ancestor fallback could read `~/.claude/settings.json` as project settings and refuse a session because of the user's own settings.
