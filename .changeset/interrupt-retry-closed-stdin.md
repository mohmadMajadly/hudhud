---
'@hudhud/claude-code': patch
---

An interrupt whose answer still lists the turn as queued, arriving after stdin closed, now fails with `SESSION_CLOSED` instead of arming a re-send that could never be written; the application's interrupt no longer waits for the process to exit (found by the turn-machine model check).
