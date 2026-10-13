// The fixture recorder (W3-T6, moved by W3-Z): the pure helpers, and whole
// suites recorded from the fake CLI with a fake process table, so every
// check of a real recording (leaks, orphans, egress, outside writes) runs
// without the real CLI and without touching real processes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { FixtureRecordLine } from '../../../src/fixtures/normalize.js';
import {
  caseFile,
  DEFAULT_CASE_EXIT_MS,
  emptyManifest,
  entryLine,
  launchEnvDiff,
  mergeManifest,
  missingPrefixes,
  readManifest,
  recordSuite,
  recordSuites,
  RECORDER,
  splitWrites,
  type ManifestEntry,
  type RecorderEnvironment,
} from '../../../src/fixtures/record/record.js';
import type {
  CaseLaunch,
  LaunchBuilder,
  LaunchRequest,
} from '../../../src/fixtures/record/launch.js';
import type { CaseSpec, ScriptSession, SuiteSpec } from '../../../src/fixtures/record/suites.js';
import { testTempBase } from '../../../src/launcher/sandbox.js';
import type { Sandbox } from '../../../src/launcher/sandbox.js';
import { outsideWatchList } from '../../../src/leaks/outside.js';
import type { ProcessRow, ProcessTable } from '../../../src/leaks/process-table.js';
import { makeFakeCli, oneSpellingPerName, scopedPolicy } from '../../launcher/fake-cli.js';
import type { FakeCli } from '../../launcher/fake-cli.js';
import { hangGuard } from '../../hang-guard.js';

/** A create launch with a fixed session id. */
const START: CaseLaunch = {
  start: { mode: 'create', sessionId: '00000000-0000-4000-8000-000000000001' },
};

/** A case launch whose `env.add` holds `add` (the fake CLI's mode). */
function adding(add: Readonly<Record<string, string>>): () => CaseLaunch {
  return () => ({ ...START, options: { env: { preset: 'harness', add } } });
}

/** Every request the test builder got. */
const requests: LaunchRequest[] = [];

/**
 * The stand-in of the product's builder: a marker argv naming the start
 * mode, the parent environment plus the case's `env.add`.
 */
const testLaunch: LaunchBuilder = (request) => {
  requests.push(request);
  const env = request.launch.options?.['env'];
  const add =
    typeof env === 'object' && env !== null && !Array.isArray(env) && 'add' in env
      ? (env['add'] as Readonly<Record<string, string>>)
      : {};
  return {
    argv: ['--test-launch', request.launch.start.mode],
    env: { ...oneSpellingPerName(request.parentEnv), ...add },
  };
};

const SPEC: CaseSpec = {
  name: '',
  launch: () => START,
  drive: () => Promise.resolve(),
  exit: 0,
  shape: [],
};
const SUITE: SuiteSpec = { name: 'demo', scenario: 's', research: 'r', cases: [SPEC] };

const line = (dir: FixtureRecordLine['dir'], v: FixtureRecordLine['v']): FixtureRecordLine => ({
  t: 0,
  dir,
  v,
});

describe('pure helpers', () => {
  it('records what the product set beyond the sandbox, and what it dropped', () => {
    expect(
      launchEnvDiff(
        { HOME: '/h', PINNED: '1', CHANGED: 'b' },
        { HOME: '/h', CHANGED: 'a', https_proxy: 'x' },
      ),
    ).toEqual({ CHANGED: 'b', PINNED: '1', https_proxy: null });
    expect(launchEnvDiff({ A: '1' }, { A: '1' })).toEqual({});
  });

  it('names fixture files per platform, case and compression', () => {
    expect(caseFile(SUITE, SPEC, 'linux')).toBe('demo/linux.jsonl');
    expect(caseFile({ ...SUITE, compress: true }, { ...SPEC, name: 'setup' }, 'win32')).toBe(
      'demo/win32.setup.jsonl.gz',
    );
  });

  it('splits a multi-frame write into one record per line', () => {
    const json = JSON.stringify({ type: 'user' });
    expect(
      splitWrites([
        { t: 5, dir: 'in', v: `${json}\nnot json` },
        { t: 6, dir: 'in', v: 'one line' },
        { t: 7, dir: 'out', v: 'a\nb' },
        { t: 8, dir: 'in', v: { type: 'x' } },
      ]),
    ).toEqual([
      { t: 5, dir: 'in', v: { type: 'user' } },
      { t: 5, dir: 'in', v: 'not json' },
      { t: 6, dir: 'in', v: 'one line' },
      { t: 7, dir: 'out', v: 'a\nb' },
      { t: 8, dir: 'in', v: { type: 'x' } },
    ]);
  });

  it('finds the shape labels as prefixes in order', () => {
    const lines = [
      line('out', { type: 'system', subtype: 'init' }),
      line('out', { type: 'result', subtype: 'success' }),
      line('exit', { code: 0, signal: null }),
    ];
    expect(missingPrefixes(lines, ['out system', 'out result/succ', 'exit 0'])).toEqual([]);
    expect(missingPrefixes(lines, ['out result', 'out system/init', 'exit 0'])).toEqual([
      'out system/init',
    ]);
  });

  it('reads, merges and summarizes manifests', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hudhud-manifest-'));
    try {
      expect(readManifest(path.join(dir, 'missing.json'))).toEqual(emptyManifest());
      writeFileSync(path.join(dir, 'bad.json'), '{');
      expect(readManifest(path.join(dir, 'bad.json'))).toEqual(emptyManifest());
      writeFileSync(path.join(dir, 'm.json'), JSON.stringify({ ...emptyManifest(), entries: [] }));
      expect(readManifest(path.join(dir, 'm.json')).entries).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const entry = (file: string, extra: Partial<ManifestEntry> = {}): ManifestEntry => ({
      suite: 's',
      case: 'main',
      file,
      platform: 'linux',
      cliVersion: '2.1.296',
      scenario: 'x',
      research: 'y',
      recordedOn: '2026-10-13',
      recorder: RECORDER,
      recorderRevision: 'abcdef0',
      exit: { code: 0, signal: null },
      compressed: false,
      shapeMissing: [],
      ...extra,
    });
    const merged = mergeManifest(
      { ...emptyManifest(), entries: [entry('b'), entry('a', { case: 'old' })] },
      [entry('a'), entry('c')],
    );
    expect(merged.entries.map((e) => [e.file, e.case])).toEqual([
      ['a', 'main'],
      ['b', 'main'],
      ['c', 'main'],
    ]);
    expect(entryLine(entry('f'), 12)).toBe('f exit=0 12ms ok');
    expect(
      entryLine(
        entry('f', {
          shapeMissing: ['x', 'y'],
          researchExit: 1,
          orphansSelfExited: ['rg: rg --files'],
        }),
        3,
      ),
    ).toBe(
      'f exit=0 3ms MISSING x | y ; EXIT 0 (research 1) ; ORPHANS (self-exited) rg: rg --files',
    );
  });
});

// ---- whole suites with the fake CLI ------------------------------------------------

let fake: FakeCli;
let root = '';
let home = '';
let out = '';

beforeAll(async () => {
  fake = await makeFakeCli();
}, 120_000);

afterAll(async () => {
  await fake.dispose();
});

beforeEach(async () => {
  root = await mkdtemp(path.join(testTempBase(process.platform, tmpdir()), 'hudhud-rec-'));
  home = path.join(root, 'home-of-user');
  out = path.join(root, 'out');
  mkdirSync(home);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A process table that lists the launched fake CLIs while they run, plus planted rows. */
class FakeTable implements ProcessTable {
  readonly source = 'linux-proc' as const;
  readonly rows = new Map<number, ProcessRow>();
  /**
   * Children planted under the first running fake CLI: listed from then on,
   * and for `afterExitReads` reads after that CLI is gone (an orphan that
   * outlives it; Infinity: until killed).
   */
  readonly planted: { row: (root: ProcessRow) => ProcessRow; afterExitReads: number }[] = [];
  readonly killed: number[] = [];
  hideRoots = false;
  readonly #active = new Map<number, ProcessRow>();

  read(): Promise<readonly ProcessRow[]> {
    const rows = [...this.rows.values()];
    const parent = rows.find((row) => row.name === 'fake-cli');
    this.planted.forEach((plant, index) => {
      if (parent !== undefined && !this.#active.has(index)) {
        this.#active.set(index, plant.row(parent));
      }
      const child = this.#active.get(index);
      if (child === undefined || this.killed.includes(child.pid)) return;
      if (parent === undefined) {
        if (plant.afterExitReads <= 0) return;
        plant.afterExitReads -= 1;
      }
      rows.push(child);
    });
    return Promise.resolve(rows);
  }
}

/** What {@link environment} leaves out. */
interface Leave {
  /** No sandbox wrapper and the default mock. */
  readonly bare?: boolean;
  /** The default sampling interval of the platform. */
  readonly defaultSampling?: boolean;
  /** The default orphan settle time. */
  readonly defaultSettle?: boolean;
}

function environment(
  table: FakeTable,
  overrides: Partial<RecorderEnvironment> = {},
  leave: Leave = {},
): RecorderEnvironment {
  const env: RecorderEnvironment = {
    cli: fake.cli,
    launch: testLaunch,
    platform: 'linux',
    leakHost: {
      table,
      kill: (pid) => {
        table.killed.push(pid);
      },
      sleep: () => Promise.resolve(),
    },
    watch: outsideWatchList({ platform: process.platform, home, hostEnv: {} }),
    confound: () => false,
    outDir: out,
    revision: 'abcdef0',
    today: '2026-10-13',
    sandbox: { testRoot: root, ancestorPolicy: scopedPolicy(root) },
    ...(leave.defaultSettle === true ? {} : { orphanSettleMs: SETTLE_MS }),
    ...(leave.defaultSampling === true ? {} : { samplingMs: 20 }),
    ...(leave.bare === true ? {} : { wrapSandbox: wrap(table) }),
    ...overrides,
  };
  return env;
}

/** Prepends the fake script and lists the launched CLI in the fake table while it runs. */
function wrap(table: FakeTable): (sandbox: Sandbox) => Sandbox {
  return (sandbox: Sandbox): Sandbox => ({
    ...sandbox,
    launch: async (options = {}, hooks) => {
      const { exact } = options;
      const child = await sandbox.launch(
        exact === undefined
          ? { ...options, args: [fake.script, ...(options.args ?? [])] }
          : { exact: { ...exact, argv: [fake.script, ...exact.argv] } },
        hooks,
      );
      if (!table.hideRoots) {
        table.rows.set(child.pid, {
          pid: child.pid,
          ppid: process.pid,
          startTime: '100',
          name: 'fake-cli',
          commandLine: `fake ${sandbox.dirs.root}`,
        });
      }
      child.child.once('exit', () => table.rows.delete(child.pid));
      return child;
    },
  });
}

// Hang guards: a suite's cases run one after another, each bounded by the
// waits of its script (WAIT_MS each), its exit (exitMs) and the orphan
// settle time (SETTLE_MS; the leak host is a fake table and never sleeps).
// A test's timeout is the sum over its cases, plus the margin of hangGuard.
/** Each wait of a script. */
const WAIT_MS = 30_000;
/** The orphan settle time these tests set. */
const SETTLE_MS = 600;
/** The exit bound of the setup case below. */
const SETUP_EXIT_MS = 20_000;
/** TEXT_CASE's script: two waits. */
const TEXT_DRIVE_MS = 2 * WAIT_MS;

/** The bound of one case: its script, its exit, the orphan settle. */
function caseBound(driveMs: number, exitMs = DEFAULT_CASE_EXIT_MS): number {
  return driveMs + exitMs + SETTLE_MS;
}

async function initialize(session: ScriptSession): Promise<void> {
  session.control('init_1', 'initialize');
  await session.waitType('control_response', 'success', WAIT_MS);
}

const TEXT_CASE: CaseSpec = {
  name: '',
  launch: () => START,
  async drive(session) {
    await initialize(session);
    session.user('hello');
    await session.waitType('result', undefined, WAIT_MS);
  },
  exit: 0,
  shape: ['out control_response/success init_1', 'out system/init', 'out result/success', 'exit 0'],
};

describe('recordSuites with the fake CLI', () => {
  it(
    'writes the fixtures and the manifest, normalized and redacted',
    async () => {
      const table = new FakeTable();
      const suites: SuiteSpec[] = [
        { name: 'text', scenario: 'a text turn', research: '05 §5', cases: [TEXT_CASE] },
        {
          name: 'packed',
          scenario: 'compressed',
          research: '05 §11',
          compress: true,
          credential: 'fake-auth-token',
          cases: [
            { ...TEXT_CASE, name: 'setup', exit: 1, shape: ['out never'], exitMs: SETUP_EXIT_MS },
            {
              ...TEXT_CASE,
              launch: adding({ FAKE_CLI_MODE: 'normal' }),
            },
          ],
        },
      ];
      const plain = path.join(root, 'plain');
      mkdirSync(plain);
      const log: string[] = [];
      const count = await recordSuites(
        suites,
        environment(table, {
          plainDir: plain,
          physicalRoot: { testRoot: root, physical: path.join(root, 'physical') },
        }),
        (text) => log.push(text),
      );
      expect(count).toBe(3);
      expect(log).toHaveLength(3);
      const text = readFileSync(path.join(out, 'text', 'linux.jsonl'), 'utf8');
      const lines = text
        .trimEnd()
        .split('\n')
        .map((entry) => JSON.parse(entry) as { dir: string; v: unknown });
      expect(lines[0]).toMatchObject({ dir: 'config', v: { suite: 'text', case: 'main' } });
      // The launch is the builder's: its argv after the fake script, and the
      // config line records what it set beyond the sandbox environment.
      expect((lines[0]?.v as { argv: string[] }).argv.slice(1)).toEqual([
        '--test-launch',
        'create',
      ]);
      // On Windows the builder keeps one spelling per variable, so the
      // sandbox's lower-case proxy spellings show as dropped.
      const folded =
        process.platform === 'win32' ? { http_proxy: null, https_proxy: null, no_proxy: null } : {};
      expect((lines[0]?.v as { env: unknown }).env).toEqual(folded);
      const packedConfig = JSON.parse(
        gunzipSync(readFileSync(path.join(out, 'packed', 'linux.jsonl.gz')))
          .toString()
          .split('\n')[0] ?? '',
      ) as { v: { env: unknown } };
      expect(packedConfig.v.env).toEqual({ ...folded, FAKE_CLI_MODE: 'normal' });
      // Each case got the sandbox's config directory and environment.
      const request = requests.at(-1);
      expect(request?.configDir).toMatch(/cfg$/u);
      expect(request?.parentEnv['CLAUDE_CONFIG_DIR']).toBe(request?.configDir);
      expect(request?.platform).toBe('linux');
      expect(text).not.toContain(root);
      expect(text).not.toContain('sk-ant-fake-hudhud-');
      const packed = gunzipSync(
        readFileSync(path.join(out, 'packed', 'linux.jsonl.gz')),
      ).toString();
      expect(packed).toBe(readFileSync(path.join(plain, 'packed.linux.jsonl'), 'utf8'));
      expect(existsSync(path.join(out, 'packed', 'linux.setup.jsonl.gz'))).toBe(true);
      const manifest = readManifest(path.join(out, 'manifest.json'));
      expect(manifest.entries.map((entry) => entry.file)).toEqual([
        'packed/linux.jsonl.gz',
        'packed/linux.setup.jsonl.gz',
        'text/linux.jsonl',
      ]);
      const setup = manifest.entries.find((entry) => entry.case === 'setup');
      expect(setup).toMatchObject({
        researchExit: 1,
        shapeMissing: ['out never'],
        compressed: true,
        recorderRevision: 'abcdef0',
        recordedOn: '2026-10-13',
      });
      expect(manifest.entries.find((entry) => entry.file === 'text/linux.jsonl')).toMatchObject({
        shapeMissing: [],
        exit: { code: 0, signal: null },
      });
      expect(
        manifest.entries.some((entry) => 'researchExit' in entry && entry.case === 'main'),
      ).toBe(false);
      // Three cases: text, packed/setup (its own exit bound), packed/main.
    },
    hangGuard(
      caseBound(TEXT_DRIVE_MS),
      caseBound(TEXT_DRIVE_MS, SETUP_EXIT_MS),
      caseBound(TEXT_DRIVE_MS),
    ),
  );

  it(
    'records an orphan that exits by itself, and fails on one that does not',
    async () => {
      const table = new FakeTable();
      const orphan = (afterExitReads: number) => ({
        row: (parent: ProcessRow): ProcessRow => ({
          pid: 999_999,
          ppid: parent.pid,
          startTime: '200',
          name: 'rg',
          commandLine: `rg --files ${parent.commandLine.slice('fake '.length)}`,
        }),
        afterExitReads,
      });
      table.planted.push(orphan(2));
      const entries = await recordSuite(
        { name: 'orphan', scenario: 'x', research: 'y', cases: [TEXT_CASE] },
        environment(table, { platform: 'win32' }, { defaultSampling: true }),
      );
      expect(entries[0]?.file).toBe('orphan/win32.jsonl');
      expect(entries[0]?.orphansSelfExited).toEqual(['rg: rg --files <root>']);

      const stuck = new FakeTable();
      stuck.planted.push(orphan(Number.POSITIVE_INFINITY));
      await expect(
        recordSuite(
          { name: 'stuck', scenario: 'x', research: 'y', cases: [TEXT_CASE] },
          environment(stuck, {}, { defaultSampling: true }),
        ),
      ).rejects.toThrow(/leaked process/);
      expect(stuck.killed).toContain(999_999);
      // Two suites of one text case each.
    },
    hangGuard(2 * caseBound(TEXT_DRIVE_MS)),
  );

  it(
    'reports a failing script with the labels of what was recorded',
    async () => {
      const table = new FakeTable();
      const failing = (reason: unknown, name: string): CaseSpec => ({
        ...TEXT_CASE,
        name,
        async drive(session) {
          await initialize(session);
          throw reason;
        },
      });
      await expect(
        recordSuite(
          { name: 'fail', scenario: 'x', research: 'y', cases: [failing(new Error('boom'), '')] },
          environment(table),
        ),
      ).rejects.toThrow(/^fail\/main: boom\n {2}in control_request\/initialize init_1/);
      await expect(
        recordSuite(
          { name: 'fail2', scenario: 'x', research: 'y', cases: [failing('text', 'setup')] },
          environment(new FakeTable()),
        ),
      ).rejects.toThrow(/^fail2\/setup: "text"/);
      await expect(
        recordSuite(
          { name: 'fail3', scenario: 'x', research: 'y', cases: [failing(undefined, '')] },
          environment(new FakeTable()),
        ),
      ).rejects.toThrow(/fail3\/main: drive failed/);
      // Three suites of one case each, whose script fails after one wait.
    },
    hangGuard(3 * caseBound(WAIT_MS)),
  );

  it('accepts a root that exited before its table query, and fails one that did not', async () => {
    const quick = new FakeTable();
    quick.hideRoots = true;
    const early: CaseSpec = {
      name: '',
      launch: adding({ FAKE_CLI_MODE: 'exit-now' }),
      drive: () => Promise.resolve(),
      exit: 3,
      shape: ['exit 3'],
    };
    const entries = await recordSuite(
      { name: 'quick', scenario: 'x', research: 'y', cases: [early] },
      environment(quick),
    );
    expect(entries[0]).toMatchObject({ exit: { code: 3 }, shapeMissing: [] });

    const hidden = new FakeTable();
    hidden.hideRoots = true;
    await expect(
      recordSuite(
        { name: 'hidden', scenario: 'x', research: 'y', cases: [TEXT_CASE] },
        environment(hidden),
      ),
    ).rejects.toThrow(/is not running/);
  }, 120_000);

  it('runs the bare sandbox and the default mock when nothing replaces them', async () => {
    const table = new FakeTable();
    // Without the fake script the launched "CLI" is node itself, which
    // refuses the stream-json flags and exits at once.
    const entries = await recordSuite(
      {
        name: 'bare',
        scenario: 'x',
        research: 'y',
        compress: true,
        cases: [{ ...SPEC, exit: 0, shape: ['exit 0'] }],
      },
      environment(table, {}, { bare: true, defaultSettle: true }),
    );
    expect(entries[0]?.exit.code).not.toBe(0);
    expect(entries[0]?.researchExit).toBe(0);
    // Compressed, and no plain copy without a plain directory.
    expect(existsSync(path.join(out, 'bare', 'linux.jsonl.gz'))).toBe(true);
  }, 120_000);
});
