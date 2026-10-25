// The pinned Windows SDK of the job addon's release build and the explicit
// choice of the Visual Studio instance (scripts/lib/addon-pin.mjs; ADR-0014
// amendment 14): reading the committed pin, unpacking the sha256-checked
// payloads, and choosing an instance by path or by the toolset it holds,
// never the latest. All through fakes on every OS: nothing is downloaded or
// unpacked.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkSdkMarker,
  kitsRoot,
  parsePin,
  parsePinArgs,
  PIN_FILE,
  PIN_USAGE,
  pinDigest,
  PinUsageError,
  renderSdkMarker,
  runPin,
  SDK_MARKER,
  sdkRequiredFiles,
  selectInstance,
  type Pin,
  type PinIo,
} from '../lib/addon-pin.mjs';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const PIN_TEXT = readFileSync(path.join(REPO, PIN_FILE), 'utf8');
const URL_BASE = 'https://download.visualstudio.microsoft.com/download/pr/x/';

function committed(): Pin {
  const pin = parsePin(PIN_TEXT);
  if (typeof pin === 'string') throw new Error(pin);
  return pin;
}

/** A small pin: one MSI and one cabinet. */
function tinyPin(): Pin {
  return {
    windowsSdk: {
      ...committed().windowsSdk,
      msis: ['a.msi'],
      payloads: [
        { name: 'a.msi', size: 3, sha256: 'a'.repeat(64), url: `${URL_BASE}a.msi` },
        { name: 'b.cab', size: 4, sha256: 'b'.repeat(64), url: `${URL_BASE}b.cab` },
      ],
    },
  };
}

function mutate(change: (sdk: Record<string, unknown>) => void): string {
  const value = JSON.parse(PIN_TEXT) as { windowsSdk: Record<string, unknown> };
  change(value.windowsSdk);
  return JSON.stringify(value);
}

function payloads(sdk: Record<string, unknown>): Record<string, unknown>[] {
  return sdk['payloads'] as Record<string, unknown>[];
}

function payloadAt(sdk: Record<string, unknown>, index: number): Record<string, unknown> {
  const payload = payloads(sdk)[index];
  if (payload === undefined) throw new Error(`no payload ${String(index)}`);
  return payload;
}

describe('the committed pin', () => {
  it('pins Windows SDK 10.1.26100.7705: 9 MSIs and their cabinets, 316 MB', () => {
    const pin = committed();
    expect(pin.windowsSdk).toMatchObject({
      version: '10.0.26100.0',
      build: '10.1.26100.7705',
      package: 'Win11SDK_10.0.26100,version=10.0.26100.15',
    });
    expect(pin.windowsSdk.msis).toHaveLength(9);
    expect(pin.windowsSdk.payloads).toHaveLength(47);
    expect(pin.windowsSdk.payloads.reduce((sum, p) => sum + p.size, 0)).toBe(316_492_188);
  });
});

describe('parsePin', () => {
  it('refuses a malformed pin with a reason', () => {
    const notAPayload = /^windowsSdk\.payloads: .* is not a payload$/u;
    const cases: [string, string | RegExp][] = [
      ['{', 'not JSON'],
      ['[]', 'fields are not windowsSdk'],
      [JSON.stringify({ ...JSON.parse(PIN_TEXT), extra: 1 }), 'fields are not windowsSdk'],
      [
        mutate((sdk) => {
          delete sdk['package'];
        }),
        'windowsSdk fields are not build, msis, package, payloads, version',
      ],
      [
        mutate((sdk) => {
          sdk['version'] = '10.0.26100.1';
        }),
        'windowsSdk.version is not 10.0.<build>.0',
      ],
      [
        mutate((sdk) => {
          sdk['build'] = '7705';
        }),
        'windowsSdk.build is not a servicing build',
      ],
      [
        mutate((sdk) => {
          sdk['package'] = 'Win11SDK';
        }),
        'windowsSdk.package is not <id>,version=<version>',
      ],
      [
        mutate((sdk) => {
          sdk['payloads'] = [];
        }),
        'windowsSdk.payloads is empty',
      ],
      [
        mutate((sdk) => {
          sdk['payloads'] = 'x';
        }),
        'windowsSdk.payloads is empty',
      ],
      [
        mutate((sdk) => {
          payloads(sdk)[0] = { name: '../a.msi', size: 1, sha256: 'a'.repeat(64), url: URL_BASE };
        }),
        notAPayload,
      ],
      [
        mutate((sdk) => {
          payloadAt(sdk, 1)['url'] = 'https://example.com/b.cab';
        }),
        notAPayload,
      ],
      [
        mutate((sdk) => {
          payloadAt(sdk, 1)['sha256'] = 'A'.repeat(64);
        }),
        notAPayload,
      ],
      [
        mutate((sdk) => {
          payloadAt(sdk, 1)['size'] = 0;
        }),
        notAPayload,
      ],
      [
        mutate((sdk) => {
          payloadAt(sdk, 1)['size'] = '1';
        }),
        notAPayload,
      ],
      [
        mutate((sdk) => {
          payloads(sdk).push(payloadAt(sdk, 0));
        }),
        `windowsSdk.payloads names ${String(committed().windowsSdk.payloads[0]?.name)} twice`,
      ],
      [
        mutate((sdk) => {
          sdk['msis'] = [];
        }),
        'windowsSdk.msis is not a list of distinct MSIs among the payloads',
      ],
      [
        mutate((sdk) => {
          sdk['msis'] = 'x';
        }),
        'windowsSdk.msis is not a list of distinct MSIs among the payloads',
      ],
      [
        mutate((sdk) => {
          sdk['msis'] = ['missing.msi'];
        }),
        'windowsSdk.msis is not a list of distinct MSIs among the payloads',
      ],
      [
        mutate((sdk) => {
          const msis = sdk['msis'] as unknown[];
          msis.push(msis[0]);
        }),
        'windowsSdk.msis is not a list of distinct MSIs among the payloads',
      ],
      [
        mutate((sdk) => {
          sdk['msis'] = [1];
        }),
        'windowsSdk.msis is not a list of distinct MSIs among the payloads',
      ],
    ];
    for (const [text, reason] of cases) {
      if (typeof reason === 'string') expect(parsePin(text)).toBe(reason);
      else expect(parsePin(text)).toMatch(reason);
    }
  });
});

describe('the SDK marker', () => {
  it('names the pin by a digest', () => {
    const pin = committed();
    expect(pinDigest(pin)).toMatch(/^[0-9a-f]{64}$/u);
    expect(pinDigest(tinyPin())).not.toBe(pinDigest(pin));
    const marker = renderSdkMarker(pin);
    expect(JSON.parse(marker)).toEqual({
      version: '10.0.26100.0',
      build: '10.1.26100.7705',
      pin: pinDigest(pin),
    });
    expect(checkSdkMarker(marker, pin)).toEqual({ build: '10.1.26100.7705' });
  });

  it('refuses a marker of another pin or a broken one', () => {
    const pin = committed();
    expect(checkSdkMarker('{', pin)).toBe(`${SDK_MARKER} is not JSON`);
    expect(checkSdkMarker('{"build":"x"}', pin)).toBe(
      `${SDK_MARKER} fields are not build, pin, version`,
    );
    expect(checkSdkMarker(renderSdkMarker(tinyPin()), pin)).toBe(
      `it was provisioned from another pin (Windows SDK 10.1.26100.7705, pin ${pinDigest(tinyPin()).slice(0, 12)}), not ${PIN_FILE} (Windows SDK 10.1.26100.7705, pin ${pinDigest(pin).slice(0, 12)})`,
    );
  });

  it('places the kits root and the files the build needs', () => {
    expect(kitsRoot('C:\\hvsdk')).toBe('C:\\hvsdk\\Windows Kits\\10\\');
    expect(sdkRequiredFiles(committed())).toContain('Lib\\10.0.26100.0\\um\\arm64\\kernel32.Lib');
  });
});

describe('selectInstance', () => {
  const instance = (installationPath: string, extra: Record<string, unknown> = {}) => ({
    installationPath,
    installationVersion: '17.14.37710.0',
    productId: 'Microsoft.VisualStudio.Product.Enterprise',
    isComplete: true,
    ...extra,
  });
  const enterprise = instance('C:\\VS\\Enterprise');
  const vs2026 = instance('C:\\VS\\18', { installationVersion: '18.11.12315.225' });
  const toolset = 'MSVC 14.44.35207 for x64';
  const holds = (paths: string[]) => (dir: string) => paths.includes(dir);

  it('takes the instance at HUDHUD_VS_INSTALL when it holds the toolset', () => {
    const text = JSON.stringify([vs2026, enterprise]);
    expect(
      selectInstance(text, {
        wanted: 'c:/vs/ENTERPRISE/',
        toolset,
        hasToolset: holds(['C:\\VS\\Enterprise', 'C:\\VS\\18']),
      }),
    ).toEqual({
      path: 'C:\\VS\\Enterprise',
      version: '17.14.37710.0',
      product: 'Microsoft.VisualStudio.Product.Enterprise',
    });
  });

  it('else takes the only complete instance that holds the toolset, never the latest', () => {
    const text = JSON.stringify([vs2026, enterprise, instance('C:\\x', { isComplete: false })]);
    expect(
      selectInstance(text, {
        wanted: undefined,
        toolset,
        hasToolset: holds(['C:\\VS\\Enterprise', 'C:\\x']),
      }),
    ).toMatchObject({ path: 'C:\\VS\\Enterprise' });
  });

  it('refuses no list, a missing or incomplete instance, a missing toolset, or several', () => {
    const none = { wanted: undefined, toolset, hasToolset: holds([]) };
    expect(selectInstance('nope', none)).toBe('vswhere printed no instance list');
    expect(selectInstance('{}', none)).toBe('vswhere printed no instance list');
    expect(selectInstance(JSON.stringify([enterprise, null, 1]), none)).toBe(
      `no complete Visual Studio instance has ${toolset} (instances: C:\\VS\\Enterprise (Microsoft.VisualStudio.Product.Enterprise 17.14.37710.0); undefined (undefined undefined); undefined (undefined undefined))`,
    );
    expect(selectInstance('[]', none)).toBe(
      `no complete Visual Studio instance has ${toolset} (instances: none)`,
    );
    expect(
      selectInstance(JSON.stringify([enterprise, vs2026]), {
        ...none,
        hasToolset: holds(['C:\\VS\\Enterprise', 'C:\\VS\\18']),
      }),
    ).toBe(
      `2 Visual Studio instances have ${toolset} (C:\\VS\\Enterprise (Microsoft.VisualStudio.Product.Enterprise 17.14.37710.0); C:\\VS\\18 (Microsoft.VisualStudio.Product.Enterprise 18.11.12315.225)); choose one with HUDHUD_VS_INSTALL`,
    );
    expect(
      selectInstance(JSON.stringify([instance('C:\\x', { isComplete: false })]), {
        ...none,
        wanted: 'C:\\x',
      }),
    ).toBe(
      'no complete Visual Studio instance at C:\\x (instances: C:\\x (Microsoft.VisualStudio.Product.Enterprise 17.14.37710.0))',
    );
    expect(
      selectInstance(JSON.stringify([enterprise]), { ...none, wanted: 'C:\\VS\\Enterprise' }),
    ).toBe(`the Visual Studio instance at C:\\VS\\Enterprise has no ${toolset}`);
  });
});

describe('parsePinArgs', () => {
  it('reads provision-sdk', () => {
    expect(
      parsePinArgs(['provision-sdk', '--out', 'C:\\hvsdk', '--downloads', 'D:\\a\\_temp\\sdk']),
    ).toEqual({ command: 'provision-sdk', downloads: 'D:\\a\\_temp\\sdk', out: 'C:\\hvsdk' });
  });

  it('refuses anything else', () => {
    const cases: [string[], RegExp][] = [
      [[], /^usage: toolchain\.mjs provision-sdk/u],
      [['install-vs'], /^usage: /u],
      [['provision-sdk', '--install', 'C:\\x'], /^provision-sdk takes no "--install"\nusage: /u],
      [['provision-sdk', '--out'], /^missing value for --out$/u],
      [['provision-sdk', '--out', ''], /^missing value for --out$/u],
      [['provision-sdk', '--out', 'C:\\a', '--out', 'C:\\a'], /^--out given twice$/u],
      [
        ['provision-sdk', '--out', 'C:\\with space'],
        /^--out must be an absolute Windows directory without spaces: /u,
      ],
      [['provision-sdk', '--out', 'relative'], /without spaces: relative$/u],
      [['provision-sdk', '--out', 'C:\\a'], /^provision-sdk needs --downloads\nusage: /u],
    ];
    for (const [argv, message] of cases) {
      expect(() => parsePinArgs(argv)).toThrow(PinUsageError);
      expect(() => parsePinArgs(argv)).toThrow(message);
    }
    expect(PIN_USAGE).toBe('usage: toolchain.mjs provision-sdk --downloads <dir> --out <dir>');
  });
});

// ---- runPin ----------------------------------------------------------------

interface Fake {
  files: Map<string, string>;
  hashes: Map<string, { size: number; sha256: string }>;
  out: string[];
  err: string[];
  runs: { file: string; args: readonly string[] }[];
  downloads: string[];
}

const ROOT = path.resolve('/repo');
const MSIEXEC = 'C:\\Windows\\System32\\msiexec.exe';

function fake(
  pinText: string,
  options: {
    files?: Record<string, string>;
    /** The size and sha256 a downloaded file gets, by URL. */
    served?: Record<string, { size: number; sha256: string }>;
    status?: () => { status: number | null; error?: string };
  } = {},
): { io: PinIo; fs: Fake } {
  const fs: Fake = {
    files: new Map(Object.entries({ [path.join(ROOT, PIN_FILE)]: pinText, ...options.files })),
    hashes: new Map(),
    out: [],
    err: [],
    runs: [],
    downloads: [],
  };
  const io: PinIo = {
    root: ROOT,
    systemRoot: 'C:\\Windows',
    exists: (file) => fs.files.has(file) || fs.hashes.has(file),
    readFile: (file) => {
      const data = fs.files.get(file);
      if (data === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return new TextEncoder().encode(data);
    },
    writeFile: (file, data) => {
      fs.files.set(file, data);
    },
    makeDir: () => undefined,
    removeFile: (file) => {
      fs.files.delete(file);
      fs.hashes.delete(file);
    },
    hashFile: (file) => Promise.resolve(fs.hashes.get(file) ?? { size: 0, sha256: '' }),
    download: (url, file) => {
      fs.downloads.push(url);
      const served = options.served?.[url];
      if (served === undefined) return Promise.reject(new Error('HTTP 404'));
      fs.hashes.set(file, served);
      return Promise.resolve();
    },
    run: (file, args) => {
      fs.runs.push({ file, args });
      return options.status?.() ?? { status: 0 };
    },
    log: (line) => {
      fs.out.push(line);
    },
    error: (line) => {
      fs.err.push(line);
    },
  };
  return { io, fs };
}

describe('runPin provision-sdk', () => {
  const pin = tinyPin();
  const pinText = JSON.stringify(pin);
  const options = { command: 'provision-sdk', downloads: 'C:\\dl', out: 'C:\\hvsdk' } as const;
  const marker = path.win32.join('C:\\hvsdk', SDK_MARKER);
  const served = Object.fromEntries(
    pin.windowsSdk.payloads.map((p) => [p.url, { size: p.size, sha256: p.sha256 }]),
  );
  const root = kitsRoot('C:\\hvsdk');
  const required = Object.fromEntries(
    sdkRequiredFiles(pin).map((file) => [path.win32.join(root, file), '']),
  );

  it('downloads, checks and unpacks every payload, then writes the marker', async () => {
    const { io, fs } = fake(pinText, { served, files: required });
    expect(await runPin(options, io)).toBe(0);
    expect(fs.downloads).toEqual(pin.windowsSdk.payloads.map((p) => p.url));
    expect(fs.runs).toEqual([
      {
        file: MSIEXEC,
        args: ['/a', 'C:\\dl\\a.msi', '/qn', 'TARGETDIR=C:\\hvsdk', '/l*v', 'C:\\dl\\a.msi.log'],
      },
    ]);
    expect(fs.files.get(marker)).toBe(renderSdkMarker(pin));
    expect(fs.out).toEqual([
      `2 Windows SDK 10.1.26100.7705 payloads, 0 MB, match ${PIN_FILE}`,
      'unpacked a.msi',
      `Windows SDK 10.1.26100.7705 (10.0.26100.0) provisioned at ${root}`,
    ]);
  });

  it('reuses a downloaded payload of the pinned size and sha256, and replaces any other', async () => {
    const reuse = fake(pinText, { served, files: required });
    reuse.fs.hashes.set('C:\\dl\\a.msi', { size: 3, sha256: 'a'.repeat(64) });
    reuse.fs.hashes.set('C:\\dl\\b.cab', { size: 5, sha256: 'b'.repeat(64) });
    expect(await runPin(options, reuse.io)).toBe(0);
    expect(reuse.fs.downloads).toEqual([`${URL_BASE}b.cab`]);
    const stale = fake(pinText, { served, files: required });
    stale.fs.hashes.set('C:\\dl\\a.msi', { size: 3, sha256: 'f'.repeat(64) });
    expect(await runPin(options, stale.io)).toBe(0);
    expect(stale.fs.downloads).toEqual([`${URL_BASE}a.msi`, `${URL_BASE}b.cab`]);
  });

  it('does nothing for a directory that holds the pinned SDK, and refuses one of another pin', async () => {
    const done = fake(pinText, { files: { [marker]: renderSdkMarker(pin) } });
    expect(await runPin(options, done.io)).toBe(0);
    expect(done.fs.out).toEqual(['C:\\hvsdk holds the pinned Windows SDK 10.1.26100.7705 already']);
    expect(done.fs.downloads).toEqual([]);
    const other = fake(pinText, { files: { [marker]: renderSdkMarker(committed()) } });
    expect(await runPin(options, other.io)).toBe(1);
    expect(other.fs.err[0]).toMatch(
      /^toolchain: C:\\hvsdk: it was provisioned from another pin .*; delete it and provision again$/u,
    );
  });

  it('refuses a failed, short or substituted download before anything is unpacked', async () => {
    const failed = fake(pinText, { served: {} });
    expect(await runPin(options, failed.io)).toBe(1);
    expect(failed.fs.err).toEqual([
      `toolchain: downloading ${URL_BASE}a.msi failed: Error: HTTP 404`,
    ]);
    const short = fake(pinText, {
      served: { ...served, [`${URL_BASE}b.cab`]: { size: 3, sha256: 'b'.repeat(64) } },
    });
    expect(await runPin(options, short.io)).toBe(1);
    expect(short.fs.err).toEqual([
      `toolchain: b.cab is 3 bytes, the pin says 4 (${URL_BASE}b.cab)`,
    ]);
    expect(short.fs.hashes.has('C:\\dl\\b.cab')).toBe(false);
    const substituted = fake(pinText, {
      served: { ...served, [`${URL_BASE}b.cab`]: { size: 4, sha256: 'e'.repeat(64) } },
    });
    expect(await runPin(options, substituted.io)).toBe(1);
    expect(substituted.fs.err).toEqual([
      `toolchain: b.cab is sha256 ${'e'.repeat(64)}, the pin says ${'b'.repeat(64)} (${URL_BASE}b.cab)`,
    ]);
    expect(substituted.fs.runs).toEqual([]);
  });

  it('refuses a failed unpack and an incomplete SDK, and writes no marker', async () => {
    const unpack = fake(pinText, { served, status: () => ({ status: 1603 }) });
    expect(await runPin(options, unpack.io)).toBe(1);
    expect(unpack.fs.err).toEqual([
      'toolchain: msiexec /a a.msi exited with 1603; log C:\\dl\\a.msi.log',
    ]);
    const crashed = fake(pinText, { served, status: () => ({ status: null, error: 'killed' }) });
    expect(await runPin(options, crashed.io)).toBe(1);
    expect(crashed.fs.err).toEqual([
      'toolchain: msiexec /a a.msi exited with null (killed); log C:\\dl\\a.msi.log',
    ]);
    const incomplete = fake(pinText, { served });
    expect(await runPin(options, incomplete.io)).toBe(1);
    expect(incomplete.fs.err[0]).toMatch(/^toolchain: the unpacked SDK lacks SDKManifest\.xml, /u);
    expect(incomplete.fs.files.has(marker)).toBe(false);
  });

  it('refuses an unreadable or malformed pin before anything else', async () => {
    const missing = fake(PIN_TEXT);
    missing.fs.files.clear();
    expect(await runPin(options, missing.io)).toBe(1);
    expect(missing.fs.err).toEqual([`toolchain: cannot read ${PIN_FILE} (ENOENT)`]);
    const thrown = fake(PIN_TEXT);
    thrown.io.readFile = () => {
      throw new Error('boom');
    };
    expect(await runPin(options, thrown.io)).toBe(1);
    expect(thrown.fs.err).toEqual([`toolchain: cannot read ${PIN_FILE} (Error: boom)`]);
    const broken = fake('{');
    expect(await runPin(options, broken.io)).toBe(1);
    expect(broken.fs.err).toEqual([`toolchain: ${PIN_FILE}: not JSON`]);
  });
});
