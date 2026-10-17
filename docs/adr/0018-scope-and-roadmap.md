# ADR-0018: Scope, roadmap and pre-v1 gates

- Status: Accepted. The G4 spikes are done (07, 06 §J); the macOS gate passed on 2026-10-16 ([research 11](../research/11-macos-gate-run3.md)); the Windows addon is built (plan §6), its release phases remain.
- Date: 2026-10-12
- Negotiation log items: A19, F (A19: resume/fork gated), G3, G4, G5 (06 §A, §F, §G)
- Related: all other ADRs

## Context

The owner requires quality and security above time (R1), and "first-class" is operational: fixtures, canary, capability declaration, docs, or the feature is not shipped ([ADR-0002](0002-execution-modes-and-every-way-registry.md)). Several behaviours were not covered by the spike (05 §16: `--resume` matrix, SDK-MCP, hooks over stdio, `--output-format json`, macOS).

## Decision

### v1

Spawn and handshake; send and stream; permissions; interrupt; resume/fork (spike green on Windows and Linux, 07 §1; macOS confirmed by the gate, research 11 §3); shutdown (drain and abort); capabilities; errors; subscriptions; best-effort containment (`processContainment: 'job'` on Windows once the addon exists, otherwise `'best-effort'`; POSIX `'best-effort'`). The Windows addon is a criterion for 1.0 ([ADR-0009](0009-process-layer-windows.md)). The `native` backend only. Sans-IO core with loopback binding ([ADR-0006](0006-sans-io-core-and-daemon-readiness.md)).

### v1.1

The `agent-sdk` backend and the SDK differential oracle ([ADR-0001](0001-foundation-and-backends.md), [ADR-0013](0013-testing-strategy.md)); hooks; in-process tools (a minimal MCP subset over `mcp_message`, plus a pluggable full MCP server); one-shot as a degraded Session ([ADR-0002](0002-execution-modes-and-every-way-registry.md)).

### Later

Session-file reading; prewarm; daemon with generated clients ([ADR-0006](0006-sans-io-core-and-daemon-readiness.md)); an ACP client adapter; an ACP facade (the core vocabulary already mirrors ACP where sound, [ADR-0003](0003-public-api.md)); a cgroup spawner (planned v1.x, `processContainment: 'cgroup'`, [ADR-0010](0010-process-layer-posix.md)); a possible darwin libproc addon; process-layer follow-ups of the pre-release review (2026-10-17): handle-based termination on Windows (an addon export that opens the pid, compares its creation time and calls `TerminateProcess` on that same handle, for sweeps when the addon is loaded but the job path failed; it closes the measured window of R2-5, [ADR-0009](0009-process-layer-windows.md)), a named macOS Gatekeeper/quarantine spawn cause and a darwin `keychain-prompt-suspected` hint on the first-frame watchdog, both only if a macOS release makes them reachable (R3-3; the gate saw neither, research 11); additional harness adapters (03 §7 lists Codex, opencode and a generic ACP client as candidates; none is committed by the log).

### Pre-v1 spike list (G4)

All eight spikes are done on Windows and Linux (research 07, 2026-10-12; lead resolutions in 06 §J). macOS was not available and is covered by the macOS gate below.

| # | Spike | Result | Resolution |
|---|---|---|---|
| 1 | `--resume` / `--fork-session` matrix | done, 07 §1 | J6: no CLI session lock; hudhud guards within a Harness; `continue` reports `resumed: false`; `SessionNotFound`; resume/fork stay in v1 ([ADR-0008](0008-turn-and-lifecycle-semantics.md)) |
| 2 | Host-crash behaviour | done, 07 §2 | J8: Windows Node host loses the tool tree, so the job addon is required for crash cleanup too; Linux drains gracefully ([ADR-0009](0009-process-layer-windows.md), [ADR-0010](0010-process-layer-posix.md)) |
| 3 | E7 gate: nonessential-traffic default (G1) | done, 07 §3 | J1: default confirmed, policy-neutral; custom base URL disables managed policy ([ADR-0012](0012-security-defaults-and-trust.md)) |
| 4 | `initialize.pid` versus the spawned pid | done, 07 §4 | J9: identity is the spawned pid; mismatch is a diagnostic ([ADR-0011](0011-spawn-hygiene-and-binary-provenance.md)) |
| 5 | Concurrent sessions sharing a config directory | done, 07 §5 | J11: safe in steady state; fresh-dir first-write race only ([ADR-0013](0013-testing-strategy.md)) |
| 6 | Windows long-path cwd | done, 07 §6 | J10: `CwdTooLong` before spawn; never auto-prefix ([ADR-0011](0011-spawn-hygiene-and-binary-provenance.md)) |
| 7 | `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` | done, 07 §7 | J5: default 600000; does not bound background shells; own `closeTimeout` ([ADR-0008](0008-turn-and-lifecycle-semantics.md)) |
| 8 | Hook timeout unit and default (E9) | done, 07 §8 | J4: seconds; callback default 600 s; fail-closed ([ADR-0007](0007-event-delivery-backpressure-timeouts.md)) |

Additional gates stated elsewhere in the log, not in the G4 list:

- Windows job addon: mostly de-risked by 05 §10 (nesting, inheritance, job-close kill, assign before the first stdin write) and reinforced by 07 §2; remaining work is the addon implementation and the arm64 prebuild pipeline.
- `initialize.workspaceTrust` (B4): done, 07 §10 (J3). It is a persisted trust grant, not a loading filter; `'context'` stays unsupported in v1 and the CLI field is never sent by default.
- Project-env `ANTHROPIC_BASE_URL` (C3): done, 07 §9 (J2). VERIFIED exfiltration path; `'full'` carries the `projectCredentialEnv` guard ([ADR-0012](0012-security-defaults-and-trust.md)).
- Not covered by 05 or 07: `mcp_message` in-process MCP, hooks over stdio, `--output-format json` shape (needed before v1.1).

Not done in the pre-v1 spikes (07 §12): macOS; an OAuth/claude.ai login (no credential); Windows hosts other than Node/libuv for host crash; Windows hosts with `LongPathsEnabled=0` or 8.3 names disabled; the full 600 s expiry of a background subagent (derived from the constant and the 5 s behaviour).

### macOS gate (G3)

A one-off `workflow_dispatch` macOS spike before v1, then macOS on the FULL tier only ([ADR-0014](0014-ci-strategy.md)). The seven-item gate list is ratified and recorded in [ADR-0014](0014-ci-strategy.md#macos-gate-list-ratified).

## Alternatives considered

- Shipping hooks and in-process tools in v1. Not chosen (A19): untested over stdio (05 §16); each is first-class only with fixtures and canary coverage.
- Making the Windows addon a v1.x item. Not chosen: it is a 1.0 criterion, because Windows `TerminateProcess` orphans tool trees (05 §10).
- A native cgroup spawner in v1. Deferred (F): not universally available.
- Shipping resume/fork unconditionally. Rejected (F): untested.
- Delaying the daemon design. Not delayed: the boundary rules apply from v1 so the daemon is a later binding, not a rewrite.

## Consequences

- v1 exit criteria are spike results, not dates.
- The v1 capability list may shrink at 1.0 if a spike is red; the capability model reports it honestly (`unsupported`, `emulated`).

## Evidence

- 06 §A19, §F, §G3, §G4, §G5, §J.
- 07 §0 (spike summary), §12 (not done).
- 05 §16 (not covered), §10.
- 03 §7 (adapter kinds).
