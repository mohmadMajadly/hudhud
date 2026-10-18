---
'@hudhudjs/win32-job-x64': patch
'@hudhudjs/win32-job-arm64': patch
---

The addon's `NOTICE` now carries a "Microsoft Distributable Code" section: `hudhud_win32_job.node` links the Microsoft C runtime statically (`/MT`), and that Microsoft object code is not under the Apache License 2.0. The section names the Microsoft terms it is redistributed under and the restrictions that pass on to anyone who distributes the file further. hudhud is not affiliated with Microsoft.
