# Compatibility

Claude Code releases often. hudhud does not refuse a version because it is new; it tells you how the version relates to the ones it was tested with, and refuses only versions that are known not to work with it ([ADR-0004](../adr/0004-packages-and-versioning.md#versioning-layers)).

## The tested window

`CLAUDE_CODE_COMPAT` (from `@hudhudjs/claude-code` and `hudhudjs`) holds the window of the installed hudhud version:

| Field         | Value in this version |
| ------------- | --------------------- |
| `minTested`   | `'2.1.296'`           |
| `maxTested`   | `'2.1.310'`           |
| `knownBroken` | `[]`                  |

The window spans several Claude Code releases, so the versions users actually have installed are covered, not only the newest. Every published release from `minTested` to `maxTested` was tested: in this version 2.1.296, 2.1.299 to 2.1.310 (2.1.297 and 2.1.298 were never published). For each of them hudhud carries the digests of the official binaries of every platform, so `binary.verification` is `'verified'` for any of them without `claudeCode.binaryDigests` ([Security](security.md#binary-verification)).

The window moves only with a reviewed hudhud release. It rolls: a new Claude Code release joins at the top once hudhud's integration suite passed against it on Linux, Windows and macOS, usually within a week of its publication, and releases older than about 30 days before the newest leave at the bottom ([ADR-0004](../adr/0004-packages-and-versioning.md#versioning-layers), rolling-window amendment).

## Changes of Claude Code inside the window

Some releases of the window change what Claude Code does by default. hudhud passes these changes through; none of them changes hudhud's API, permission handling, interrupt or containment:

- **2.1.304: tool search behind a custom `ANTHROPIC_BASE_URL`.** Claude Code now defers rarely used tools (for example `WebFetch`, `WebSearch`, `NotebookEdit`, the cron and worktree tools) behind its `ToolSearch` tool also when `ANTHROPIC_BASE_URL` names a gateway or proxy, as it already did against the Anthropic API. The model loads a deferred tool by name before it calls it; `ToolSearch` itself asks no permission. Tools removed with `claudeCode.disallowedTools` are neither offered nor loadable. A gateway that refuses tool search (HTTP 400 or 422) gets the request again without it, and Claude Code remembers that for a day. To turn tool search off, pass `ENABLE_TOOL_SEARCH=false` through `env` (for example `env: { preset: 'harness', add: { ENABLE_TOOL_SEARCH: 'false' } }`).
- **2.1.310: the `Monitor` tool, and long leading `sleep` refused.** The `Monitor` tool is on by default: it runs a command in the background and reports each line it prints. Its process behaves like a background shell: after the input ended, Claude Code waits for it, so `close()` ends at `closeTimeoutMs` and the termination ladder ends the process, and `dispose` interrupts; measured on Linux and on Windows with the job object, nothing of it survives either way, while Windows best effort leaves the same residual as for a background shell ([Sessions](sessions.md#close-drain), [Platforms](platforms.md#process-containment)). The Bash tool now refuses a foreground command that starts with `sleep N` for N of 25 seconds or more (the model gets a tool error pointing to `run_in_background` and `Monitor`), unless background tasks are disabled (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`).

## Status of the running version

`connect()` runs `claude --version` once and compares the version with the window. The result is `harness.compat` and the `compat` event at the start of every `events()` stream:

| `compat.status`  | Meaning                                               | Effect                                              |
| ---------------- | ----------------------------------------------------- | --------------------------------------------------- |
| `'tested'`       | Between `minTested` and `maxTested`                   | none                                                |
| `'untested'`     | Outside the window, or not a version hudhud can parse | A warning only: the session runs                    |
| `'known-broken'` | Listed in `knownBroken`                               | `connect` fails with `HARNESS_VERSION_KNOWN_BROKEN` |

Check `compat.status` at start and log or surface `'untested'`: the version may behave differently from the tested ones. Each session started on an untested version also publishes the diagnostic `compat.untested` among its start diagnostics (`data` is the `compat` object), so an application that only watches diagnostics sees the warning too ([Diagnostics](diagnostics.md#start-and-configuration)). hudhud does not refuse an untested version: Claude Code updates itself daily, and a refusal would stop every user between a release of Claude Code and the next release of hudhud.

A known-broken version can still be run with `claudeCode.dangerouslyAllowKnownBrokenVersion: true`. The `compat` status stays `'known-broken'`, the setting appears in the security posture, and the error's `details.reason` (when refused) carries the reviewed reason for the listing.

hudhud detects features from what Claude Code announces at start (`session.info.features`), not from the version number.

## Version drift

The binary can change between `connect()` and a session, for example through an update in place. Each session compares the version Claude Code reports at start with the one `connect()` probed:

- any difference publishes a `binary.version-changed` diagnostic (`probedVersion`, `version`);
- a session that finds the binary file changed before it starts verifies and probes it again first, and reports the change the same way (`reverified: true`);
- a drift to a known-broken version fails the session's start with `HARNESS_VERSION_KNOWN_BROKEN`, unless the opt-in above is set.

`harness.binary` and `harness.compat` keep describing what `connect()` found. Keep `autoUpdate: 'disabled'` (the default) to avoid updates while sessions run.

## hudhud's own versions

- The packages follow semantic versioning. The stable API is everything exported from `hudhudjs`, `@hudhudjs/core` and `@hudhudjs/claude-code` except the few adapter-author items tagged `@beta` (`defineAdapter`, `buildPosture`), plus `sanitizeForDisplay`, `parseErrorData` and `isRetryable` from `@hudhudjs/core/protocol`, and the schemas; the `claudeCode` options are versioned with the Claude Code adapter. The other subpaths of `@hudhudjs/core` (`/binding`, `/process`, the rest of `/protocol`) are beta: for adapter authors, and they may change in a minor version. `@hudhudjs/conformance` is test data: the types of its index are stable, its streams are not (they are exactly what the conformance suite of the same version asserts, so pin it at the version of `@hudhudjs/claude-code`).
- `@hudhudjs/claude-code/raw` is exempt from compatibility promises ([The raw tier](raw.md)).
- Fields and types whose names start with `x-` are experimental and exempt as well.
- Event types and fields are only ever added within a major version; removing one is a major change. Code that reads events must skip unknown types ([Events](events.md#reading-events-in-typescript)). Values from a fixed list in events, results, capabilities and binary information (for example `permission.resolved`'s `by`) are open: a minor version may add values, so handle unknown ones too.
- `wireSchemaVersion` (currently `1`) versions the JSON model of events, errors, capabilities and the security posture (the schemas under `@hudhudjs/core/schemas/`), independent of the package version; it changes only on a breaking change. `adapterApiVersion` (currently `1`) is the contract between the core and harness adapters.
- `hudhudjs` depends on exact versions of the other two packages. When you install `@hudhudjs/core` or `@hudhudjs/claude-code` next to it (for a subpath), use the same version.
