import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'packages',
          include: ['packages/*/test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'scripts',
          include: ['scripts/test/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'scripts/lib/**/*.mjs'],
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
