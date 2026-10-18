// The unit-test guard (R8-4): installed by the unit project's setup file, it
// refuses to start Claude Code and hides the user's configuration directory.

import { exec, execSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import {
  assertNoRefusals,
  installUnitGuard,
  shellOption,
  startsClaude,
  takeRefusals,
  UNIT_GUARD_CONFIG_DIR,
  UnitGuardError,
} from '../src/unit-guard.js';

describe('startsClaude', () => {
  it.each([
    ['claude', false, true],
    ['CLAUDE.EXE', false, true],
    ['D:\\tools\\bin\\claude.exe', false, true],
    ['/opt/tools/bin/claude', false, true],
    ['"C:\\Program Files\\x\\claude.cmd"', false, true],
    ['claude --version', true, true],
    ['claude --version', false, false],
    ['claude-code', false, false],
    // A test's own stand-in, built under the temp directory.
    [path.join(tmpdir(), 'hudhud-fake', 'claude.exe'), false, false],
    [path.join(tmpdir(), 'hudhud-fake', 'claude'), true, false],
    ['/usr/bin/node', false, false],
    ['node -e 0', true, false],
    ['', true, false],
    [42, false, false],
  ])('%j (shell %s): %s', (command, shell, expected) => {
    expect(startsClaude(command, shell)).toBe(expected);
  });
});

describe('shellOption', () => {
  it('finds `shell` in an options object only', () => {
    expect(shellOption([['--version'], { shell: true }])).toBe(true);
    expect(shellOption([{ shell: 'cmd.exe' }])).toBe(true);
    expect(shellOption([{ shell: false }, null, 'x'])).toBe(false);
    expect(shellOption([])).toBe(false);
  });
});

describe('the installed guard', () => {
  it('refuses every launcher before anything starts, through the ESM bindings too', () => {
    expect(() => spawn('claude', ['--version'])).toThrow(UnitGuardError);
    expect(() => spawnSync('C:\\bin\\claude.exe')).toThrow(UnitGuardError);
    expect(() => spawnSync('claude --version', { shell: true })).toThrow(UnitGuardError);
    expect(() => exec('claude --version')).toThrow(/never run Claude Code/u);
    expect(() => execSync('claude')).toThrow(UnitGuardError);
    // Each refusal is recorded, so a refusal the code under test caught
    // still fails the test (the setup file's afterEach).
    expect(takeRefusals()).toHaveLength(5);
    expect(() => spawn('claude')).toThrow(UnitGuardError);
    expect(() => {
      assertNoRefusals();
    }).toThrow(/spawn\("claude"\) was refused/u);
    expect(takeRefusals()).toEqual([]);
  });

  it('lets other commands run', () => {
    const result = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], {
      encoding: 'utf8',
    });
    expect(result.stdout).toBe('ok');
  });

  it('points CLAUDE_CONFIG_DIR at a directory that does not exist; installing again changes nothing', () => {
    expect(process.env['CLAUDE_CONFIG_DIR']).toBe(UNIT_GUARD_CONFIG_DIR);
    const env: NodeJS.ProcessEnv = {};
    installUnitGuard(env);
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: UNIT_GUARD_CONFIG_DIR });
    expect(() => spawn('claude')).toThrow(UnitGuardError);
    expect(takeRefusals()).toHaveLength(1);
    assertNoRefusals();
  });
});
