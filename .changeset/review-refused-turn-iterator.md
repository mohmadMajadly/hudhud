---
'@hudhudjs/core': patch
---

The iterator of a turn that `send()` could not start (the session is closed or closing) now rejects with the same error as `turn.done`, as the guide states. After the session had ended it finished quietly with no events instead (found by the lifecycle matrix of the pre-release review, R8-2).
