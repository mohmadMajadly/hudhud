---
'@hudhudjs/core': minor
---

The identity of a verified binary now compares the modification time and the status change time (`ctime`) in nanoseconds, together with the file id and the size: at every re-check before a spawn (`recheckBinary`, `assertSpawnable`, the re-check in `sessions.create`/`resume`), in the binding of a digest to the resolved file, and in the `VerificationCache` key and hit check. Before, it compared the mtime in whole milliseconds only, so a same-size rewrite in place whose mtime was set back (`utimes`) kept the identity. On POSIX an unprivileged process cannot set `ctime` back, so such a rewrite is now detected; on Windows Node reports the NTFS change time, which a writer can set back, so it is compared but is not a security property there (the fresh hash at each `connect` bounds that case).

API: `ResolvedExecutable`, `FileDigest` and `BinaryIdentity` (and so `VerifiedBinary`) gain `mtimeNs` and `ctimeNs` (decimal strings); `sha256File` also checks `ctimeNs` before and after the read. New `ExecutableIdentity` (`FileIdentity` plus `mtimeNs` and `ctimeNs` as bigints) is what `ExecutableFs.stat` and `IdentityFs.stat` now return; a custom seam must supply both (Node's `stat(path, { bigint: true })` does).
