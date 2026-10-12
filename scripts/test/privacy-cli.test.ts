// End-to-end tests of the privacy gate: the CLI in --staged and --tree mode
// and the tracked pre-commit hook, each in a throw-away git repository.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const join = (...parts: string[]): string => parts.join('');
const LEAK_EMAIL = join('alice', '@', 'example.com');
const DENIED = 'secret-handle';

let dir: string;
let denylist: string;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Run {
  const result = spawnSync(command, args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, HUDHUD_PRIVACY_DENYLIST: denylist, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(...args: string[]): Run {
  const result = run('git', [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@users.noreply.github.com',
    ...args,
  ]);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}

function scan(mode: '--staged' | '--tree', env: NodeJS.ProcessEnv = {}): Run {
  return run(process.execPath, [path.join(dir, 'scripts', 'privacy-scan.mjs'), mode], env);
}

function write(file: string, content: string): void {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content);
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hudhud-privacy-')));
  git('init', '--quiet');
  // The repository under test carries its own copy of the gate.
  for (const file of [
    'scripts/privacy-scan.mjs',
    'scripts/lib/privacy.mjs',
    '.githooks/pre-commit',
  ]) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    copyFileSync(path.join(repoRoot, file), path.join(dir, file));
  }
  chmodSync(path.join(dir, '.githooks/pre-commit'), 0o755);
  denylist = path.join(dir, 'denylist.txt');
  writeFileSync(denylist, `# private\n${DENIED}\n`);
  write('.gitignore', 'denylist.txt\n');
  git('add', '.');
  git('commit', '--quiet', '--no-verify', '-m', 'init');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('privacy-scan --staged', () => {
  it('passes a clean index', () => {
    write('ok.md', 'nothing personal\n');
    git('add', 'ok.md');
    const result = scan('--staged');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('clean');
  });

  it('blocks added lines and new file names, and never prints denylist terms', () => {
    write('notes.md', `line one\nmail ${LEAK_EMAIL}\nby ${DENIED.toUpperCase()}\n`);
    write(`docs/${DENIED}.md`, 'fine\n');
    git('add', '.');
    const result = scan('--staged');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('notes.md:2: [email] ***@example.com');
    expect(result.stderr).toContain('notes.md:3: [denylist] term #1');
    expect(result.stderr).toContain('docs/***.md:(file name): [denylist] term #1');
    expect(result.stderr.toLowerCase()).not.toContain(DENIED);
    expect(result.stderr).not.toContain(LEAK_EMAIL);
  });

  it('ignores removed lines', () => {
    write('old.md', `${LEAK_EMAIL}\n`);
    git('add', 'old.md');
    git('commit', '--quiet', '--no-verify', '-m', 'old');
    write('old.md', 'cleaned\n');
    git('add', 'old.md');
    expect(scan('--staged').status).toBe(0);
  });

  it('fails closed when the configured denylist is missing', () => {
    const result = scan('--staged', { HUDHUD_PRIVACY_DENYLIST: path.join(dir, 'missing.txt') });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('points to a missing file');
  });

  it('reads .git/info/privacy-denylist when no variable is set', () => {
    writeFileSync(path.join(dir, '.git', 'info', 'privacy-denylist'), `${DENIED}\n`);
    write('a.md', `${DENIED}\n`);
    git('add', 'a.md');
    expect(scan('--staged', { HUDHUD_PRIVACY_DENYLIST: '' }).status).toBe(1);
  });

  it('rejects an unknown mode', () => {
    expect(run(process.execPath, [path.join(dir, 'scripts', 'privacy-scan.mjs')]).status).toBe(2);
  });
});

describe('privacy-scan --tree', () => {
  it('scans tracked and untracked unignored files but not ignored ones', () => {
    expect(scan('--tree').status).toBe(0);
    write('untracked.txt', `${LEAK_EMAIL}\n`);
    const result = scan('--tree');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('untracked.txt:1: [email]');
    expect(result.stderr).not.toContain('denylist.txt');
  });

  it('skips binary content', () => {
    write('blob.bin', `\0\0${LEAK_EMAIL}`);
    expect(scan('--tree').status).toBe(0);
  });
});

describe('pre-commit hook', () => {
  it('blocks a commit with findings and allows a clean one', () => {
    write('leak.md', `${LEAK_EMAIL}\n`);
    run('git', ['add', 'leak.md']);
    const blocked = run('git', [
      '-c',
      'core.hooksPath=.githooks',
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@users.noreply.github.com',
      'commit',
      '--quiet',
      '-m',
      'leak',
    ]);
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain('[email]');

    write('leak.md', 'clean\n');
    run('git', ['add', 'leak.md']);
    const allowed = run('git', [
      '-c',
      'core.hooksPath=.githooks',
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@users.noreply.github.com',
      'commit',
      '--quiet',
      '-m',
      'clean',
    ]);
    expect(allowed.status).toBe(0);
  });
});
