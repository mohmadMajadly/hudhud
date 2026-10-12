# hudhud

hudhud is a TypeScript library that drives locally installed agent harnesses (Claude Code first) on behalf of applications, on Windows, Linux and macOS.

## Status

Pre-alpha. Nothing usable is implemented yet: this repository currently contains the design and the build, test and CI foundation. The packages export only version constants and must not be used.

- Design: [docs/architecture.md](docs/architecture.md), decisions in [docs/adr/](docs/adr/README.md), research in [docs/research/](docs/research/README.md).
- Packages: `@hudhud/core`, `@hudhud/claude-code` and the umbrella `hudhud` under [packages/](packages/). All are private and unpublished.
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Security: [SECURITY.md](SECURITY.md).

No license has been chosen yet; until one is, no rights are granted.
