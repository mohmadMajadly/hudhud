// The schema entry points as the closer wires them into package.json
// (W1-Z): exit codes and messages. Read-only against the repository; the
// no-ajv check runs on temporary trees.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const scripts = fileURLToPath(new URL('../schema/', import.meta.url));

function node(script: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [path.join(scripts, script), ...args], {
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('schema entry points', () => {
  it('check.mjs passes on the committed tree', () => {
    const result = node('check.mjs');
    expect(result.stderr).toBe('');
    expect(result).toMatchObject({ status: 0, stdout: 'schema:check: up to date\n' });
  }, 120_000);

  it('diff.mjs passes on the committed baseline and refuses unknown arguments', () => {
    expect(node('diff.mjs')).toMatchObject({
      status: 0,
      stdout: expect.stringMatching(/additive only/) as unknown,
    });
    expect(node('diff.mjs', '--bogus')).toMatchObject({
      status: 2,
      stderr: expect.stringMatching(/usage/) as unknown,
    });
  });

  describe('no-ajv.mjs', () => {
    let root: string;

    beforeEach(() => {
      root = realpathSync(mkdtempSync(path.join(tmpdir(), 'hudhud-no-ajv-cli-')));
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    const put = (file: string, text: string) => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    };

    it('passes on clean output', () => {
      put('packages/a/dist/index.js', 'export const x = 1;\n');
      expect(node('no-ajv.mjs', '--root', root)).toEqual({
        status: 0,
        stdout: 'check:no-ajv: 1 built files, no Ajv import\n',
        stderr: '',
      });
    });

    it('fails on a planted import', () => {
      put('packages/a/dist/index.js', "import 'ajv';\n");
      const result = node('no-ajv.mjs', '--root', root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('packages/a/dist/index.js: imports ajv');
    });

    it('fails when nothing was built', () => {
      mkdirSync(path.join(root, 'packages', 'a'), { recursive: true });
      const result = node('no-ajv.mjs', '--root', root);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/no built output/);
    });

    it('refuses unknown arguments', () => {
      expect(node('no-ajv.mjs', '--bogus').status).toBe(2);
    });
  });
});
