/**
 * `pnpm cli:bump <version>`: the lead's local helper for the version-bump PR
 * (K16, plan §1.11, §4.6, §5.9 W7-T2). Never run by CI, never pushes.
 *
 * ```
 * cli:bump <version> [--sdk <agent-sdk-version>] [--allow-downgrade] [--cache <dir>]
 * ```
 *
 * @remarks
 * For every platform the pin covers with digests it records the registry's
 * `dist.integrity` of `<version>`, downloads the tarball, verifies it against
 * that record, extracts the binary into the CLI cache and requires its
 * sha256 and size to equal the Agent SDK `manifest.json` that bundles the
 * same CLI version (`cli/newest.ts` `fetchRecordedCli`, the canary's own
 * path). The cross-check is mandatory here: a pin is a lasting trust anchor,
 * so a version no SDK release describes cannot be pinned (name the SDK
 * release with `--sdk` when the SDK's `latest` already moved on). Entries
 * pending their gate (`pendingGate`; the darwin entries had one until the
 * macOS gate passed, research 11) are left exactly as they are.
 *
 * Only `tooling/cli-pin.json` is written, and only after every platform
 * verified; it keeps its key order and comment, so the diff is the version
 * and the digests. Nothing is re-recorded automatically: the command prints
 * the record (reproducible with the printed command line) and the exact
 * follow-up steps, each a reviewable diff of its own: the committed digest
 * table and the tested window, the fixtures, the request-shape snapshots on
 * Linux and Windows, the Windows publisher check, the macOS gate run (darwin
 * pins, Team ID and darwin snapshots) and `pnpm check:full`.
 *
 * Exit codes: 0 pin updated, 1 fetch, verification or cross-check failure,
 * 2 usage error.
 */

import path from 'node:path';
import { parseArgs } from 'node:util';

import { SDK_PACKAGE } from '../cli/crosscheck.js';
import { CliFetchError } from '../cli/errors.js';
import { fetchRecordedCli } from '../cli/newest.js';
import type { RunPin } from '../cli/newest.js';
import { isValidVersion, parsePin } from '../cli/pin.js';
import { fetchLatest } from '../cli/registry.js';
import type { FetchLike, RegistryOptions } from '../cli/registry.js';

const DOCUMENT_TIMEOUT_MS = 30_000;
const TARBALL_TIMEOUT_MS = 15 * 60_000;

/** Host access of the command, injected. */
export interface BumpHost {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Absolute repository root. */
  readonly repoRoot: string;
  readonly fetch: FetchLike;
  /** Host OS for the cache mode checks. */
  readonly platform: NodeJS.Platform;
  readonly now: () => Date;
  readonly readFile: (file: string) => Promise<string>;
  /** Replaces `file` with `text` atomically (temporary file and rename). */
  readonly replaceFile: (file: string, text: string) => Promise<void>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const USAGE =
  'usage: cli:bump <version> [--sdk <agent-sdk-version>] [--allow-downgrade] [--cache <dir>]\n';

/** A release version `X.Y.Z` as numbers; undefined for anything else (pre-releases included). */
export function releaseVersion(value: string): readonly [number, number, number] | undefined {
  if (!isValidVersion(value) || value.includes('-')) return undefined;
  const [major = 0, minor = 0, patch = 0] = value.split('.').map(Number);
  return [major, minor, patch];
}

/** Compares two release versions: negative, zero or positive. */
export function compareReleases(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The pin document with `version` and the digests of `runPins`; every other
 * key, the key order and the pending entries stay as they are.
 */
export function bumpedPinText(
  document: Record<string, unknown>,
  runPins: readonly RunPin[],
): string {
  const platforms = document['platforms'];
  if (!isRecord(platforms)) throw new CliFetchError('pin-invalid', 'pin without platforms');
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(platforms)) {
    const fetched = runPins.find((runPin) => runPin.platform === key);
    next[key] =
      fetched === undefined
        ? entry
        : {
            package: fetched.package,
            file: fetched.file,
            integrity: fetched.integrity,
            sha256: fetched.sha256,
            size: fetched.size,
          };
  }
  const [first] = runPins;
  const bumped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (key === 'version') bumped[key] = first?.version ?? value;
    else if (key === 'platforms') bumped[key] = next;
    else bumped[key] = value;
  }
  return `${JSON.stringify(bumped, null, 2)}\n`;
}

function command(version: string, sdk: string, allowDowngrade: boolean): string {
  return [
    'pnpm cli:bump',
    version,
    '--sdk',
    sdk,
    ...(allowDowngrade ? ['--allow-downgrade'] : []),
  ].join(' ');
}

/** The record and the follow-up steps the command prints. */
export function bumpReport(
  previous: string,
  runPins: readonly RunPin[],
  reproduce: string,
): string {
  const [first] = runPins;
  const version = first?.version ?? previous;
  const digests = runPins
    .map(
      (runPin) =>
        `      '${runPin.platform}': Object.freeze({\n        sha256: '${runPin.sha256}',\n        size: ${String(runPin.size)},\n      }),`,
    )
    .join('\n');
  return [
    `cli:bump ${previous} -> ${version}: tooling/cli-pin.json updated.`,
    '',
    'Record (reproduce with the same registry state):',
    `  ${reproduce}`,
    ...runPins.flatMap((runPin) => [
      `  ${runPin.package}@${runPin.version}`,
      `    registry integrity ${runPin.integrity} (recorded ${runPin.recordedAt})`,
      `    binary sha256 ${runPin.sha256}, size ${String(runPin.size)}`,
      `    cross-check ${runPin.crossCheck}: ${runPin.crossCheckDetail}`,
    ]),
    '',
    'Nothing else was changed. Follow-up, each step its own reviewable diff:',
    `1. packages/claude-code/src/known-binaries.ts: add the digests of ${version} to KNOWN_BINARIES`,
    '   (keep the previous version while it stays in the tested window):',
    `    '${version}': Object.freeze({`,
    digests,
    '    }),',
    `2. packages/claude-code/src/compat.ts: set CLAUDE_CODE_COMPAT.maxTested to '${version}'`,
    '   (and minTested if the window moves); the provenance and compat unit tests keep',
    '   both equal to the pin.',
    '3. Windows publisher: on the new win32-x64 binary in the CLI cache, read (never run)',
    '   `Get-AuthenticodeSignature <cache>\\' +
      `${version}\\win32-x64\\claude.exe\` and compare its signer subject with`,
    '   CLAUDE_CODE_PUBLISHER.windowsSubject (known-binaries.ts).',
    '4. pnpm cli:fetch   (re-verifies the new pin from the cache, no download)',
    '5. pnpm fixtures:record   (re-records the conformance fixtures; review the diff)',
    '6. On Linux and on Windows (HUDHUD_TEST_ROOT outside the user profile):',
    '   HUDHUD_REQUEST_SHAPE_UPDATE=1 pnpm vitest run --project integration packages/claude-code/test/integration/request-shape',
    '   then review the snapshots/*.<platform>.shape diffs.',
    '7. macOS: push the branch and dispatch .github/workflows/macos-gate.yml on it. Gate item 1',
    '   must verify both darwin binaries against the new pin and the Team ID',
    '   (CLAUDE_CODE_PUBLISHER.darwinTeamId); the integration evidence job writes the darwin',
    '   request-shape snapshots (artifact integration-evidence, request-shape/): review and commit.',
    '8. pnpm check:full on Linux and on Windows; then a changeset and the PR (its FULL CI',
    '   run covers macOS).',
    '',
  ].join('\n');
}

/** Runs the command; resolves to the process exit code. */
export async function runBump(host: BumpHost): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...host.argv],
      options: {
        sdk: { type: 'string' },
        'allow-downgrade': { type: 'boolean' },
        cache: { type: 'string' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    host.stderr(`cli:bump: ${String(error)}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [version] = positionals;
  if (version === undefined || positionals.length !== 1) {
    host.stderr(`cli:bump: exactly one version is required\n${USAGE}`);
    return 2;
  }
  const wanted = releaseVersion(version);
  if (wanted === undefined) {
    host.stderr(`cli:bump: ${JSON.stringify(version)} is not a release version X.Y.Z\n${USAGE}`);
    return 2;
  }
  if (values.sdk !== undefined && !isValidVersion(values.sdk)) {
    host.stderr(`cli:bump: ${JSON.stringify(values.sdk)} is not an SDK version\n${USAGE}`);
    return 2;
  }
  const allowDowngrade = values['allow-downgrade'] === true;
  const pinFile = path.join(host.repoRoot, 'tooling', 'cli-pin.json');
  const configured = values.cache ?? host.env['HUDHUD_CLI_CACHE'];
  const cacheRoot = path.resolve(
    host.repoRoot,
    configured === undefined || configured === '' ? '.cache/claude-cli' : configured,
  );
  const registry: RegistryOptions = {
    fetch: host.fetch,
    documentTimeoutMs: DOCUMENT_TIMEOUT_MS,
    tarballTimeoutMs: TARBALL_TIMEOUT_MS,
  };
  try {
    const document: unknown = JSON.parse(await host.readFile(pinFile));
    const pin = parsePin(document, pinFile);
    const current = releaseVersion(pin.version);
    if (current === undefined) {
      throw new CliFetchError(
        'pin-invalid',
        `${pinFile}: the pinned ${pin.version} is not a release version`,
      );
    }
    const order = compareReleases(wanted, current);
    if (order === 0) {
      host.stderr(`cli:bump: ${version} is already the pinned version\n`);
      return 2;
    }
    if (order < 0 && !allowDowngrade) {
      host.stderr(
        `cli:bump: ${version} is older than the pinned ${pin.version}; pass --allow-downgrade to pin it anyway\n`,
      );
      return 2;
    }
    // The SDK release is fixed before any download, so every platform is
    // cross-checked against the same manifest, the cross-check fails closed
    // (an explicit release must describe the version) and the printed
    // command reproduces the bump after the SDK's `latest` moved on.
    let sdk = values.sdk;
    if (sdk === undefined) {
      const latest = await fetchLatest(registry, SDK_PACKAGE);
      if (latest.claudeCodeVersion !== version) {
        throw new CliFetchError(
          'cross-check-failed',
          `${SDK_PACKAGE}@${latest.version} (latest) bundles CLI ${latest.claudeCodeVersion ?? 'unknown'}, not ${version}: pass --sdk <version> naming the SDK release that bundles CLI ${version}`,
        );
      }
      sdk = latest.version;
    }
    const runPins: RunPin[] = [];
    for (const [platform] of [...pin.platforms].filter(([, entry]) => !('pendingGate' in entry))) {
      const { runPin } = await fetchRecordedCli({
        platform,
        version,
        sdkVersion: sdk,
        cacheRoot,
        hostPlatform: host.platform,
        registry,
        now: host.now,
      });
      runPins.push(runPin);
      host.stdout(`verified ${runPin.package}@${version} sha256=${runPin.sha256}\n`);
    }
    if (runPins.length === 0) {
      throw new CliFetchError('pin-invalid', `${pinFile}: no platform with digests to bump`);
    }
    await host.replaceFile(pinFile, bumpedPinText(document as Record<string, unknown>, runPins));
    host.stdout(bumpReport(pin.version, runPins, command(version, sdk, allowDowngrade)));
    return 0;
  } catch (error) {
    const message =
      error instanceof CliFetchError ? `[${error.code}] ${error.message}` : String(error);
    host.stderr(`cli:bump: ${message}\ncli:bump: tooling/cli-pin.json was not changed\n`);
    return 1;
  }
}
