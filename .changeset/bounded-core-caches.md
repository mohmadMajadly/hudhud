---
'@hudhudjs/core': patch
---

`VerificationCache` keeps at most 16 results, forgetting the one stored first, so a long-lived Harness whose binary is replaced again and again (auto-updates) no longer keeps one result per version it ever saw; a forgotten result is only verified again. `ManualClock` drops cancelled and fired timers once most of its list is dead, so a loopback session that re-arms a timer on every frame without advancing time keeps only its live timers.
