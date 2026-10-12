# ADR-0002: Execution modes and the every-way registry

- Status: Accepted
- Date: 2026-10-12
- Negotiation log items: R2, A19, B2 (06 header, §A, §B, §C round 3)
- Related: [ADR-0003](0003-public-api.md), [ADR-0007](0007-event-delivery-backpressure-timeouts.md), [ADR-0018](0018-scope-and-roadmap.md)

## Context

Owner rule R2: "Provide every way". Anything doable more than one way is offered in all ways, first-class. The default is the most stable, professional and safe option; the library is simple by default and fully customizable.

The Claude Code CLI itself offers many ways to do the same thing (01 §5): run non-interactively (`-p`, piped stdin, stream-json input, background sessions), get results (text/json/stream-json output, transcripts, hooks), handle permissions (modes, rules, MCP prompt tool, stdio control protocol, hooks), pass configuration, continue sessions, stop a run, and authenticate.

"First-class" needs a testable meaning, otherwise R2 turns into untested surface.

## Decision

### 1. First-class is operational

A way is first-class only if all four hold. Otherwise it is not shipped.

1. Golden fixtures cover it ([ADR-0013](0013-testing-strategy.md)).
2. The canary exercises it against new CLI versions.
3. The adapter declares it as a capability (see capability model in [architecture.md](../architecture.md#capability-model)).
4. It is documented, including its default and how to opt in or out.

### 2. The registry

hudhud maintains an every-way registry: a table in the documentation with one row per goal and, per way, the option that selects it, whether it is the default, its capability string, and its fixture and canary coverage. The registry is a release artifact: a way without all four columns filled in does not ship. The initial rows are the decisions already recorded in the negotiation log:

| Goal | Ways offered | Default |
|---|---|---|
| Claude Code backend | `native`; `agent-sdk` (optional peer) | `native` (confirmed; `agent-sdk` from v1.1, see [ADR-0001](0001-foundation-and-backends.md)) |
| Process source | local spawn; custom spawner (duplex stream) | local spawn |
| Session shape | long-lived multi-turn Session; one-shot (capability-degraded Session) | long-lived Session |
| Stop | drain (`close`); abort (`dispose`, `AbortSignal`, `turn.interrupt()` for one turn) | n/a (explicit calls) |
| Environment | preset `'harness'`; `'inherit'`; explicit map | `'harness'` |
| Config sources / trust | `workspaceTrust` `'none'` \| `'context'` \| `'full'` (harness-neutral); `claudeCode.settingSources` (Claude-Code-specific; setting both is a validation error) | `'none'` (`['user']`) |
| Config isolation | user's real config dir (never-write); isolated `CLAUDE_CONFIG_DIR`; `--bare` | real config dir |
| Permissions | explicit `--permission-mode`; stdio prompt handler; (later) hooks | mode always explicit; stdio only when a handler is supplied |
| Event overflow | `'error'`; `'drop-oldest-with-gap-marker'`; `'block'` | `'error'` per subscriber |
| Oversized frame | `'fail'`; `'skip'` | `'fail'` |
| Auth failure | `'fail-fast'`; `'harness-retry'` | `'fail-fast'` where applicable ([ADR-0012](0012-security-defaults-and-trust.md)) |
| Process containment | Windows job; POSIX best-effort sweep; (later) cgroup | best available, reported as capability |
| Binary resolution | explicit path; discovery | see [ADR-0011](0011-spawn-hygiene-and-binary-provenance.md) |

The registry is not exhaustive today. Rows are added as features are designed; this ADR fixes the rule, not the final row set.

### 3. One-shot is a capability-degraded Session (B2 = option i)

The one-shot form (`-p` with text or json output) uses the same `Session` type with degraded capabilities, not a separate `Harness.run()` sibling operation. `multiTurn` is emulated via `--resume`. hudhud always generates and passes `--session-id` ([ADR-0008](0008-turn-and-lifecycle-semantics.md)), which makes the emulation addressable. One-shot ships in v1.1 ([ADR-0018](0018-scope-and-roadmap.md)).

## Alternatives considered

- Separate `Harness.run() -> OneShotResult` operation (B2 option ii). Rejected in round 3: two result types and two lifecycles for one harness, versus one `Session` whose capabilities say what is degraded.
- Offer every flag the CLI has as a typed option. Rejected [derived]: violates "first-class is operational"; flags without fixtures and canary coverage are only reachable through the harness-namespaced options or the unstable `/raw` tier ([ADR-0003](0003-public-api.md)).
- Only one way per goal. Rejected: violates R2.

## Consequences

- Each new option has a recurring cost: fixtures, canary, docs. This is deliberate; it is the price of R2.
- Adapters must be able to report `unsupported` and `emulated` honestly; capability negotiation is part of the public API.
- The registry doubles as a checklist for reviewing PRs that add options.

## Evidence

- 01 §5 (multiple ways to do the same thing), §1 (flags).
- 03 §5 item 5 (capability negotiation, tri-state), §4 (common denominator versus divergence).
- 05 §4 (stream-json behaves the same with and without `-p`), §9 (exit codes).
