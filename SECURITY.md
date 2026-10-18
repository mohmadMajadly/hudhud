# Security policy

## Reporting a vulnerability

Please do not open a public issue, discussion or pull request for a suspected vulnerability.

Report it privately through GitHub private vulnerability reporting: on the repository's **Security** tab, choose **Report a vulnerability**. The report is visible only to you and the maintainers. Include the affected package and version, the operating system, and the steps or code that show the problem.

## Supported versions

hudhud's packages (`hudhudjs`, `@hudhudjs/core`, `@hudhudjs/claude-code`, `@hudhudjs/conformance` and `@hudhudjs/win32-job-x64`) receive security fixes in their newest published version only. A fix is released as a new version of the four packages of the release group together; older versions are deprecated on npm with a pointer to the fixed one when the problem is serious.

## What happens after a report

- We aim to acknowledge a report within 7 days.
- We confirm the problem, agree a disclosure date with you, and prepare the fix and a GitHub security advisory in private.
- The fix is published to npm first, then the advisory, which credits you unless you ask not to be named.

## Scope

The threat model is in [docs/architecture.md](docs/architecture.md#security-model-and-threat-model) and [ADR-0012](docs/adr/0012-security-defaults-and-trust.md). Vulnerabilities in Claude Code itself go to Anthropic, not here.
