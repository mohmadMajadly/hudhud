# Security

Whoever controls Claude Code's input has the agent's full authority over the machine it runs on. hudhud therefore starts it with the safest settings that still work, makes every weaker setting an explicit option, and reports every deviation from the defaults ([ADR-0012](../adr/0012-security-defaults-and-trust.md)). Naming rule: boolean options that weaken a default start with `dangerously`; enum values that weaken one (`workspaceTrust: 'full'`, `env: 'inherit'`, `permissionMode: 'auto'`, `'harness-default'`) are named for what they do. Every one of them is listed in the security posture.

## The defaults

| Area                    | Default                                                                                                                   | Option to change it                                          | ADR                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Workspace configuration | Only the user's own settings are loaded; the repository's `.claude/` settings, `CLAUDE.md`, hooks and MCP servers are not | `workspaceTrust`, `claudeCode.settingSources`                | [0012 §2](../adr/0012-security-defaults-and-trust.md#2-setting-sources-and-workspace-trust-a9-b4-f) |
| Permission mode         | `default`, always passed explicitly                                                                                       | `permissionMode`, `dangerouslyAllowBypassPermissions`        | [0012 §3](../adr/0012-security-defaults-and-trust.md#3-permission-mode-and-prompting-a8-d3-d4)      |
| Permission questions    | Not sent to the application; Claude Code decides                                                                          | `onPermission`                                               | [0012 §3](../adr/0012-security-defaults-and-trust.md#3-permission-mode-and-prompting-a8-d3-d4)      |
| Settings writes         | Permission updates that would write settings files are removed                                                            | `dangerouslyAllowConfigWrites`                               | [0012 §3](../adr/0012-security-defaults-and-trust.md#3-permission-mode-and-prompting-a8-d3-d4)      |
| Environment             | An allowlist of the parent's variables (`'harness'`)                                                                      | `env`                                                        | [0012 §4](../adr/0012-security-defaults-and-trust.md#4-environment-a8)                              |
| Auto-update             | Off for the session (`DISABLE_AUTOUPDATER=1`)                                                                             | `autoUpdate: 'harness-default'`                              | [0012 §4](../adr/0012-security-defaults-and-trust.md#4-environment-a8)                              |
| Nonessential traffic    | Off (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`)                                                                        | `nonessentialTraffic: 'harness-default'`                     | [0012 §5](../adr/0012-security-defaults-and-trust.md#5-egress-and-nonessential-traffic-e7-g1)       |
| Config directory        | The user's real Claude Code config directory, never written by hudhud                                                     | `claudeCode.configDir`, `claudeCode.bare`                    | [0012 §1](../adr/0012-security-defaults-and-trust.md#1-config-posture-a8)                           |
| Binary verification     | `'advisory'`: digest checked and reported, never blocking                                                                 | `binaryVerification: 'strict'`, `claudeCode.binaryDigests`   | [0011](../adr/0011-spawn-hygiene-and-binary-provenance.md#binary-provenance-a15-amended-by-f)       |
| Known-broken versions   | Refused                                                                                                                   | `claudeCode.dangerouslyAllowKnownBrokenVersion`              | [0004](../adr/0004-packages-and-versioning.md#versioning-layers)                                    |
| Raw control frames      | Refused                                                                                                                   | `claudeCode.dangerouslyAllowRawControl`                      | [0012 §8](../adr/0012-security-defaults-and-trust.md#8-untrusted-text-and-frames)                   |
| Authentication failure  | A rejected API key or token fails the session at once                                                                     | `onAuthFailure: 'harness-retry'`                             | [0012 §6](../adr/0012-security-defaults-and-trust.md#6-authentication-failure-g2)                   |
| Frame size              | Output lines above 64 MiB fail the session; prompts above 32 MiB are refused                                              | `maxFrameBytes`, `onOversizedFrame`, `maxOutboundFrameBytes` | [0011](../adr/0011-spawn-hygiene-and-binary-provenance.md#spawn-a14)                                |

hudhud also never does these, whatever the options: it never sends Claude Code's persisted workspace-trust grant (`initialize.workspaceTrust`), never applies Claude Code's permission suggestions by itself, never passes `--dangerously-skip-permissions` or `--project-config-root`, never sets `CLAUDE_CODE_ENTRYPOINT`, never runs `.cmd` or `.bat` files or a shell, never edits or deletes the user's Claude Code configuration, credentials or transcripts, and has no login flow: it never collects, stores or proxies OAuth or claude.ai session tokens ([ADR-0015](../adr/0015-legal-and-provenance.md)).

## Security posture

`harness.securityPosture` lists every security-relevant setting of `connect()`, and each session publishes its own posture (connect and session settings together) as a `security.posture` diagnostic, which every `events()` subscriber receives in the replay at the start of its stream ([Events](events.md#what-a-new-subscriber-receives-first)). An entry has `setting`, `value`, `defaultValue` and `deviates`. Values are kinds and names, never secrets or paths.

```ts
for (const entry of postureDeviations(harness.securityPosture)) {
  console.log(`${entry.setting}: ${JSON.stringify(entry.value)}`);
}
```

Helpers from `@hudhudjs/core` (and `hudhudjs`): `postureDeviations(posture)` returns the entries that deviate, `postureEntry(posture, setting)` finds one, `serializePosture` and `parsePosture` convert to and from JSON, for example to store a posture with an audit record.

| Setting                                                                                     | Where            | Default                                                                         |
| ------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------- |
| `binaryVerification`                                                                        | Harness, session | `'advisory'`                                                                    |
| `claudeCode.configDir`                                                                      | Harness, session | `'user'` (`'isolated'` when set; never the path)                                |
| `claudeCode.bare`                                                                           | Harness, session | `false`                                                                         |
| `claudeCode.dangerouslyAllowRawControl`                                                     | Harness, session | `false`                                                                         |
| `claudeCode.dangerouslyAllowKnownBrokenVersion`                                             | Harness, session | `false`                                                                         |
| `managedPolicy`                                                                             | Harness, session | `'fetched-if-eligible'` ([below](#network-traffic-and-managed-policy))          |
| `raw.extraArgs`, `raw.extraEnv`                                                             | Harness, session | `[]` (flag and variable names only)                                             |
| `permissionMode`                                                                            | session          | `'default'`                                                                     |
| `dangerouslyAllowBypassPermissions`                                                         | session          | `false`                                                                         |
| `permissionPrompting`                                                                       | session          | `'none'` (`'stdio'` with `onPermission`)                                        |
| `workspaceTrust`                                                                            | session          | `'none'`                                                                        |
| `claudeCode.settingSources`                                                                 | session          | `['user']`                                                                      |
| `projectCredentialEnv`                                                                      | session          | `null`, or `'refuse'` when project settings load                                |
| `env`                                                                                       | session          | `'harness'` (an explicit map shows its names only)                              |
| `env.credentialAndRoutingVariables`                                                         | session          | `[]` (names of credential, routing, proxy and TLS variables you set explicitly) |
| `autoUpdate`                                                                                | session          | `'disabled'`                                                                    |
| `nonessentialTraffic`                                                                       | session          | `'disabled'`                                                                    |
| `dangerouslyAllowConfigWrites`                                                              | session          | `false`                                                                         |
| `claudeCode.allowedTools`, `claudeCode.disallowedTools`, `claudeCode.additionalDirectories` | session          | `[]`                                                                            |
| `initialize.workspaceTrust`                                                                 | session          | `'never-sent'` (fixed)                                                          |
| `permissionSuggestions`                                                                     | session          | `'never-applied'` (fixed)                                                       |

## Workspace trust

A repository can carry Claude Code configuration: `.claude/settings.json`, `.claude/settings.local.json`, `CLAUDE.md`, hooks, MCP servers and an `env` block. Claude Code loads all of it without any trust dialog as soon as project settings are enabled, and a project `env` can redirect every model request, with your API key, to another host ([ADR-0012](../adr/0012-security-defaults-and-trust.md#context)).

| `workspaceTrust`   | Loads                                                                                             | Support in v1                           |
| ------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `'none'` (default) | The user's settings only (`--setting-sources=user`)                                               | supported                               |
| `'full'`           | User, project and local settings, with the repository's hooks, MCP servers, `CLAUDE.md` and `env` | supported                               |
| `'context'`        | (repository context without executable configuration)                                             | not supported: `CAPABILITY_UNSUPPORTED` |

`'full'` is a normal, first-class choice when your application, and through it the user, trusts the repository it runs in ([ADR-0012](../adr/0012-security-defaults-and-trust.md#2-setting-sources-and-workspace-trust-a9-b4-f), owner decision 1). It is listed in the posture because it is not the default.

`claudeCode.settingSources` selects the sources directly (any of `'user'`, `'project'`, `'local'`) instead of `workspaceTrust`. Setting both is an `INVALID_OPTIONS` error. With `'none'`, a project under your home directory also cannot pick up the home directory's own `.claude` folder as if it were a project folder.

### The project credential guard

Whenever the setting sources include `project` or `local`, hudhud reads the repository's settings files before it starts Claude Code: `.claude/settings.json` and `.claude/settings.local.json` in the working directory, in the nearest git root and in the main worktree's root. If their `env` sets a credential, routing or TLS-trust variable, or if the file sets `apiKeyHelper`, or if a file cannot be evaluated, the session is refused with `PROJECT_CREDENTIAL_ENV`. The error names the files and the variable names, never values.

When the git root cannot be resolved (a symlinked `.git`, an unreadable or malformed `.git` file, an unreadable `gitdir` or `commondir`, or one on another host), the guard reads the settings files of the working directory and of every directory above it instead, and reports a `settings-guard.git-root-unresolved` diagnostic. That wider scan never reads your own Claude Code config directory (`claudeCode.configDir`, else the `CLAUDE_CONFIG_DIR` Claude Code runs with, else `~/.claude`): its settings are user settings (when the guard refuses, `details.skipped` names it).

A settings file or `.claude` directory that is a link is followed, as Claude Code follows it, and reported (`settings-guard.symlink-followed`, `details.symlinks`); a link to another host (a UNC path on Windows) is never followed. The guard fails closed: a file it cannot evaluate refuses the session just like a finding. `details.unparseable` names such files and `details.problems` gives the reason for each: `invalid-json`, `too-deep`, `not-object`, `env-not-object`, `prototype-key` (a `__proto__` key), `oversized` (above 2 MiB), `not-a-file`, `unreadable`, `dangling-symlink` (a link whose target does not exist), `symlink-loop`, `remote-link` or `unsupported-link`.

The refused variables are defined by family, in any letter case, so that a variable a newer Claude Code adds to a family is refused too:

- every variable of the provider and API families: `ANTHROPIC_*`, `AWS_*`, `GOOGLE_*`, `GCLOUD_*`, `CLOUDSDK_*`, `CLOUD_ML_*`, `VERTEX_*`, `AZURE_*`, `CCR_*` and `CLAUDE_CODE_USE_*`, except model selection (`ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL` and its siblings, `ANTHROPIC_CUSTOM_MODEL_OPTION`, with their `_NAME`, `_DESCRIPTION` and `_SUPPORTED_CAPABILITIES` variants). Claude Code builds the Vertex, Bedrock and Foundry hosts from some of them (`CLOUD_ML_REGION`, `AWS_REGION`, `ANTHROPIC_FOUNDRY_RESOURCE`), so a repository could otherwise send your provider credential to its own host;
- `CLAUDE_*` variables whose name has a credential, routing or configuration segment: `TOKEN`, `KEY`, `SECRET`, `PASSWORD`, `PASSPHRASE`, `CRED`, `CREDS`, `CREDENTIAL`, `CREDENTIALS`, `AUTH`, `OAUTH`, `AUTHENTICATE`, `AUTHORIZATION`, `BEARER`, `CERT`, `URL`, `URI`, `HOST`, `HOSTS`, `ENDPOINT`, `SOCKET`, `GATEWAY`, `PORT`, `REGION`, `HEADER`, `HEADERS`, `CONFIG`, `SETTINGS` (for example `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_API_BASE_URL`, `CLAUDE_CONFIG_DIR`; `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is not refused);
- proxies: any variable with a `PROXY` segment (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `CLAUDE_CODE_PROXY_URL`), except the `NO_PROXY` forms;
- TLS trust: any variable with an `SSL`, `TLS`, `CA`, `CERT`, `CERTS`, `CAINFO` or `CAPATH` segment (`NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`), and `SSLKEYLOGFILE`.

A repository that sets an unrelated variable of a refused family (an `AWS_PROFILE` for its own scripts, say) is refused as well. If your application needs such a variable, set it itself with `env: { preset: 'harness', add: { ... } }`, or opt in with `projectCredentialEnv: 'allow'`.

The guard stops configured redirection only; it does not keep your credentials from the repository. Under `'full'` the repository's hooks, MCP servers and helper commands (`awsAuthRefresh`, `awsCredentialExport`, `otelHeadersHelper`, `statusLine` and the like; only `apiKeyHelper` is refused) run as you, with Claude Code's environment, including your API key or provider credentials, and can read the files you can read. A repository that passes the guard can still send your key elsewhere from a `SessionStart` hook. Use `'full'` only for repositories you trust to run code on your machine.

`projectCredentialEnv: 'allow'` lets such a repository run; a `settings-guard.allowed` diagnostic then names what was let through. The guard is a check before start: a file changed between the check and Claude Code's own read is not caught. Setting `projectCredentialEnv` while no project source is loaded is an `INVALID_OPTIONS` error.

## The environment

Claude Code and every tool it runs inherit its environment. The `env` option decides what they get ([ADR-0012](../adr/0012-security-defaults-and-trust.md#4-environment-a8)):

| `env`                       | The child receives                                                             |
| --------------------------- | ------------------------------------------------------------------------------ |
| `'harness'` (default)       | The parent's variables that pass the allowlist below                           |
| `'inherit'`                 | Every parent variable except the never-inherited ones                          |
| `{ NAME: 'value', ... }`    | Exactly these variables                                                        |
| `{ preset, remove?, add? }` | The preset (`'harness'` or `'inherit'`), then `remove` deleted, then `add` set |

The `'harness'` allowlist: the operating system's essentials (Windows: `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `PATHEXT`, `SYSTEMDRIVE`, `PATH`, `TEMP`, `TMP`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`, `ProgramFiles*`, `LOGONSERVER`, `USERDOMAIN`, `USERNAME`, and PowerShell's `PSModulePath` and `PSModuleAnalysisCachePath`, so PowerShell tools find the modules you installed; Linux and macOS: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, `TERM`, `XDG_*`), every `CLAUDE_*` and `ANTHROPIC_*` variable, the proxy and CA variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` in both cases, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`), and a cloud provider's variables only when its switch is on (`CLAUDE_CODE_USE_BEDROCK`: `AWS_*`; `CLAUDE_CODE_USE_VERTEX`: `GOOGLE_*`, `GCLOUD_*`, `CLOUD_ML_*`, `VERTEX_*`, such as the per-model regions `VERTEX_REGION_CLAUDE_*`; `CLAUDE_CODE_USE_FOUNDRY`: `AZURE_*`).

Never inherited by either preset: `NODE_OPTIONS`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_AGENT_SDK_*`. Add one explicitly if you need it.

hudhud then sets its own variables in every form, and refuses options that name them: `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` (from `claudeCode.backgroundWaitCeilingMs`), `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (unless their options say `'harness-default'`), `CLAUDE_CONFIG_DIR` (only with `claudeCode.configDir`), `TRACEPARENT` and `TRACESTATE` (only with `trace`, else removed). `CLAUDE_CODE_SDK_READS_SESSION_STATE` is always removed.

Diagnostics report names, never values: `env.dropped` (variables of your process's environment that the preset filtered out or hudhud always removes and that are absent from Claude Code's final environment; a variable hudhud pins, such as `DISABLE_AUTOUPDATER`, or one you add back is not listed, because Claude Code has it), `env.added` and `env.removed`. Credential and routing variables you set explicitly are listed in the posture (`env.credentialAndRoutingVariables`). On Windows, variable names compare case-insensitively, and two names in your options that differ only in case are refused. An explicit map that leaves out a variable Windows needs to start a process fails with `INVALID_OPTIONS` (`details.rule: 'spawn-spec'`).

If a tool needs a variable the allowlist drops, add it by name with `{ preset: 'harness', add: { ... } }` rather than switching to `'inherit'`.

```ts
// The default allowlist, minus the proxy variable, plus one named variable.
env: { preset: 'harness', remove: ['HTTPS_PROXY'], add: { GIT_AUTHOR_NAME: 'Build Bot' } },
```

## Config directory and bare mode

By default Claude Code uses the user's own configuration directory, with their login and settings; hudhud reads only `settings.json` from it (to report `managedPolicy`) and never writes it. `claudeCode.configDir` points Claude Code at another directory (`CLAUDE_CONFIG_DIR`), for example an isolated one for a service account. `claudeCode.bare: true` passes Claude Code's `--bare` flag, which changes what Claude Code loads at start (see its documentation). Both are connect options and are listed in the posture.

## Binary verification

`connect()` hashes the resolved binary (SHA-256) and compares it with a committed table of the Claude Code builds hudhud was tested with, plus any digests you add ([ADR-0011](../adr/0011-spawn-hygiene-and-binary-provenance.md#binary-provenance-a15-amended-by-f)):

| `binaryVerification`   | Behaviour                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'advisory'` (default) | The digest is compared and the result reported in `binary.verification`; nothing is refused and no other process is started                                                                                                                                                                                                                                 |
| `'strict'`             | The operating system's signature check runs first (Windows: Authenticode, and the signer must be Anthropic, PBC; macOS: `codesign --verify --strict`, and the signature must be a Developer ID signature of Anthropic's Team ID `Q6L2SF6YDW`; Linux has none), then the digest; anything not `'verified'` fails `connect` with `BINARY_VERIFICATION_FAILED` |

`binary.verification` has `status` (`'verified'`, `'unverified'`, `'failed'`), `method` (`'os-signature'`, `'sha256-manifest'`, `'none'`), `mode`, `detail`, and `transient: true` when a check could not complete (for example the signature checker timed out); a transient result is never cached, so the next attempt checks again.

The committed table covers the tested version on Linux x64, Windows x64, macOS arm64 and macOS x64 only. Any other version or platform is `'unverified'` (so `'strict'` refuses it) unless you supply its digest:

```text
claudeCode.binaryDigests: { '<version>': { '<platform>-<arch>': '<sha256 hex>' } }
```

Platforms are written like `linux-x64`, `linux-arm64`, `darwin-arm64`, `win32-x64`. Take digests from a source you trust, such as the checksums Anthropic publishes for a release.

Each session checks that the file is still the one that was verified before it starts it: the same file (device and inode, or volume and file index on Windows), the same size, and the same modification and status-change times to the nanosecond. A changed binary is verified and probed again once (a second change fails with `BINARY_VERIFICATION_FAILED`). On Linux and macOS an unprivileged process cannot set the status-change time back, so only root, or a file system that caches file attributes (NFS, some FUSE mounts), can present a changed file with the old identity. On Windows a writer can set both times back, so there the identity is not a security property; the fresh hash at every `connect()` bounds that case. The check cannot close every window: the operating system opens the file again by path at spawn, so a replacement between the last check and the spawn is not detected. Writing the binary's directory needs the rights of the user who installed it.

## Network traffic and managed policy

With `nonessentialTraffic: 'disabled'` (the default) Claude Code skips its nonessential requests (telemetry, feature flags, and similar); in hudhud's tests, which point Claude Code at a local mock API, only model requests were observed. Without it, Claude Code was observed to open connections to `api.anthropic.com` directly even when `ANTHROPIC_BASE_URL` points elsewhere. The default does not stop the fetch of an organization's managed policy ([ADR-0012](../adr/0012-security-defaults-and-trust.md#5-egress-and-nonessential-traffic-e7-g1)).

The posture entry `managedPolicy` says whether that policy can apply: `'fetched-if-eligible'` (default), `'not-fetched-custom-base-url'` (a custom `ANTHROPIC_BASE_URL` in the environment or the user's settings turns the fetch off), `'not-applicable-third-party-provider'` (a `CLAUDE_CODE_USE_*` provider), or `'unknown-project-settings-unreadable'` or `'unknown-user-settings-unreadable'` when a settings file that could set those variables cannot be read.

`autoUpdate: 'disabled'` (the default) keeps Claude Code from updating itself while a session runs; an update can replace the binary under a running session.

## Authentication failures

With `onAuthFailure: 'fail-fast'` (the default), a 401 for a static credential from the environment (`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`) fails the session at once with `AUTHENTICATION_FAILED` instead of letting Claude Code retry for minutes; a rejected static key does not start working on retry. `details.credentialSource` names which one. Logins that can refresh (Claude Code's own login, `apiKeyHelper`) behave as `'harness-retry'` ([ADR-0012](../adr/0012-security-defaults-and-trust.md#6-authentication-failure-g2)).

## Frame limits

Claude Code's output is read line by line. A line above `maxFrameBytes` (default 64 MiB, range 1 MiB to 1 GiB) fails the session with `OVERSIZED_FRAME` under `onOversizedFrame: 'fail'` (default), or is skipped with a `frame.skipped-oversized` diagnostic under `'skip'`. Nothing is ever truncated silently. Prompts and other writes above `maxOutboundFrameBytes` (default 32 MiB) are refused with `OUTBOUND_FRAME_TOO_LARGE` and nothing is written.

## Untrusted text

Text from the agent (model output, tool results, permission reasons, error messages from Claude Code) is untrusted data. It can contain terminal escape sequences meant to spoof your interface. Pass it through `sanitizeForDisplay` from `@hudhudjs/core/protocol` before you show it, as in the [permission example](permissions.md#the-permission-handler).

## macOS keychain

On macOS, Claude Code reads the user's login keychain, even when `ANTHROPIC_API_KEY` is set. That is Claude Code's own behaviour on the user's own keychain; hudhud neither causes nor prevents it, and no hudhud option isolates the keychain.

## Changing a default safely

1. Change one option at a time, for the sessions that need it, not globally.
2. Prefer the narrow form: `{ preset: 'harness', add }` over `'inherit'`, `allowedTools` over a broader permission mode, `onPermission` over `'auto'`.
3. Keep `projectCredentialEnv: 'refuse'` with `workspaceTrust: 'full'` unless you control the repositories.
4. Log `postureDeviations(harness.securityPosture)` and each session's `security.posture` diagnostic, and review them like any other security-relevant configuration.
5. Search your code for `dangerously`: every boolean weakening is spelled that way on purpose.
