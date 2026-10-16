---
'@hudhudjs/claude-code': patch
---

The `env.dropped` diagnostic now names exactly the parent variables the child's final environment lacks. A variable that the preset filters out but hudhud pins again (such as `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, or `TRACEPARENT`/`TRACESTATE` with `trace`) reaches the child with hudhud's value and is no longer listed; a name set again by `env.add` is reported in `env.added` only. The child's environment itself is unchanged.
