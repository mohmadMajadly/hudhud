---
'@hudhudjs/core': patch
---

On Windows the process-table query now resolves `powershell.exe` the way `taskkill.exe` and the Authenticode check do (a validated, unambiguous `SystemRoot`; the realpath must be the expected file, so a redirected `System32` is refused) and runs it with the current directory `%SystemRoot%\System32` instead of the host's current directory.
