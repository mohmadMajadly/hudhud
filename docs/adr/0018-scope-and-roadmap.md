# ADR-0018: Scope, roadmap and pre-v1 gates

- Status: Accepted. Several v1 items are conditional on spikes (listed below).
- Date: 2026-10-12
- Negotiation log items: A19, F (A19: resume/fork gated), G3, G4, G5 (06 §A, §F, §G)
- Related: all other ADRs

## Context

The owner requires quality and security above time (R1), and "first-class" is operational: fixtures, canary, capability declaration, docs, or the feature is not shipped ([ADR-0002](0002-execution-modes-and-every-way-registry.md)). Several behaviours were not covered by the spike (05 §16: `--resume` matrix, SDK-MCP, hooks over stdio, `--output-format json`, macOS).

## Decision

### v1

Spawn and handshake; send and stream; permissions; interrupt; resume/fork (gated: only if the resume/fork spike is green); shutdown (drain and abort); capabilities; errors; subscriptions; best-effort containment (`processContainment: 'job'` on Windows once the addon exists, otherwise `'best-effort'`; POSIX `'best-effort'`). The Windows addon is a criterion for 1.0 ([ADR-0009](0009-process-layer-windows.md)). The `native` backend only. Sans-IO core with loopback binding ([ADR-0006](0006-sans-io-core-and-daemon-readiness.md)).

### v1.1

The `agent-sdk` backend and the SDK differential oracle ([ADR-0001](0001-foundation-and-backends.md), [ADR-0013](0013-testing-strategy.md)); hooks; in-process tools (a minimal MCP subset over `mcp_message`, plus a pluggable full MCP server); one-shot as a degraded Session ([ADR-0002](0002-execution-modes-and-every-way-registry.md)).

### Later

Session-file reading; prewarm; daemon with generated clients ([ADR-0006](0006-sans-io-core-and-daemon-readiness.md)); an ACP client adapter; an ACP facade (the core vocabulary already mirrors ACP where sound, [ADR-0003](0003-public-api.md)); a cgroup spawner (planned v1.x, `processContainment: 'cgroup'`, [ADR-0010](0010-process-layer-posix.md)); a possible darwin libproc addon; additional harness adapters (03 §7 lists Codex, opencode and a generic ACP client as candidates; none is committed by the log).

### Pre-v1 spike list (G4)

1. `--resume` / `--fork-session` matrix (also gates resume/fork in v1).
2. Host-crash behaviour: what the CLI does on EOF/EPIPE when the host dies.
3. E7 gate: nonessential-traffic default (G1 a/b, [ADR-0012](0012-security-defaults-and-trust.md)).
4. `initialize.pid` versus the spawned pid with a native launcher.
5. Concurrent sessions sharing a config directory.
6. Windows long-path cwd.
7. `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` pinned ([ADR-0008](0008-turn-and-lifecycle-semantics.md)).
8. Hook timeout unit and default (E9, [ADR-0007](0007-event-delivery-backpressure-timeouts.md)).

Additional gates stated elsewhere in the log, not in the G4 list:

- Windows job addon: mostly de-risked by 05 §10 (nesting, inheritance, job-close kill, assign before the first stdin write); remaining work is the addon implementation and the arm64 prebuild pipeline.
- `initialize.workspaceTrust` (B4: `'context'` unsupported in v1; the spike would decide a later upgrade).
- Project-env `ANTHROPIC_BASE_URL` (C3, never tested; informs the threat model in [architecture.md](../architecture.md#security-model-and-threat-model)).
- Not covered by 05: `mcp_message` in-process MCP, hooks over stdio, `--output-format json` shape (needed before v1.1).

### macOS gate (G3)

A one-off `workflow_dispatch` macOS spike before v1, then macOS on the FULL tier only ([ADR-0014](0014-ci-strategy.md)). The seven-item gate list is ratified and recorded in [ADR-0014](0014-ci-strategy.md#macos-gate-list).

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

- 06 §A19, §F, §G3, §G4, §G5.
- 05 §16 (not covered), §10.
- 03 §7 (adapter kinds).
