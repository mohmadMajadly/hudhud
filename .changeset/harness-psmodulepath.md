---
'@hudhudjs/claude-code': patch
---

On Windows the `'harness'` env preset now passes `PSModulePath` and `PSModuleAnalysisCachePath` on to Claude Code. Before, they were dropped, so PowerShell modules installed outside Windows PowerShell's default directories resolved in your terminal but not in Claude Code's PowerShell tools. Both are paths, not credentials.
