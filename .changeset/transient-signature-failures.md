---
'@hudhudjs/core': minor
---

Strict binary verification no longer caches a signature check that did not complete. `checkOsSignature` returns the new kind `inconclusive` when the checker timed out, could not be started, was ended by a signal, exited non-zero itself (PowerShell, as opposed to a parsed Authenticode status) or wrote unusable output; `verifyBinary` reports it as `failed` with the new `verification.transient: true` and keeps it out of the `VerificationCache`, so that attempt fails closed and the next one checks again. Definitive verdicts (`verified`, a digest mismatch, another Authenticode status, a missing or different publisher, a non-zero codesign exit) are cached as before. `DEFAULT_SIGNATURE_TIMEOUT_MS` is now 120 s, sized from measured checks of up to 50 s on GitHub-hosted Windows runners, and the Authenticode script no longer loads `Microsoft.PowerShell.Utility`.
