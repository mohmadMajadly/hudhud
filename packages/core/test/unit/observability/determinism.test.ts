import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('../../../src/observability/', import.meta.url));

// The observability primitives are pure functions of their input: no clock,
// timers, randomness, host globals or I/O, so outputs are reproducible
// (ADR-0006 style determinism without a clock to inject).
const AMBIENT =
  /\b(Date|Math\.random|performance|setTimeout|setInterval|setImmediate|queueMicrotask|process|globalThis|crypto|require)\b|from 'node:|import\(/;

describe('observability sources', () => {
  const files = readdirSync(dir).filter((file) => file.endsWith('.ts'));

  it('exist', () => {
    expect(files.sort()).toEqual(['redact.ts', 'stderr-tail.ts', 'utf8.ts']);
  });

  it.each(files)('%s uses no ambient time, randomness or I/O', (file) => {
    const code = readFileSync(`${dir}${file}`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(AMBIENT);
  });
});
