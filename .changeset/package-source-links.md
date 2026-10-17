---
'@hudhudjs/core': patch
'@hudhudjs/claude-code': patch
'hudhudjs': patch
'@hudhudjs/win32-job-x64': patch
---

Every published package's `package.json` now names its source: `repository` (this repository and the package's directory), `homepage` and `bugs`. npm trusted publishing requires `repository.url` to match the repository the package is published from. No code changed.
