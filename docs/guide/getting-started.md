# Getting started

## Requirements

- **Node.js 22.12.0 or newer.** The packages declare `"engines": { "node": ">=22.12.0" }`. hudhud's CI runs on Node 22, 24 and 26 on Linux and on Node 22 on Windows and macOS (arm64).
- **Claude Code, installed and signed in.** hudhud does not bundle, download, install or update Claude Code, and it has no login flow of its own ([ADR-0015](../adr/0015-legal-and-provenance.md)). Whoever runs your application installs Claude Code and signs in with their own credentials, or provides them in the environment (for example `ANTHROPIC_API_KEY`). Embedding or running Claude Code in a product is subject to Anthropic's terms; your application must meet them.
- **A supported platform.** Windows x64 and Linux x64 are tested end to end. Windows arm64, Linux arm64 and macOS have limits that are listed in [Platforms](platforms.md); read it before you ship on them.
- **TypeScript (optional).** Type declarations are included. They use Node's `AbortSignal`, so install `@types/node`; the repository checks the published declarations with TypeScript 6.0 under `strict` and `module: nodenext`.

hudhud is tested against Claude Code 2.1.296. Other versions run, with a warning; see [Compatibility](compatibility.md).

## Install

The simple path is the umbrella package, which re-exports the two packages below with exact versions:

```sh
npm install hudhudjs
```

Or install the packages directly:

```sh
npm install @hudhudjs/core @hudhudjs/claude-code
```

| Package                   | Contents                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `hudhudjs`                | Re-exports `@hudhudjs/core` and `@hudhudjs/claude-code`. No code of its own.                                                               |
| `@hudhudjs/core`          | Harness-neutral types, errors, events and the process layer. Subpath `@hudhudjs/core/protocol` holds helpers such as `sanitizeForDisplay`. |
| `@hudhudjs/claude-code`   | The Claude Code adapter: `connect`, `session`, `hudhud`, the option types and `CLAUDE_CODE_COMPAT`. Subpath `/raw` is the unstable tier.   |
| `@hudhudjs/win32-job-x64` | The Windows x64 job-object addon. An optional dependency of `@hudhudjs/core`: npm installs it on Windows x64 only. Never import it.        |

The subpaths `@hudhudjs/core/protocol` and `@hudhudjs/claude-code/raw` are not re-exported by `hudhudjs`. To import them, add the package as a direct dependency at the same version as `hudhudjs`.

The packages are ES modules and ship no install scripts.

## Where hudhud looks for Claude Code

`connect()` (and `session()`) resolves the binary in this order and stops at the first hit ([ADR-0011](../adr/0011-spawn-hygiene-and-binary-provenance.md)):

1. `binaryPath`, when you pass it. Nothing else is tried.
2. The native installer's launcher: `~/.local/bin/claude` (Windows: `%USERPROFILE%\.local\bin\claude.exe`), resolved to the real binary.
3. A `PATH` lookup that skips empty, relative and current-directory entries. On Windows only `claude.exe` is accepted; `.cmd` and `.bat` shims are never run. On Linux and macOS a world-writable directory is skipped.

`node_modules` is never searched. If nothing is found, `connect()` fails with `BINARY_NOT_FOUND` and lists every candidate it tried in `details`.

## The first session

```ts
import { hudhud } from 'hudhudjs';

const session = await hudhud.session();
try {
  const result = await session.ask('List the files in this directory and say what the project is.');
  if (result.isError) {
    console.error(`The turn ended with outcome ${result.outcome}:`, result.errors ?? []);
  } else {
    console.log(result.text);
  }
} finally {
  await session.close();
}
```

What happens here, with the defaults:

- hudhud finds Claude Code, hashes it and compares the digest with the versions it was tested against, and runs `claude --version` once in an empty temporary directory.
- It starts Claude Code in the current directory, in `default` permission mode, loading only the user's own settings (never the repository's), with an allowlisted environment, auto-update off and nonessential network traffic off. [Security](security.md) explains each default.
- `ask()` sends the prompt and resolves with the `TurnResult` when the turn ends. A turn that ends with an error (for example the model hit `maxTurns`) is still a result: check `result.isError` and `result.outcome`. `ask()` rejects only when the session itself fails.
- `close()` lets running work finish, ends Claude Code's input and waits for it to exit (at most 30 s by default, then it is stopped).

Without a permission handler, Claude Code decides permission questions itself in `default` mode: it runs read-only tools and denies tools that would change something. To ask a person instead, pass `onPermission`; see [Permissions](permissions.md).

## Next steps

- Run many sessions over one verified binary with `connect()`: [Sessions and turns](sessions.md).
- Stream what the agent does as it happens: [Events](events.md).
- Check what your configuration changed from the safe defaults: [Security](security.md#security-posture).
- Handle failures by code: [Troubleshooting](troubleshooting.md).
