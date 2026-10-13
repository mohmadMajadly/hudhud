// The tested window and its agreement with the pin and the digest table
// (plan §1.8, ADR-0004 §4, K8, K16).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CLAUDE_CODE_COMPAT,
  claudeCompatInfo,
  compareParsed,
  compatStatus,
  parseVersion,
  type CompatWindow,
} from '../../src/compat.js';
import { KNOWN_BINARIES } from '../../src/known-binaries.js';
import { parseClaudeVersion } from '../../src/provenance.js';

const pin = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../tooling/cli-pin.json', import.meta.url)), 'utf8'),
) as { readonly version: string };

function cmp(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === undefined || pb === undefined) throw new Error('unparseable fixture');
  return compareParsed(pa, pb);
}

describe('CLAUDE_CODE_COMPAT agrees with the pin and the digest table', () => {
  it('has the pinned version inside the window, as its upper bound', () => {
    expect(CLAUDE_CODE_COMPAT.maxTested).toBe(pin.version);
    expect(cmp(CLAUDE_CODE_COMPAT.minTested, CLAUDE_CODE_COMPAT.maxTested)).toBeLessThanOrEqual(0);
    expect(compatStatus(pin.version)).toBe('tested');
  });

  it('has every digest-table version inside the window and none known broken', () => {
    for (const version of Object.keys(KNOWN_BINARIES)) {
      expect(compatStatus(version)).toBe('tested');
    }
    expect(Object.keys(KNOWN_BINARIES)).toContain(CLAUDE_CODE_COMPAT.minTested);
    expect(Object.keys(KNOWN_BINARIES)).toContain(CLAUDE_CODE_COMPAT.maxTested);
    for (const broken of CLAUDE_CODE_COMPAT.knownBroken) {
      expect(parseVersion(broken)).toBeDefined();
    }
  });

  it('is frozen and every bound parses', () => {
    expect(Object.isFrozen(CLAUDE_CODE_COMPAT)).toBe(true);
    expect(Object.isFrozen(CLAUDE_CODE_COMPAT.knownBroken)).toBe(true);
    expect(parseVersion(CLAUDE_CODE_COMPAT.minTested)).toBeDefined();
    expect(parseVersion(CLAUDE_CODE_COMPAT.maxTested)).toBeDefined();
  });
});

describe('parseVersion', () => {
  it('parses release and pre-release versions', () => {
    expect(parseVersion('2.1.296')).toEqual({ major: 2, minor: 1, patch: 296, prerelease: [] });
    expect(parseVersion('2.2.0-beta.1')).toEqual({
      major: 2,
      minor: 2,
      patch: 0,
      prerelease: ['beta', '1'],
    });
  });

  it.each([
    '',
    '2.1',
    'v2.1.296',
    '2.1.296+build',
    '2.1.296 (Claude Code)',
    '2.1.x',
    '1.2.3-',
    '1.2.3-a..b',
    '1.2.3-01',
    '1234567890.0.0',
    ' 2.1.296',
    '2.1.296\n',
  ])('rejects %j', (text) => {
    expect(parseVersion(text)).toBeUndefined();
  });

  it('accepts what the version probe accepts (property)', () => {
    const version = fc
      .tuple(
        fc.nat(999),
        fc.nat(999),
        fc.nat(9999),
        fc.option(fc.stringMatching(/^[a-z][0-9A-Za-z]{0,8}(\.[1-9][0-9]{0,3})?$/), {
          nil: undefined,
        }),
      )
      .map(
        ([x, y, z, pre]) =>
          `${String(x)}.${String(y)}.${String(z)}${pre === undefined ? '' : `-${pre}`}`,
      );
    fc.assert(
      fc.property(version, (text) => {
        expect(parseVersion(text)).toBeDefined();
        expect(parseClaudeVersion(`${text} (Claude Code)`)).toBe(text);
      }),
    );
  });
});

describe('compareParsed (semver precedence)', () => {
  it('orders the semver.org example chain', () => {
    const chain = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.1.0',
      '2.0.0',
    ];
    for (let i = 0; i < chain.length; i += 1) {
      for (let j = 0; j < chain.length; j += 1) {
        expect(cmp(chain[i] ?? '', chain[j] ?? '')).toBe(Math.sign(i - j));
      }
    }
  });

  it('is a total order over numeric triples (property)', () => {
    const triple = fc.tuple(fc.nat(50), fc.nat(50), fc.nat(500));
    fc.assert(
      fc.property(triple, triple, (a, b) => {
        const order = cmp(a.join('.'), b.join('.'));
        expect(order).toBe(-cmp(b.join('.'), a.join('.')));
        const expected = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
        expect(order).toBe(Math.sign(expected));
      }),
    );
  });
});

describe('compatStatus', () => {
  const window: CompatWindow = {
    minTested: '2.1.290',
    maxTested: '2.1.300',
    knownBroken: ['2.1.295', '2.1.400'],
  };

  it('is tested inside the window, bounds included', () => {
    expect(compatStatus('2.1.290', window)).toBe('tested');
    expect(compatStatus('2.1.296', window)).toBe('tested');
    expect(compatStatus('2.1.300', window)).toBe('tested');
  });

  it('is untested outside the window, for pre-releases below it and for unparseable input', () => {
    expect(compatStatus('2.1.289', window)).toBe('untested');
    expect(compatStatus('2.1.301', window)).toBe('untested');
    expect(compatStatus('3.0.0', window)).toBe('untested');
    expect(compatStatus('2.1.290-rc.1', window)).toBe('untested');
    expect(compatStatus('unknown', window)).toBe('untested');
    expect(compatStatus('', window)).toBe('untested');
  });

  it('is known-broken for a listed version, inside or outside the window', () => {
    expect(compatStatus('2.1.295', window)).toBe('known-broken');
    expect(compatStatus('2.1.400', window)).toBe('known-broken');
  });

  it('never says tested when a bound is unparseable', () => {
    expect(compatStatus('2.1.296', { ...window, minTested: 'x' })).toBe('untested');
    expect(compatStatus('2.1.296', { ...window, maxTested: 'x' })).toBe('untested');
  });

  it('never throws and is tested only for a version inside the window (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (text) => {
        const status = compatStatus(text);
        if (status === 'tested') expect(parseVersion(text)).toBeDefined();
      }),
    );
  });
});

describe('claudeCompatInfo', () => {
  it('builds the CompatInfo of harness.compat', () => {
    expect(claudeCompatInfo(pin.version)).toEqual({
      harness: 'claude-code',
      version: pin.version,
      minTested: CLAUDE_CODE_COMPAT.minTested,
      maxTested: CLAUDE_CODE_COMPAT.maxTested,
      knownBroken: [],
      status: 'tested',
    });
  });

  it('reports an untested version without refusing, and copies the broken list', () => {
    const window: CompatWindow = { minTested: '1.0.0', maxTested: '1.0.0', knownBroken: ['1.0.1'] };
    const info = claudeCompatInfo('9.9.9', window);
    expect(info.status).toBe('untested');
    expect(info.knownBroken).toEqual(['1.0.1']);
    expect(info.knownBroken).not.toBe(window.knownBroken);
    expect(claudeCompatInfo('1.0.1', window).status).toBe('known-broken');
  });
});
