import { describe, expect, it } from 'vitest';

import { decideWeekly } from '../lib/canary-weekly.mjs';
import {
  CLI_PACKAGE,
  MAX_DOCUMENT_BYTES,
  REGISTRY_DOCUMENT,
  compareReleases,
  decideNightly,
  decideRequested,
  parseRelease,
  parseTime,
  pinFacts,
  readRegistry,
  registryFacts,
  runScheduleCheck,
} from '../lib/nightly.mjs';
import type { CheckHost, ScheduleDecision, ScheduleFacts } from '../lib/nightly.mjs';

const now = new Date('2026-10-16T03:17:00Z');

function document(latest: string, time: Record<string, string> = {}): unknown {
  return {
    name: CLI_PACKAGE,
    'dist-tags': { latest, next: '9.9.9', stable: '2.1.200' },
    time: { created: '2025-02-24T00:00:00.000Z', modified: '2026-10-16T00:00:00.000Z', ...time },
  };
}

const PIN = {
  version: '2.1.296',
  platforms: {
    'linux-x64': { package: 'x', file: 'claude' },
    'darwin-arm64': { package: 'y', file: 'claude', pendingGate: true },
  },
};

function facts(latest: string | null, overrides: Partial<ScheduleFacts> = {}): ScheduleFacts {
  return {
    now,
    registry: latest === null ? null : registryFacts(document(latest)),
    registryError: latest === null ? 'HTTP 503' : undefined,
    pin: { version: '2.1.296', darwinPending: true },
    mode: 'canary',
    dispatched: false,
    ...overrides,
  };
}

describe('release versions', () => {
  it('parses X.Y.Z only', () => {
    expect(parseRelease('2.1.296')).toEqual([2, 1, 296]);
    expect(parseRelease('0.0.0')).toEqual([0, 0, 0]);
    for (const bad of ['2.1.296-next.1', '02.1.0', '2.1', 'latest', '2.1.0\nrun=true', 2, null]) {
      expect(parseRelease(bad)).toBeNull();
    }
  });

  it('compares numerically', () => {
    expect(compareReleases([2, 1, 296], [2, 1, 30])).toBeGreaterThan(0);
    expect(compareReleases([2, 1, 0], [2, 2, 0])).toBeLessThan(0);
    expect(compareReleases([3, 0, 0], [2, 9, 9])).toBeGreaterThan(0);
    expect(compareReleases([1, 2, 3], [1, 2, 3])).toBe(0);
  });
});

describe('parseTime', () => {
  it('parses ISO-8601', () => {
    expect(parseTime('2026-10-12T03:00:00.000Z')?.toISOString()).toBe('2026-10-12T03:00:00.000Z');
  });

  it.each([[''], ['  '], ['not a date'], [42], [null], [undefined]])('rejects %j', (input) => {
    expect(parseTime(input)).toBeNull();
  });
});

describe('registryFacts', () => {
  it('keeps the latest tag and the publish times of release versions', () => {
    const result = registryFacts(
      document('2.1.301', {
        '2.1.301': '2026-10-15T14:34:23.330Z',
        '2.1.302-rc.1': 'x',
        '2.1.1': 'bad',
      }),
    );
    expect(result.latest).toBe('2.1.301');
    expect([...result.published.keys()]).toEqual(['2.1.301']);
  });

  it.each([
    [null, 'is not @anthropic-ai/claude-code'],
    [{ name: 'other' }, 'is not @anthropic-ai/claude-code'],
    [{ name: CLI_PACKAGE }, 'latest dist-tag'],
    [{ name: CLI_PACKAGE, 'dist-tags': { latest: '2.1.0-rc.1' } }, 'latest dist-tag'],
    [{ name: CLI_PACKAGE, 'dist-tags': { latest: '2.1.0' } }, 'no time map'],
  ])('refuses %j', (value, message) => {
    expect(() => registryFacts(value)).toThrow(message);
  });
});

describe('readRegistry', () => {
  it('reads the CLI document without following redirects', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const result = await readRegistry((url, init) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify(document('2.1.301'))));
    });
    expect(result.latest).toBe('2.1.301');
    expect(calls[0]?.url).toBe(REGISTRY_DOCUMENT);
    expect(calls[0]?.init.redirect).toBe('error');
  });

  it('fails on an HTTP error, an oversized or non-JSON body', async () => {
    await expect(
      readRegistry(() => Promise.resolve(new Response('x', { status: 503 }))),
    ).rejects.toThrow('HTTP 503');
    await expect(
      readRegistry(() =>
        Promise.resolve(
          new Response('{}', { headers: { 'content-length': String(MAX_DOCUMENT_BYTES + 1) } }),
        ),
      ),
    ).rejects.toThrow('more than');
    await expect(
      readRegistry(() => Promise.resolve(new Response('x'.repeat(MAX_DOCUMENT_BYTES + 1)))),
    ).rejects.toThrow('more than');
    await expect(readRegistry(() => Promise.resolve(new Response('{')))).rejects.toThrow(
      'not valid JSON',
    );
    await expect(
      readRegistry(() => Promise.resolve(new Response(null, { status: 404 }))),
    ).rejects.toThrow('HTTP 404');
  });
});

describe('pinFacts', () => {
  it('reads the version and whether a darwin entry is pending', () => {
    expect(pinFacts(PIN)).toEqual({ version: '2.1.296', darwinPending: true });
    expect(
      pinFacts({ version: '2.1.296', platforms: { 'darwin-arm64': { sha256: 'x' } } }),
    ).toEqual({ version: '2.1.296', darwinPending: false });
    expect(pinFacts({ version: '2.1.296', platforms: {} }).darwinPending).toBe(true);
    expect(
      pinFacts({ version: '2.1.296', platforms: { 'darwin-arm64': 'odd', 'darwin-x64': {} } })
        .darwinPending,
    ).toBe(false);
  });

  it.each([[null], [{ version: 'x' }], [{ version: '2.1.296' }]])('refuses %j', (value) => {
    expect(() => pinFacts(value)).toThrow('tooling/cli-pin.json');
  });
});

describe('decideNightly', () => {
  it('runs the canary on the newest release when it is newer than the pin', () => {
    expect(decideNightly(facts('2.1.301'))).toEqual({
      run: true,
      mode: 'canary',
      version: '2.1.301',
      macos: false,
      lines: [
        `The newest ${CLI_PACKAGE} (2.1.301) is newer than the pinned 2.1.296: the nightly canary tests it on Linux.`,
      ],
    });
  });

  it('never re-runs the pinned version and skips an older newest', () => {
    expect(decideNightly(facts('2.1.296'))).toMatchObject({
      run: false,
      version: '',
      lines: [expect.stringContaining('never re-runs the pinned version')],
    });
    expect(decideNightly(facts('2.1.200'))).toMatchObject({
      run: false,
      lines: [expect.stringContaining('is older than the pinned 2.1.296')],
    });
  });

  it('fails when the registry state is unknown', () => {
    expect(decideNightly(facts(null))).toMatchObject({
      run: false,
      error: `${CLI_PACKAGE} registry state unknown: HTTP 503`,
    });
    expect(decideNightly(facts(null, { registryError: undefined })).error).toContain('not read');
  });

  it('runs a labelled dry run against the pinned version, without the registry', () => {
    expect(decideNightly(facts(null, { mode: 'dry-run' }))).toEqual({
      run: true,
      mode: 'dry-run',
      version: '2.1.296',
      macos: false,
      lines: [expect.stringContaining('DRY RUN (manual dispatch)')],
    });
  });
});

describe('decideRequested (a dispatch naming an exact release)', () => {
  const published = {
    '2.1.296': '2026-10-09T16:58:10.924Z',
    '2.1.299': '2026-10-14T00:23:19.588Z',
    '2.1.302': '2026-10-16T16:48:28.057Z',
  };
  function asked(requested: string, latest = '2.1.302'): ScheduleFacts & { requested: string } {
    return {
      ...facts(null),
      registry: registryFacts(document(latest, published)),
      registryError: undefined,
      dispatched: true,
      requested,
    };
  }

  it('tests exactly the requested release, older, equal or newer than the pin', () => {
    expect(decideRequested(asked('2.1.299'), 'on Linux', false)).toEqual({
      run: true,
      mode: 'canary',
      version: '2.1.299',
      macos: false,
      lines: [
        `Manual dispatch for ${CLI_PACKAGE} 2.1.299 (newer than the pinned 2.1.296; the newest is 2.1.302): the canary path tests exactly this version on Linux (an admission or window run of the rolling tested window, ADR-0004 §4).`,
      ],
    });
    expect(decideRequested(asked('2.1.296'), 'x', true)).toMatchObject({
      run: true,
      version: '2.1.296',
      macos: true,
      lines: [expect.stringContaining('(the pinned version;')],
    });
    const older = { ...asked('2.1.296'), pin: { version: '2.1.302', darwinPending: false } };
    expect(decideRequested(older, 'x', false).lines[0]).toContain('older than the pinned 2.1.302');
  });

  it('is what both schedules decide for a requested release', () => {
    expect(decideNightly(asked('2.1.299'))).toMatchObject({ run: true, version: '2.1.299' });
    expect(decideWeekly(asked('2.1.299'), true)).toMatchObject({
      run: true,
      version: '2.1.299',
      macos: false,
      lines: [expect.stringContaining('on Windows (an admission')],
    });
    const gated = { ...asked('2.1.299'), pin: { version: '2.1.296', darwinPending: false } };
    expect(decideWeekly(gated, true)).toMatchObject({
      macos: true,
      lines: [expect.stringContaining('on Windows and macOS')],
    });
    expect(decideWeekly(gated, false)).toMatchObject({ macos: false });
    // A dry run stays a dry run of the pinned version.
    expect(decideNightly({ ...asked('2.1.299'), mode: 'dry-run' }).mode).toBe('dry-run');
  });

  it('refuses an unpublished release, one above latest and an unknown registry', () => {
    expect(decideRequested(asked('2.1.297'), 'x', false)).toMatchObject({
      run: false,
      version: '',
      error: `"2.1.297" is not a published release of ${CLI_PACKAGE}`,
    });
    expect(decideRequested(asked('2.1.302', '2.1.299'), 'x', false).error).toBe(
      '2.1.302 is newer than the latest dist-tag (2.1.299): not what users get',
    );
    expect(decideRequested(asked('2.1.299-rc.1'), 'x', false).error).toContain(
      'is not a published release',
    );
    expect(decideRequested({ ...facts(null), requested: '2.1.299' }, 'x', false).error).toBe(
      `${CLI_PACKAGE} registry state unknown: HTTP 503`,
    );
    expect(
      decideRequested(
        { ...facts(null), registryError: undefined, requested: '2.1.299' },
        'x',
        false,
      ).error,
    ).toBe(`${CLI_PACKAGE} registry state unknown: not read`);
  });
});

describe('runScheduleCheck', () => {
  function host(
    env: Record<string, string>,
    options: { pin?: unknown; body?: unknown; status?: number } = {},
  ): CheckHost & { files: Map<string, string>; out: string; err: string; fetched: number } {
    const state = { files: new Map<string, string>(), out: '', err: '', fetched: 0 };
    return Object.assign(state, {
      env,
      fetch: () => {
        state.fetched += 1;
        return Promise.resolve(
          new Response(JSON.stringify(options.body ?? document('2.1.301')), {
            status: options.status ?? 200,
          }),
        );
      },
      readFile: (file: string) => {
        if (file !== 'tooling/cli-pin.json') throw new Error(`unexpected ${file}`);
        return JSON.stringify(options.pin ?? PIN);
      },
      appendFile: (file: string, text: string) => {
        state.files.set(file, (state.files.get(file) ?? '') + text);
      },
      now: () => now,
      stdout: (text: string) => {
        state.out += text;
      },
      stderr: (text: string) => {
        state.err += text;
      },
    });
  }

  const ACTIONS = { GITHUB_OUTPUT: 'out', GITHUB_STEP_SUMMARY: 'summary' };

  it('writes the outputs and the summary of a scheduled run', async () => {
    const h = host(ACTIONS);
    expect(await runScheduleCheck(h, 'nightly', decideNightly)).toBe(0);
    expect(h.files.get('out')).toBe('run=true\nmode=canary\nversion=2.1.301\nmacos=false\n');
    expect(h.files.get('summary')).toContain('## nightly canary: should-run\n\nThe newest');
    expect(h.out).toContain('run=true mode=canary version=2.1.301 macos=false');
  });

  it('takes the mode from CANARY_MODE and refuses an unknown one', async () => {
    const dry = host({ ...ACTIONS, CANARY_MODE: 'dry-run' });
    expect(await runScheduleCheck(dry, 'weekly', decideWeekly)).toBe(0);
    expect(dry.fetched).toBe(0);
    expect(dry.files.get('out')).toBe('run=true\nmode=dry-run\nversion=2.1.296\nmacos=false\n');
    const seen: boolean[] = [];
    const spy = (input: ScheduleFacts): ScheduleDecision => {
      seen.push(input.dispatched);
      return decideNightly(input);
    };
    const explicit = host({ CANARY_MODE: 'canary' });
    expect(await runScheduleCheck(explicit, 'nightly', spy)).toBe(0);
    expect(explicit.files.size).toBe(0);
    expect(await runScheduleCheck(host({ CANARY_MODE: '' }), 'nightly', spy)).toBe(0);
    expect(seen).toEqual([true, false]);
    const bad = host({ CANARY_MODE: 'newest' });
    expect(await runScheduleCheck(bad, 'nightly', decideNightly)).toBe(2);
    expect(bad.err).toContain('CANARY_MODE must be canary or dry-run, got "newest"');
  });

  it('fails visibly on an unreadable registry, with run=false in the outputs', async () => {
    const h = host({ ...ACTIONS, GITHUB_OUTPUT: 'out' }, { status: 503 });
    expect(await runScheduleCheck(h, 'nightly', decideNightly)).toBe(1);
    expect(h.files.get('out')).toBe('run=false\nmode=canary\nversion=\nmacos=false\n');
    expect(h.files.get('summary')).toContain(
      'ERROR: @anthropic-ai/claude-code registry state unknown',
    );
    expect(h.err).toContain('nightly-check: @anthropic-ai/claude-code registry state unknown');
    const thrown = host({}, {});
    thrown.fetch = () => Promise.reject(new TypeError('offline'));
    expect(await runScheduleCheck(thrown, 'nightly', decideNightly)).toBe(1);
    expect(thrown.err).toContain('registry state unknown: TypeError: offline');
  });

  it('fails on an unreadable pin', async () => {
    const h = host({}, { pin: { version: 'x' } });
    expect(await runScheduleCheck(h, 'nightly', decideNightly)).toBe(1);
    expect(h.err).toContain('nightly-check: Error: tooling/cli-pin.json');
    expect(h.fetched).toBe(0);
  });

  it('passes a requested release to the decision and refuses a bad request', async () => {
    const body = document('2.1.301', {
      '2.1.299': '2026-10-14T00:23:19.588Z',
      '2.1.301': '2026-10-15T14:34:23.330Z',
    });
    const asked = host(
      { ...ACTIONS, CANARY_MODE: 'canary', CANARY_VERSION_REQUEST: '2.1.299' },
      { body },
    );
    expect(await runScheduleCheck(asked, 'weekly', decideWeekly)).toBe(0);
    expect(asked.files.get('out')).toBe('run=true\nmode=canary\nversion=2.1.299\nmacos=false\n');
    expect(asked.files.get('summary')).toContain(
      'Manual dispatch for @anthropic-ai/claude-code 2.1.299',
    );
    for (const [env, message] of [
      [{ CANARY_MODE: 'dry-run', CANARY_VERSION_REQUEST: '2.1.299' }, 'with CANARY_MODE="dry-run"'],
      [{ CANARY_VERSION_REQUEST: '2.1.299' }, 'with CANARY_MODE=""'],
      [{ CANARY_MODE: 'canary', CANARY_VERSION_REQUEST: '2.1.299\nrun=true' }, 'must be a release'],
      [{ CANARY_MODE: 'canary', CANARY_VERSION_REQUEST: 'latest' }, 'must be a release'],
    ] as const) {
      const bad = host({ ...ACTIONS, ...env }, { body });
      expect(await runScheduleCheck(bad, 'nightly', decideNightly)).toBe(2);
      expect(bad.err).toContain(message);
      expect(bad.files.size).toBe(0);
      expect(bad.fetched).toBe(0);
    }
    const unpublished = host(
      { ...ACTIONS, CANARY_MODE: 'canary', CANARY_VERSION_REQUEST: '2.1.297' },
      { body },
    );
    expect(await runScheduleCheck(unpublished, 'nightly', decideNightly)).toBe(1);
    expect(unpublished.files.get('out')).toBe('run=false\nmode=canary\nversion=\nmacos=false\n');
    expect(unpublished.err).toContain('"2.1.297" is not a published release');
  });

  it('runs nothing when the newest is the pinned version', async () => {
    const h = host({ GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' }, { body: document('2.1.296') });
    expect(await runScheduleCheck(h, 'nightly', decideNightly)).toBe(0);
    expect(h.out).toContain('run=false mode=canary version= macos=false');
  });
});
