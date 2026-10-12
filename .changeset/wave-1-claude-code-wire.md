---
'@hudhud/claude-code': minor
---

Claude Code wire schemas (`@hudhud/claude-code/schemas/wire-inbound.schema.json`, `wire-outbound.schema.json`): lenient inbound envelopes and strict outbound frames, so `initialize.workspaceTrust` cannot be sent. Only fields seen in observed frames or the MIT Python SDK are modelled (ADR-0015); system prompts are passed through the documented CLI flags, not `initialize`.
