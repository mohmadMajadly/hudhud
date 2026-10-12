/**
 * The macOS gate run (plan §5.4 M1, ADR-0014 "macOS gate list"): fetch and
 * verify both darwin binaries, run the seven items in order, clean up every
 * process by verified identity, and write the results.
 *
 * ```
 * macos-gate --out <dir> --expect-arch arm64|x64
 *            [--sdk-version <v>] [--pin <file>] [--cache <dir>]
 * ```
 *
 * Output in `<out>`: `item-<n>-<key>.json` per item, `result.json` (the whole
 * report), `digests.json` (the verified darwin digests in the pin's shape)
 * and `summary.md`, which is also appended to `$GITHUB_STEP_SUMMARY` when
 * set. Exit codes: 0 every item passed and nothing survived, 1 otherwise,
 * 2 usage error.
 */

import path from 'node:path';
import { parseArgs } from 'node:util';

import { parsePin } from '../../test-support/src/cli/pin.js';
import { DEFAULT_SDK_VERSION, digestRecord } from './digests.js';
import type { GateHost } from './host.js';
import { errorMessage } from './items/common.js';
import { keychainItem } from './items/keychain.js';
import { pathIdentityItem } from './items/path-identity.js';
import { processTreeItem } from './items/process-tree.js';
import type { prepareBinaries } from './items/provenance.js';
import { provenanceItem } from './items/provenance.js';
import { runnerItem } from './items/runner.js';
import { shellSnapshotItem } from './items/shell-snapshot.js';
import { socketPathItem } from './items/socket-path.js';
import { ProcessLedger } from './ps.js';
import {
  ItemRecorder,
  REPORT_SCHEMA,
  renderSummary,
  runStatus,
  type GateItemId,
  type GateReport,
  type ItemResult,
} from './report.js';
import type { SessionContext } from './session.js';

/** Parsed command line. */
export interface GateOptions {
  readonly out: string;
  readonly expectArch: 'arm64' | 'x64';
  readonly sdkVersion: string;
  readonly pin: string;
  readonly cache: string;
  /** `$GITHUB_STEP_SUMMARY`, when set. */
  readonly summary: string | undefined;
}

export const USAGE =
  'usage: macos-gate --out <dir> --expect-arch arm64|x64 [--sdk-version <v>] [--pin <file>] [--cache <dir>]\n';

/** Parses the command line; a string is a usage error. Relative paths resolve against `cwd`. */
export function parseGateArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): GateOptions | string {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        out: { type: 'string' },
        'expect-arch': { type: 'string' },
        'sdk-version': { type: 'string' },
        pin: { type: 'string' },
        cache: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return errorMessage(error);
  }
  const arch = values['expect-arch'];
  if (values.out === undefined) return '--out is required';
  if (arch !== 'arm64' && arch !== 'x64') return '--expect-arch must be arm64 or x64';
  const out = path.posix.resolve(cwd, values.out);
  const summary = env['GITHUB_STEP_SUMMARY'];
  return {
    out,
    expectArch: arch,
    sdkVersion: values['sdk-version'] ?? DEFAULT_SDK_VERSION,
    pin: path.posix.resolve(cwd, values.pin ?? 'tooling/cli-pin.json'),
    cache: path.posix.resolve(cwd, values.cache ?? path.posix.join(out, '..', 'cli-cache')),
    summary: summary === undefined || summary === '' ? undefined : summary,
  };
}

/** Runs one item; an exception ends it as failed with the message recorded. */
export async function runItem(
  host: GateHost,
  id: GateItemId,
  procedure: (r: ItemRecorder) => Promise<void>,
): Promise<ItemResult> {
  const recorder = new ItemRecorder(id);
  const started = host.now();
  host.log(`gate item ${String(id)}: start`);
  let result: ItemResult;
  try {
    await procedure(recorder);
    result = recorder.finish(host.now() - started);
  } catch (error) {
    result = recorder.finish(host.now() - started, errorMessage(error));
  }
  host.log(`gate item ${String(id)}: ${result.status} (${String(result.durationMs)} ms)`);
  return result;
}

type SessionItem = (context: SessionContext, r: ItemRecorder) => Promise<void>;

const SESSION_ITEMS: readonly (readonly [GateItemId, SessionItem])[] = [
  [2, processTreeItem],
  [3, keychainItem],
  [4, shellSnapshotItem],
  [5, socketPathItem],
  [6, pathIdentityItem],
];

/** How the binaries are obtained: {@link prepareBinaries} in production. */
export type PrepareBinaries = typeof prepareBinaries;

/** Runs the gate and writes the results; resolves to the exit code. */
export async function runGate(
  host: GateHost,
  options: GateOptions,
  prepare: PrepareBinaries,
): Promise<number> {
  const startedAt = new Date(host.now()).toISOString();
  const pin = parsePin(JSON.parse(await host.fs.readFile(options.pin)), options.pin);
  const platform = `darwin-${host.arch}`;
  const prepared = await prepare(host, pin, {
    sdkVersion: options.sdkVersion,
    cacheRoot: options.cache,
    hostKey: platform,
  });
  const ledger = new ProcessLedger(host);
  const items: ItemResult[] = [
    await runItem(host, 1, (r) => provenanceItem(host, prepared, pin.version, r)),
  ];
  for (const [id, procedure] of SESSION_ITEMS) {
    items.push(
      await runItem(host, id, async (r) => {
        const binary = prepared.hostBinary;
        if (binary === undefined) throw new Error(`no verified ${platform} binary (item 1)`);
        await procedure({ host, ledger, binary }, r);
      }),
    );
  }
  const earlierPassed = items.every((item) => item.status === 'pass');
  items.push(
    await runItem(host, 7, (r) =>
      runnerItem(host, options.expectArch, prepared.hostBinary, earlierPassed, r),
    ),
  );
  const cleanup = await ledger.sweepAll();
  const report: GateReport = {
    schema: REPORT_SCHEMA,
    cliVersion: pin.version,
    platform,
    runner: { node: host.nodeVersion, arch: host.arch, expectArch: options.expectArch },
    startedAt,
    finishedAt: new Date(host.now()).toISOString(),
    items,
    cleanup,
    status: runStatus(items, cleanup),
  };

  await host.fs.mkdir(options.out);
  const write = (name: string, value: unknown): Promise<void> =>
    host.fs.writeFile(path.posix.join(options.out, name), `${JSON.stringify(value, null, 2)}\n`);
  for (const item of items) await write(`item-${String(item.id)}-${item.key}.json`, item);
  await write('result.json', report);
  await write('digests.json', digestRecord(pin.version, prepared.digests));
  const summary = renderSummary(report);
  await host.fs.writeFile(path.posix.join(options.out, 'summary.md'), summary);
  if (options.summary !== undefined) await host.fs.appendFile(options.summary, summary);
  host.log(`macos gate ${platform}: ${report.status}`);
  return report.status === 'pass' ? 0 : 1;
}
