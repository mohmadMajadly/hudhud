import { afterEach, describe, expect, it } from 'vitest';

import type { GateDigest } from '../src/digests.js';
import { keychainItem, keychainPaths, searchListIsolation } from '../src/items/keychain.js';
import { pathIdentityItem, turnMessages } from '../src/items/path-identity.js';
import { processTreeItem } from '../src/items/process-tree.js';
import {
  provenanceItem,
  quarantineValue,
  signerLines,
  type PreparedBinaries,
} from '../src/items/provenance.js';
import { machArch, runnerItem, runnerMetadata } from '../src/items/runner.js';
import { shellSnapshotItem } from '../src/items/shell-snapshot.js';
import { fitsSunPath, isInside, LONG_TMP_NAME, socketPathItem } from '../src/items/socket-path.js';
import { ProcessLedger } from '../src/ps.js';
import { ItemRecorder, type GateItemId, type ItemResult } from '../src/report.js';
import type { SessionContext } from '../src/session.js';
import {
  clearSessions,
  result,
  SimCli,
  SimHost,
  type CliFlags,
  type SimChild,
  type SimOptions,
} from './sim.js';

const BINARY = '/cache/2.1.296/darwin-arm64/claude';

afterEach(() => {
  clearSessions();
});

function world(
  flags: CliFlags = {},
  options: SimOptions = {},
): { sim: SimHost; context: SessionContext } {
  const sim = new SimHost({ cli: (child, host) => new SimCli(child, host, flags), ...options });
  sim.files.set(BINARY, { kind: 'file', text: 'binary' });
  return { sim, context: { host: sim, ledger: new ProcessLedger(sim), binary: BINARY } };
}

async function item(
  id: GateItemId,
  run: (r: ItemRecorder) => Promise<void>,
): Promise<ItemResult & { failed: string[] }> {
  const recorder = new ItemRecorder(id);
  await run(recorder);
  const finished = recorder.finish(0);
  return {
    ...finished,
    failed: finished.checks.filter((check) => !check.ok).map((check) => check.name),
  };
}

/** The detail of the one check whose name starts with `prefix`. */
function detail(outcome: ItemResult, prefix: string): string | undefined {
  return outcome.checks.find((check) => check.name.startsWith(prefix))?.detail;
}

function noSurvivors(sim: SimHost): void {
  expect(sim.descendantsOf(sim.pid)).toEqual([]);
  expect([...sim.table.values()].filter((p) => p.ppid === 1 && p.pid !== sim.pid)).toEqual([]);
}

const digest = (platform: string): GateDigest => ({
  platform,
  package: `@anthropic-ai/claude-code-${platform}`,
  version: '2.1.296',
  file: 'claude',
  integrity: 'sha512-x',
  sha256: 'a'.repeat(64),
  size: 1,
  manifest: { source: 'sdk', sdkIntegrity: 'sha512-y', sha256: 'a'.repeat(64), size: 1 },
  pinStatus: 'recorded',
  recordedAt: 'now',
});

const prepared: PreparedBinaries = {
  digests: [digest('darwin-arm64'), digest('darwin-x64')],
  failures: {},
  hostBinary: BINARY,
};

describe('item 1: provenance', () => {
  it('passes with verified digests, a valid signature and named quarantine outcomes', async () => {
    const { sim } = world();
    const outcome = await item(1, (r) => provenanceItem(sim, prepared, '2.1.296', r));
    expect(outcome.failed).toEqual([]);
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence['signer']).toEqual([
      'Identifier=com.anthropic.claude-code',
      'Authority=Developer ID Application',
      'TeamIdentifier=Q6L2SF6YDW',
    ]);
    expect(outcome.evidence['quarantinedUnsigned']).toMatchObject({
      cause: 'killed-at-launch',
      refusedByPolicy: true,
    });
    const xattr = sim.runs.find((run) => run.file === '/usr/bin/xattr');
    expect(xattr?.args.slice(0, 3)).toEqual([
      '-w',
      'com.apple.quarantine',
      quarantineValue(sim.time),
    ]);
    expect(sim.mocks.every((mock) => mock.closed)).toBe(true);
  });

  it('fails on a fetch failure and stops without a binary', async () => {
    const { sim } = world();
    const outcome = await item(1, (r) =>
      provenanceItem(
        sim,
        { digests: [], failures: { 'darwin-x64': '[registry] 404' }, hostBinary: undefined },
        '2.1.296',
        r,
      ),
    );
    expect(outcome.failed).toEqual([
      'darwin-x64: npm integrity, binary sha256/size and SDK manifest agree',
      'binary of this runner verified',
    ]);
    expect(sim.runs).toEqual([]);
  });

  it('fails when the signature, version, quarantine outcomes or egress are wrong', async () => {
    const { sim } = world(
      {},
      {
        run: (file, args) => {
          if (file === '/usr/bin/codesign' && args[0] === '--verify')
            return result('', { code: 1 });
          if (file === '/usr/bin/codesign' && args[0] === '--remove-signature') {
            return result('', { code: 1 });
          }
          if (args[0] === '--version' && file.includes('/signed/')) return result('', { code: 2 });
          if (args[0] === '--version' && file.includes('/unsigned/'))
            return result('2.1.296 (Claude Code)');
          if (args[0] === '--version') return result('9.9.9 (Claude Code)');
          if (file === '/usr/bin/xattr') return result('', { code: 1, stderr: 'denied' });
          return undefined;
        },
      },
    );
    const original = sim.startMock.bind(sim);
    sim.startMock = async () => {
      const mock = await original();
      (mock as unknown as { trapped: unknown[] }).trapped.push({ kind: 'connect' });
      return mock;
    };
    const outcome = await item(1, (r) => provenanceItem(sim, prepared, '2.1.296', r));
    expect(outcome.failed).toEqual([
      'codesign --verify --strict accepts the binary',
      'the binary runs in the sandbox and reports the pinned version',
      'the signature of the test copy was removed',
      'quarantine attribute set on signed copy',
      'quarantine attribute set on unsigned copy',
      'quarantined signed binary: runs, or fails with a named launch cause',
      'egress: no request reached the trap',
    ]);
  });

  it('records an unsigned quarantined copy that runs as evidence only, never failing the item', async () => {
    const { sim } = world(
      {},
      {
        run: (file, args) =>
          args[0] === '--version' && file.includes('/unsigned/')
            ? result('2.1.296 (Claude Code)')
            : undefined,
      },
    );
    const outcome = await item(1, (r) => provenanceItem(sim, prepared, '2.1.296', r));
    expect(outcome.failed).toEqual([]);
    expect(outcome.status).toBe('pass');
    expect(outcome.evidence['quarantinedUnsigned']).toMatchObject({
      cause: 'ok',
      refusedByPolicy: false,
    });
  });

  it('accepts a Gatekeeper refusal of the quarantined signed binary', async () => {
    const { sim } = world(
      {},
      {
        run: (file, args) =>
          args[0] === '--version' && file.includes('/quarantine/')
            ? result('', { code: null, error: 'ETIMEDOUT' })
            : undefined,
      },
    );
    const outcome = await item(1, (r) => provenanceItem(sim, prepared, '2.1.296', r));
    expect(outcome.failed).toEqual([]);
  });

  it('extracts signer lines and builds the quarantine value', () => {
    expect(
      signerLines('Executable=/x\r\nIdentifier=a\nFormat=Mach-O\nRuntime Version=15\n'),
    ).toEqual(['Identifier=a', 'Format=Mach-O', 'Runtime Version=15']);
    expect(quarantineValue(0x10_000 * 1000 + 999)).toBe('0083;10000;hudhud-gate;');
  });
});

describe('item 2: process tree', () => {
  it('passes when the tool has its own group, SIGTERM cleans it, SIGINT exits 0 and the sweep works', async () => {
    const { sim, context } = world();
    const outcome = await item(2, (r) => processTreeItem(context, r));
    expect(outcome.failed).toEqual([]);
    expect(outcome.status).toBe('pass');
    expect((outcome.evidence['sigkillSurvivors'] as unknown[]).length).toBe(2);
    expect(outcome.evidence['sweep']).toMatchObject({ survivors: [] });
    noSurvivors(sim);
  });

  it('records the Linux SIGINT shape (no result) and the core classification', async () => {
    const { context } = world();
    const outcome = await item(2, (r) => processTreeItem(context, r));
    expect(outcome.evidence['sigintShape']).toEqual({ shape: 'no-result', results: [] });
    expect(outcome.evidence['sigintClassification']).toEqual({
      outcome: 'unknown',
      turnSynthesis: 'error',
      error: 'PROCESS_EXITED',
    });
  });

  it('passes on the gate run 1 macOS shapes: (name) tool rows, zombie children, error result then exit 0 on SIGINT', async () => {
    const { sim, context } = world({
      hiddenToolArgs: true,
      zombieSecurity: true,
      intErrorResultExit0: true,
    });
    const outcome = await item(2, (r) => processTreeItem(context, r));
    expect(outcome.failed).toEqual([]);
    const seen = (outcome.evidence['sigtermSession'] as { descendantsSeen: string[] })
      .descendantsSeen;
    expect(seen).toEqual(expect.arrayContaining(['(security) [zombie]', '(zsh)', '(sleep)']));
    expect(outcome.evidence['sigintShape']).toEqual({
      shape: 'error-result',
      results: [{ subtype: 'error_during_execution', is_error: true, terminal_reason: undefined }],
    });
    expect(outcome.evidence['sigintClassification']).toEqual({
      outcome: 'unknown',
      turnSynthesis: 'none',
      error: 'PROCESS_EXITED',
    });
    const lines = outcome.evidence['psLinesBeforeSigterm'] as string[];
    expect(
      lines.some((text) => / Z {4}\w{3} \w{3} [ \d]\d [\d:]{8} \d{4} {5}\(security\)$/.test(text)),
    ).toBe(true);
    noSurvivors(sim);
  });

  it('fails when SIGINT yields a success result', async () => {
    class SuccessOnInt extends SimCli {
      private readonly own: SimChild;
      constructor(child: SimChild, host: SimHost) {
        super(child, host, {});
        this.own = child;
      }
      override signal(name: NodeJS.Signals): void {
        if (name !== 'SIGINT') {
          super.signal(name);
          return;
        }
        this.own.emit({ type: 'result', subtype: 'success', is_error: false });
        this.own.exit(0, null);
      }
    }
    const { sim, context } = world({}, { cli: (child, host) => new SuccessOnInt(child, host) });
    const outcome = await item(2, (r) => processTreeItem(context, r));
    // A success result and exit 0 would read as a normal close: both checks fail.
    expect(outcome.failed).toEqual([
      'SIGINT mid-stream: no result, or exactly one error result (recorded shape)',
      'SIGINT mid-stream: the core exit classifier ends the session with PROCESS_EXITED and settles the turn once',
    ]);
    expect(outcome.evidence['sigintShape']).toMatchObject({ shape: 'other' });
    noSurvivors(sim);
  });

  it('fails when the CLI path carries column padding (the gate run 1 parser fault)', async () => {
    const { context } = world({}, { cli: (child, host) => new SimCli(child, host, {}) });
    const host = context.host as SimHost;
    const spawn = host.spawn.bind(host);
    host.spawn = (file, args, options) => {
      const child = spawn(file, args, options);
      const record = child.pid === undefined ? undefined : host.table.get(child.pid);
      if (record !== undefined) record.name = `    ${record.name}`;
      return child;
    };
    const outcome = await item(2, (r) => processTreeItem(context, r));
    expect(outcome.failed).toContain(
      'ps: the CLI name is its executable path, without column padding',
    );
  });

  it('fails on a shared group, a SIGTERM that leaves tools, and a SIGINT with a result', async () => {
    const { sim, context } = world({ sharedGroup: true, termLeavesTools: true, intResult: true });
    const outcome = await item(2, (r) => processTreeItem(context, r));
    expect(outcome.failed).toEqual([
      'process groups: the Bash tool leads its own group',
      'SIGTERM: the CLI cleans its tool groups (no survivor by pid + start time)',
      'SIGINT mid-stream: exit code 0',
      'SIGINT mid-stream: the core exit classifier ends the session with PROCESS_EXITED and settles the turn once',
    ]);
    noSurvivors(sim);
  });

  it('fails when the CLI never starts the tool, never answers and ignores signals', async () => {
    const { sim, context } = world({ silent: true, ignoreTerm: true });
    const outcome = await item(2, (r) => processTreeItem(context, r));
    expect(outcome.failed).toEqual([
      'SIGTERM run: the Bash tool runs under the CLI',
      'SIGINT run: signalled while the turn streams',
      'SIGKILL run: the Bash tool runs under the CLI',
    ]);
    noSurvivors(sim);
  });

  it('fails when ps lines are rejected, the start time is off and SIGTERM does not end the CLI', async () => {
    const { sim, context } = world({ ignoreTerm: true });
    const ps = sim.ps.bind(sim);
    let calls = 0;
    sim.ps = () => {
      calls += 1;
      return `${ps()}garbage line\n`;
    };
    const spawn = sim.spawn.bind(sim);
    let first = true;
    sim.spawn = (file, args, options) => {
      const child = spawn(file, args, options);
      if (first && child.pid !== undefined) {
        first = false;
        const record = sim.table.get(child.pid);
        if (record !== undefined) record.start -= 3600;
      }
      return child;
    };
    const outcome = await item(2, (r) => processTreeItem(context, r));
    expect(calls).toBeGreaterThan(0);
    expect(outcome.failed).toEqual(
      expect.arrayContaining([
        'ps: every line parses (LC_ALL=C, TZ=UTC0, pid ppid pgid stat lstart comm)',
        'ps: the lstart start time of the CLI matches its spawn',
        'SIGTERM: the CLI exits',
      ]),
    );
    noSurvivors(sim);
  });

  it('fails without signalling anything when the CLI cannot be spawned', async () => {
    const { sim, context } = world();
    sim.spawnFails = true;
    const outcome = await item(2, (r) => processTreeItem(context, r));
    expect(outcome.failed).toContain('SIGTERM run: the Bash tool runs under the CLI');
    expect(sim.signals).toEqual([]);
  });

  it('reports survivors the session sweep could not kill', async () => {
    const { sim, context } = world({ ignoreEof: true, ignoreTerm: true, silent: true });
    sim.denySignals = true;
    const outcome = await item(2, (r) => processTreeItem(context, r));
    expect(outcome.failed).toContain('SIGTERM run: nothing survives the session');
    sim.denySignals = false;
    expect((await context.ledger.sweepAll()).survivors).toEqual([]);
  });
});

describe('item 3: keychain', () => {
  it('passes with an API key and no security(1) child; the control run ends; the search list is isolated', async () => {
    const { sim, context } = world(
      {},
      {
        cli: (child, host) => {
          host.addProcess(child.pid ?? 0, '/usr/libexec/helper', false);
          return new SimCli(child, host, {});
        },
      },
    );
    const outcome = await item(3, (r) => keychainItem(context, r));
    expect(outcome.failed).toEqual([]);
    expect(outcome.evidence['keychainsDirInIsolatedHome']).toBeNull();
    expect(outcome.evidence['limitation']).toMatch(/security\(1\) child processes/);
    expect(outcome.evidence['apiKeySession']).toMatchObject({
      descendants: ['/usr/libexec/helper'],
      security: [],
    });
    expect(outcome.evidence['securityShim']).toMatchObject({ invoked: false, argv: [] });
    expect(detail(outcome, 'API key: Keychain access recorded')).toMatch(
      /^no security\(1\) child in \d+ samples$/,
    );
    expect(outcome.evidence['keychainIsolation']).toMatchObject({
      cffixedUserHome: 'isolated',
      homeAlone: 'isolated',
      proven: true,
    });
    expect(detail(outcome, 'search-list probes')).toMatch(
      /^CFFIXED_USER_HOME: isolated, HOME alone: isolated; isolation proven \(/,
    );
    noSurvivors(sim);
  });

  it('records a security(1) child with the API key (ADR-0014 amendment 5); fails on another key source', async () => {
    const { sim, context } = world({ security: true, apiKeySource: 'none' });
    const outcome = await item(3, (r) => keychainItem(context, r));
    expect(outcome.failed).toEqual(['API key: apiKeySource is ANTHROPIC_API_KEY']);
    expect(detail(outcome, 'API key: Keychain access recorded')).toMatch(
      /^security\(1\) seen 1x, first at \d+ ms after the spawn \(\d+ samples\)$/,
    );
    noSurvivors(sim);
  });

  it('records the gate run 1 and 2 shape: a (security) zombie with the API key, and the shim argv', async () => {
    const { sim, context } = world({ zombieSecurity: true });
    const outcome = await item(3, (r) => keychainItem(context, r));
    // Access is recorded, not failed (ADR-0014 item 3, amendment 5).
    expect(outcome.failed).toEqual([]);
    expect(outcome.evidence['apiKeySession']).toMatchObject({
      descendants: ['(security) [zombie]'],
      security: [expect.objectContaining({ name: '(security)', zombie: true })],
    });
    expect(outcome.evidence['controlSession']).toMatchObject({ securitySeen: true });
    expect(outcome.evidence['securityShim']).toMatchObject({
      invoked: true,
      argv: ['[find-generic-password][-s][Claude Code-credentials]'],
      securitySeen: false,
      result: 'success',
    });
    const probes = outcome.evidence['keychainSearchList'] as { env: string; command: string }[];
    expect(probes.map((probe) => `${probe.env}: ${probe.command}`)).toEqual([
      'runner HOME: security list-keychains -d user',
      'runner HOME: security default-keychain -d user',
      'sandbox HOME: security list-keychains -d user',
      'sandbox HOME: security default-keychain -d user',
      'sandbox HOME + CFFIXED_USER_HOME: security list-keychains -d user',
      'sandbox HOME + CFFIXED_USER_HOME: security default-keychain -d user',
    ]);
    const security = sim.runs.filter((run) => run.file === '/usr/bin/security');
    // Read-only: never `-s` (which would change the user's search list).
    expect(security.every((run) => !run.args.includes('-s'))).toBe(true);
    expect(security.at(-1)?.options.env['CFFIXED_USER_HOME']).toMatch(/\/home$/);
    const chmod = sim.runs.find((run) => run.file === '/bin/chmod');
    expect(chmod?.args[0]).toBe('700');
    expect(String(chmod?.args[1])).toMatch(/\/shim\/security$/);
    noSurvivors(sim);
  });

  it('writes a shim that logs each argument and answers not found', async () => {
    const { securityShim } = await import('../src/items/keychain.js');
    expect(securityShim("/tmp/it's/log")).toBe(
      [
        '#!/bin/sh',
        `for a in "$@"; do printf '[%s]' "$a"; done >> '/tmp/it'\\''s/log'`,
        `printf '\\n' >> '/tmp/it'\\''s/log'`,
        'exit 44',
        '',
      ].join('\n'),
    );
  });

  it('does not count isolation as proven when CFFIXED_USER_HOME keeps the runner keychain', async () => {
    const { sim, context } = world(
      {},
      {
        run: (file, args, options) =>
          file === '/usr/bin/security' &&
          options.env['CFFIXED_USER_HOME'] !== undefined &&
          args[0] === 'default-keychain'
            ? result('    "/Users/runner/Library/Keychains/login.keychain-db"\n')
            : undefined,
      },
    );
    const outcome = await item(3, (r) => keychainItem(context, r));
    expect(outcome.failed).toEqual([]);
    expect(outcome.evidence['keychainIsolation']).toMatchObject({
      cffixedUserHome: 'not-isolated',
      homeAlone: 'isolated',
      proven: false,
    });
    noSurvivors(sim);
  });

  it('fails when a search-list probe does not run, and calls the verdict inconclusive', async () => {
    const { context } = world(
      {},
      {
        run: (file, _args, options) =>
          file === '/usr/bin/security' && options.env['CFFIXED_USER_HOME'] !== undefined
            ? result('', { code: null, error: 'ETIMEDOUT' })
            : undefined,
      },
    );
    const outcome = await item(3, (r) => keychainItem(context, r));
    expect(outcome.failed).toEqual(['search-list probes: every read-only query ran']);
    expect(outcome.evidence['keychainIsolation']).toMatchObject({
      cffixedUserHome: 'inconclusive',
      proven: false,
    });
  });

  it('calls the verdict inconclusive without a runner HOME (the baseline then lists nothing)', async () => {
    const { sim, context } = world();
    delete sim.env['HOME'];
    const outcome = await item(3, (r) => keychainItem(context, r));
    expect(outcome.failed).toEqual([]);
    expect(outcome.evidence['keychainIsolation']).toMatchObject({
      cffixedUserHome: 'inconclusive',
      homeAlone: 'inconclusive',
      proven: false,
    });
    const runnerProbe = sim.runs.find((run) => run.file === '/usr/bin/security');
    expect(runnerProbe?.options.env['HOME']).toBe('');
  });

  it('calls every verdict inconclusive when the runner HOME baseline lists no keychain', () => {
    const probe = (env: string, command: string, stdout: string, code: number | null = 0) => ({
      env,
      command,
      code,
      stdout,
      stderr: '',
    });
    const list = 'security list-keychains -d user';
    const fallback = 'security default-keychain -d user';
    const isolated = [
      probe('sandbox HOME', list, ''),
      probe('sandbox HOME', fallback, '', 1),
      probe('sandbox HOME + CFFIXED_USER_HOME', list, '"/s/home/Library/Keychains/x.keychain-db"'),
      probe('sandbox HOME + CFFIXED_USER_HOME', fallback, '', 1),
    ];
    expect(
      searchListIsolation([probe('runner HOME', list, ''), ...isolated], '/s/home'),
    ).toMatchObject({ cffixedUserHome: 'inconclusive', homeAlone: 'inconclusive', proven: false });
    const login = '"/Users/runner/Library/Keychains/login.keychain-db"';
    expect(
      searchListIsolation([probe('runner HOME', list, login, 1), ...isolated], '/s/home'),
    ).toMatchObject({ cffixedUserHome: 'inconclusive' });
    expect(
      searchListIsolation([probe('runner HOME', list, login), ...isolated], '/s/home'),
    ).toMatchObject({ cffixedUserHome: 'isolated', homeAlone: 'isolated', proven: true });
    expect(
      searchListIsolation([probe('runner HOME', list, login), ...isolated.slice(1)], '/s/home'),
    ).toMatchObject({ homeAlone: 'inconclusive' });
    expect(keychainPaths('    "/a b/k"\n\n  "/c"  \nplain\n')).toEqual(['/a b/k', '/c', 'plain']);
  });

  it('names a control-run hang on a security(1) child keychain-access', async () => {
    const { sim, context } = world({ keychainHangWithoutKey: true });
    const outcome = await item(3, (r) => keychainItem(context, r));
    expect(outcome.failed).toEqual([]);
    expect(outcome.evidence['controlSession']).toMatchObject({
      securitySeen: true,
      stallCause: 'keychain-access',
    });
    noSurvivors(sim);
  });

  it('fails when the CLI never answers (first frame, turn, unnamed control stall)', async () => {
    const { sim, context } = world({ silent: true });
    const outcome = await item(3, (r) => keychainItem(context, r));
    expect(outcome.failed).toEqual([
      'API key: the first frame arrives within the first-frame watchdog',
      'API key: apiKeySource is ANTHROPIC_API_KEY',
      'API key: the turn completes',
      'control (no credential): the CLI ends, or its stall is named',
    ]);
    noSurvivors(sim);
  });

  it('fails when the CLI dies without a result, and stops sampling it', async () => {
    const { sim, context } = world(
      {},
      {
        cli: (child, host) => {
          host.at(1_000, () => {
            child.exit(1, null);
          });
          return new SimCli(child, host, { silent: true });
        },
      },
    );
    const outcome = await item(3, (r) => keychainItem(context, r));
    expect(outcome.failed).toContain('API key: the turn completes');
    expect(outcome.failed).not.toContain(
      'control (no credential): the CLI ends, or its stall is named',
    );
    noSurvivors(sim);
  });

  it('copes with a failed spawn: nothing was sampled, so no access was recorded', async () => {
    const { sim, context } = world();
    sim.spawnFails = true;
    const outcome = await item(3, (r) => keychainItem(context, r));
    expect(outcome.failed).toContain('API key: the turn completes');
    expect(outcome.failed).toContain(
      'API key: Keychain access recorded (the tree was sampled from the spawn to the result)',
    );
    expect(detail(outcome, 'API key: Keychain access recorded')).toBe(
      'no security(1) child in 0 samples',
    );
    expect(outcome.failed).not.toContain(
      'control (no credential): the CLI ends, or its stall is named',
    );
  });
});

describe('item 4: shell snapshot', () => {
  it('passes when the CLI completes the turn despite the hanging login shell', async () => {
    const { sim, context } = world();
    const outcome = await item(4, (r) => shellSnapshotItem(context, r));
    expect(outcome.failed).toEqual([]);
    expect(outcome.evidence['hangOutcome']).toMatch(/^completed/);
    expect(sim.files.get(`${sim.tmpdir}/hhg-AAAAA2/home/.zprofile`)?.text).toBe('sleep 600\n');
    noSurvivors(sim);
  });

  it('passes when the hang reaches the stalled path, is named shell-snapshot and is cleaned up', async () => {
    const { sim, context } = world({ zshHang: true });
    const outcome = await item(4, (r) => shellSnapshotItem(context, r));
    expect(outcome.failed).toEqual([]);
    expect(outcome.evidence['hangOutcome']).toBe('watchdog stalled');
    expect(outcome.evidence['hangSession']).toMatchObject({ stallCause: 'shell-snapshot' });
    noSurvivors(sim);
  });

  it('fails when nothing answers (first-frame timeout instead of the stalled path)', async () => {
    const { sim, context } = world({ silent: true });
    const outcome = await item(4, (r) => shellSnapshotItem(context, r));
    expect(outcome.failed).toEqual([
      'default runner shell: the Bash tool turn completes',
      'hanging login shell: the idle watchdog reaches the stalled path',
      'hanging login shell: the stall is named shell-snapshot',
    ]);
    noSurvivors(sim);
  });

  it('fails when turns fail', async () => {
    const { context } = world({ failTurns: true });
    const outcome = await item(4, (r) => shellSnapshotItem(context, r));
    expect(outcome.failed).toEqual([
      'default runner shell: the Bash tool turn completes',
      'hanging login shell: the CLI completes the turn on its own',
    ]);
  });

  it('does not sample a tree it has no identity for', async () => {
    const { sim, context } = world({ zshHang: true });
    const register = context.ledger.register.bind(context.ledger);
    context.ledger.register = async (pid) => {
      await register(pid);
      return null;
    };
    const outcome = await item(4, (r) => shellSnapshotItem(context, r));
    expect(outcome.failed).toContain('hanging login shell: the stall is named shell-snapshot');
    await context.ledger.sweepAll();
    noSurvivors(sim);
  });
});

describe('item 5: socket path', () => {
  it('passes: socket inside the isolated TMPDIR, fallback outside the long one', async () => {
    const { sim, context } = world();
    const outcome = await item(5, (r) => socketPathItem(context, r));
    expect(outcome.failed).toEqual([]);
    expect(outcome.evidence['fallback']).toMatchObject({
      socket: expect.stringMatching(/^\/tmp\/cc-socks-501\//) as unknown,
    });
    expect(outcome.evidence['isolatedSocketAfterExit']).toBe('socket');
    noSurvivors(sim);
  });

  it('fails without messaging_socket_path', async () => {
    const { context } = world({ noSocket: true });
    const outcome = await item(5, (r) => socketPathItem(context, r));
    expect(outcome.failed).toEqual([
      'isolated TMPDIR: system/init reports messaging_socket_path',
      'long TMPDIR: system/init reports messaging_socket_path',
    ]);
    expect(outcome.evidence['isolatedSocketAfterExit']).toBeNull();
    expect(outcome.evidence['fallbackSocketAfterExit']).toBeNull();
  });

  it('fails when the paths are too long, misplaced, not sockets, or the turns fail', async () => {
    const { context } = world({
      socket: (tmp) => `${tmp}/${'s'.repeat(120)}.sock`,
      failTurns: true,
    });
    const outcome = await item(5, (r) => socketPathItem(context, r));
    expect(outcome.failed).toEqual([
      'isolated TMPDIR: the socket path fits sun_path (< 104 bytes)',
      'isolated TMPDIR: the turn completes',
      'long TMPDIR: the fallback socket path fits sun_path (< 104 bytes)',
      'long TMPDIR: the socket falls back outside the over-long TMPDIR',
      'long TMPDIR: the turn completes',
    ]);
    const outside = world({ socket: () => '/elsewhere/x.sock' });
    outside.sim.fs.kind = () => Promise.resolve('file');
    const second = await item(5, (r) => socketPathItem(outside.context, r));
    expect(second.failed).toEqual([
      'isolated TMPDIR: the socket lies inside the isolated TMPDIR',
      'isolated TMPDIR: the path is a socket while the CLI runs',
    ]);
  });

  it('has pure helpers for the limit and containment', () => {
    expect(fitsSunPath('/'.padEnd(103, 'x'))).toBe(true);
    expect(fitsSunPath('/'.padEnd(104, 'x'))).toBe(false);
    expect(isInside('/a/b/c', ['/x', '/a/b/'])).toBe(true);
    expect(isInside('/a/bc', ['/a/b'])).toBe(false);
    expect(LONG_TMP_NAME.length).toBeGreaterThan(64);
  });
});

describe('item 6: path identity', () => {
  it('passes: /tmp alias resolved, case variant canonical, resume keeps the session', async () => {
    const { sim, context } = world();
    const outcome = await item(6, (r) => pathIdentityItem(context, r));
    expect(outcome.failed).toEqual([]);
    expect(outcome.evidence['caseInsensitiveVolume']).toBe(true);
    expect(outcome.evidence['aliasResume']).toMatchObject({ environmentUpdate: true });
    expect(outcome.evidence['eagerResume']).toMatchObject({ ok: true, result: 'result/success' });
    expect(outcome.evidence['duplicateUuidResume']).toMatchObject({
      ok: false,
      result: undefined,
      lifecycle: ['completed'],
      dropped: true,
    });
    expect(outcome.evidence['duplicateUuidResumeSession']).toMatchObject({
      frames: ['control_response', 'command_lifecycle:completed'],
    });
    noSurvivors(sim);
  });

  it('fails fast on the gate run 2 shape: every message reuses one uuid, so the CLI drops each resumed one', async () => {
    const { sim, context } = world();
    sim.uuid = () => '00000000-0000-4000-8000-000000000001';
    const started = sim.now();
    const outcome = await item(6, (r) => pathIdentityItem(context, r));
    expect(outcome.failed).toEqual([
      'resume (canonical cwd): same session, turn completes',
      'resume (canonical cwd): the history is loaded',
      'resume (canonical cwd): the CLI sees the same working directory',
    ]);
    expect(outcome.checks.find((check) => check.name.startsWith('resume (canonical'))).toEqual({
      name: 'resume (canonical cwd): same session, turn completes',
      ok: false,
      detail: 'session undefined, no result, lifecycle [completed]',
    });
    // Each dropped message ends the wait at once; run 2 waited 90 s per resume.
    expect(sim.now() - started).toBeLessThan(60_000);
    noSurvivors(sim);
  });

  it('resumes after the initialize response; the gate run 1 eager write is recorded, not failed', async () => {
    const { sim, context } = world({ resumeEagerStall: true });
    const outcome = await item(6, (r) => pathIdentityItem(context, r));
    expect(outcome.failed).toEqual([]);
    expect(outcome.evidence['eagerResume']).toMatchObject({ ok: false, messages: 0 });
    expect(outcome.evidence['eagerResumeSession']).toMatchObject({
      frames: ['command_lifecycle:queued', 'control_response'],
    });
    noSurvivors(sim);
  });

  it('fails when resume loses the history or the CLI reports another cwd', async () => {
    const { context } = world({ resumeLosesHistory: true, reportCwd: (cwd) => `${cwd}/x` });
    const outcome = await item(6, (r) => pathIdentityItem(context, r));
    expect(outcome.failed).toEqual([
      'start: the turn completes and the CLI reports the canonical cwd',
      'resume (canonical cwd): the history is loaded',
      'resume (canonical cwd): the CLI sees the same working directory',
    ]);
  });

  it('fails without a session id; a case-sensitive volume needs no case check', async () => {
    const { sim, context } = world({ noInit: true });
    sim.caseInsensitive = false;
    sim.aliases.clear();
    const outcome = await item(6, (r) => pathIdentityItem(context, r));
    expect(outcome.failed).toEqual([
      '/tmp resolves to /private/tmp',
      'start: the turn completes and the CLI reports the canonical cwd',
      'start: a session id is reported',
    ]);
    expect(outcome.evidence['caseInsensitiveVolume']).toBe(false);
  });

  it('fails when validateCwd keeps the alias or the case variant differs', async () => {
    const { sim, context } = world({}, {});
    sim.cwdFs.realpath = (value) => Promise.resolve(value);
    const outcome = await item(6, (r) => pathIdentityItem(context, r));
    expect(outcome.failed).toEqual(
      expect.arrayContaining([
        'validateCwd maps the /tmp alias to its realpath',
        'validateCwd gives a case variant the canonical spelling (case-insensitive volume)',
      ]),
    );
  });

  it('picks the turn request, not a side request', () => {
    const request = (
      body: unknown,
    ): {
      seq: number;
      method: string;
      target: string;
      headers: Record<string, string>;
      body: unknown;
      bytes: number;
    } => ({
      seq: 1,
      method: 'POST',
      target: '/',
      headers: {},
      body,
      bytes: 1,
    });
    expect(
      turnMessages(
        [
          request({ messages: [{ content: 'turn A' }, { content: 'x' }] }),
          request({ messages: [{ content: 'title' }] }),
          request({ messages: [{ content: 'turn A' }] }),
          request({ other: true }),
          request(null),
        ],
        'turn A',
      ),
    ).toHaveLength(2);
    expect(turnMessages([], 'x')).toEqual([]);
  });
});

describe('item 7: CI runner', () => {
  it('passes on a native arm64 runner and records eligibility', async () => {
    const { sim } = world();
    const outcome = await item(7, (r) => runnerItem(sim, 'arm64', BINARY, true, r));
    expect(outcome.failed).toEqual([]);
    expect(outcome.evidence).toMatchObject({
      platform: 'darwin-arm64',
      maxTestedEligible: true,
      runner: { ImageOS: 'macos15', RUNNER_ARCH: 'ARM64' },
    });
  });

  it('passes on a native x64 runner (no proc_translated sysctl)', async () => {
    const { sim } = world({}, { arch: 'x64' });
    const outcome = await item(7, (r) => runnerItem(sim, 'x64', BINARY, false, r));
    expect(outcome.failed).toEqual([]);
    expect(outcome.checks.find((check) => check.name.includes('Rosetta'))?.detail).toBe(
      'proc_translated=n/a',
    );
  });

  it('fails off macOS, on the wrong or translated architecture, and without a binary', async () => {
    const { sim } = world(
      {},
      {
        platform: 'linux',
        run: (file) => (file === '/usr/sbin/sysctl' ? result('1\n') : undefined),
      },
    );
    const outcome = await item(7, (r) => runnerItem(sim, 'x64', undefined, true, r));
    expect(outcome.failed).toEqual([
      'the runner is macOS',
      'Node.js runs on the requested architecture',
      'the kernel reports the same architecture',
      'the harness is not translated by Rosetta',
      'the pinned binary is native for this runner',
    ]);
  });

  it('maps architectures and reads runner metadata', () => {
    expect(machArch('x64')).toBe('x86_64');
    expect(machArch('arm64')).toBe('arm64');
    expect(runnerMetadata({ ImageOS: 'macos15', OTHER: 'x', RUNNER_OS: undefined })).toEqual({
      ImageOS: 'macos15',
    });
  });
});
