// The entry point of the tarball check (scripts/check-tarball.mjs). The full
// run (pack, install, import, type-check) needs a built tree and pnpm and is
// part of `pnpm check:full`; what is asserted here is cheap and safe to run
// everywhere: the usage contract and that the script never publishes.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const script = path.join(fileURLToPath(new URL('..', import.meta.url)), 'check-tarball.mjs');

describe('check-tarball.mjs', () => {
  it('takes no arguments and exits 2 on any', () => {
    const result = spawnSync(process.execPath, [script, '--publish'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: node scripts/check-tarball.mjs');
    expect(result.stdout).toBe('');
  });

  it('release mode refuses a path that is not a committed release record, before packing', () => {
    const bad = spawnSync(process.execPath, [script, '--release-record', 'manifest.json'], {
      encoding: 'utf8',
    });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('manifest.json is not a release record path');
    expect(bad.stderr).toContain('usage: node scripts/check-tarball.mjs [--release-record');
    expect(bad.stdout).toBe('');
    const missing = 'native/win32-job/release/9.9.9-missing/manifest.json';
    const absent = spawnSync(process.execPath, [script, '--release-record', missing], {
      encoding: 'utf8',
    });
    expect(absent.status).toBe(2);
    expect(absent.stderr).toBe(`tarball check: cannot read ${missing} (ENOENT)\n`);
    expect(absent.stdout).toBe('');
  });

  it('never publishes and never talks to a registry itself', () => {
    const source = readFileSync(script, 'utf8');
    // It packs and installs tarballs only: no publish command, no registry URL,
    // and the install runs with empty npm configuration files.
    expect(source).not.toMatch(/['"`]publish['"`]/u);
    expect(source).not.toMatch(/https?:\/\//u);
    for (const argument of ["'install'", "'--omit=dev'", "'--ignore-scripts'"]) {
      expect(source).toContain(argument);
    }
    expect(source).toContain('cleanEnv(');
  });
});
