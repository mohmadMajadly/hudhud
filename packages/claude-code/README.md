# @hudhudjs/claude-code

The Claude Code adapter of hudhud: it finds and verifies the Claude Code CLI installed on the machine, starts it with secure defaults, and drives it over its stream-json protocol. Most applications install the umbrella package `hudhudjs`, which re-exports this package.

```sh
npm install @hudhudjs/claude-code
```

```ts
import { CLAUDE_CODE_COMPAT, connect } from '@hudhudjs/claude-code';

const { minTested, maxTested } = CLAUDE_CODE_COMPAT;
console.log(`hudhud was tested with Claude Code ${minTested} to ${maxTested}`);

const harness = await connect();
try {
  console.log(`found Claude Code ${harness.binary.version} (${harness.compat.status})`);
  const session = await harness.sessions.create();
  try {
    console.log((await session.ask('Say hello.')).text);
  } finally {
    await session.close();
  }
} finally {
  await harness[Symbol.asyncDispose]();
}
```

## Entry points

| Specifier                              | Contents                                                                                                                                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@hudhudjs/claude-code`                | `connect`, `session`, `hudhud`, `CLAUDE_CODE_COMPAT`, and the option types (`ConnectOptions`, `SessionOptions`, `ResumeOptions`, `EnvOption`, `PermissionMode`, `WorkspaceTrust`, `SettingSource`, `ClaudeCodeHarness`) |
| `@hudhudjs/claude-code/raw`            | The unstable raw tier: every wire frame, raw control requests behind an explicit opt-in, extra argv and environment. Exempt from compatibility promises.                                                                |
| `@hudhudjs/claude-code/schemas/<name>` | The JSON Schemas of the options and of the Claude Code wire frames hudhud reads and writes (`options.schema`, `wire-inbound.schema`, `wire-outbound.schema`)                                                            |

## Requirements

- Node.js 22.12.0 or newer; `@hudhudjs/core` at the same version (a dependency).
- Claude Code, installed and signed in by whoever runs your application. hudhud does not bundle, install or update it, and has no login flow.
- Tested with Claude Code 2.1.296 (`CLAUDE_CODE_COMPAT`); other versions run with a warning, versions listed as known broken are refused.

## Defaults

Sessions start in the `default` permission mode, load only the user's own settings (not the repository's), get an allowlisted environment, run with auto-update and nonessential traffic off, and the binary's SHA-256 is compared with the tested builds. Every deviation from these defaults is listed in `harness.securityPosture` and in each session's `security.posture` diagnostic.

## Documentation

The user guide is in the `docs/guide/` directory of the hudhud repository.

## License

Apache License 2.0. Claude Code is not part of hudhud and is subject to Anthropic's own terms.
