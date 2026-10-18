---
'@hudhudjs/claude-code': patch
---

Long-running sessions no longer grow memory with their number of permission requests. A session now remembers the ids of the last 1024 permission requests to arrive or end, each by a key of at most a few hundred characters, instead of every id it ever saw (copied on each request, so the work grew quadratically). A request that reuses one of those ids is still denied without asking (`permission.duplicate-request-id`); an older id is asked as a new request. Forgetting cannot apply an earlier decision to the new request: by then no answer for the earlier request is left in the session.
