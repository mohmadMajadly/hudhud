---
'@hudhudjs/claude-code': patch
---

The `'harness'` env preset now serves every provider switch of Claude Code 2.1.296. With `CLAUDE_CODE_USE_ANTHROPIC_AWS` (Claude Platform on AWS) or `CLAUDE_CODE_USE_MANTLE` (Bedrock Mantle) on, it passes your `AWS_*` variables; with `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD` (Claude Platform on Google Cloud) on, your `GOOGLE_*` and `GCLOUD_*` variables. With either Google switch, the lower-case `gcloud_project` and `google_cloud_project` pass too. Before, these were dropped and had to be added with `env.add`.
