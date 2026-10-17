---
'@hudhudjs/core': patch
'@hudhudjs/claude-code': patch
---

Raw control checks what it writes (pre-release review, R4-8). `RawSession.writeFrame` and `controlRequest` checked the caller's object and then serialized it again, so a getter or a proxy could pass the checks with one value and write another (for example a permission update to `userSettings` without `dangerouslyAllowConfigWrites`). The encoded line is now parsed back and checked once more under the same rules, and exactly that line is written. A getter or proxy trap that throws is refused with `INVALID_OPTIONS` instead of escaping as a plain `Error`: `isJsonValue` returns `false` for such a value and `encodeJsonLine` returns `PROTOCOL_ERROR` (`not-serializable`), as both functions document that they never throw.
