/**
 * The fixture recorder's command line (`pnpm fixtures:record`, composition
 * root `packages/claude-code/test/record/record-fixtures.mjs`, which injects
 * the product's launch builders): lead-run, never in CI.
 *
 * ```
 * pnpm fixtures:record --rev <git sha> [--out <dir>] [--suite <name>]...
 * ```
 *
 * Needs a prior `pnpm cli:fetch`. The test root (`HUDHUD_TEST_ROOT`) must lie
 * outside the home and below no `.claude`/`CLAUDE.md`/`.mcp.json` (Windows: a
 * `subst` drive; then `HUDHUD_TEST_ROOT_PHYSICAL` names the directory behind
 * it, normalized like the drive). `HUDHUD_RECORD_PLAIN_DIR` receives an
 * uncompressed copy of each compressed fixture for the privacy scan. On a
 * local macOS host the real CLI is refused (`launcher/host-policy.ts`).
 */

import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { probePinnedCli } from '../../launcher/pinned-cli.js';
import type { PinnedCliProbe } from '../../launcher/pinned-cli.js';
import { outsideWatchList } from '../../leaks/outside.js';
import type { OutsideChange } from '../../leaks/outside.js';
import { hostProcessTable } from '../../leaks/process-table.js';
import type { LaunchBuilder } from './launch.js';
import { recordSuites } from './record.js';
import type { RecorderEnvironment } from './record.js';
import { SUITES } from './suites.js';
import type { SuiteSpec } from './suites.js';

/** The host facts the command line reads; {@link nodeRecorderHost} in production. */
export interface RecorderHost {
  readonly repoRoot: string;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly uid: number | undefined;
  readonly tmpdir: string;
  /** The product's launch builder (`launch.ts`), injected by the composition root. */
  readonly launch: LaunchBuilder;
  /** `YYYY-MM-DD` now. */
  today(): string;
  probe(): Promise<PinnedCliProbe>;
  /** Builds the rest of the environment (leak host, ...) once the CLI is known. */
  record(
    suites: readonly SuiteSpec[],
    env: RecorderEnvironment,
    log: (line: string) => void,
  ): Promise<number>;
  write(text: string): void;
}

/** The host of a real run, with the product's launch builder. */
export function nodeRecorderHost(repoRoot: string, launch: LaunchBuilder): RecorderHost {
  return {
    repoRoot,
    launch,
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    uid: process.getuid?.(),
    tmpdir: os.tmpdir(),
    today: () => new Date().toISOString().slice(0, 10),
    probe: () => probePinnedCli({ repoRoot, env: process.env }),
    record: recordSuites,
    write: (text) => process.stdout.write(text),
  };
}

/** The parsed command line. */
export interface RecorderArgs {
  readonly revision: string;
  readonly outDir: string;
  readonly suites: readonly SuiteSpec[];
}

/**
 * Parses the command line against `suites`.
 *
 * @throws for a missing or malformed `--rev`, an unknown suite or option
 */
export function parseRecorderArgs(
  argv: readonly string[],
  repoRoot: string,
  suites: readonly SuiteSpec[] = SUITES,
): RecorderArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      rev: { type: 'string' },
      out: { type: 'string' },
      suite: { type: 'string', multiple: true },
    },
  });
  const revision = values.rev;
  if (revision === undefined || !/^[0-9a-f]{7,40}$/.test(revision)) {
    throw new Error('--rev <git sha of the recorder sources> is required');
  }
  const names = values.suite;
  const selected =
    names === undefined ? suites : suites.filter((suite) => names.includes(suite.name));
  if (names !== undefined && selected.length !== names.length) {
    throw new Error(`unknown suite in ${names.join(', ')}`);
  }
  return {
    revision,
    outDir: path.resolve(
      values.out ?? path.join(repoRoot, 'packages', 'claude-code', 'conformance'),
    ),
    suites: selected,
  };
}

/**
 * The one documented confound (05 §13): the user's own live Claude Code
 * session rewrites `~/.claude.json` and its temp folder; ignored only when
 * the recorder itself runs under Claude Code.
 */
export function liveSessionConfound(
  host: Pick<RecorderHost, 'env' | 'home' | 'tmpdir'>,
): (change: OutsideChange) => boolean {
  const underClaudeCode = host.env['CLAUDECODE'] === '1';
  const hostTemp = host.env['TEMP'] ?? host.tmpdir;
  return (change) =>
    underClaudeCode &&
    (change.path === path.join(host.home, '.claude.json') ||
      change.path.startsWith(path.join(hostTemp, 'claude') + path.sep));
}

/**
 * Runs the recorder; resolves to the process exit code.
 *
 * @throws when the arguments are invalid, the pinned CLI is unavailable or
 *   refused, or a recording fails its checks
 */
export async function runRecorder(argv: readonly string[], host: RecorderHost): Promise<number> {
  const args = parseRecorderArgs(argv, host.repoRoot);
  const probe = await host.probe();
  if (!probe.available) throw new Error(probe.reason);
  const testRoot = host.env['HUDHUD_TEST_ROOT'];
  const physical = host.env['HUDHUD_TEST_ROOT_PHYSICAL'];
  const plainDir = host.env['HUDHUD_RECORD_PLAIN_DIR'];
  const env: RecorderEnvironment = {
    cli: probe.cli,
    launch: host.launch,
    platform: host.platform,
    leakHost: { table: hostProcessTable(host.platform, host.env) },
    watch: outsideWatchList({
      platform: host.platform,
      home: host.home,
      hostEnv: host.env,
      uid: host.uid,
    }),
    confound: liveSessionConfound(host),
    outDir: args.outDir,
    revision: args.revision,
    today: host.today(),
    ...(testRoot !== undefined && physical !== undefined
      ? { physicalRoot: { testRoot, physical } }
      : {}),
    ...(plainDir !== undefined && plainDir !== '' ? { plainDir } : {}),
  };
  const count = await host.record(args.suites, env, (line) => {
    host.write(`${line}\n`);
  });
  host.write(
    `\n${String(count)} case(s) recorded; egress violations 0, leaks 0, outside writes 0\n`,
  );
  return 0;
}
