# ADR-0013: Testing strategy

- Status: Accepted. The opt-in live suite is deferred (owner decision 2, 2026-10-12: no test credential exists yet).
- Date: 2026-10-12
- Negotiation log items: A16, F (A16), D14, D16, D12, R5 (06 header, §A, §D, §F)
- Related: [ADR-0005](0005-schema-and-validation.md), [ADR-0012](0012-security-defaults-and-trust.md), [ADR-0014](0014-ci-strategy.md)

## Context

The system under test is a closed-source binary that changes almost daily and talks to a paid API. Tests must be deterministic, free of real credentials, and must not let the CLI reach production by accident.

Spike findings that shape the design (05):

- The CLI can be pointed at a local mock API via `ANTHROPIC_BASE_URL`. With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` it makes only `POST /v1/messages?beta=true`; without the variable it also opens `CONNECT api.anthropic.com:443` directly, bypassing the base URL. A sandbox with real internet and without a trap would send traffic (and possibly the key) to production (05 §2).
- Requests carry 12 `anthropic-beta` values, mid-conversation `role:"system"` messages after tool results, and an `x-anthropic-billing-header` text block in the system prompt (D16, 05 §2).
- The auto-mode classifier never calls the mock and fails closed with a third-party base URL (05 §2, §6).
- With cwd under the user's home, `~/.claude` leaks as project config (05 §13.1).
- The Linux messaging socket needs a native-filesystem `TMPDIR` (05 §13).

## Decision

1. Mock API: an in-process Node server on `127.0.0.1`, running on all three OS runners. Docker is used only for local Linux runs (R5; services never installed on the host). The spike mock (zero dependencies, Docker image, 05 §2) is the prototype.
2. The mock implements an HTTP `CONNECT` trap: the CLI is launched with `HTTPS_PROXY` pointing at the mock and `NO_PROXY=<mock host>`; any attempt to reach a non-mock host is logged with its hostname and refused (403).
3. Tests always set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` AND use the CONNECT trap. Fake key only (`<fake-key>`). cwd outside the user's home tree and outside any `.claude`/`CLAUDE.md`/`.mcp.json` ancestor. `TMPDIR`/`CLAUDE_CODE_TMPDIR` on a native filesystem. `--setting-sources=` (empty) or explicit sources. Explicit `--permission-mode` (05 §13.2 recipe).
4. Request-shape structural snapshots of what the CLI sends to the mock. They are normalized (volatile values such as ids, timestamps, paths and version strings removed); a semantic change fails the test, an additive change warns.
5. Endpoint allowlist: the mock answers `POST /v1/messages?beta=true` (and any other path hudhud explicitly allows); every other path is logged and fails the test.
6. Mock responses are hand-authored, typed and validated against `@anthropic-ai/sdk` types (or a published specification if one exists). The response provider is pluggable.
7. Scenario matching uses markers in user-message text only (as in the spike, `[[mock:NAME k=v]]`), never positional assumptions: the mock must not assume the last message is `role:"user"` (D16).
8. Degradation-signal assertions: when the canary (below) goes red, the assertions classify the failure as `mock-inadequate` (the CLI sent something the mock cannot answer, for example a new endpoint or a new required response field) versus `protocol-regressed` (hudhud's expectations about frames are broken).
9. The CLI under test is pinned and hash-verified (npm integrity plus manifest SHA-256), as in the spike (05 §1).
10. Golden fixtures: recorded and hand-minimized frame sequences as language-neutral JSONL conformance suites ([ADR-0006](0006-sans-io-core-and-daemon-readiness.md)). They run against the sans-IO core without processes.
11. SDK differential oracle (from v1.1, together with the `agent-sdk` backend): the same scenarios are run through `@anthropic-ai/claude-agent-sdk` (optional peer, never vendored) and compared at the frame level with the `native` backend ([ADR-0001](0001-foundation-and-backends.md)).
12. Canary (amended by K16, 06 §K): the scheduled nightly downloads the newest published CLI version, records its registry `dist.integrity` and pins it for that run, verifies the tarball against that record, and runs the integration suite against it on Linux. A failure turns the run red, with a job summary (version, integrity, results, degradation classification). The nightly never re-runs the pinned version. A weekly scheduled canary additionally runs the integration suite on Windows, and on macOS once the macOS gate has passed (Windows only before that), against the newest CLI version whenever a version newer than the pinned one was published since the last weekly run, so every OS sees a new CLI within a week at bounded cost. Scheduled jobs hold no write tokens, so the canary opens no PRs; the lead prepares the version-bump PR locally ([ADR-0004](0004-packages-and-versioning.md), [ADR-0014](0014-ci-strategy.md)). Amendment (2026-10-18, rolling tested window, ADR-0004 §4): the canaries are also the admission tests of the window. A green nightly and weekly run on the newest release admits it. A manual dispatch can name any published release up to `latest` (ADR-0014 amendment 13), which admits the releases in between and runs `minTested` before each hudhud release. The integration harness judges `compat` and `binary.verification` by the committed window and digest table, so the same suites serve the pin, every admitted release and a newer, untested one.
13. Property-based tests with fast-check for the framer, the state machines, and the argv builder.
14. Windows CI is mandatory ([ADR-0014](0014-ci-strategy.md)); process-tree tests on Windows and Linux follow the spike (`tree` scenarios of 05 §10), including pid-plus-creation-time verification of survivors.
15. Opt-in live suite: only with an owner-provided dedicated credential (deferred by owner decision 2). Without it, no test calls the real API.
16. Mock robustness (J12, 07 §0.2, §11.5): the mock's CONNECT handler must survive a client that resets the socket during refusal (the spike mock crashed on this, with no socket `error` listener). A test for it is required.
17. Fresh config dirs (J11, 07 §5): concurrent sessions on a cold, never-initialized `CLAUDE_CONFIG_DIR` can hit a first-write race (a skipped global-config write). Test fixtures pre-initialize config dirs, or start one session first. Production is unaffected, because the real config dir exists; sharing it between concurrent sessions is safe in steady state.
18. Egress setting: the variable `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` also fixes feature-flag defaults, so tests and production use the same setting (07 §11 item 6).
19. Real-CLI runs on macOS (lead decision after macOS gate run 1, research 09): the pinned CLI calls `security(1)` on the login keychain even with an API key, and nothing in the sandbox isolates a developer's own keychain. Every real-CLI suite (integration, golden-fixture recordings, the macOS gate) is therefore refused by the test-support launcher on a local macOS host, with a message naming the opt-in, unless the run is on a GitHub-hosted runner (`CI=true` and `RUNNER_ENVIRONMENT=github-hosted`) or `HUDHUD_ALLOW_LOCAL_MACOS_REAL_CLI=1` is set. Tests that use a stand-in CLI are not affected.
20. A test timeout is a hang guard, not a performance budget (owner ruling, W3-Z): every Vitest project runs with a 60 s test and hook timeout; CPU-bound property tests keep their run counts; a test that needs a time bound asserts it with an injected clock. A test that fails for a reason other than its timeout is root-caused, not retried (for example a read count that a legal short read can change is replaced by the invariants the code guarantees).

## Alternatives considered

- Record/replay of real API traffic as the main defence. Not chosen as the main defence [derived]: recordings go stale at each CLI release, need real credentials to refresh, and cannot detect the CLI's changing behaviour toward unknown endpoints; the mock plus canary plus oracle gives continuous coverage. Golden fixtures (frames, not API traffic) are kept for the sans-IO core.
- Tests against the real API with the developer's own login. Rejected: R1/R6 (credentials, user's config) and cost.
- Docker-only mock on CI. Rejected: Windows and macOS runners cannot run Linux containers in the same way and the mock is simple enough to run in-process (R5 limits Docker to local Linux runs).
- Only `ANTHROPIC_BASE_URL` for egress control. Rejected: demonstrably bypassed (05 §2).
- Hard-coded positional matching in the mock. Rejected: breaks on new system messages (D16).
- Mocking at the SDK level instead of the CLI. Rejected: the CLI, not the SDK, is what hudhud drives.
- Running the oracle as the primary test. Rejected: the SDK is a different implementation under a different license; it is a comparison, not a specification.

## Consequences

- Maintaining the mock is a recurring cost; the `mock-inadequate` classification exists to keep that cost visible.
- The structural snapshots must be reviewed on every CLI bump; additive warnings are triaged during changelog review ([ADR-0004](0004-packages-and-versioning.md)).
- The test harness depends on the pinned CLI binaries and therefore on registry access; hash verification is part of the setup.
- Any test that forgets the CONNECT trap is a defect; the trap is part of the shared test launcher, not per-test.

## Evidence

- 05 §2 (mock, endpoints, headers, gotcha), §3 (sandbox env), §13.2 (sandbox recipe), §16 (reproducing).
- 07 §0.2 (TLS-terminating trap, mock fixes), §5 (concurrent sessions, cold config dir), §11 items 5-6; 06 §J11-J12.
- 04 §4 (cache and pitfalls for CI side).
- 02 §13 (open questions the spike answered), §8 (SDK as oracle).
