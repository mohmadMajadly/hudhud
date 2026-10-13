import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ancestorsOf,
  assertNoForbiddenAncestors,
  findForbiddenAncestors,
  FORBIDDEN_ANCESTOR_ENTRIES,
  testRootInstructions,
} from '../../src/launcher/ancestors.js';
import type { AncestorProbe } from '../../src/launcher/ancestors.js';
import { SandboxRefusedError } from '../../src/launcher/errors.js';
import { fsProbe } from '../../src/launcher/sandbox.js';

function probe(
  existing: readonly string[],
  real: Readonly<Record<string, string>> = {},
): AncestorProbe {
  const set = new Set(existing);
  return { exists: (file) => set.has(file), realpath: (dir) => real[dir] };
}

describe('ancestorsOf', () => {
  it('lists the directory and every ancestor, nearest first (POSIX)', () => {
    expect(ancestorsOf('/a/b/c', 'linux')).toEqual(['/a/b/c', '/a/b', '/a', '/']);
  });

  it('lists the directory and every ancestor, nearest first (Windows)', () => {
    expect(ancestorsOf('C:\\a\\b', 'win32')).toEqual(['C:\\a\\b', 'C:\\a', 'C:\\']);
  });
});

describe('findForbiddenAncestors', () => {
  it('accepts a clean directory', () => {
    expect(
      findForbiddenAncestors({
        dir: '/srv/t/run',
        homes: ['/home/user'],
        platform: 'linux',
        probe: probe([]),
      }),
    ).toEqual([]);
  });

  it('refuses the real home as an ancestor or as the directory itself', () => {
    const check = { homes: ['/home/user'], platform: 'linux' as const, probe: probe([]) };
    expect(findForbiddenAncestors({ ...check, dir: '/home/user/tmp/run' })).toEqual([
      { ancestor: '/home/user', reason: 'home' },
    ]);
    expect(findForbiddenAncestors({ ...check, dir: '/home/user' })).toEqual([
      { ancestor: '/home/user', reason: 'home' },
    ]);
  });

  it('compares homes case-insensitively on Windows and through their real paths', () => {
    expect(
      findForbiddenAncestors({
        dir: 'C:\\USERS\\USER\\AppData\\Local\\Temp\\run',
        homes: ['C:\\Users\\user'],
        platform: 'win32',
        probe: probe([]),
      }),
    ).toEqual([{ ancestor: 'C:\\USERS\\USER', reason: 'home' }]);
    expect(
      findForbiddenAncestors({
        dir: '/data/run',
        homes: ['/srv/link'],
        platform: 'linux',
        probe: probe([], { '/srv/link': '/data' }),
      }),
    ).toEqual([{ ancestor: '/data', reason: 'home' }]);
  });

  it('ignores empty and relative home entries', () => {
    expect(
      findForbiddenAncestors({
        dir: '/x/run',
        homes: ['', 'relative'],
        platform: 'linux',
        probe: probe([]),
      }),
    ).toEqual([]);
  });

  it.each(FORBIDDEN_ANCESTOR_ENTRIES)('refuses an ancestor holding %s', (name) => {
    expect(
      findForbiddenAncestors({
        dir: '/srv/t/run',
        homes: [],
        platform: 'linux',
        probe: probe([`/srv/${name}`]),
      }),
    ).toEqual([{ ancestor: '/srv', reason: name }]);
  });

  it('also walks the real path of the directory (links, junctions, short names)', () => {
    const hits = findForbiddenAncestors({
      dir: '/link/run',
      homes: [],
      platform: 'linux',
      probe: probe(['/real/parent/.claude'], { '/link/run': '/real/parent/run' }),
    });
    expect(hits).toEqual([{ ancestor: '/real/parent', reason: '.claude' }]);
  });

  it('checks a shared ancestor of both walks once', () => {
    const hits = findForbiddenAncestors({
      dir: '/a/link/run',
      homes: [],
      platform: 'linux',
      probe: probe(['/a/.claude'], { '/a/link/run': '/a/real/run' }),
    });
    expect(hits).toEqual([{ ancestor: '/a', reason: '.claude' }]);
  });

  it('does not walk a real path equal to the directory twice', () => {
    const hits = findForbiddenAncestors({
      dir: '/srv/run',
      homes: [],
      platform: 'linux',
      probe: probe(['/.mcp.json'], { '/srv/run': '/srv/run' }),
    });
    expect(hits).toEqual([{ ancestor: '/', reason: '.mcp.json' }]);
  });
});

describe('assertNoForbiddenAncestors', () => {
  it('passes a clean directory', () => {
    expect(() => {
      assertNoForbiddenAncestors({
        dir: '/srv/run',
        homes: [],
        platform: 'linux',
        probe: probe([]),
      });
    }).not.toThrow();
  });

  it('refuses with every reason and platform instructions', () => {
    const run = (): void => {
      assertNoForbiddenAncestors({
        dir: 'C:\\Users\\user\\Temp\\run',
        homes: ['C:\\Users\\user'],
        platform: 'win32',
        probe: probe(['C:\\.claude']),
      });
    };
    expect(run).toThrow(SandboxRefusedError);
    expect(run).toThrow(/C:\\Users\\user is the real home directory/);
    expect(run).toThrow(/C:\\ contains \.claude/);
    expect(run).toThrow(/HUDHUD_TEST_ROOT.*subst/);
    try {
      run();
    } catch (error) {
      expect((error as SandboxRefusedError).code).toBe('forbidden-ancestor');
    }
  });

  it('gives POSIX instructions off Windows', () => {
    expect(testRootInstructions('linux')).toMatch(/HUDHUD_TEST_ROOT.*native file system/);
    expect(testRootInstructions('win32')).toMatch(/subst/);
  });
});

describe('the real file-system probe', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hudhud-ancestors-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10 });
  });

  it('finds a planted .claude directory, CLAUDE.md and .mcp.json above the run directory', async () => {
    const run = path.join(root, 'a', 'b', 'run');
    await mkdir(run, { recursive: true });
    await mkdir(path.join(root, '.claude'));
    await writeFile(path.join(root, 'a', 'CLAUDE.md'), '');
    await writeFile(path.join(root, 'a', 'b', '.mcp.json'), '{}');
    const prefix = path.resolve(root);
    const scoped: AncestorProbe = {
      exists: (file) => path.resolve(file).startsWith(prefix) && fsProbe.exists(file),
      realpath: (dir) => fsProbe.realpath(dir),
    };
    const hits = findForbiddenAncestors({
      dir: run,
      homes: [],
      platform: process.platform,
      probe: scoped,
    });
    expect(hits.map((hit) => hit.reason).sort()).toEqual(['.claude', '.mcp.json', 'CLAUDE.md']);
  });

  it('reports no real path for a missing directory', () => {
    expect(fsProbe.realpath(path.join(root, 'missing'))).toBeUndefined();
    expect(fsProbe.exists(path.join(root, 'missing'))).toBe(false);
  });
});
