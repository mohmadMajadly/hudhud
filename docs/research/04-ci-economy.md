# 04 - CI economy for hudhud (researched 2026-10-12)

Scope: read-only research. Web content treated as data. Items not confirmed in official docs are marked UNVERIFIED.

## 1. Billing facts (private repo, personal account)

Official: https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions and https://docs.github.com/en/billing/reference/actions-runner-pricing

| Item | Value | Status |
|---|---|---|
| Included minutes / month | Free 2,000; Pro 3,000; Team 3,000 (Enterprise Cloud 50,000) | official |
| Artifact/Packages storage included | Free 500 MB; Pro 1 GB | official |
| Cache included | 10 GB per repo; overage $0.07/GB-month | official |
| Artifact overage | $0.25/GB-month; deleting artifacts does not refund already accrued charges | official |
| Per-minute overage (after Jan 1 2026 cut) | Linux 2-core x64 $0.006; Linux arm64 $0.005; Linux 1-core $0.002; Windows 2-core $0.010; macOS 3/4-core $0.062 | official |
| Rounding | each job's time rounded UP to whole minute | official (pricing page) |
| Included-minute multipliers | Linux 1x, Windows 2x, macOS 10x | UNVERIFIED in current official docs (fetched billing pages show no multiplier table; only third-party blogs, e.g. https://bitrise.io/blog/post/best-github-actions-runners-in-2026-and-hidden-pricing-traps-to-avoid). Dollar ratios (0.010/0.006 = 1.7x, 0.062/0.006 = 10.3x) are consistent with macOS about 10x. Plan with 1/2/10 as conservative. |
| Larger runners | Always billed, blocked without payment method, do not use included minutes | official |
| Spending behavior | No payment method: usage blocked at quota. With one: governed by budgets. Emails at 90%/100% | official (https://docs.github.com/en/billing/concepts/product-billing/github-actions) |
| Hosted price change | Up to 39% cut effective 2026-01-01 | official: https://github.com/resources/insights/2026-pricing-changes-for-github-actions |
| Self-hosted runner platform fee ($0.002/min, planned 2026-03-01) | POSTPONED Dec 2025, no new date. "Never took effect" per secondary sources only (UNVERIFIED). Could return; re-check before relying on it | official postponement statement (same URL); https://www.theregister.com/2025/12/17/github_charge_dev_own_hardware/ |
| Public repos | standard hosted runners free (not applicable: hudhud is private) | official |

Key consequence: one 4-minute job per OS costs 4 (Linux) + 8 (Windows) + 40 (macOS) = 52 Linux-equivalent minutes. macOS is about 77% of a full matrix. On Free (2,000) that is about 38 full-matrix runs per month. Per-job rounding means a 61-second job bills 2 minutes, so many tiny jobs waste minutes, especially on macOS (each wasted macOS minute = 10).

## 2. Techniques (what works, what bites)

- paths / paths-ignore on the workflow: if the workflow is skipped by path filtering, its checks remain "Pending" and a required check blocks merge (https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax). A job skipped via `if:` reports "Skipped", which counts as passing. So do NOT path-filter the workflow providing required checks. Instead: an always-triggered workflow, a tiny classify job, and one aggregate "gate" job (`if: always()`) as the only required check, failing on any failed/cancelled need. dorny/paths-filter (https://github.com/dorny/paths-filter) can classify, but a repo-local script is better: unit-testable, no third-party code in a security-sensitive repo.
- Concurrency with cancel-in-progress per PR ref cancels superseded pushes. Do not cancel on main/schedule.
- Staged pipeline: cheap Linux gate (lint, typecheck, unit, build) first; Windows/macOS `needs:` it, so broken pushes never spend 2x/10x minutes.
- Full matrix on "ready for review" / merge queue, not every push; skip drafts. Merge queue needs the `merge_group` trigger or checks do not run (https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows). Availability for private repos on a personal account: UNVERIFIED (historically Team/Enterprise only). Fallback: full matrix on ready_for_review / label `full-ci`, plus push to main.
- Caching: key on lockfile hash + OS + Node version; restore-keys only same-OS prefix. Only main writes caches used by release jobs. Keep within the 10 GB.
- Consolidate: one job per OS doing install+lint+test+build avoids repeated setup and rounding waste. Never split macOS jobs.
- `timeout-minutes` on every job (default 360 - UNVERIFIED here but widely documented); set 10-15 so a hang cannot burn 3,600 equivalents on macOS.
- Test impact analysis: safe for docs/tests-only or dev-tooling changes with exact dependency graphs; unsafe for src of a security library (dynamic paths, crypto/platform behavior that static graphs miss, and OS-specific behavior is what the matrix exists for). Never use it for src, build, lockfile, CI. At most use it to order tests for fail-fast while still running everything.
- Scheduled full matrix as safety net: costs 52+/run, so run weekly, or only if main changed since the last full green run. Schedules run only on the default branch.
- `workflow_dispatch` input `full=true` for manual full runs on any ref.
- Local verification: run the Linux gate locally (Docker/npm) before pushing; `act` (https://github.com/nektos/act) approximates Linux jobs only, not Windows/macOS.
- Self-hosted runner on the user's PC: no minutes cost today (fee postponed), but it runs repo code with the user's privileges. Private repo with only the owner's PRs: moderate risk; public repo: dangerous (fork PRs run arbitrary code; GitHub advises against, see https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions). Covers only one OS (Windows here); macOS impossible. If used, ephemeral VM/container isolation. Optional, not core.

## 3. Provably safe skipping

Principles: (a) default-deny: anything not explicitly matched by a SAFE rule is FULL; (b) classification is a pure function of the changed-file list -> `scripts/ci-classify.mjs`; (c) its rules are unit-tested (table tests: each safe path -> LIGHT, each risky path -> FULL, unknown path -> FULL, empty list -> FULL, renames/deletes count both old and new path, odd paths (`..`, case variants, symlinks) -> FULL, diff computation failure or very large diff -> FULL); (d) the classifier and its tests are themselves in the FULL set; (e) a mixed PR takes the max tier of any file.

Always FULL: `src/**`, `.github/**`, `scripts/**` (incl. classifier), lockfiles, `package.json`, tsconfig*, bundler/test config, `.node-version`/`.nvmrc`, `*.config.*`, tests and fixtures (they define what is verified; coverage may only grow), native/binary files, submodules, anything unmatched.

LIGHT (docs only): explicit allowlist such as `docs/**`, `README.md`, `CHANGELOG.md`, `LICENSE`. Before listing any `*.md`, confirm no test or example-compilation reads it. LIGHT still runs a 1-2 min Linux markdown/link lint.

Cost-of-error mapping (matches the user's other project): LIGHT = trivially reversible, wrong => fixed on next push; FULL = behavior/security impact, expensive to find later. A post-merge full run on main catches any misclassification within minutes.

## 4. Pitfalls checklist

- Skipped required check blocks merge: use the aggregate gate; require only `ci-gate`.
- `[skip ci]` in a commit message skips workflows entirely (https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/skipping-workflow-runs), bypassing the classifier. Do not use it; optionally add a check rejecting it.
- Cache poisoning: do not restore PR-written caches in release/publish jobs; releases build from a clean install.
- `pull_request_target`: runs with base context and secrets; docs warn that running untrusted code on it may lead to vulnerabilities. Do not use it here; never check out PR head in it.
- Pin third-party actions to full commit SHAs; update with Dependabot.
- Least privilege: top-level `permissions: contents: read`, elevate per job; `persist-credentials: false` on checkout.
- Artifacts: `retention-days` 1-3, upload only on failure (storage allowance is 500 MB/1 GB).
- Billing guardrails: set a budget cap and keep 90% alerts.

## 5. Recommended design

Tiers (decided by `scripts/ci-classify.mjs`, unit-tested, default FULL):

| Tier | Trigger | Jobs | Est. cost (Linux-equiv min; 1/2/10, ~4 min/job) |
|---|---|---|---|
| LIGHT (docs-only PR) | pull_request | classify (1) + Linux lint/links (1-2) + gate (1) | 3-4 |
| STANDARD (any non-docs PR push, draft or not ready) | pull_request | classify (1) + one Linux job: install, lint, typecheck, build, all tests + coverage (~4) + gate (1) | ~6 |
| FULL (PR ready_for_review or label `full-ci`; merge queue if available; push to main; dispatch full=true; release tags) | Linux green first, then Windows (4x2=8) and macOS (4x10=40) | ~56 |
| Safety net | weekly cron, only if main changed since last full green | ~56, at most 4-5/month |

Job layout (single `ci.yml`, always triggers, no workflow-level path filter):
1. `classify` (ubuntu): fetch-depth 0, run classifier, output tier.
2. `linux`: whole pipeline in one job, timeout 10. LIGHT: lint only.
3. `windows`, `macos`: `needs: linux`, only when tier==FULL and event is ready/main/dispatch/schedule/tag; one consolidated job each, timeout 15, identical test command.
4. `ci-gate` (`if: always()`): fails on any failed/cancelled need, or if a FULL-required OS job was skipped. The only required check.
Also: concurrency `ci-${{ github.ref }}` cancel-in-progress for PRs only; permissions read-only; SHA-pinned actions; caches keyed lockfile+OS+Node; draft PRs run classify+linux only.

Budget example (Free 2,000): 25 STANDARD pushes (150) + 6 ready-PR full (336) + 6 main full (336) + 4 weekly (224) + 10 docs (40) = about 1,100/month with margin for reruns, versus 52 per push for a naive matrix on every push (about 38 pushes exhausts Free). Biggest lever: macOS only after Linux green and only at ready/main.

Quality preserved: every change reaching main is covered by the 3-OS matrix, tests/coverage unchanged, unknown change -> FULL.

Open items to verify before implementing: (1) actual plan (Free vs Pro) and usage in Billing > Usage; (2) multiplier table in current official docs; (3) merge queue availability for personal private repos; (4) measure real per-job durations and recompute the table.

## Sources
- https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions
- https://docs.github.com/en/billing/reference/actions-runner-pricing
- https://docs.github.com/en/billing/concepts/product-billing/github-actions
- https://github.com/resources/insights/2026-pricing-changes-for-github-actions
- https://www.theregister.com/2025/12/17/github_charge_dev_own_hardware/
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- https://bitrise.io/blog/post/best-github-actions-runners-in-2026-and-hidden-pricing-traps-to-avoid (third party, multipliers)
