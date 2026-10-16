---
'@hudhudjs/core': patch
---

`sha256File` reads in 4 MiB chunks by default instead of 64 KiB. Each chunk is one asynchronous read, and under CPU contention each read waits for the scheduler: hashing the pinned 260 MB Claude Code binary on Windows with 16 CPU-bound processes running took 37 s at 64 KiB and 1.2 s at 4 MiB (194 ms idle, previously 300 ms). The guarantees are unchanged: one open handle, one reusable buffer, and the identity is checked before and after the read.
