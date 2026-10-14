# Contributing to hudhud

hudhud is security-sensitive: other sensitive projects build on it. Quality and security come before speed, and no rule is weakened to get a check green. The design is fixed in [docs/](docs/architecture.md); changes to it go through an ADR.

## Setup

Requirements:

- Node.js 22.13 or newer for the tooling (pnpm 11 and ESLint 10 require it). The published packages support Node `>=22.12.0`. [.nvmrc](.nvmrc) selects the latest Node 22.
- pnpm, exactly the version in the `packageManager` field of [package.json](package.json). A different version is refused (`pmOnFail: error`).
- Git. On Windows, Git for Windows (its `sh` runs the hooks). In deep checkout paths, `git clean -xfd` cannot delete parts of `node_modules` unless long paths are enabled: `git -c core.longPaths=true clean -xfd`.

```sh
pnpm install --frozen-lockfile
pnpm hooks:install
pnpm check
```

`pnpm install` never runs dependency install scripts: `allowBuilds` allows none and `strictDepBuilds` makes any dependency that wants one fail the install. Its single entry, `esbuild: false`, is an explicit deny (K14): esbuild takes its binary from its optional platform package (`@esbuild/<platform>-<arch>`), so its postinstall is never needed. This was verified on Windows and Linux.

The workspace has the published packages under `packages/` and private repository tooling under `tooling/` (for example `@hudhud/test-support`). Published sources never import `tooling/`. A workspace package imports another one only when its own `package.json` declares it (`dependencies` for `src/`, also `devDependencies` for tests); dependency-cruiser enforces this (`workspace-deps-declared`).

## Git hooks and the privacy gate

The tracked hooks live in [.githooks/](.githooks/). pnpm blocks lifecycle scripts by design, so there is no `prepare` or `postinstall` that installs them; enable them once per clone:

```sh
pnpm hooks:install   # runs: git config core.hooksPath .githooks
```

The pre-commit hook runs the privacy gate on the staged changes (added lines and new file names) and blocks the commit on any finding:

- home-directory paths (`C:\Users\<name>`, `/Users/<name>`, `/home/<name>`, MSYS and WSL forms);
- e-mail addresses, except `noreply@anthropic.com` and `*@users.noreply.github.com`;
- credentials: Anthropic, GitHub, AWS, npm, Slack and Google key formats, private key headers, literal `_authToken=` values; the one exception is the test launcher's fake key, the prefix `sk-ant-fake-hudhud-` followed by letters and digits only (it authenticates nowhere; every other `sk-ant-` string is still a finding);
- terms from your private denylist.

The denylist holds your user names and anything else that must never be committed. It is never committed itself. Put one term per line (at least 3 characters, `#` starts a comment) in `.git/info/privacy-denylist`, or point `HUDHUD_PRIVACY_DENYLIST` at a file outside the repository. Findings never print a denylist term.

Run the gate by hand with `pnpm privacy:staged` (index) or `pnpm privacy:tree` (every tracked and untracked, unignored file). CI runs the tree scan as part of `pnpm check`. Commit author metadata is not scanned. If the gate flags something, remove it; do not bypass the hook with `--no-verify`.

## Checks

`pnpm check` runs, in order:

| Step                | Command              | What it enforces                                                                                                                                                                                                     |
| ------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format              | `pnpm format:check`  | Prettier                                                                                                                                                                                                             |
| Schemas             | `pnpm schema:check`  | the committed JSON Schemas and generated validators equal a fresh `pnpm schema:build` byte for byte                                                                                                                  |
| Schema evolution    | `pnpm schema:diff`   | schemas changed additively only against `schemas/.baseline/` (ADR-0005)                                                                                                                                              |
| Build and typecheck | `pnpm build`         | `tsc --build`, maximal strictness, project references                                                                                                                                                                |
| No Ajv at run time  | `pnpm check:no-ajv`  | no built file under `packages/*/dist` imports Ajv (validators are precompiled)                                                                                                                                       |
| Lint                | `pnpm lint`          | ESLint with typescript-eslint `strict-type-checked` and `stylistic-type-checked`; sans-IO rules for `packages/core/src/protocol/` and `packages/claude-code/src/protocol/`; integration tests use `testConnect` only |
| Markdown            | `pnpm lint:md`       | markdownlint and an offline link and anchor checker                                                                                                                                                                  |
| Layers              | `pnpm depcruise`     | dependency-cruiser: the layer rules of the [v1 plan §1.2](docs/plan/v1-implementation.md#12-layering-dependency-cruiser-and-eslint), tested by `scripts/test/depcruise-rules.test.ts`                                |
| Tests               | `pnpm test:coverage` | Vitest projects `unit`, `conformance`, `scripts` with 100 % v8 coverage thresholds over `packages/*/src`, `tooling/*/src` and `scripts/lib`; `integration` runs separately                                           |
| API                 | `pnpm api:check`     | API Extractor reports under `packages/*/api/` match the build                                                                                                                                                        |
| Privacy             | `pnpm privacy:tree`  | the privacy gate over the whole tree                                                                                                                                                                                 |

`pnpm check:full` runs `pnpm check` and then `pnpm cli:fetch`, which fetches, verifies and caches the pinned Claude Code CLI for the integration tests under `.cache/claude-cli` (plan §4.6; it downloads from `registry.npmjs.org` and never runs the binary). Integration and tarball checks join `check:full` when they land. Until then the integration suites run with `pnpm build` and `pnpm vitest run --project integration` after `pnpm cli:fetch`; on Windows set `HUDHUD_TEST_ROOT` to a directory outside your user profile first (plan §1.11 describes the harness and how to write a suite).

It must pass from a clean clone on Windows and Linux. To check Linux from Windows or macOS, run it in a throw-away `node:22` container on a copy of the repository, never on your working copy or host pnpm store.

The design documents under `docs/` are covered by the link checker and the privacy scan but not yet by markdownlint or Prettier: they predate the tooling and have open lint findings. Bringing them in is a separate, owner-reviewed change.

## Public API changes

Every entry point in a package's `exports` map has an API Extractor config and a committed report. After an intended API change, run `pnpm build && pnpm api:update`, review the diff of `packages/*/api/*.api.md`, and commit it with the change. `pnpm api:check` fails on any unreviewed difference, on an exported entry point without a config, and on a report without a config. JSON subpaths such as `./schemas/*` are data and have no report; a package without `exports` is skipped unless it has configs or reports.

## Releases and changesets

Changes to a package's behaviour or API need a changeset (`pnpm changeset`). All packages are `private` while the repository is private; nothing is published.

## Dependencies

- Every third-party version lives once, as an exact pin, in the `catalog` of [pnpm-workspace.yaml](pnpm-workspace.yaml); manifests use `catalog:` (`catalogMode: strict`).
- `minimumReleaseAge: 10080`: versions younger than 7 days are not installed. `trustPolicy: no-downgrade` refuses versions with weaker provenance than earlier ones. Exceptions are exact-version entries with a written reason.
- Review the lockfile diff for unexpected packages before committing it.

## Commits

- Conventional Commits (`feat:`, `fix:`, `build:`, `ci:`, `docs:`, `test:`, `refactor:`, `chore:`), imperative subject, body explaining why.
- One logical change per commit; the hooks must pass.
- Never use `[skip ci]`: it bypasses the CI classifier.

## CI

CI follows [ADR-0014](docs/adr/0014-ci-strategy.md). A unit-tested classifier ([scripts/lib/ci-classify.mjs](scripts/lib/ci-classify.mjs)) picks the tier; anything it cannot prove safe is FULL:

| Tier     | When                                                                                           | Jobs                                                                           |
| -------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| LIGHT    | pull request or push to `main` touching only `docs/**`, `README.md`, `CHANGELOG.md`, `LICENSE` | Markdown and link check, privacy scan                                          |
| STANDARD | other draft pull requests, manual runs                                                         | `pnpm check` on Linux, Node 22                                                 |
| FULL     | ready pull requests, label `full-ci`, other pushes to `main`, tags, merge queue, `full=true`   | `pnpm check` on Linux (Node 22, 24, 26), then Windows and macOS (darwin-arm64) |

Keep pull requests in draft while iterating to save minutes, and mark them ready for review to get the full matrix. The `full-ci` label takes effect on the next push. `ci-gate` is the only required check. A nightly run repeats FULL only when a new Claude Code CLI version was published.
