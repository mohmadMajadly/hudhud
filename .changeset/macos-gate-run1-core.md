---
'@hudhudjs/core': minor
'hudhudjs': minor
---

macOS gate run 1 fixes (research 09).

- `@hudhudjs/core/process`: the macOS `ps` contract is `pid=,ppid=,pgid=,stat=,lstart=,comm=`; `parsePsOutput(output, dialect)` strips exactly the column padding of macOS (`bsd`, `lstart` width 28, the default) or procps (`procps`), so process names no longer carry 4 leading spaces. `ProcessRecord.zombie` marks a zombie (state `Z` from `stat` or `/proc/<pid>/stat`); `planSweep` never signals a zombie by pid (skip reason `zombie`) and still counts it as a verified group member. New type `PsDialect`.
- `@hudhudjs/core/protocol`: `classifyExit` maps intent `none`, exit code 0 after an error result with no open turn (macOS SIGINT from outside: `result/error_during_execution`, then exit 0) to `unknown` with `PROCESS_EXITED`, as for the Linux SIGINT shape; it was `crashed`.
