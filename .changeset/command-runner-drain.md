---
'@hudhudjs/core': patch
---

The process-table readers (`/bin/ps` on macOS, the CIM query through `powershell.exe` on Windows) now finish when the command exits instead of when its output pipe closes. A descendant of the command that inherited the pipe could hold it open, and with it one pending read, for as long as it ran. Output that has not ended 2 s after the exit is dropped and the read fails; only the command itself is ever stopped, through its own handle.
