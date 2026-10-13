---
'@hudhud/core': minor
'@hudhud/claude-code': minor
'hudhud': minor
---

K10: auth fail-fast covers `ANTHROPIC_AUTH_TOKEN` as well as `ANTHROPIC_API_KEY` (lead decision after the recorded `auth-token-source` fixture: a static env credential that got a 401 does not succeed on retry). The CLI reports the token as `account.tokenSource: "ANTHROPIC_AUTH_TOKEN"` with `apiKeySource: "none"`, so `SessionInfoData` and the `session.started` event gain the optional `tokenSource`; fail-fast matches `apiKeySource` or `tokenSource` against `authFailFastSources` (default both env credentials), and the `AUTHENTICATION_FAILED` details name the triggering credential (`credentialSource`). OAuth and `apiKeyHelper` stay excluded because they can refresh.
