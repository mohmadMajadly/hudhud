---
'@hudhudjs/core': patch
'hudhudjs': patch
---

`isHudhudError` now recognizes errors from another copy of `@hudhudjs/core` in the same process (pre-release review R5-3). Every hudhud error carries a hidden brand from the global symbol registry (`Symbol.for('hudhudjs.error')`), and `isHudhudError(value, code?)` accepts either an `instanceof` match or a branded error whose `code` this version knows. Before, it used `instanceof` only, so when a dependency installed a second copy of the core, every error from that copy failed the check, and code-based handling such as retry loops stopped working.
