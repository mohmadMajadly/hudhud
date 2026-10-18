---
'@hudhudjs/conformance': minor
---

New package `@hudhudjs/conformance`: the expected event streams of hudhud's Claude Code conformance suite, as data. Each `dist/streams/<scenario>/<platform>[.<case>].expect.jsonl` is byte-identical to the stream this exact hudhud version's conformance suite asserts, and a typed index (`HUDHUD_VERSION`, `CONFORMANCE_STREAMS`) lists them. It is released with `hudhudjs`, `@hudhudjs/core` and `@hudhudjs/claude-code` at their version; pin it at the version of `@hudhudjs/claude-code` you use. No shape is promised across versions.
