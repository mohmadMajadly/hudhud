// The entry point of the tarball check (scripts/check-tarball.mjs). The full
// run (pack, install, import, type-check) needs a built tree and pnpm and is
// part of `pnpm check:full`; what is asserted here is cheap and safe to run
// everywhere: the usage contract and that the script never publishes.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    expect(bad.stderr).toContain(
      'usage: node scripts/check-tarball.mjs [--tarballs <dir> | --release-record',
    );
    expect(bad.stdout).toBe('');
    const missing = 'native/win32-job/release/9.9.9-missing/manifest.json';
    const absent = spawnSync(process.execPath, [script, '--release-record', missing], {
      encoding: 'utf8',
    });
    expect(absent.status).toBe(2);
    expect(absent.stderr).toBe(`tarball check: cannot read ${missing} (ENOENT)\n`);
    expect(absent.stdout).toBe('');
  });

  it('release tag mode needs the tag as its one argument', () => {
    const result = spawnSync(process.execPath, [script, '--release-tag'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--release-tag v<version> [--keep-tarballs <dir>]]');
    expect(result.stdout).toBe('');
  });

  it('keeps tarballs only after a release tag check, into a directory it is given', () => {
    for (const args of [
      ['--release-tag', 'v0.1.0', '--keep-tarballs'],
      ['--keep-tarballs', 'out'],
      [
        '--release-record',
        'native/win32-job/release/0.0.0-dev/manifest.json',
        '--keep-tarballs',
        'out',
      ],
      ['--tarballs'],
    ]) {
      const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.stderr).toContain('--release-tag v<version> [--keep-tarballs <dir>]]');
      expect(result.stdout).toBe('');
    }
  });

  describe('--tarballs (the full check over tarballs packed earlier)', () => {
    let dir = '';
    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'hudhud-tarballs-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('refuses a directory with anything but tarballs, before checking', () => {
      writeFileSync(path.join(dir, 'notes.txt'), 'x');
      const result = spawnSync(process.execPath, [script, '--tarballs', dir], { encoding: 'utf8' });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('holds files that are not tarballs: notes.txt');
      expect(result.stdout).toBe('');
    });

    it('names every publishable package without a tarball, and packs nothing', () => {
      const result = spawnSync(process.execPath, [script, '--tarballs', dir], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('are not those of the publishable packages');
      for (const name of [
        'hudhudjs',
        '@hudhudjs/core',
        '@hudhudjs/claude-code',
        '@hudhudjs/conformance',
        '@hudhudjs/win32-job-x64',
      ]) {
        expect(result.stdout).toContain(`${name}: no tarball given`);
      }
      expect(result.stdout).not.toContain('win32-job-arm64');
      expect(result.stdout).not.toContain('packed');
    });
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
