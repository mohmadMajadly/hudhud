---
'@hudhudjs/claude-code': patch
---

Requests Claude Code sends that hudhud never answers (`remote_*`, `request_user_dialog`) are now remembered at most 64 at a time, the oldest forgotten first, each by a key of at most a few hundred characters; before, a long-running session kept every one Claude Code never cancelled. Nothing is written for them either way; a cancel of a forgotten one is reported as `control.unknown-cancel`.
