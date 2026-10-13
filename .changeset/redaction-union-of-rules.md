---
'@hudhud/core': patch
'hudhud': patch
---

Redaction no longer leaves part of a credential readable when a known secret sits inside it. Every rule of `redactText`, `redactJson` and the stderr tail now matches on the original text and the union of all matches is masked at once, each run of overlapping or adjacent matches by one `<redacted>`. Before, known secrets were masked first and the shape rules stopped at the inserted marker, so the rest of an `sk-ant-` key, a `Bearer` token, a `name=value` value or a URL userinfo around a known secret stayed readable (found by the `StderrTail` property test).
