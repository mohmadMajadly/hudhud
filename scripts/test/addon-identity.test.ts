// The input identity of a job addon build (scripts/lib/addon-identity.mjs;
// ADR-0014 amendment 14): reading FileTracker logs, naming each input by its
// root, checking and ordering an identity, and naming every difference from
// a reference. Diagnostic only: the gate is the output bytes.

import { describe, expect, it } from 'vitest';

import {
  checkIdentity,
  identityDifferences,
  identityInputs,
  identityKey,
  MAX_IDENTITY_FILES,
  orderedIdentity,
  parseTlogReads,
  type Identity,
} from '../lib/addon-identity.mjs';

const MSVC = 'C:\\BT\\VC\\Tools\\MSVC\\14.44.35207';
const ROOTS = [
  { name: 'msvc', dir: MSVC },
  { name: 'sdk', dir: 'C:\\hvsdk\\Windows Kits\\10\\' },
  { name: 'node-api-headers', dir: 'C:/repo/node_modules/node-api-headers' },
];
const EXCLUDED = [
  'C:\\repo\\native\\win32-job\\build\\x64',
  'C:\\repo\\native\\win32-job',
  'C:\\Windows',
];
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function identityOf(overrides: Partial<Identity> = {}): Identity {
  return {
    visualStudio: '17.14.37710.0',
    windowsSdkBuild: '10.1.26100.7705',
    files: { 'msvc/bin/hostx64/x64/cl.exe': A },
    ...overrides,
  };
}

describe('parseTlogReads', () => {
  it('names every read file, without source markers, blank lines or a byte order mark', () => {
    const text =
      '\uFEFF^C:\\REPO\\SRC\\A.C|C:\\REPO\\SRC\\B.C\r\nC:\\SDK\\UM\\WINDOWS.H\r\n\r\n  C:\\MSVC\\INCLUDE\\SAL.H  \n';
    expect(parseTlogReads(text)).toEqual(['C:\\SDK\\UM\\WINDOWS.H', 'C:\\MSVC\\INCLUDE\\SAL.H']);
    expect(parseTlogReads('')).toEqual([]);
  });
});

describe('identityKey', () => {
  it('names a file by its root, in lower case with forward slashes', () => {
    expect(
      identityKey(`${MSVC.toUpperCase()}\\LIB\\SPECTRE\\X64\\LIBCMT.LIB`, ROOTS, EXCLUDED),
    ).toBe('msvc/lib/spectre/x64/libcmt.lib');
    expect(
      identityKey(
        'C:\\HVSDK\\WINDOWS KITS\\10\\LIB\\10.0.26100.0\\UM\\X64\\KERNEL32.LIB',
        ROOTS,
        EXCLUDED,
      ),
    ).toBe('sdk/lib/10.0.26100.0/um/x64/kernel32.lib');
    expect(
      identityKey('C:/repo/node_modules/node-api-headers/include/node_api.h', ROOTS, EXCLUDED),
    ).toBe('node-api-headers/include/node_api.h');
  });

  it('skips the repository and Windows, and names anything else by its file name only', () => {
    expect(
      identityKey('C:\\REPO\\NATIVE\\WIN32-JOB\\BUILD\\X64\\NODE.LIB', ROOTS, EXCLUDED),
    ).toBeNull();
    expect(identityKey('C:\\REPO\\NATIVE\\WIN32-JOB\\SRC\\A.C', ROOTS, EXCLUDED)).toBeNull();
    expect(identityKey('C:\\WINDOWS\\SYSTEM32\\TZRES.DLL', ROOTS, EXCLUDED)).toBeNull();
    expect(identityKey('D:\\elsewhere\\Some.dll', ROOTS, EXCLUDED)).toBe('other/some.dll');
    // A directory name is not a prefix of a longer one.
    expect(identityKey(`${MSVC}X\\cl.exe`, ROOTS, EXCLUDED)).toBe('other/cl.exe');
  });
});

describe('identityInputs', () => {
  it('maps each key once (the first file named), keys sorted, skipped files left out', () => {
    const inputs = identityInputs(
      [
        'C:\\HVSDK\\WINDOWS KITS\\10\\INCLUDE\\10.0.26100.0\\UM\\WINDOWS.H',
        `${MSVC}\\bin\\Hostx64\\x64\\cl.exe`,
        `${MSVC.toUpperCase()}\\BIN\\HOSTX64\\X64\\CL.EXE`,
        'C:\\repo\\native\\win32-job\\src\\a.c',
      ],
      ROOTS,
      EXCLUDED,
    );
    expect([...inputs.entries()]).toEqual([
      ['msvc/bin/hostx64/x64/cl.exe', `${MSVC}\\bin\\Hostx64\\x64\\cl.exe`],
      [
        'sdk/include/10.0.26100.0/um/windows.h',
        'C:\\HVSDK\\WINDOWS KITS\\10\\INCLUDE\\10.0.26100.0\\UM\\WINDOWS.H',
      ],
    ]);
  });
});

describe('checkIdentity', () => {
  it('accepts a well-formed identity, pinned or not', () => {
    expect(checkIdentity(identityOf())).toEqual(identityOf());
    expect(checkIdentity(identityOf({ windowsSdkBuild: 'unpinned', files: {} }))).toEqual(
      identityOf({ windowsSdkBuild: 'unpinned', files: {} }),
    );
  });

  it('refuses anything else with a reason', () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_IDENTITY_FILES + 1 }, (_, i) => [`other/f${String(i)}`, A]),
    );
    const cases: [unknown, string][] = [
      [null, 'not an object'],
      [[], 'not an object'],
      [
        { visualStudio: '1.2.3.4' },
        'fields visualStudio are not files, visualStudio, windowsSdkBuild',
      ],
      [identityOf({ visualStudio: '17.14' }), 'visualStudio is not a version'],
      [{ ...identityOf(), visualStudio: 17 }, 'visualStudio is not a version'],
      [identityOf({ windowsSdkBuild: 'latest' }), 'windowsSdkBuild is not a version or unpinned'],
      [{ ...identityOf(), windowsSdkBuild: null }, 'windowsSdkBuild is not a version or unpinned'],
      [{ ...identityOf(), files: [] }, 'files is not an object'],
      [{ ...identityOf(), files: null }, 'files is not an object'],
      [identityOf({ files: many }), `files names more than ${String(MAX_IDENTITY_FILES)} inputs`],
      [identityOf({ files: { 'msvc/../x': A } }), 'files: "msvc/../x" is not an input key'],
      [identityOf({ files: { 'MSVC/cl.exe': A } }), 'files: "MSVC/cl.exe" is not an input key'],
      [identityOf({ files: { 'tools/cl.exe': A } }), 'files: "tools/cl.exe" is not an input key'],
      [identityOf({ files: { msvc: A } }), 'files: "msvc" is not an input key'],
      [
        identityOf({ files: { 'msvc/cl.exe': 'A'.repeat(64) } }),
        'files: msvc/cl.exe is not a sha256',
      ],
      [{ ...identityOf(), files: { 'msvc/cl.exe': 1 } }, 'files: msvc/cl.exe is not a sha256'],
    ];
    for (const [value, reason] of cases) expect(checkIdentity(value)).toBe(reason);
  });
});

describe('orderedIdentity', () => {
  it('orders the fields and sorts the files by key', () => {
    const shuffled = {
      files: { 'sdk/b.lib': B, 'msvc/a.lib': A },
      windowsSdkBuild: 'unpinned',
      visualStudio: '17.14.37710.0',
    };
    expect(JSON.stringify(orderedIdentity(shuffled))).toBe(
      JSON.stringify({
        visualStudio: '17.14.37710.0',
        windowsSdkBuild: 'unpinned',
        files: { 'msvc/a.lib': A, 'sdk/b.lib': B },
      }),
    );
  });
});

describe('identityDifferences', () => {
  it('is empty for the same inputs', () => {
    expect(identityDifferences(identityOf(), identityOf(), 'record')).toEqual([]);
  });

  it('names every difference with both values', () => {
    const reference = identityOf({
      files: { 'msvc/cl.exe': A, 'sdk/kernel32.lib': A, 'sdk/gone.lib': A },
    });
    const build = identityOf({
      visualStudio: '17.14.37806.7',
      windowsSdkBuild: '10.1.26100.9457',
      files: { 'msvc/cl.exe': A, 'sdk/kernel32.lib': B, 'sdk/new.lib': B },
    });
    expect(identityDifferences(reference, build, 'record')).toEqual([
      'Visual Studio 17.14.37806.7 (record 17.14.37710.0)',
      'Windows SDK build 10.1.26100.9457 (record 10.1.26100.7705)',
      'sdk/gone.lib: read by the record only',
      `sdk/kernel32.lib: sha256 ${B} (record ${A})`,
      'sdk/new.lib: read by the rebuild only',
    ]);
  });

  it('says when either side records no identity', () => {
    expect(identityDifferences(undefined, identityOf(), 'CI')).toEqual([
      'the CI names no input identity',
    ]);
    expect(identityDifferences(identityOf(), undefined, 'record')).toEqual([
      'the rebuild names no input identity (record has one)',
    ]);
  });
});
