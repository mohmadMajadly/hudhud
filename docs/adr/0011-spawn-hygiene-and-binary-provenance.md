# ADR-0011: Spawn hygiene and binary provenance

- Status: Accepted. Binary discovery order is not fixed by the negotiation log (see Decision 5). Verification against OS signatures is design intent; hash verification evidence is from the spike.
- Date: 2026-10-12
- Negotiation log items: A14, A15, E10, F (A14/E10, A15), D1, D9, D10 (06 §A, §D, §E, §F)
- Related: [ADR-0008](0008-turn-and-lifecycle-semantics.md), [ADR-0009](0009-process-layer-windows.md), [ADR-0012](0012-security-defaults-and-trust.md), [ADR-0015](0015-legal-and-provenance.md)

## Context

Argv injection is a documented real-world issue: a dash-leading value is parsed as a new flag, and both SDKs fixed it by sending `--flag=value` (02 §2.4: Python for `--resume`, `--session-id`; TS in 0.3.295). The `--allowedTools` tokenizer splits on commas and spaces outside parentheses, so rule strings need validation (02 §2.4, Python changelog 0.2.129 calls the old behaviour an injection). On Windows, spawning `.cmd` or `.bat` hits CVE-2024-27980 ("BatBadBut") (02 §2.3, §10 item 3). Large values can exceed Windows command-line limits, which is why the SDKs send agents, hooks and prompts through `initialize` (02 §2.4).

The TS SDK trusts whatever `require.resolve` finds in `node_modules`; Python trusts PATH and a bundled file, and deliberately avoids probing driveless `/usr/local/bin` on Windows because of binary planting (02 §10 item 9).

Spike hashes (D1, 05 §1): the win32-x64 and linux-x64 binaries match npm integrity and the SHA-256 in the SDK package's `manifest.json`; the SDK's win32 binary is byte-identical to the claude-code one. The SDK does not read `manifest.json` at runtime (02 §8).

## Decision

### Spawn (A14)

1. `shell: false`, `windowsHide: true`, stdio `pipe` x3, explicit environment ([ADR-0012](0012-security-defaults-and-trust.md)).
2. Explicit binary resolution, preferring a real `.exe`. Refuse `.cmd` and `.bat` anywhere in the resolved path. Never `shell: true`.
3. All flags in the form `--flag=value`, always, including named options and free-form values.
4. Rule strings (allowed/disallowed tools, skill names) are validated against the tokenizer's constraints before being formatted into argv.
5. Binary discovery (ratified by K7, 06 §K): the explicit path option, then the native installer launcher (`~/.local/bin/claude[.exe]`, resolved to its version directory), then a sanitized `PATH` lookup (empty, relative and current-directory entries skipped; on Windows only `.exe`). SDK platform packages in `node_modules` are not probed (planting, 02 §10 item 9). In all cases the resolved path, the version and the verification status are reported; the version comes from one `claude --version` probe at connect (zero network requests, 05 §1), and each session reports drift against `initialize.claude_code_version` (K4).
6. Large values go through `initialize` or hudhud-owned private files, not argv. Private files are created by hudhud with restrictive permissions in a hudhud-owned location; they are not placed in the harness's config directory (R6).
7. A bounded, UTF-8-safe NDJSON framer: per-line inbound cap 64 MiB by default, configurable (E10); outbound cap 32 MiB (initial, tunable); `onOversizedFrame: 'fail'` (default) or `'skip'` ([ADR-0008](0008-turn-and-lifecycle-semantics.md)). The framer tolerates CRLF, blank lines, a leading BOM and multibyte characters split across chunks (05 §11, D10).
8. Non-JSON stdout lines are skipped as non-protocol noise and never executed (02 §10 item 7).
9. Windows cwd length (J10, 07 §6): a plain spawn works up to 258 characters; from 259 it fails with a misleading `ENOENT`. A `\\?\`-prefixed cwd spawns, but the CLI then runs in the 8.3 short-name alias, which puts transcripts under a different project key (resume and transcripts split) and makes the Bash tool refuse writes. hudhud therefore validates the cwd length on Windows before spawn and throws a named error (`CwdTooLong`, illustrative). It never auto-prefixes. Application workarounds: a shorter path, `subst`, or a junction used consistently. Verified on a host with `LongPathsEnabled=1`; not verified with it disabled or with 8.3 names disabled.

### Binary provenance (A15, amended by F)

- Advisory only: never blocking by default. Result is exposed as `binary.verification`.
- Option `binaryVerification: 'advisory' | 'strict'`, default `'advisory'` (K9, 06 §K).
- Advisory mode checks the SHA-256 digest table only (K8): a committed table for the tested version window, derived from npm integrity and the published `manifest.json` checksums and updated by the version-bump PR, plus digests supplied by the application. Nothing is fetched at run time. The linux-x64 and win32-x64 digests were verified in the spike (05 §1).
- Strict mode runs the OS signature check first (Authenticode on Windows via `Get-AuthenticodeSignature` through absolute-path PowerShell; `/usr/bin/codesign --verify` on macOS; a Gatekeeper/quarantine spawn failure is mapped to a named cause), then the digest table, and refuses anything that is not `verified`. The OS check runs only in strict mode because it is slow (K8).
- Resolve launcher symlinks (and the native-installer layout `~/.local/bin/claude[.exe]` -> `~/.local/share/claude/versions/<ver>`, 01 §4.1) to the real binary before verifying.
- Process identity (J9, 07 §4): `initialize.pid` equals the spawned pid only when the native binary is spawned directly; behind a launcher (for example the npm fallback `cli-wrapper.cjs` shape, a shell shim, a user-supplied launcher) it is the real CLI, a child of the spawned process. hudhud always uses the pid it spawned, plus its start time, as the process identity for containment ([ADR-0009](0009-process-layer-windows.md), [ADR-0010](0010-process-layer-posix.md)); the launcher's whole tree is covered by the job or by the descendant snapshot from the spawned pid. `initialize.pid` is informational, and a mismatch is reported as a diagnostic (launcher detected). `system/init` carries no pid.
- Opt-in strict mode (`binaryVerification: 'strict'`): refuse to run when verification does not succeed. It is reported in `securityPosture`.
- Signals behind a launcher: see [ADR-0010](0010-process-layer-posix.md) (K1); identity stays the spawned pid.

## Alternatives considered

- Resolve the binary with `PATH` lookup only. Rejected: planting risk (02 §10 item 9).
- Accept `.cmd` shims with `shell: true`. Rejected: BatBadBut.
- Hard-block when hash or signature verification fails. Rejected as default (A15): the user installs and updates the CLI, and Anthropic's native auto-update changes it; blocking by default would break legitimate installs. Offered as opt-in.
- Rely on hash only, or signature only. Rejected: signatures are the stronger OS-native check but not on every platform; the manifest hash is the portable fallback.
- Version probe by running `claude -v` before every session (as Python does). Not required: `initialize.claude_code_version` is available after spawn, and `claude --version` makes zero network requests (05 §1) should a pre-flight check be wanted.
- 1 MiB frame cap (Python). Rejected: too small (05 §11). Unbounded buffering (TS). Rejected: memory exhaustion (02 §3).
- Passing large values through argv. Rejected: Windows command-line limits (02 §2.4).
- A pre-`dlopen` sha256 check as a security boundary for the Windows addon. Defence in depth only ([ADR-0009](0009-process-layer-windows.md)).

## Consequences

- Provenance results can be `unverified` (no signature, no manifest available); the application decides whether to treat that as an error.
- Strict `--flag=value` formatting must be applied at the single point where argv is built, covered by tests that include dash-leading and comma-containing values.
- Digests are delivered as a committed table for the tested window plus application-supplied digests (K8); a CLI version outside the table is `unverified` in advisory mode. Only SDK-package checksums have been observed (05 §1).

## Evidence

- 02 §2.2-§2.4, §3, §8, §10 items 2, 3, 6, 7, 9.
- 05 §1 (hash verification), §11 (frame sizes and encoding), §5 (`initialize.pid`).
- 07 §4 (`initialize.pid` versus spawned pid), §6 (Windows long-path cwd); 06 §J9-J10.
- 01 §4.1 (binary layout and auto-update), §7 (Windows specifics).
