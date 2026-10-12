// OS-scoped coverage of the thin syscall adapters (plan §4.8). The main
// config excludes the adapters of other operating systems; each OS job runs
// this config so its own adapters are held to 100 % by themselves.
//
//   vitest run --coverage --config vitest.os.config.ts

import process from 'node:process';

import { defineConfig } from 'vitest/config';

const OS_DIR = 'packages/core/src/process/os';

/** The adapters that run on this platform. */
const OWN_ADAPTERS =
  process.platform === 'win32'
    ? [`${OS_DIR}/win32.ts`]
    : process.platform === 'darwin'
      ? [`${OS_DIR}/posix.ts`, `${OS_DIR}/darwin.ts`]
      : [`${OS_DIR}/posix.ts`];

export default defineConfig({
  test: {
    name: 'os',
    include: ['packages/core/test/**/*.test.ts'],
    exclude: ['packages/*/test/integration/**', 'packages/*/test/conformance/**'],
    coverage: {
      provider: 'v8',
      include: OWN_ADAPTERS,
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage/os',
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
