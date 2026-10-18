# @hudhudjs/conformance

The expected event streams of hudhud's Claude Code conformance suite, as data, for projects that test their own handling of hudhud's events against the streams hudhud itself asserts.

```sh
npm install --save-dev --save-exact @hudhudjs/conformance@<the version of @hudhudjs/claude-code you use>
```

## The contract

- Each file is byte-identical to the expected stream that the conformance suite of this exact hudhud version asserts: the build copies them from the suite's fixtures, and the release checks the packed bytes against them.
- Pin this package at exactly the same version as `@hudhudjs/claude-code`. It is released together with `hudhudjs`, `@hudhudjs/core` and `@hudhudjs/claude-code`, always at their version.
- No shape is promised across versions: the streams, their scenarios and their line format may change in any release, including a patch release, whenever the suite changes. Compare against the version you run.

## Contents

- `dist/streams/<scenario>/<platform>[.<case>].expect.jsonl`: one file per scenario, platform (`linux`, `win32`) and case, each one JSON line per recorded line of the session, as the suite's conformance schema describes. Resolve a file through its subpath, for example `@hudhudjs/conformance/streams/text-turn/linux.expect.jsonl` (with `import.meta.resolve`).
- The index, the package's only code: `HUDHUD_VERSION` (the hudhud version these streams belong to) and `CONFORMANCE_STREAMS`, one entry per file with its `scenario`, `platform`, `case`, `path` (relative to the package root) and `specifier` (the subpath above), typed by `ConformanceStream`.

The raw recordings the streams are derived from are not part of the package; they are in the `packages/claude-code/conformance/` directory of the hudhud repository. The package has no dependencies.

Licensed under the Apache License 2.0.
