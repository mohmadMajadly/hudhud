---
'@hudhudjs/claude-code': minor
'hudhudjs': minor
---

Six more environment variables never reach Claude Code from your process's environment, in either preset (`'harness'` and `'inherit'`). Each loads code or configuration, re-routes traffic or weakens a protection in Claude Code 2.1.302:

- `CLAUDE_CODE_REMOTE`
- `CLAUDE_CODE_ENVIRONMENT_KIND`
- `CLAUDE_CODE_REMOTE_MCP_CONFIG`
- `CLAUDE_CODE_DESKTOP_SKILLS_PLUGIN_DIR`
- `CLAUDE_CODE_SANDBOX_LEAVE_DENIES_TO_SRT_WIN`
- `CLAUDE_CODE_CCR_WORKER_SOCKET`

When your environment holds one, it is reported in `env.dropped`. To pass one on, set it with `env.add` or an explicit map; the security posture then lists it in `env.credentialAndRoutingVariables`.
