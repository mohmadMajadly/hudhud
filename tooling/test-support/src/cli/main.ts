/**
 * Command line of `pnpm cli:fetch` (`tooling/test-support/bin/fetch-cli.mjs`,
 * plan §4.6). All host access is injected so the command is unit-tested
 * without network or process globals.
 *
 * ```
 * fetch-cli [--platform <key>]... [--all] [--channel pinned|newest]
 *           [--version <version>] [--cache <dir>] [--pin <file>] [--libc glibc|musl]
 * ```
 *
 * - `pinned` (default, or `HUDHUD_CLI_CHANNEL`): fetch and verify the pinned
 *   version for the host platform, each `--platform`, or every platform with
 *   digests (`--all`). A cached copy is re-hashed and reused when it verifies.
 * - `newest`: the canary variant (K16): the `latest` dist-tag, resolved once
 *   for every platform of the call; records the registry integrity and the
 *   Agent SDK cross-check result, writes them to stdout and, when set, to
 *   `$GITHUB_STEP_SUMMARY`, and writes the run-local pin
 *   (`<cache>/run-pin.json`) that the integration harness reads under
 *   `HUDHUD_CLI_CHANNEL=newest`. `--version` (newest channel only) records
 *   that exact version instead of `latest`: the canary workflows' dry run
 *   uses it with the pinned version to exercise the whole canary path.
 * - Host platform (without `--platform`): `<platform>-<arch>`, plus `-musl`
 *   on a musl Linux, detected from the Node.js diagnostic report; `--libc`
 *   or `HUDHUD_CLI_LIBC` overrides the detection.
 * - Cache root: `--cache`, else `HUDHUD_CLI_CACHE`, else `.cache/claude-cli`
 *   under the repository root.
 *
 * Exit codes: 0 verified, 1 fetch or verification failure, 2 usage error.
 */

import path from 'node:path';
import { parseArgs } from 'node:util';

import { CliFetchError } from './errors.js';
import {
  fetchRecordedCli,
  newestCliVersion,
  runPinDocument,
  runPinFile,
  runPinSummary,
} from './newest.js';
import type { RunPin } from './newest.js';
import { hostPlatform, isValidVersion, libcFromReport, loadPin } from './pin.js';
import { ensurePinnedCli } from './pinned.js';
import type { CliBinary } from './pinned.js';
import type { FetchLike, RegistryOptions } from './registry.js';

const DOCUMENT_TIMEOUT_MS = 30_000;
const TARBALL_TIMEOUT_MS = 15 * 60_000;

/** Host access of the command, injected. */
export interface FetchCliHost {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Absolute path of the repository root. */
  readonly repoRoot: string;
  readonly fetch: FetchLike;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** The Node.js diagnostic report (`process.report.getReport()`), read on Linux only. */
  readonly report: () => unknown;
  readonly now: () => Date;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly appendFile: (file: string, text: string) => Promise<void>;
  /** Writes `text` to `file`, replacing it (the run-local pin). */
  readonly writeFile: (file: string, text: string) => Promise<void>;
  /** Removes `file`; a missing file is not an error. */
  readonly removeFile: (file: string) => Promise<void>;
}

const USAGE =
  'usage: fetch-cli [--platform <key>]... [--all] [--channel pinned|newest] [--version <version>] [--cache <dir>] [--pin <file>] [--libc glibc|musl]\n';

function nonEmpty(value: string | undefined): string | undefined {
  return value === '' ? undefined : value;
}

function line(binary: CliBinary): string {
  return `ok ${binary.platform} ${binary.version} cache=${binary.cache} sha256=${binary.sha256} size=${String(binary.size)} path=${binary.binaryPath}\n`;
}

/** Runs the command; resolves to the process exit code. */
export async function runFetchCli(host: FetchCliHost): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...host.argv],
      options: {
        platform: { type: 'string', multiple: true },
        all: { type: 'boolean' },
        channel: { type: 'string' },
        version: { type: 'string' },
        cache: { type: 'string' },
        pin: { type: 'string' },
        libc: { type: 'string' },
        help: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    host.stderr(`fetch-cli: ${String(error)}\n${USAGE}`);
    return 2;
  }
  if (values.help === true) {
    host.stdout(USAGE);
    return 0;
  }
  const channel = values.channel ?? nonEmpty(host.env['HUDHUD_CLI_CHANNEL']) ?? 'pinned';
  if (channel !== 'pinned' && channel !== 'newest') {
    host.stderr(`fetch-cli: unknown channel ${JSON.stringify(channel)}\n${USAGE}`);
    return 2;
  }
  if (channel === 'newest' && values.all === true) {
    host.stderr(`fetch-cli: --all applies to the pinned channel only\n${USAGE}`);
    return 2;
  }
  if (values.version !== undefined && channel !== 'newest') {
    host.stderr(`fetch-cli: --version applies to the newest channel only\n${USAGE}`);
    return 2;
  }
  if (values.version !== undefined && !isValidVersion(values.version)) {
    host.stderr(`fetch-cli: not a SemVer version ${JSON.stringify(values.version)}\n${USAGE}`);
    return 2;
  }
  const libc = values.libc ?? nonEmpty(host.env['HUDHUD_CLI_LIBC']);
  if (libc !== undefined && libc !== 'glibc' && libc !== 'musl') {
    host.stderr(`fetch-cli: unknown libc ${JSON.stringify(libc)}\n${USAGE}`);
    return 2;
  }
  const hostKey = (): string =>
    hostPlatform(
      host.platform,
      host.arch,
      libc ?? (host.platform === 'linux' ? libcFromReport(host.report()) : 'glibc'),
    );
  const cacheRoot = path.resolve(
    host.repoRoot,
    values.cache ?? nonEmpty(host.env['HUDHUD_CLI_CACHE']) ?? '.cache/claude-cli',
  );
  const registry: RegistryOptions = {
    fetch: host.fetch,
    documentTimeoutMs: DOCUMENT_TIMEOUT_MS,
    tarballTimeoutMs: TARBALL_TIMEOUT_MS,
  };
  const options = { cacheRoot, hostPlatform: host.platform, registry };
  try {
    if (channel === 'newest') {
      const summaryFile = nonEmpty(host.env['GITHUB_STEP_SUMMARY']);
      const pinFile = runPinFile(cacheRoot);
      // A failed fetch must not leave an earlier run's pin for the harness.
      await host.removeFile(pinFile);
      const version = values.version ?? (await newestCliVersion(registry));
      const runPins: RunPin[] = [];
      for (const platform of values.platform ?? [hostKey()]) {
        const { runPin, binary } = await fetchRecordedCli({
          ...options,
          platform,
          version,
          now: host.now,
        });
        runPins.push(runPin);
        host.stdout(
          `recorded ${runPin.package}@${runPin.version} integrity=${runPin.integrity} at ${runPin.recordedAt}
`,
        );
        host.stdout(`cross-check=${runPin.crossCheck} ${runPin.crossCheckDetail}
`);
        host.stdout(line(binary));
        if (summaryFile !== undefined) await host.appendFile(summaryFile, runPinSummary(runPin));
      }
      await host.writeFile(pinFile, runPinDocument(runPins));
      host.stdout(`run-pin ${pinFile}
`);
      return 0;
    }
    const pin = await loadPin(path.resolve(host.repoRoot, values.pin ?? 'tooling/cli-pin.json'));
    const platforms =
      values.all === true
        ? [...pin.platforms].filter(([, entry]) => !('pendingGate' in entry)).map(([key]) => key)
        : (values.platform ?? [hostKey()]);
    for (const platform of platforms) {
      host.stdout(line(await ensurePinnedCli({ ...options, pin, platform })));
    }
    return 0;
  } catch (error) {
    const message =
      error instanceof CliFetchError ? `[${error.code}] ${error.message}` : String(error);
    host.stderr(`fetch-cli: ${message}\n`);
    return 1;
  }
}
