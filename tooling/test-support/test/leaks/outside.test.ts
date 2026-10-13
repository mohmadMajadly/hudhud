import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertNoOutsideWrites,
  diffOutside,
  outsideWatchList,
  OutsideWriteError,
  snapshotOutside,
} from '../../src/leaks/outside.js';
import type { OutsideWatch } from '../../src/leaks/outside.js';

describe('outsideWatchList', () => {
  it('watches the Windows profile locations from the host environment', () => {
    const watch = outsideWatchList({
      platform: 'win32',
      home: 'C:\\Users\\user',
      hostEnv: { APPDATA: 'C:\\R', LOCALAPPDATA: 'C:\\L', TEMP: 'C:\\T' },
    });
    expect(watch.paths).toEqual([
      'C:\\Users\\user\\.claude.json',
      'C:\\Users\\user\\.claude',
      'C:\\R\\Anthropic',
      'C:\\R\\Claude',
      'C:\\L\\claude-cli-nodejs',
      'C:\\Users\\user\\.config\\claude',
      'C:\\Users\\user\\.local\\state\\claude',
      'C:\\Users\\user\\.cache\\claude',
    ]);
    expect(watch.listings.map((l) => l.dir)).toEqual([
      'C:\\Users\\user',
      'C:\\R',
      'C:\\L',
      'C:\\T',
      'C:\\T\\claude',
    ]);
  });

  it('derives the Windows folders from the home when the environment lacks them', () => {
    const watch = outsideWatchList({ platform: 'win32', home: 'C:\\Users\\user', hostEnv: {} });
    expect(watch.paths).toContain('C:\\Users\\user\\AppData\\Roaming\\Anthropic');
    expect(watch.listings.map((l) => l.dir)).toContain('C:\\Users\\user\\AppData\\Local\\Temp');
  });

  it('watches the POSIX locations including the socket fallback', () => {
    const watch = outsideWatchList({
      platform: 'linux',
      home: '/home/user',
      hostEnv: {},
      uid: 1000,
    });
    expect(watch.paths).toContain('/home/user/.claude.json');
    expect(watch.paths).toContain('/tmp/cc-socks-1000');
    expect(outsideWatchList({ platform: 'linux', home: '/root', hostEnv: {} }).paths).toContain(
      '/tmp/cc-socks-0',
    );
    const tmp = watch.listings.find((l) => l.dir === '/tmp');
    expect(tmp?.pattern.test('cc-socks-1000')).toBe(true);
    expect(tmp?.pattern.test('hudhud-run-x')).toBe(false);
  });

  it('snapshots the real default list by metadata only', () => {
    const watch = outsideWatchList({
      platform: process.platform,
      home: os.homedir(),
      hostEnv: process.env,
      uid: process.getuid?.(),
    });
    const snap = snapshotOutside(watch);
    expect(snap.paths.size).toBe(watch.paths.length);
  });
});

describe('snapshot and diff', () => {
  let root = '';
  let watch: OutsideWatch;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hudhud-outside-'));
    await mkdir(path.join(root, 'list'));
    await writeFile(path.join(root, 'modified.json'), 'a');
    await writeFile(path.join(root, 'removed.json'), 'a');
    await writeFile(path.join(root, 'list', 'claude-old'), '');
    await writeFile(path.join(root, 'list', 'unrelated'), '');
    watch = {
      paths: [
        path.join(root, 'modified.json'),
        path.join(root, 'removed.json'),
        path.join(root, 'created'),
        path.join(root, 'same'),
        path.join(root, 'link'),
      ],
      listings: [
        { dir: path.join(root, 'list'), pattern: /claude/ },
        { dir: path.join(root, 'later'), pattern: /^/ },
        { dir: path.join(root, 'never'), pattern: /^/ },
      ],
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10 });
  });

  it('reports every kind of change, by metadata and names only', async () => {
    const before = snapshotOutside(watch);
    await writeFile(path.join(root, 'modified.json'), 'abc');
    await rm(path.join(root, 'removed.json'));
    await mkdir(path.join(root, 'created'));
    await symlink(path.join(root, 'list'), path.join(root, 'link'), 'junction');
    await writeFile(path.join(root, 'list', 'claude-new'), '');
    await writeFile(path.join(root, 'list', 'unrelated-2'), '');
    await rm(path.join(root, 'list', 'claude-old'));
    await mkdir(path.join(root, 'later'));
    await writeFile(path.join(root, 'later', 'x'), '');
    const after = snapshotOutside(watch);
    expect(after.paths.get(path.join(root, 'link'))?.kind).toBe('other');
    expect(after.paths.get(path.join(root, 'created'))?.kind).toBe('directory');
    expect(after.paths.get(path.join(root, 'modified.json'))?.kind).toBe('file');
    const changes = diffOutside(before, after).map((c) => [path.relative(root, c.path), c.change]);
    expect(changes).toEqual([
      ['modified.json', 'modified'],
      ['removed.json', 'removed'],
      ['created', 'created'],
      ['link', 'created'],
      [path.join('list', 'claude-new'), 'entry-added'],
      [path.join('list', 'claude-old'), 'entry-removed'],
      [path.join('later', 'x'), 'entry-added'],
    ]);
  });

  it('notices an mtime-only change and a listing that disappears', async () => {
    const before = snapshotOutside(watch);
    const later = new Date(Date.now() + 120_000);
    await utimes(path.join(root, 'modified.json'), later, later);
    await rm(path.join(root, 'list'), { recursive: true });
    const changes = diffOutside(before, snapshotOutside(watch));
    expect(changes.map((c) => c.change)).toEqual(['modified', 'entry-removed']);
  });

  it('treats a path missing from the later snapshot as removed', () => {
    const before = snapshotOutside(watch);
    const changes = diffOutside(before, { paths: new Map(), entries: new Map() });
    expect(changes.filter((c) => c.change === 'removed').map((c) => path.basename(c.path))).toEqual(
      ['modified.json', 'removed.json'],
    );
  });

  it('asserts no changes unless explicitly ignored', async () => {
    const before = snapshotOutside(watch);
    expect(() => {
      assertNoOutsideWrites(diffOutside(before, snapshotOutside(watch)));
    }).not.toThrow();
    await writeFile(path.join(root, 'modified.json'), 'changed');
    const changes = diffOutside(before, snapshotOutside(watch));
    expect(() => {
      assertNoOutsideWrites(changes);
    }).toThrow(OutsideWriteError);
    expect(() => {
      assertNoOutsideWrites(changes);
    }).toThrow(/1 change\(s\) outside the sandbox\n {2}modified /);
    expect(() => {
      assertNoOutsideWrites(changes, (c) => c.path.endsWith('modified.json'));
    }).not.toThrow();
  });
});
