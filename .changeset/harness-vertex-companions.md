---
'@hudhudjs/claude-code': patch
---

With `CLAUDE_CODE_USE_VERTEX` on, the `'harness'` env preset now also passes `VERTEX_*` (such as the per-model regions `VERTEX_REGION_CLAUDE_*`) and `GCLOUD_*` (such as `GCLOUD_PROJECT`) from your environment to Claude Code. Before, they were dropped and had to be added with `env.add`.
