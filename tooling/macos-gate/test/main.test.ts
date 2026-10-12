import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parsePin } from '../../test-support/src/cli/pin.js';
import {
  fakeRegistry,
  manifestFor,
  release,
  serve,
  serveSdk,
} from '../../test-support/test/cli/fake-registry.js';
import { prepareBinaries, type PreparedBinaries } from '../src/items/provenance.js';
import {
  parseGateArgs,
  runGate,
  runItem,
  type GateOptions,
  type PrepareBinaries,
} from '../src/main.js';
import type { GateReport, ItemResult } from '../src/report.js';
import { clearSessions, SimCli, SimHost } from './sim.js';

const PIN = {
  version: '2.1.296',
  platforms: {
    'darwin-arm64': {
      package: '@anthropic-ai/claude-code-darwin-arm64',
      file: 'claude',
      pendingGate: true,
    },
    'darwin-x64': {
      package: '@anthropic-ai/claude-code-darwin-x64',
      file: 'claude',
      pendingGate: true,
    },
  },
};
const BINARY = '/cache/2.1.296/darwin-arm64/claude';

afterEach(() => {
  clearSessions();
});

describe('parseGateArgs', () => {
  it('parses the options and resolves paths against the working directory', () => {
    expect(
      parseGateArgs(
        [
          '--out',
          'res',
          '--expect-arch',
          'x64',
          '--sdk-version',
          '0.3.300',
          '--pin',
          'p.json',
          '--cache',
          '/c',
        ],
        { GITHUB_STEP_SUMMARY: '/s.md' },
        '/repo',
      ),
    ).toEqual({
      out: '/repo/res',
      expectArch: 'x64',
      sdkVersion: '0.3.300',
      pin: '/repo/p.json',
      cache: '/c',
      summary: '/s.md',
    });
    expect(
      parseGateArgs(
        ['--out', '/o/res', '--expect-arch', 'arm64'],
        { GITHUB_STEP_SUMMARY: '' },
        '/repo',
      ),
    ).toEqual({
      out: '/o/res',
      expectArch: 'arm64',
      sdkVersion: '0.3.296',
      pin: '/repo/tooling/cli-pin.json',
      cache: '/o/cli-cache',
      summary: undefined,
    });
  });

  it('reports usage errors', () => {
    expect(parseGateArgs(['--bogus'], {}, '/')).toMatch(/bogus/);
    expect(parseGateArgs(['--expect-arch', 'arm64'], {}, '/')).toBe('--out is required');
    expect(parseGateArgs(['--out', 'x'], {}, '/')).toBe('--expect-arch must be arm64 or x64');
    expect(parseGateArgs(['--out', 'x', '--expect-arch', 'ia32'], {}, '/')).toBe(
      '--expect-arch must be arm64 or x64',
    );
  });
});

describe('runItem', () => {
  it('records a thrown error as a failed item and logs progress', async () => {
    const sim = new SimHost();
    const failed = await runItem(sim, 3, () => Promise.reject(new Error('boom')));
    expect(failed).toMatchObject({ id: 3, status: 'fail', error: 'boom' });
    expect(sim.logs).toContain('gate item 3: fail (0 ms)');
  });
});

describe('runGate', () => {
  function gate(): { sim: SimHost; options: GateOptions } {
    const sim = new SimHost({ cli: (child, host) => new SimCli(child, host, {}) });
    sim.files.set('/repo/tooling/cli-pin.json', { kind: 'file', text: JSON.stringify(PIN) });
    sim.files.set(BINARY, { kind: 'file', text: 'binary' });
    return {
      sim,
      options: {
        out: '/out/results',
        expectArch: 'arm64',
        sdkVersion: '0.3.296',
        pin: '/repo/tooling/cli-pin.json',
        cache: '/out/cli-cache',
        summary: '/summary.md',
      },
    };
  }

  const digest = (platform: string): PreparedBinaries['digests'][number] => ({
    platform,
    package: `@anthropic-ai/claude-code-${platform}`,
    version: '2.1.296',
    file: 'claude',
    integrity: `sha512-${'A'.repeat(86)}==`,
    sha256: 'a'.repeat(64),
    size: 10,
    manifest: { source: 'sdk', sdkIntegrity: 'sha512-y', sha256: 'a'.repeat(64), size: 10 },
    pinStatus: 'recorded',
    recordedAt: 'now',
  });

  it('runs all seven items against the simulated macOS host and passes', async () => {
    const { sim, options } = gate();
    const seen: unknown[] = [];
    const prepare: PrepareBinaries = (host, pin, prepareOptions) => {
      seen.push(host === sim, pin.version, prepareOptions);
      return Promise.resolve({
        digests: [digest('darwin-arm64'), digest('darwin-x64')],
        failures: {},
        hostBinary: BINARY,
      });
    };
    const code = await runGate(sim, options, prepare);
    const report = JSON.parse(
      sim.files.get('/out/results/result.json')?.text ?? '{}',
    ) as GateReport;
    const failures = report.items.flatMap((item) =>
      item.checks.filter((check) => !check.ok).map((check) => `${String(item.id)}: ${check.name}`),
    );
    expect(failures).toEqual([]);
    expect(code).toBe(0);
    expect(seen).toEqual([
      true,
      '2.1.296',
      { sdkVersion: '0.3.296', cacheRoot: '/out/cli-cache', hostKey: 'darwin-arm64' },
    ]);
    expect(report.status).toBe('pass');
    expect(report.items.map((item) => item.status)).toEqual(Array(7).fill('pass'));
    expect(report.cleanup.survivors).toEqual([]);
    for (const name of [
      'item-1-provenance.json',
      'item-2-process-tree.json',
      'item-3-keychain.json',
      'item-4-shell-snapshot.json',
      'item-5-socket-path.json',
      'item-6-path-identity.json',
      'item-7-ci-runner.json',
    ]) {
      const item = JSON.parse(sim.files.get(`/out/results/${name}`)?.text ?? '{}') as ItemResult;
      expect(item.status).toBe('pass');
    }
    const record = JSON.parse(sim.files.get('/out/results/digests.json')?.text ?? '{}') as {
      platforms: object;
    };
    expect(Object.keys(record.platforms)).toEqual(['darwin-arm64', 'darwin-x64']);
    expect(sim.files.get('/out/results/summary.md')?.text).toContain('**PASS**');
    expect(sim.files.get('/summary.md')?.text).toBe(sim.files.get('/out/results/summary.md')?.text);
    expect(sim.descendantsOf(sim.pid)).toEqual([]);
  });

  it('fails every session item without a verified binary, and skips the step summary when unset', async () => {
    const { sim, options } = gate();
    const prepare: PrepareBinaries = () =>
      Promise.resolve({
        digests: [],
        failures: { 'darwin-arm64': 'gone', 'darwin-x64': 'gone' },
        hostBinary: undefined,
      });
    const code = await runGate(sim, { ...options, summary: undefined }, prepare);
    expect(code).toBe(1);
    const report = JSON.parse(
      sim.files.get('/out/results/result.json')?.text ?? '{}',
    ) as GateReport;
    expect(report.items.map((item) => item.status)).toEqual(Array(7).fill('fail'));
    expect(report.items[1]?.error).toBe('no verified darwin-arm64 binary (item 1)');
    expect(sim.files.has('/summary.md')).toBe(false);
    expect(sim.spawned).toEqual([]);
  });

  it('refuses an invalid pin before anything runs', async () => {
    const { sim, options } = gate();
    sim.files.set(options.pin, { kind: 'file', text: '{"version":"x"}' });
    await expect(runGate(sim, options, () => Promise.reject(new Error('unused')))).rejects.toThrow(
      /SemVer/,
    );
  });
});

describe('prepareBinaries', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hudhud-gate-prepare-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function host(registry: ReturnType<typeof fakeRegistry>): SimHost {
    const sim = new SimHost({ platform: process.platform });
    Object.assign(sim, { registry: registry.options });
    return sim;
  }

  it('verifies both platforms, picks the host binary and records failures per platform', async () => {
    const registry = fakeRegistry();
    const arm = release('darwin-arm64', '2.1.296');
    serve(registry, arm);
    serveSdk(registry, '0.3.296', '2.1.296', manifestFor('2.1.296', arm));
    const pin = parsePin(PIN, 'pin');
    const prepared = await prepareBinaries(host(registry), pin, {
      sdkVersion: '0.3.296',
      cacheRoot: root,
      hostKey: 'darwin-arm64',
    });
    expect(prepared.digests.map((entry) => entry.platform)).toEqual(['darwin-arm64']);
    expect(prepared.hostBinary).toBe(path.join(root, '2.1.296', 'darwin-arm64', 'claude'));
    expect(prepared.failures['darwin-x64']).toMatch(/^\[registry\] /);
    const other = await prepareBinaries(host(registry), pin, {
      sdkVersion: '0.3.296',
      cacheRoot: root,
      hostKey: 'darwin-x64',
    });
    expect(other.hostBinary).toBeUndefined();
  });

  it('records a non-fetch failure by its message', async () => {
    const registry = fakeRegistry();
    const arm = release('darwin-arm64', '2.1.296');
    serve(registry, arm);
    serveSdk(registry, '0.3.296', '2.1.296', manifestFor('2.1.296', arm));
    const file = path.join(root, 'not-a-dir');
    await writeFile(file, 'x');
    const prepared = await prepareBinaries(host(registry), parsePin(PIN, 'pin'), {
      sdkVersion: '0.3.296',
      cacheRoot: file,
      hostKey: 'darwin-arm64',
    });
    expect(prepared.failures['darwin-arm64']).not.toMatch(/^\[/);
    expect(prepared.hostBinary).toBeUndefined();
  });
});
