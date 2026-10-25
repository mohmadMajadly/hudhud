---
'@hudhudjs/claude-code': minor
'hudhudjs': minor
---

`tool.call` events of Claude Code's `Monitor` tool, which Claude Code 2.1.310 turns on by default, now carry `kind: 'execute'` instead of `'other'`: `Monitor` starts a command in the background and reports each line it prints, as a Bash call with `run_in_background` does. The Events guide now lists which Claude Code tools map to which kind and the rule behind it (a tool gets the kind of its effect on your machine; tools whose effect stays inside Claude Code are `'other'`).
