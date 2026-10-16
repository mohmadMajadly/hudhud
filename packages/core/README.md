# @hudhudjs/core

The harness-neutral core of hudhud: the public types (`Harness`, `Session`, `Turn`, events, results, capabilities, the security posture), the error classes and codes, the session driver, and the process layer that spawns, contains and stops harness processes on Windows, Linux and macOS.

Applications normally do not install this package on its own: install `hudhudjs`, or `@hudhudjs/claude-code`, which depends on it. Install it directly when you need one of its subpaths.

```sh
npm install @hudhudjs/core
```

## Entry points

| Specifier                       | Contents                                                                                                                                                                                                                                                                                                                | Stability                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `@hudhudjs/core`                | The application types; the error classes, `HUDHUD_ERROR_CODES` and `isHudhudError`; the posture helpers (`postureDeviations`, `postureEntry`, `serializePosture`, `parsePosture`); the redaction helpers (`redactText`, `redactJson`, `secretsFromEnv`, `credentialEnvNames`); `wireSchemaVersion`, `adapterApiVersion` | stable (`defineAdapter`: beta) |
| `@hudhudjs/core/protocol`       | The sans-IO protocol pieces: `sanitizeForDisplay` for untrusted text, error data (`parseErrorData`, `isRetryable`), JSON line encoding and parsing, exit classification                                                                                                                                                 | stable                         |
| `@hudhudjs/core/process`        | The process layer used by adapters: spawn, binary and working-directory checks, verification, termination ladders, the Windows job addon loader                                                                                                                                                                         | stable, for adapter authors    |
| `@hudhudjs/core/binding`        | The session driver and transports for adapter authors                                                                                                                                                                                                                                                                   | beta                           |
| `@hudhudjs/core/schemas/<name>` | JSON Schemas of the neutral model (`events.schema`, `errors.schema`, `capabilities.schema`, `posture.schema`, `conformance.schema`) and `version`                                                                                                                                                                       | stable                         |

## Windows

On Windows x64, npm installs the optional dependency `@hudhudjs/win32-job-x64`, a native addon that places each harness process tree in a Windows job object. The core loads it only after checking its SHA-256 and version against a table shipped with this exact version; if it is missing or a check fails, containment falls back to best effort and the reason is reported in the Harness capabilities. No compiler is needed on the installing machine.

## Requirements

Node.js 22.12.0 or newer. The package is an ES module and ships no install scripts.

## Documentation

The user guide is in the `docs/guide/` directory of the hudhud repository.

## License

Apache License 2.0.
