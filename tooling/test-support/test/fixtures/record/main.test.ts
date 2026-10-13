// The recorder's command line (W3-Z): arguments, the environment it builds
// for a run, and the host of a real run (built, never run here).

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  liveSessionConfound,
  nodeRecorderHost,
  parseRecorderArgs,
  runRecorder,
  type RecorderHost,
} from '../../../src/fixtures/record/main.js';
import type { RecorderEnvironment } from '../../../src/fixtures/record/record.js';
import { SUITES, type SuiteSpec } from '../../../src/fixtures/record/suites.js';
import type { VerifiedCli } from '../../../src/launcher/pinned-cli.js';

const REPO = path.resolve('/repo');
const CONFORMANCE = path.join(REPO, 'packages', 'claude-code', 'conformance');

describe('parseRecorderArgs', () => {
  it('takes the revision, the output directory and the selected suites', () => {
    expect(parseRecorderArgs(['--rev', 'abcdef0'], REPO)).toEqual({
      revision: 'abcdef0',
      outDir: CONFORMANCE,
      suites: SUITES,
    });
    const picked = parseRecorderArgs(
      ['--rev', 'a'.repeat(40), '--out', 'x', '--suite', 'resume', '--suite', 'handshake'],
      REPO,
    );
    expect(picked.outDir).toBe(path.resolve('x'));
    expect(picked.suites.map((suite) => suite.name)).toEqual(['handshake', 'resume']);
  });

  it('refuses a missing or malformed revision, an unknown suite and an unknown option', () => {
    for (const argv of [[], ['--rev', 'ABCDEF0'], ['--rev', 'abc'], ['--rev', 'g'.repeat(7)]]) {
      expect(() => parseRecorderArgs(argv, REPO)).toThrow(/--rev/);
    }
    expect(() => parseRecorderArgs(['--rev', 'abcdef0', '--suite', 'nope'], REPO)).toThrow(
      /unknown suite in nope/,
    );
    expect(() => parseRecorderArgs(['--rev', 'abcdef0', '--bogus'], REPO)).toThrow();
  });
});

describe('liveSessionConfound', () => {
  const home = path.resolve('/users-home/u');
  const temp = path.resolve('/t');

  it('ignores the live Claude Code session files only under Claude Code', () => {
    const under = liveSessionConfound({ env: { CLAUDECODE: '1', TEMP: temp }, home, tmpdir: '' });
    expect(under({ path: path.join(home, '.claude.json'), change: 'modified' })).toBe(true);
    expect(under({ path: path.join(temp, 'claude', 'x'), change: 'modified' })).toBe(true);
    expect(under({ path: path.join(home, '.claude', 'x'), change: 'modified' })).toBe(false);
    const outside = liveSessionConfound({ env: {}, home, tmpdir: temp });
    expect(outside({ path: path.join(home, '.claude.json'), change: 'modified' })).toBe(false);
    const noTemp = liveSessionConfound({ env: { CLAUDECODE: '1' }, home, tmpdir: temp });
    expect(noTemp({ path: path.join(temp, 'claude', 'x'), change: 'modified' })).toBe(true);
  });
});

/** A launch builder the recorder only hands on. */
const LAUNCH = () => ({ argv: [], env: {} });

describe('runRecorder', () => {
  const cli = { version: '2.1.296', binaryPath: '/c/claude' } as unknown as VerifiedCli;

  function host(overrides: Partial<RecorderHost> = {}): RecorderHost & {
    calls: { suites: readonly SuiteSpec[]; env: RecorderEnvironment }[];
    written: string[];
  } {
    const calls: { suites: readonly SuiteSpec[]; env: RecorderEnvironment }[] = [];
    const written: string[] = [];
    return {
      calls,
      written,
      repoRoot: REPO,
      platform: 'linux',
      env: {},
      home: '/users-home/u',
      uid: 1000,
      launch: LAUNCH,
      tmpdir: '/tmp',
      today: () => '2026-10-13',
      probe: () => Promise.resolve({ available: true, cli }),
      record: (suites, env, log) => {
        calls.push({ suites, env });
        log('one');
        return Promise.resolve(suites.length);
      },
      write: (text) => written.push(text),
      ...overrides,
    };
  }

  it('records the selected suites with the run environment', async () => {
    const h = host();
    await expect(runRecorder(['--rev', 'abcdef0', '--suite', 'handshake'], h)).resolves.toBe(0);
    expect(h.calls).toHaveLength(1);
    const env = h.calls[0]?.env;
    expect(env).toMatchObject({
      cli,
      platform: 'linux',
      outDir: CONFORMANCE,
      revision: 'abcdef0',
      today: '2026-10-13',
    });
    expect(env?.physicalRoot).toBeUndefined();
    expect(env?.plainDir).toBeUndefined();
    expect(env?.leakHost.table.source).toBe('linux-proc');
    // The product's builder reaches the recording unchanged.
    expect(env?.launch).toBe(LAUNCH);
    expect(h.written).toEqual([
      'one\n',
      '\n1 case(s) recorded; egress violations 0, leaks 0, outside writes 0\n',
    ]);
  });

  it('passes a subst test root, its physical directory and the plain-copy directory', async () => {
    const h = host({
      env: {
        HUDHUD_TEST_ROOT: 'S:\\',
        HUDHUD_TEST_ROOT_PHYSICAL: 'C:\\r',
        HUDHUD_RECORD_PLAIN_DIR: 'C:\\plain',
      },
    });
    await runRecorder(['--rev', 'abcdef0'], h);
    expect(h.calls[0]?.env).toMatchObject({
      physicalRoot: { testRoot: 'S:\\', physical: 'C:\\r' },
      plainDir: 'C:\\plain',
    });
    const partial = host({ env: { HUDHUD_TEST_ROOT: 'S:\\', HUDHUD_RECORD_PLAIN_DIR: '' } });
    await runRecorder(['--rev', 'abcdef0'], partial);
    expect(partial.calls[0]?.env.physicalRoot).toBeUndefined();
    expect(partial.calls[0]?.env.plainDir).toBeUndefined();
  });

  it('stops before recording when the pinned CLI is unavailable', async () => {
    const h = host({ probe: () => Promise.resolve({ available: false, reason: 'no cache' }) });
    await expect(runRecorder(['--rev', 'abcdef0'], h)).rejects.toThrow('no cache');
    expect(h.calls).toEqual([]);
  });
});

describe('nodeRecorderHost', () => {
  it('describes this host and writes to stdout', () => {
    const real = nodeRecorderHost(REPO, LAUNCH);
    expect(real.repoRoot).toBe(REPO);
    expect(real.launch).toBe(LAUNCH);
    expect(real.platform).toBe(process.platform);
    expect(real.env).toBe(process.env);
    expect(real.today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof real.probe).toBe('function');
    expect(typeof real.record).toBe('function');
    real.write('');
  });

  it('probes the repository pin (refused or unavailable here, never run)', async () => {
    const probe = nodeRecorderHost(path.join(REPO, 'no-such-repo'), LAUNCH).probe();
    await expect(probe).rejects.toThrow();
  });
});
