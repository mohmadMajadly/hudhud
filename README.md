# hudhud

hudhud is a TypeScript library for driving the Claude Code CLI that is installed on the same machine, from a Node.js application, on Windows, Linux and macOS. It starts and resumes sessions, sends prompts, streams what the agent does, puts permission questions in front of your code, and stops sessions cleanly, with secure defaults and a report of every setting you change.

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

## Status

hudhud is published on npm, starting with version 0.1.0. The packages are:

- `hudhudjs`: the umbrella, which re-exports the two packages below at exactly its own version;
- `@hudhudjs/core`: the harness-neutral core;
- `@hudhudjs/claude-code`: the Claude Code adapter;
- `@hudhudjs/win32-job-x64`: the Windows x64 job-object addon. Do not install it yourself: `@hudhudjs/core` lists it as an optional dependency.

`hudhudjs`, `@hudhudjs/core` and `@hudhudjs/claude-code` are always released together at one version. The version is 0.x, so under semver a minor release may still contain breaking changes; which entry points are stable and which are beta is stated in [ADR-0004](docs/adr/0004-packages-and-versioning.md). Each release is published from this repository's release workflow with npm provenance, so `npm audit signatures` can check where a package was built. The changes of each version are in the `CHANGELOG.md` of each package under `packages/`.

## Install

```sh
npm install hudhudjs
```

`hudhudjs` re-exports `@hudhudjs/core` and `@hudhudjs/claude-code`. To install them directly instead, install both at the same version:

```sh
npm install @hudhudjs/core @hudhudjs/claude-code
```

Requirements: Node.js 22.12.0 or newer, and Claude Code installed and signed in by whoever runs your application; hudhud does not bundle or install it. Tested with Claude Code 2.1.296. See [Getting started](docs/guide/getting-started.md).

## What it does

- **Sessions and turns:** `ask()` for a result, `send()` for a turn you can stream and interrupt, resume and fork by session id, a drain (`close()`) and an abort (dispose or `AbortSignal`) with a defined termination sequence per operating system. [Sessions and turns](docs/guide/sessions.md)
- **Events:** a typed, open event stream with bounded per-subscriber queues; a slow reader never stalls a session unless it asks to. [Events](docs/guide/events.md)
- **Permissions:** an explicit permission mode for every session, and an optional handler that receives each permission question, with cancellation and fail-closed answers. [Permissions](docs/guide/permissions.md)
- **Secure defaults:** the repository's own Claude Code configuration is not loaded unless you choose to, the environment is an allowlist, auto-update and nonessential traffic are off, the binary is hashed against the tested builds, and `securityPosture` lists every deviation. [Security](docs/guide/security.md)
- **Process containment:** on Windows x64 a native job object ends Claude Code's whole process tree; elsewhere a best-effort sweep with identity checks. [Platforms](docs/guide/platforms.md)
- **Every way:** each goal offered in all the ways Claude Code supports, with the safest as the default. [Every way](docs/guide/every-way.md)
- **Errors and diagnostics:** stable error codes with a `retryable` flag, redacted diagnostics, and a compatibility report for the installed Claude Code version. [Troubleshooting](docs/guide/troubleshooting.md), [Diagnostics](docs/guide/diagnostics.md), [Compatibility](docs/guide/compatibility.md)

## Platforms

| Platform                | Status                        | Process containment                        |
| ----------------------- | ----------------------------- | ------------------------------------------ |
| Windows x64             | supported, tested             | job object (best effort without the addon) |
| Linux x64               | supported, tested             | best effort                                |
| macOS arm64             | supported, tested             | best effort                                |
| macOS x64               | supported (macOS gate passed) | best effort                                |
| Windows and Linux arm64 | not tested                    | best effort                                |

Details in [Platforms](docs/guide/platforms.md).

## Documentation

- [User guide](docs/guide/README.md), with [examples](examples/README.md) that are type-checked on every change
- [Architecture](docs/architecture.md) and [decision records](docs/adr/README.md)
- [Research](docs/research/README.md) behind the decisions

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup and the checks. Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## License

hudhud is licensed under the [Apache License 2.0](LICENSE); see also [NOTICE](NOTICE). Claude Code itself is not part of hudhud and is subject to Anthropic's own terms.
