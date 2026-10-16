---
'@hudhudjs/core': minor
'@hudhudjs/claude-code': minor
'hudhudjs': minor
---

Strict binary verification on macOS requires the pinned publisher (macOS gate, research 11).

- `@hudhudjs/core/process`: `PublisherPin.darwinTeamId` (new). The macOS signature check runs `/usr/bin/codesign --verify --strict -R <requirement>`, where the requirement is a Developer ID designated requirement whose leaf organizational unit is the pinned Team ID (`anchor apple generic`, a Developer ID intermediate, a Developer ID Application leaf). A valid signature by another team fails (`codesign failed: exit 3`). Without a Team ID, or with one that is not 10 upper-case letters or digits, the check fails without running codesign, as the Windows check fails without a pinned subject. The verification cache is keyed by the Team ID.
- `@hudhudjs/claude-code`: `CLAUDE_CODE_PUBLISHER.darwinTeamId` is `Q6L2SF6YDW` (Anthropic PBC, recorded from the signed darwin-arm64 and darwin-x64 binaries of CLI 2.1.296).
