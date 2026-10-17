# hudhudjs

Drive the Claude Code CLI installed on the same machine from a Node.js application: sessions, prompts, streamed events, permission questions, and clean shutdown, with secure defaults on Windows, Linux and macOS.

`hudhudjs` is the umbrella package of hudhud. It contains no code of its own: it re-exports `@hudhudjs/core` and `@hudhudjs/claude-code`, at exact versions.

```sh
npm install hudhudjs
```

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

## Requirements

- Node.js 22.12.0 or newer.
- Claude Code, installed and signed in by whoever runs your application. hudhud does not bundle, install or update it, and has no login flow. Embedding or running Claude Code in a product is subject to Anthropic's terms.
- Tested with Claude Code 2.1.296 (`CLAUDE_CODE_COMPAT`); other versions run with a warning.
- Windows x64, Linux x64 and macOS arm64 are tested end to end; macOS x64 passed the macOS gate; Windows and Linux arm64 are not tested.

## What is exported

Everything from the root entry points of `@hudhudjs/core` and `@hudhudjs/claude-code`: `connect`, `session`, `hudhud`, `CLAUDE_CODE_COMPAT`, the option, session, event and result types, the error classes, `isHudhudError`, the event type guard `isEventType`, and the security-posture and redaction helpers.

Not re-exported: the subpaths `@hudhudjs/core/protocol` (for example `sanitizeForDisplay`), `@hudhudjs/core/process`, `@hudhudjs/core/binding`, the schemas, and the unstable `@hudhudjs/claude-code/raw`. To import them, add the package that holds them as a direct dependency, at the same version as `hudhudjs`.

## Documentation

The user guide is in the `docs/guide/` directory of the hudhud repository: getting started, sessions and turns, events, permissions, security, an options reference, platforms, compatibility, diagnostics, troubleshooting with every error code, and the registry of every way hudhud offers.

## License

Apache License 2.0. Claude Code is not part of hudhud and is subject to Anthropic's own terms.
