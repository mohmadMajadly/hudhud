---
'@hudhudjs/core': patch
'@hudhudjs/claude-code': patch
'hudhudjs': patch
---

Every option and every public member of the stable entry points now has documentation in the types, so editor hover shows its meaning, default, units and limits (pre-release review R5-8): for example that `SessionOptions.signal` covers only the start of a session, that `closeTimeoutMs` runs from the `close()` call, and the range of every size and duration option. The types themselves are unchanged.
