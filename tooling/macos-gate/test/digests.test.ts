import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sdkCrossCheck, type AvailableCrossCheck } from '../../test-support/src/cli/crosscheck.js';
import { CliFetchError } from '../../test-support/src/cli/errors.js';
import { parsePin, type CliPin } from '../../test-support/src/cli/pin.js';
import {
  fakeRegistry,
  json,
  manifestFor,
  release,
  serve,
  serveSdk,
  type FakeRegistry,
  type Release,
} from '../../test-support/test/cli/fake-registry.js';
import {
  DEFAULT_SDK_CLI_VERSION,
  DEFAULT_SDK_VERSION,
  digestRecord,
  fetchGateBinary,
  type GateDigest,
} from '../src/digests.js';

const VERSION = '2.1.296';
const SDK_VERSION = '0.3.296';
const PIN_PATH = fileURLToPath(new URL('../../cli-pin.json', import.meta.url));
const NOW = new Date('2026-10-12T17:00:00.000Z');
const HOST = process.platform;

let root = '';
let registry: FakeRegistry;
let arm: Release;
let x64: Release;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hudhud-gate-digests-'));
  registry = fakeRegistry();
  arm = release('darwin-arm64', VERSION);
  x64 = release('darwin-x64', VERSION);
  serve(registry, arm);
  serve(registry, x64);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10 });
});

function pendingPin(): CliPin {
  return parsePin(
    {
      version: VERSION,
      platforms: {
        'darwin-arm64': { package: arm.pkg, file: 'claude', pendingGate: true },
        'darwin-x64': { package: x64.pkg, file: 'claude', pendingGate: true },
      },
    },
    'pin',
  );
}

function pinnedPin(overrides: Record<string, unknown> = {}): CliPin {
  return parsePin(
    {
      version: VERSION,
      platforms: {
        'darwin-arm64': {
          package: arm.pkg,
          file: 'claude',
          integrity: arm.integrity,
          sha256: arm.sha256,
          size: arm.size,
          ...overrides,
        },
      },
    },
    'pin',
  );
}

function fetchArm(pin: CliPin, sdkVersion = SDK_VERSION): ReturnType<typeof fetchGateBinary> {
  return fetchGateBinary({
    pin,
    platform: 'darwin-arm64',
    sdkVersion,
    cacheRoot: root,
    hostPlatform: HOST,
    registry: registry.options,
    now: () => NOW,
  });
}

async function error(promise: Promise<unknown>): Promise<CliFetchError> {
  const caught: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(caught).toBeInstanceOf(CliFetchError);
  return caught as CliFetchError;
}

describe('fetchGateBinary', () => {
  it('records the digests of a pendingGate platform after npm integrity and manifest agree', async () => {
    serveSdk(registry, SDK_VERSION, VERSION, manifestFor(VERSION, arm, x64));
    const { digest, binaryPath } = await fetchArm(pendingPin());
    expect(digest).toEqual({
      platform: 'darwin-arm64',
      package: arm.pkg,
      version: VERSION,
      file: 'claude',
      integrity: arm.integrity,
      sha256: arm.sha256,
      size: arm.size,
      manifest: {
        source: `@anthropic-ai/claude-agent-sdk@${SDK_VERSION}`,
        sdkIntegrity: digest.manifest.sdkIntegrity,
        sha256: arm.sha256,
        size: arm.size,
      },
      pinStatus: 'recorded',
      recordedAt: NOW.toISOString(),
    });
    expect(digest.manifest.sdkIntegrity).toMatch(/^sha512-/);
    expect(binaryPath).toBe(path.join(root, VERSION, 'darwin-arm64', 'claude'));
    // The SDK staging directory is gone; only the version directory remains.
    expect(await readdir(root)).toEqual([VERSION]);
  });

  it('verifies a pinned platform against the pin as well', async () => {
    serveSdk(registry, SDK_VERSION, VERSION, manifestFor(VERSION, arm));
    const { digest } = await fetchArm(pinnedPin());
    expect(digest.pinStatus).toBe('verified-against-pin');
  });

  it('refuses a registry integrity that differs from the pin', async () => {
    serveSdk(registry, SDK_VERSION, VERSION, manifestFor(VERSION, arm));
    const caught = await error(fetchArm(pinnedPin({ integrity: x64.integrity })));
    expect(caught.code).toBe('integrity-mismatch');
  });

  it('refuses a manifest that disagrees with the pin', async () => {
    serveSdk(registry, SDK_VERSION, VERSION, manifestFor(VERSION, arm));
    expect((await error(fetchArm(pinnedPin({ sha256: x64.sha256 })))).code).toBe(
      'cross-check-failed',
    );
    expect((await error(fetchArm(pinnedPin({ size: arm.size + 1 })))).code).toBe(
      'cross-check-failed',
    );
  });

  it('refuses a binary that differs from the manifest (fail closed)', async () => {
    const tampered = {
      version: VERSION,
      platforms: { 'darwin-arm64': { binary: 'claude', checksum: x64.sha256, size: arm.size } },
    };
    serveSdk(registry, SDK_VERSION, VERSION, tampered);
    expect((await error(fetchArm(pendingPin()))).code).toBe('binary-mismatch');
  });

  it('refuses a tarball that differs from the npm integrity', async () => {
    serveSdk(registry, SDK_VERSION, VERSION, manifestFor(VERSION, arm));
    serve(registry, arm, x64.tgz);
    expect((await error(fetchArm(pendingPin()))).code).toBe('integrity-mismatch');
  });

  it('refuses a platform without a pin entry', async () => {
    const caught = await error(
      fetchGateBinary({
        pin: pinnedPin(),
        platform: 'darwin-x64',
        sdkVersion: SDK_VERSION,
        cacheRoot: root,
        hostPlatform: HOST,
        registry: registry.options,
        now: () => NOW,
      }),
    );
    expect(caught.code).toBe('platform-unavailable');
  });
});

describe('sdkCrossCheck with the explicit SDK version of the gate', () => {
  const lookup = (sdkVersion = SDK_VERSION): Promise<AvailableCrossCheck> =>
    sdkCrossCheck(
      { registry: registry.options, stagingRoot: root },
      VERSION,
      'darwin-arm64',
      'claude',
      sdkVersion,
    );

  it('defaults to the SDK release that bundles the pinned CLI (research 05 §1)', () => {
    // npm view @anthropic-ai/claude-agent-sdk@0.3.310 claudeCodeVersion: 2.1.310
    expect(DEFAULT_SDK_VERSION).toBe('0.3.310');
    expect(DEFAULT_SDK_CLI_VERSION).toBe('2.1.310');
    const pin = JSON.parse(readFileSync(PIN_PATH, 'utf8')) as { version: string };
    expect(DEFAULT_SDK_CLI_VERSION).toBe(pin.version);
  });

  it('refuses an invalid SDK version before any request', async () => {
    expect((await error(lookup('../0.3.296'))).code).toBe('cross-check-failed');
    expect(registry.calls).toEqual([]);
  });

  it('fails closed when the manifest is for another CLI version or lacks the platform', async () => {
    serveSdk(registry, SDK_VERSION, VERSION, manifestFor('2.1.297', arm));
    expect((await error(lookup())).code).toBe('cross-check-failed');
    serveSdk(registry, SDK_VERSION, VERSION, manifestFor(VERSION, x64));
    expect((await error(lookup())).code).toBe('cross-check-failed');
  });

  it('fails closed on a manifest that is not JSON, or missing', async () => {
    serveSdk(registry, SDK_VERSION, VERSION, '{not json');
    expect((await error(lookup())).code).toBe('cross-check-failed');
    serveSdk(registry, SDK_VERSION, VERSION, undefined);
    expect((await error(lookup())).code).toBe('archive-refused');
  });

  it('refuses an SDK tarball that differs from its registry integrity', async () => {
    serveSdk(registry, SDK_VERSION, VERSION, manifestFor(VERSION, arm), (tgz) => {
      const copy = tgz.slice();
      copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 0xff;
      return copy;
    });
    expect((await error(lookup())).code).toBe('integrity-mismatch');
    expect(await readdir(root)).toEqual([]);
  });

  it('refuses a registry document of another package', async () => {
    registry.routes.set(
      `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/${SDK_VERSION}`,
      json({ name: 'other', version: SDK_VERSION }),
    );
    expect((await error(lookup())).code).toBe('registry');
  });
});

describe('digestRecord', () => {
  const digest = (overrides: Partial<GateDigest> = {}): GateDigest => ({
    platform: 'darwin-arm64',
    package: '@anthropic-ai/claude-code-darwin-arm64',
    version: VERSION,
    file: 'claude',
    integrity: arm.integrity,
    sha256: arm.sha256,
    size: arm.size,
    manifest: { source: 'sdk', sdkIntegrity: 'sha512-x', sha256: arm.sha256, size: arm.size },
    pinStatus: 'recorded',
    recordedAt: NOW.toISOString(),
    ...overrides,
  });

  it('writes pin-shaped entries that the pin parser accepts, plus their provenance', () => {
    const record = digestRecord(VERSION, [digest()]);
    expect(record.platforms).toEqual({
      'darwin-arm64': {
        package: '@anthropic-ai/claude-code-darwin-arm64',
        file: 'claude',
        integrity: arm.integrity,
        sha256: arm.sha256,
        size: arm.size,
      },
    });
    expect(record.provenance['darwin-arm64']).toMatchObject({
      npmIntegrity: arm.integrity,
      pinStatus: 'recorded',
    });
    const pin = parsePin({ version: record.version, platforms: record.platforms }, 'record');
    expect(pin.platforms.get('darwin-arm64')).toEqual(record.platforms['darwin-arm64']);
  });

  it('accepts an empty run (no platform verified)', () => {
    expect(digestRecord(VERSION, []).platforms).toEqual({});
  });

  it('refuses digests of another version and entries the pin would refuse', () => {
    expect(() => digestRecord(VERSION, [digest({ version: '2.1.297' })])).toThrow(/2\.1\.297/);
    expect(() => digestRecord(VERSION, [digest({ sha256: 'ABC' })])).toThrow(CliFetchError);
    expect(() => digestRecord(VERSION, [digest({ package: 'evil' })])).toThrow(CliFetchError);
  });
});
