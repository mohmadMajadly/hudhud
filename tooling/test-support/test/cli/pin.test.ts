import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CliFetchError } from '../../src/cli/errors.js';
import {
  MAX_BINARY_BYTES,
  binaryFileName,
  hostPlatform,
  libcFromReport,
  isValidVersion,
  loadPin,
  parsePin,
  platformPackage,
  requirePinned,
} from '../../src/cli/pin.js';

const PIN_FILE = path.resolve(import.meta.dirname, '../../../cli-pin.json');

const LINUX = {
  package: '@anthropic-ai/claude-code-linux-x64',
  file: 'claude',
  integrity: `sha512-${'A'.repeat(86)}==`,
  sha256: 'a'.repeat(64),
  size: 10,
};

function pinWith(
  overrides: Record<string, unknown>,
  entry: Record<string, unknown> = LINUX,
): unknown {
  return { version: '1.2.3', platforms: { 'linux-x64': entry }, ...overrides };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CliFetchError);
    return (error as CliFetchError).code;
  }
  throw new Error('expected a CliFetchError');
}

describe('the committed pin (tooling/cli-pin.json)', () => {
  it('pins 2.1.296 with the 05 §1 digests for linux-x64 and win32-x64', async () => {
    const pin = await loadPin(PIN_FILE);
    expect(pin.version).toBe('2.1.296');
    expect(requirePinned(pin, 'linux-x64')).toEqual({
      package: '@anthropic-ai/claude-code-linux-x64',
      file: 'claude',
      integrity:
        'sha512-+m01urgelnI+VJxPaKPEK0wixgq42uZ8PeCaUk5tX/8YoDBvSmC/REVQG2jQfJAr8dxunpjJ600FvLrcj1WWTw==',
      sha256: '24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de',
      size: 257068216,
    });
    expect(requirePinned(pin, 'win32-x64')).toEqual({
      package: '@anthropic-ai/claude-code-win32-x64',
      file: 'claude.exe',
      integrity:
        'sha512-g2aYBzYM5YTDio0ulAoGIGgtGRMa08WAecer4wuOUrKPwVPRfyRdmoZI01BNS8jF9yupDmQycBMuBcVui/VGNw==',
      sha256: '76de74f7694a5bdc03378a5f837c9e132827bf004c98c276bc4e9094ff06769a',
      size: 260489376,
    });
  });

  it('pins the darwin platforms recorded by the macOS gate (research 10 §5, research 11)', async () => {
    const pin = await loadPin(PIN_FILE);
    expect(requirePinned(pin, 'darwin-arm64')).toMatchObject({
      package: '@anthropic-ai/claude-code-darwin-arm64',
      file: 'claude',
      integrity:
        'sha512-vqtx3kS3r1hNLMk+N8JMG5J4kcLHIbI3t/NSIdcFQZrRVCFA6NtcxJyn/B+Sf3GxJaFJOCEfoBQXsFo10+Oj9A==',
      sha256: 'c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937',
      size: 240664432,
    });
    expect(requirePinned(pin, 'darwin-x64')).toMatchObject({
      package: '@anthropic-ai/claude-code-darwin-x64',
      file: 'claude',
      integrity:
        'sha512-yCJe1vp7juHg3xVyk0Ts8b+mcEylCo6aINg7yC7r1eI8BKfm1DT15htxl1riz3y+B1FV25emIK90d7rH+zFjLA==',
      sha256: 'a6bf4f30be241053a923f3820ad23c5991d2f5ac2935b3a8dd64da218d9cc603',
      size: 249194752,
    });
  });
});

describe('parsePin', () => {
  it('accepts a complete and a pending entry', () => {
    const pin = parsePin(
      pinWith({
        $comment: 'x',
        platforms: {
          'linux-x64': LINUX,
          'linux-arm64-musl': {
            package: '@anthropic-ai/claude-code-linux-arm64-musl',
            file: 'claude',
            pendingGate: true,
          },
        },
      }),
      'pin',
    );
    expect(requirePinned(pin, 'linux-x64')).toEqual(LINUX);
    expect(code(() => requirePinned(pin, 'win32-x64'))).toBe('platform-unavailable');
  });

  it.each([
    ['not an object', []],
    ['null', null],
    ['unknown top-level key', pinWith({ extra: 1 })],
    ['version not a string', pinWith({ version: 1 })],
    ['version with a path separator', pinWith({ version: '1.2.3/..' })],
    ['version dot-dot', pinWith({ version: '..' })],
    ['platforms not an object', pinWith({ platforms: [] })],
    ['unsupported platform', pinWith({ platforms: { 'freebsd-x64': LINUX } })],
    ['platform with a path segment', pinWith({ platforms: { '../x': LINUX } })],
    ['entry not an object', pinWith({}, 'x' as unknown as Record<string, unknown>)],
    ['wrong package', pinWith({}, { ...LINUX, package: '@evil/claude-code-linux-x64' })],
    ['wrong file', pinWith({}, { ...LINUX, file: '../claude' })],
    [
      'pendingGate false',
      pinWith({}, { package: LINUX.package, file: 'claude', pendingGate: false }),
    ],
    ['pending with digests', pinWith({}, { ...LINUX, pendingGate: true })],
    ['unknown entry key', pinWith({}, { ...LINUX, url: 'https://evil' })],
    ['integrity not sha512', pinWith({}, { ...LINUX, integrity: 'sha1-abc' })],
    ['integrity missing', pinWith({}, { ...LINUX, integrity: undefined })],
    ['sha256 upper case', pinWith({}, { ...LINUX, sha256: 'A'.repeat(64) })],
    ['size zero', pinWith({}, { ...LINUX, size: 0 })],
    ['size fractional', pinWith({}, { ...LINUX, size: 1.5 })],
    ['size too large', pinWith({}, { ...LINUX, size: MAX_BINARY_BYTES + 1 })],
    ['size a string', pinWith({}, { ...LINUX, size: '10' })],
  ])('refuses %s', (_name, value) => {
    expect(code(() => parsePin(value, 'pin'))).toBe('pin-invalid');
  });
});

describe('helpers', () => {
  it('validates versions as single safe path segments', () => {
    for (const ok of ['0.0.0', '2.1.296', '1.0.0-beta.1', '1.0.0-rc-1'])
      expect(isValidVersion(ok)).toBe(true);
    for (const bad of [
      '',
      '1.2',
      '01.2.3',
      '1.2.3-',
      '1.2.3-a..b',
      '1.2.3+build',
      'v1.2.3',
      '1.2.3/x',
      '1.2.3\\x',
    ]) {
      expect(isValidVersion(bad)).toBe(false);
    }
  });

  it('derives package, file and host platform', () => {
    expect(platformPackage('win32-x64')).toBe('@anthropic-ai/claude-code-win32-x64');
    expect(binaryFileName('win32-arm64')).toBe('claude.exe');
    expect(binaryFileName('linux-x64')).toBe('claude');
    expect(hostPlatform('linux', 'x64', 'glibc')).toBe('linux-x64');
    expect(hostPlatform('linux', 'arm64', 'musl')).toBe('linux-arm64-musl');
    expect(hostPlatform('win32', 'arm64', 'musl')).toBe('win32-arm64');
    expect(code(() => hostPlatform('aix', 'ppc64', 'glibc'))).toBe('platform-unavailable');
  });

  it('detects musl from a diagnostic report without glibcVersionRuntime', () => {
    expect(libcFromReport({ header: { glibcVersionRuntime: '2.36' } })).toBe('glibc');
    expect(libcFromReport({ header: { glibcVersionRuntime: '' } })).toBe('musl');
    expect(libcFromReport({ header: {} })).toBe('musl');
    expect(libcFromReport({ header: null })).toBe('musl');
    expect(libcFromReport({})).toBe('musl');
    expect(libcFromReport(null)).toBe('musl');
    // The real report of this host: glibc on the Linux CI image, no glibc elsewhere.
    expect(libcFromReport(process.report.getReport())).toBe(
      process.platform === 'linux' ? 'glibc' : 'musl',
    );
  });
});

describe('loadPin', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hudhud-pin-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  it('refuses invalid JSON and oversized files', async () => {
    const broken = path.join(dir, 'broken.json');
    await writeFile(broken, '{');
    await expect(loadPin(broken)).rejects.toMatchObject({ code: 'pin-invalid' });
    const big = path.join(dir, 'big.json');
    await writeFile(big, `{"$comment":"${'x'.repeat(70_000)}"}`);
    await expect(loadPin(big)).rejects.toMatchObject({ code: 'pin-invalid' });
  });
});
