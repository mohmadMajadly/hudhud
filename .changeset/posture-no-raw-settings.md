---
'@hudhudjs/claude-code': minor
---

The `managedPolicy` posture entry no longer has the value `'unknown-raw-settings'`. It could never be produced: `/raw` refuses `--settings` in every spelling and hudhud never passes the flag. Code that matched on the value can drop the case; the remaining values are `'fetched-if-eligible'`, `'not-fetched-custom-base-url'`, `'not-applicable-third-party-provider'`, `'unknown-project-settings-unreadable'` and `'unknown-user-settings-unreadable'`.
