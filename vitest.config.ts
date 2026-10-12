import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { configDefaults, defineConfig } from 'vitest/config';

/** Directories that hold test files, per Vitest project (plan §4.1). */
const PROJECTS = {
  unit: ['packages/*/test', 'tooling/*/test'],
  conformance: ['packages/*/test/conformance'],
  integration: ['packages/*/test/integration'],
  scripts: ['scripts/test'],
} as const;

type ProjectName = keyof typeof PROJECTS;

const ROOT = import.meta.dirname;

/** Expands a single leading `<dir>/*` segment; the layouts above need no more. */
function expand(pattern: string): string[] {
  const [parent = '', star, ...rest] = pattern.split('/');
  if (star !== '*') return [pattern];
  const base = path.join(ROOT, parent);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [parent, entry.name, ...rest].join('/'));
}

function hasTests(name: ProjectName): boolean {
  return PROJECTS[name].some((pattern) =>
    expand(pattern).some((dir) => {
      const abs = path.join(ROOT, dir);
      return (
        existsSync(abs) &&
        readdirSync(abs, { recursive: true, encoding: 'utf8' }).some((file) =>
          file.endsWith('.test.ts'),
        )
      );
    }),
  );
}

/** Projects named with `--project` on the command line; all when none is named. */
function selectedProjects(): string[] {
  const names: string[] = [];
  const argv = process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--project') names.push(argv[i + 1] ?? '');
    else if (arg.startsWith('--project=')) names.push(arg.slice('--project='.length));
  }
  return names.length > 0 ? names : Object.keys(PROJECTS);
}

// `passWithNoTests` is a run-wide Vitest option. It is enabled only when every
// selected project is still empty (conformance and integration until their
// tests land), so a project that has tests, or an unknown project name, can
// never pass with zero tests run.
const passWithNoTests = selectedProjects().every(
  (name) => name in PROJECTS && !hasTests(name as ProjectName),
);

// Thin OS syscall adapters are covered on their own OS only (plan §4.8). The
// compensating control is vitest.os.config.ts: each OS job runs it with
// `include` set to its own adapters and a 100 % threshold.
const OFF_PLATFORM_OS_ADAPTERS = [
  ...(process.platform === 'win32' ? [] : ['packages/core/src/process/os/win32.ts']),
  ...(process.platform === 'win32' ? ['packages/core/src/process/os/posix.ts'] : []),
  ...(process.platform === 'darwin' ? [] : ['packages/core/src/process/os/darwin.ts']),
];

export default defineConfig({
  test: {
    passWithNoTests,
    projects: [
      {
        test: {
          name: 'unit',
          include: PROJECTS.unit.map((dir) => `${dir}/**/*.test.ts`),
          exclude: [
            ...configDefaults.exclude,
            ...PROJECTS.conformance.map((dir) => `${dir}/**`),
            ...PROJECTS.integration.map((dir) => `${dir}/**`),
          ],
        },
      },
      {
        test: {
          name: 'conformance',
          include: PROJECTS.conformance.map((dir) => `${dir}/**/*.test.ts`),
        },
      },
      {
        test: {
          name: 'integration',
          include: PROJECTS.integration.map((dir) => `${dir}/**/*.test.ts`),
        },
      },
      {
        test: {
          name: 'scripts',
          include: PROJECTS.scripts.map((dir) => `${dir}/**/*.test.ts`),
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: [
        'packages/*/src/**/*.ts',
        // Test infrastructure is held to the same bar: it carries the egress
        // trap, the mock API and the pinned-CLI tar reader (security-relevant).
        // Files without statements (the current skeleton) count as empty and
        // are skipped; every statement that lands is measured.
        'tooling/*/src/**/*.ts',
        'scripts/lib/**/*.mjs',
      ],
      exclude: [
        // Generated Ajv standalone validators (plan §4.8). Compensating
        // controls: `schema:check` regenerates them byte for byte, the wire and
        // option tests exercise them, and the tarball check imports them.
        'packages/*/src/**/generated/**',
        ...OFF_PLATFORM_OS_ADAPTERS,
        // native/win32-job/** (C) is outside `include`: not JavaScript; covered
        // by the native tests (plan §6.5) and /W4 /WX, /analyze.
      ],
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
      // Ratchet from the top: the foundation starts at 100 % and any lowering
      // needs an explicit, reviewed change of this file.
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
