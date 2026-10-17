# Examples

Small programs that use hudhud's public API, one per topic of the [user guide](../docs/guide/README.md). Every code block in the guide and in the READMEs is an excerpt of one of these files.

They are part of the repository's checks: `pnpm build` type-checks them against the packages under `packages/` with the repository's strict TypeScript settings, `pnpm lint` lints them, and `pnpm lint:md` checks that every TypeScript block of the documentation is an excerpt of one of them. They are not run by the checks, because each one starts the Claude Code installed on the machine.

| File                                     | Topic                                                      |
| ---------------------------------------- | ---------------------------------------------------------- |
| [quick-start.ts](quick-start.ts)         | One session, one question, a graceful close                |
| [harness.ts](harness.ts)                 | `connect()`, what it reports, sessions over one Harness    |
| [resume-fork.ts](resume-fork.ts)         | Resuming and forking a session                             |
| [streaming.ts](streaming.ts)             | `send()` and iterating a turn's events                     |
| [session-events.ts](session-events.ts)   | A session-wide event subscription with an overflow policy  |
| [event-guard.ts](event-guard.ts)         | A type guard for the open event union                      |
| [permissions.ts](permissions.ts)         | A permission handler that asks a person                    |
| [stopping.ts](stopping.ts)               | Interrupt, abort, close and dispose                        |
| [errors.ts](errors.ts)                   | Error codes and retries                                    |
| [security.ts](security.ts)               | Changing security defaults on purpose                      |
| [raw.ts](raw.ts)                         | The unstable raw tier                                      |
| [adapter-package.ts](adapter-package.ts) | Using `@hudhudjs/claude-code` without the umbrella package |

To try one, copy it into a project where `hudhudjs` is installed (and `@hudhudjs/core` or `@hudhudjs/claude-code` for the examples that import their subpaths), compile it with TypeScript under `module: nodenext`, and run the output with Node.js. Each example starts the Claude Code installed on your machine, in the current directory, with your own login.
