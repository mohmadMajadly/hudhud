// Source-tree guard (plan §5.4 W2-T6, ADR-0011 §"Spawn"): no shell anywhere
// in the published sources. Every `shell` option is literally `false`, no
// shell-based child_process API is used, and every file that starts a
// process says `shell: false` explicitly.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const PACKAGES = path.join(ROOT, 'packages');

const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = path.join(PACKAGES, entry.name, 'src');
    let names: string[];
    try {
      names = readdirSync(src, { recursive: true, encoding: 'utf8' });
    } catch {
      continue;
    }
    for (const name of names) if (SOURCE.test(name)) files.push(path.join(src, name));
  }
  return files.sort();
}

/** Comments removed, so documentation may quote `shell: true` as a counterexample. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** Calls that start a process. */
const STARTS_PROCESS = /\b(?:spawn|spawnSync|execFile|execFileSync|fork)\s*\(/;

/** A `shell` option or property and its value (up to `,`, `;`, `}` or whitespace). */
const SHELL_OPTION = /\bshell\s*:\s*([^,;}\s]+)/g;

/** child_process APIs that always run a shell. */
const SHELL_API = /\b(?:exec|execSync)\s*\(|\bexec(?:Sync)?\b\s*[,}]/;

describe('no shell in packages/*/src', () => {
  const files = sourceFiles();

  it('finds the sources (the guard is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((file) => file.endsWith(path.join('process', 'spawn.ts')))).toBe(true);
  });

  it('has no shell option other than `shell: false`', () => {
    const offenders = files.flatMap((file) =>
      [...code(readFileSync(file, 'utf8')).matchAll(SHELL_OPTION)]
        .filter((match) => match[1] !== 'false')
        .map((match) => `${path.relative(ROOT, file)}: ${match[0]}`),
    );
    expect(offenders).toEqual([]);
  });

  it('uses no shell-based child_process API (exec, execSync)', () => {
    const offenders = files.filter((file) => {
      const text = code(readFileSync(file, 'utf8'));
      return text.includes('child_process') && SHELL_API.test(text);
    });
    expect(offenders.map((file) => path.relative(ROOT, file))).toEqual([]);
  });

  it('says `shell: false` in every file that starts a process', () => {
    const offenders = files.filter((file) => {
      const text = code(readFileSync(file, 'utf8'));
      return (
        text.includes('child_process') &&
        STARTS_PROCESS.test(text) &&
        !/\bshell\s*:\s*false\b/.test(text)
      );
    });
    expect(offenders.map((file) => path.relative(ROOT, file))).toEqual([]);
  });

  it('the detectors catch the forms they guard against', () => {
    const shellTrue = code('spawn(file, args, { shell: true }); // { shell: false }');
    expect([...shellTrue.matchAll(SHELL_OPTION)].map((match) => match[1])).toEqual(['true']);
    // A property type (`readonly shell: false;`) is the literal `false`, not `false;`.
    expect(
      [...code('interface O { readonly shell: false; x: 1 }').matchAll(SHELL_OPTION)].map(
        (match) => match[1],
      ),
    ).toEqual(['false']);
    expect([...code('let o: { shell: true; }').matchAll(SHELL_OPTION)].map((m) => m[1])).toEqual([
      'true',
    ]);
    expect(code("x({ shell: 'cmd.exe' })")).toMatch(/shell\s*:\s*'cmd\.exe'/);
    expect(SHELL_API.test("import { exec } from 'node:child_process';")).toBe(true);
    expect(SHELL_API.test('execSync("ls")')).toBe(true);
    expect(SHELL_API.test('execFile(file, args)')).toBe(false);
    expect(STARTS_PROCESS.test('spawn (file, [])')).toBe(true);
    expect(code('/* shell: true */ a // shell: true')).not.toContain('shell');
  });
});
