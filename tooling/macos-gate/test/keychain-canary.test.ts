// The decisive Keychain probe of gate item 3 (lead decision C after gate
// run 2): GitHub-hosted runners only, a labelled fake item in the runner's
// own login keychain, lookups that never print a secret, and a verified
// deletion in a finally block.

import { afterEach, describe, expect, it } from 'vitest';

import {
  CANARY_VALUE,
  canaryAllowed,
  canaryVerdict,
  keychainCanary,
} from '../src/items/keychain-canary.js';
import { keychainItem } from '../src/items/keychain.js';
import { ProcessLedger } from '../src/ps.js';
import { ItemRecorder } from '../src/report.js';
import { createSandbox, type Sandbox } from '../src/sandbox.js';
import type { SessionContext } from '../src/session.js';
import { clearSessions, result, SimCli, SimHost, type SimOptions } from './sim.js';

const BINARY = '/cache/2.1.296/darwin-arm64/claude';
const LOGIN = '/Users/runner/Library/Keychains/login.keychain-db';
const CHECK = 'keychain canary: written only on a GitHub-hosted runner, and deleted again';

afterEach(() => {
  clearSessions();
});

function world(options: SimOptions = {}): { sim: SimHost; context: SessionContext } {
  const sim = new SimHost({ cli: (child, host) => new SimCli(child, host, {}), ...options });
  sim.files.set(BINARY, { kind: 'file', text: 'binary' });
  return { sim, context: { host: sim, ledger: new ProcessLedger(sim), binary: BINARY } };
}

async function sandboxOf(sim: SimHost): Promise<Sandbox> {
  return createSandbox(sim.fs, sim.tmpdir);
}

function securityRuns(sim: SimHost, command: string) {
  return sim.runs.filter((run) => run.file === '/usr/bin/security' && run.args[0] === command);
}

describe('the keychain canary', () => {
  it('runs only on a GitHub-hosted runner', () => {
    expect(canaryAllowed({ CI: 'true', RUNNER_ENVIRONMENT: 'github-hosted' })).toBe(true);
    expect(canaryAllowed({ CI: 'true', RUNNER_ENVIRONMENT: 'self-hosted' })).toBe(false);
    expect(canaryAllowed({ CI: '1', RUNNER_ENVIRONMENT: 'github-hosted' })).toBe(false);
    expect(canaryAllowed({})).toBe(false);
  });

  it('is refused elsewhere and writes nothing (item 3 still passes)', async () => {
    const { sim, context } = world();
    delete sim.env['RUNNER_ENVIRONMENT'];
    const recorder = new ItemRecorder(3);
    await keychainItem(context, recorder);
    const outcome = recorder.finish(0);
    expect(outcome.evidence['keychainCanary']).toEqual({
      verdict: 'refused',
      reason: 'not a GitHub-hosted runner (CI=true and RUNNER_ENVIRONMENT=github-hosted)',
      lookups: [],
    });
    expect(outcome.checks.find((check) => check.name === CHECK)?.ok).toBe(true);
    expect(sim.runs.filter((run) => run.args[0]?.endsWith('-generic-password'))).toEqual([]);
  });

  it('in item 3 on a GitHub-hosted runner: isolated, deleted, recorded', async () => {
    const { sim, context } = world();
    const recorder = new ItemRecorder(3);
    await keychainItem(context, recorder);
    const outcome = recorder.finish(0);
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence['keychainCanary']).toMatchObject({
      verdict: 'isolated',
      keychain: LOGIN,
      deleted: { code: 0, gone: true },
    });
    expect(outcome.checks.find((check) => check.name === CHECK)?.detail).toBe(
      'isolated: the CLI environment cannot find an item of the runner login keychain',
    );
    expect(sim.keychain.size).toBe(0);
  });

  it('writes one labelled fake item, never prints a secret, and deletes exactly it', async () => {
    const { sim, context } = world();
    const report = await keychainCanary(context, await sandboxOf(sim), 'http://127.0.0.1:1', LOGIN);
    expect(report.verdict).toBe('isolated');
    expect(report.service).toMatch(/^hudhud-gate-canary-[0-9a-f-]{36}$/);
    const [add] = securityRuns(sim, 'add-generic-password');
    expect(add?.args).toEqual([
      'add-generic-password',
      '-a',
      'hudhud-gate',
      '-s',
      report.service,
      '-l',
      'hudhud macOS gate canary (fake value, deleted by the gate)',
      '-w',
      CANARY_VALUE,
      LOGIN,
    ]);
    expect(add?.options.env['HOME']).toBe('/Users/runner');
    const finds = securityRuns(sim, 'find-generic-password');
    expect(finds).toHaveLength(4);
    for (const find of finds) {
      expect(find.args).toEqual([
        'find-generic-password',
        '-a',
        'hudhud-gate',
        '-s',
        report.service,
      ]);
      expect(find.args.some((arg) => arg === '-w' || arg === '-g')).toBe(false);
    }
    // The CLI's own environment, then with CFFIXED_USER_HOME.
    expect(finds[1]?.options.env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:1');
    expect(finds[2]?.options.env['CFFIXED_USER_HOME']).toBe(finds[2]?.options.env['HOME']);
    expect(securityRuns(sim, 'delete-generic-password').map((run) => run.args)).toEqual([
      ['delete-generic-password', '-a', 'hudhud-gate', '-s', report.service, LOGIN],
    ]);
    expect(report.lookups.map((lookup) => [lookup.env, lookup.found])).toEqual([
      ['runner HOME (control)', true],
      ['CLI environment (sandbox HOME)', false],
      ['CLI environment + CFFIXED_USER_HOME', false],
    ]);
    expect(sim.keychain.size).toBe(0);
  });

  it('reports not-isolated when the CLI environment finds the canary, and still deletes it', async () => {
    const { sim, context } = world({
      run: (file, args, options) =>
        file === '/usr/bin/security' &&
        args[0] === 'find-generic-password' &&
        options.env['CFFIXED_USER_HOME'] !== undefined
          ? result('keychain: login')
          : undefined,
    });
    const report = await keychainCanary(context, await sandboxOf(sim), 'http://m', LOGIN);
    expect(report).toMatchObject({ verdict: 'not-isolated', deleted: { gone: true } });
    expect(sim.keychain.size).toBe(0);
  });

  it('fails the item check when the deletion cannot be verified', async () => {
    const { sim, context } = world({
      run: (file, args) =>
        file === '/usr/bin/security' && args[0] === 'delete-generic-password'
          ? result('', { code: 1 })
          : undefined,
    });
    const recorder = new ItemRecorder(3);
    await keychainItem(context, recorder);
    const outcome = recorder.finish(0);
    expect(outcome.evidence['keychainCanary']).toMatchObject({
      deleted: { code: 1, gone: false },
    });
    expect(outcome.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual([CHECK]);
    expect(sim.keychain.size).toBe(1);
  });

  it('deletes in a finally block even when a lookup throws', async () => {
    const { sim, context } = world({
      run: (file, args, options) => {
        if (
          file === '/usr/bin/security' &&
          args[0] === 'find-generic-password' &&
          options.env['CFFIXED_USER_HOME'] !== undefined
        ) {
          throw new Error('spawn failed');
        }
        return undefined;
      },
    });
    await expect(keychainCanary(context, await sandboxOf(sim), 'http://m', LOGIN)).rejects.toThrow(
      'spawn failed',
    );
    expect(securityRuns(sim, 'delete-generic-password')).toHaveLength(1);
    expect(sim.keychain.size).toBe(0);
  });

  it('is inconclusive without a default keychain inside the runner HOME, and writes nothing', async () => {
    const { sim, context } = world();
    const sandbox = await sandboxOf(sim);
    for (const keychain of [undefined, '/Library/Keychains/System.keychain']) {
      expect(await keychainCanary(context, sandbox, 'http://m', keychain)).toEqual({
        verdict: 'inconclusive',
        reason: 'no default keychain inside the runner HOME to write the canary to',
        lookups: [],
      });
    }
    delete sim.env['HOME'];
    expect((await keychainCanary(context, sandbox, 'http://m', LOGIN)).verdict).toBe(
      'inconclusive',
    );
    expect(securityRuns(sim, 'add-generic-password')).toEqual([]);
  });

  it('is inconclusive when the canary cannot be added (and the delete finds nothing)', async () => {
    const { sim, context } = world({
      run: (file, args) =>
        file === '/usr/bin/security' && args[0] === 'add-generic-password'
          ? result('', { code: 36, stderr: 'locked\n' })
          : undefined,
    });
    const report = await keychainCanary(context, await sandboxOf(sim), 'http://m', LOGIN);
    expect(report).toMatchObject({
      verdict: 'inconclusive',
      reason: 'the canary could not be added',
      added: { code: 36, stderr: 'locked' },
      lookups: [],
      deleted: { code: 44, gone: true },
    });
  });

  it('decides the verdict from the control and the two CLI-environment lookups', () => {
    const found = (env: string) => ({ env, code: 0, found: true });
    const missing = (env: string, code: number | null = 44) => ({ env, code, found: false });
    expect(canaryVerdict(0, [missing('control'), missing('a'), missing('b')])).toEqual({
      verdict: 'inconclusive',
      reason: 'the control lookup did not find the canary',
    });
    expect(canaryVerdict(0, [])).toMatchObject({ verdict: 'inconclusive' });
    expect(canaryVerdict(0, [found('control'), missing('a'), missing('b', null)])).toEqual({
      verdict: 'inconclusive',
      reason: 'a lookup in the CLI environment failed',
    });
    expect(canaryVerdict(0, [found('control'), missing('a')])).toMatchObject({
      verdict: 'inconclusive',
    });
    expect(canaryVerdict(null, [])).toMatchObject({ verdict: 'inconclusive' });
    expect(canaryVerdict(0, [found('control'), missing('a'), found('b')])).toMatchObject({
      verdict: 'not-isolated',
    });
  });
});
