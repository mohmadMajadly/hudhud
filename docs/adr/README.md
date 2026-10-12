# Architecture decision records

MADR-style records for hudhud. Overview: [../architecture.md](../architecture.md). Evidence: [../research/](../research/README.md). Date of all records: 2026-10-12.

Status vocabulary: "Accepted" is decided; "Accepted — pending spike X" is decided but gated on the named spike; "pending owner decision N" refers to the open owner decisions in [../architecture.md](../architecture.md#open-owner-decisions).

| ADR | Title | Status | Negotiation log items |
|---|---|---|---|
| [0001](0001-foundation-and-backends.md) | Foundation and Claude Code backends (agent-sdk backend from v1.1) | Accepted | A1, A2 |
| [0002](0002-execution-modes-and-every-way-registry.md) | Execution modes and the every-way registry | Accepted | R2, A19, B2 |
| [0003](0003-public-api.md) | Public API shape | Accepted | A3, B2 |
| [0004](0004-packages-and-versioning.md) | Packages, versioning and adapterApiVersion | Accepted (names pending owner decision 3) | A4, A17, E4 |
| [0005](0005-schema-and-validation.md) | Schema and validation | Accepted | A5, E2, F |
| [0006](0006-sans-io-core-and-daemon-readiness.md) | Sans-IO core, serialization rules and daemon readiness | Accepted | A6, A7, E5 |
| [0007](0007-event-delivery-backpressure-timeouts.md) | Event delivery, backpressure and handler timeouts | Accepted (hook timeout unit pending spike G4) | A10, B3, B6, E9 |
| [0008](0008-turn-and-lifecycle-semantics.md) | Turn and lifecycle semantics | Accepted (ceiling value pending spike G4) | A11, E8, E10, F |
| [0009](0009-process-layer-windows.md) | Process layer on Windows | Accepted — pending addon spike | A13, B1, D6, D7 |
| [0010](0010-process-layer-posix.md) | Process layer on POSIX | Accepted — pending macOS gate (list ratified) | A12 (replaced), E1, F, D8 |
| [0011](0011-spawn-hygiene-and-binary-provenance.md) | Spawn hygiene and binary provenance | Accepted | A14, A15, E10 |
| [0012](0012-security-defaults-and-trust.md) | Security defaults, workspace trust and opt-in naming | Accepted — pending spike G1; pending owner decision 1 | A8, A9, B4, B5, E7, G1, G2 |
| [0013](0013-testing-strategy.md) | Testing strategy | Accepted (live suite pending owner decision 2) | A16 |
| [0014](0014-ci-strategy.md) | CI strategy | Accepted — pending macOS spike | R7, G3 |
| [0015](0015-legal-and-provenance.md) | Legal posture and code provenance | Accepted (legal review pending, owner decision 4) | A1, A2 |
| [0016](0016-observability.md) | Observability | Accepted | A18 |
| [0017](0017-toolchain.md) | Toolchain | Accepted | E3, E6, A4 |
| [0018](0018-scope-and-roadmap.md) | Scope, roadmap and pre-v1 gates | Accepted | A19, G3, G4 |

## Precedence used when reading the negotiation log

Section G overrides F; F overrides E, B and A where they conflict; B's round-3 resolutions override B's options; A12 is replaced by the E1 ladder as amended in F. Full details: [../research/06-architecture-negotiation.md](../research/06-architecture-negotiation.md).
