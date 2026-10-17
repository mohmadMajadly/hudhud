# hudhud user guide

hudhud lets a Node.js application drive the Claude Code CLI that is installed on the same machine: start sessions, send prompts, stream what the agent does, answer its permission questions, and stop it cleanly, with secure defaults on Windows, Linux and macOS.

Start with [Getting started](getting-started.md). The other pages can be read in any order.

| Page                                  | What it covers                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [Getting started](getting-started.md) | Requirements, installation, the first session                                                                     |
| [Sessions and turns](sessions.md)     | `connect`, `session`, `ask`, `send`, resume and fork, interrupt, close, abort and dispose                         |
| [Events](events.md)                   | The event stream, every event type, backpressure and overflow policies                                            |
| [Permissions](permissions.md)         | Permission modes, the permission handler, cancellation                                                            |
| [Security](security.md)               | The secure defaults, `securityPosture`, workspace trust, the environment, binary verification, how to change them |
| [Options reference](options.md)       | Every option of `connect`, `session` and `sessions.create`/`resume`, with defaults and limits                     |
| [Platforms](platforms.md)             | Operating systems and architectures, process containment, the Windows job addon                                   |
| [Compatibility](compatibility.md)     | Supported Claude Code versions, `CLAUDE_CODE_COMPAT`, version drift                                               |
| [Diagnostics](diagnostics.md)         | What hudhud reports about itself: compat, binary, posture, diagnostic codes, usage, tracing, redaction            |
| [Troubleshooting](troubleshooting.md) | Every error code with its cause and fix                                                                           |
| [The raw tier](raw.md)                | The unstable `@hudhudjs/claude-code/raw` entry point                                                              |
| [Every way](every-way.md)             | The registry of every way hudhud offers to do one thing, with defaults and test coverage                          |

Every code example in this guide is an excerpt of a program under [examples/](../../examples/README.md). The repository type-checks and lints those programs on every change, so the examples compile against the current API.

Design decisions are recorded in the [architecture decision records](../adr/README.md) (ADRs). The guide cites them where a behaviour has a reason worth knowing.
