---
'@hudhudjs/core': minor
'hudhudjs': minor
---

Wave 6 (integration against the pinned CLI).

- `isHudhudError(value, code?)`: the optional `code` narrows to a hudhud error with that code (plan §2.2), for example `isHudhudError(error, 'SESSION_NOT_FOUND')`. Without it the function is unchanged.
- Fix: the POSIX abort ladder reported a process it had ended with `SIGKILL` as never exited (`exitedAfter: null` in the `termination.ladder` diagnostic) whenever Node had not yet reaped the child when the report was built (seen on Node 26). After the `SIGKILL` the ladder now waits for the exit, at most `termGraceMs`, and reports `exitedAfter: 'sweep'` (or `'sigkill'` without a verified identity); `null` again means the process did not exit within that wait.
