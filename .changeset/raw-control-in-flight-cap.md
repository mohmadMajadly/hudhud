---
'@hudhudjs/claude-code': patch
---

Raw tier (`@hudhudjs/claude-code/raw`, unstable): `controlRequest` now lets at most 64 requests (`RAW_CONTROL_MAX_IN_FLIGHT`, new export) wait for an answer at once per session. One more is refused at once with `ControlRequestError` (`CONTROL_REQUEST_FAILED`, `details.cause: 'in-flight-limit'`, `details.limit`) and nothing is written. Before, requests Claude Code never answered stayed until the session ended, since a raw request has no default timeout; pass `timeoutMs` or a `signal` for requests that may go unanswered.
