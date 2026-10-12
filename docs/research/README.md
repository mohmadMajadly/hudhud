# Research snapshots

These files are point-in-time research snapshots dated 2026-10-12. They record what was read, run and measured while the hudhud architecture was being decided. They are kept as evidence, not as specification.

| File | Content |
|---|---|
| [01-claude-code-cli.md](01-claude-code-cli.md) | Programmatic surface of the Claude Code CLI (flags, wire protocol, exit codes, state per OS), CLI 2.1.296 |
| [02-agent-sdk-internals.md](02-agent-sdk-internals.md) | Claude Agent SDK internals: how the SDKs spawn and drive the CLI, control-protocol catalog, licensing, security observations |
| [03-harness-landscape.md](03-harness-landscape.md) | Other harnesses, ACP and other standards, prior art, event-model design practices |
| [04-ci-economy.md](04-ci-economy.md) | GitHub Actions billing facts and risk-tiered CI design |
| [05-empirical-cli.md](05-empirical-cli.md) | Spike results against pinned, hash-verified CLI binaries and a local mock API (Windows and Linux) |
| [06-architecture-negotiation.md](06-architecture-negotiation.md) | The architecture negotiation log. Its section G overrides F, F overrides E/B/A where they conflict; section J records the lead resolutions after the pre-v1 spikes |
| [07-pre-v1-spikes.md](07-pre-v1-spikes.md) | Pre-v1 spike results against the pinned CLI 2.1.296 (resume/fork, host crash, nonessential traffic, pid, concurrency, long paths, background ceiling, hook timeout, project env base URL, workspaceTrust; Windows and Linux, no macOS) |

Rules for reading them:

- The ADRs in [../adr/](../adr/README.md) and [../architecture.md](../architecture.md) are authoritative. Where a snapshot and an ADR disagree, the ADR wins. Several snapshot statements were superseded later in the negotiation (for example the POSIX process-group kill in 06 A12, replaced by the ladder in 06 F and ADR-0010).
- Items marked UNVERIFIED in a snapshot were not verified at the time; the ADRs repeat that status wherever they depend on such an item.
- Snapshots were sanitized for publication: local absolute paths are replaced by placeholders (`<home>`, `<scratch>`, `<C>`), the local username is replaced by `<user>`, a personal skill name by `<user-skill>`, and the fake test API key by `<fake-key>`. Technical content is otherwise unchanged. Paths such as `S/sandbox/...` inside the reports refer to a scratch workspace that is not part of this repository.
- Section numbers cited by the ADRs are the numbers of the actual headings in each snapshot. Some snapshots contain internal cross-references that do not match their own headings (for example 05 §0 row 10 points to "§10" for the isolation recipe, which is 05 §13.2).
