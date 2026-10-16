// The composition root of the integration suites (plan §1.11, §4.4; W6-T0).
//
// Test-support may not depend on the adapter (plan §4.3 "Single-source
// launch"), so its harness takes the product's `connect` injected; the
// adapter's test tree is the one place that may import both. What is
// injected is the product itself: `connectWith` (the body of the public
// `connect`) over the product's real host (`nodeHost()`) with only the
// sandbox seams of test-support's `product-host.ts` replaced: the parent
// environment (the sandbox's explicit map, never `process.env`), the home
// and working directories, the version probe's directory, and a check of
// every launch before the core spawns it. `sessionWith` (the body of the
// public `session()`) runs over the same seams through the harness's
// `testLaunch` (W6-T1). Integration tests import from here, never the
// package entry (ESLint, plan §4.4).
//
// A Wave 6 suite:
//
//   const it = integrationSuite();
//   test('...', async () => {
//     const harness = await it.testConnect();          // disposed after the test
//     const session = await harness.sessions.create(); // cwd: the sandbox work dir
//     const result = await session.ask('[[mock:text]] hi');
//     await session.close();
//     expect((await it.mock()).requests).toHaveLength(1);
//   });
//
// After each test: every Harness disposed, zero egress violations, zero
// leaked processes, no refused launch; after the suite: no process naming
// the suite directory.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, onTestFinished } from 'vitest';

import type { BinaryInfo, Session } from '@hudhudjs/core';
import { hostJobAddonDeps, loadJobAddon, type JobAddonLoad } from '@hudhudjs/core/process';

import { nodeHost, type ClaudeHost } from '../../../src/adapter.js';
import { connectWith, sessionWith, type ClaudeCodeHarness } from '../../../src/connect.js';
import type { ConnectOptions, SessionOptions } from '../../../src/options-types.js';
import {
  IntegrationSuite,
  registerIntegrationHooks,
  type ProductConnect,
  type ProductConnectRequest,
} from '../../../../../tooling/test-support/src/launcher/integration.js';
import { stagedJobAddonDeps } from '../../../../../tooling/test-support/src/launcher/staged-addon.js';

/** The repository root (the pin and the CLI cache). */
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');

/**
 * Where a sandboxed connect gets the Windows job addon from (plan §6.4, K2;
 * lead rulings on A2). Every mode runs the real loader, and in every mode
 * the ABI `version` is compared with the committed digest table, so a stale
 * table fails every run:
 *
 * - `'staged'` (the default, the mode of the Windows suites): the loader with
 *   the x64 digest taken from the staged `SHA256SUMS`, which test-support's
 *   `readStagedAddon` first proves to name the staged bytes. On Windows x64
 *   the Harness reports `'job'` whatever supported toolchain built the
 *   staged addon (`pnpm addon:stage`); a missing or inconsistent staged
 *   addon fails the connect, never falls back.
 * - `'host'`: the exact product path, `loadHostJobAddon()` with the committed
 *   `WIN32_JOB_DIGESTS`. It reports `'job'` only when the staged addon is the
 *   build of record (`scripts/test/addon-record.test.ts`).
 * - `'unavailable'`: the loader with the addon package unresolvable, so it
 *   reports `package-missing` and the Harness falls back to `'best-effort'`,
 *   as for an application installed without the optional platform package.
 *
 * These are test seams of this composition root only; the product has no
 * switch. Off Windows every mode reports `not-windows`.
 */
export type JobAddonMode = 'staged' | 'host' | 'unavailable';

/** `connect` options of a sandboxed test: the binary is always the pinned one. */
export type SandboxConnectOptions = Omit<ConnectOptions, 'binaryPath'> & {
  /** Where the job addon comes from; default `'staged'`. Never passed to the product. */
  readonly jobAddon?: JobAddonMode;
};

/** The `'staged'` load of this process (a native module is opened once per process). */
let stagedLoad: JobAddonLoad | undefined;

/** The host seam of a {@link JobAddonMode}: nothing for `'host'`. */
export function jobAddonSeam(mode: JobAddonMode | undefined): Partial<ClaudeHost> {
  if (mode === 'host') return {};
  if (mode === 'unavailable') {
    return {
      loadJobAddon: () =>
        loadJobAddon({
          ...hostJobAddonDeps(),
          requireResolve: (specifier) => {
            throw Object.assign(new Error(`Cannot find module '${specifier}'`), {
              code: 'MODULE_NOT_FOUND',
            });
          },
        }),
    };
  }
  return {
    loadJobAddon: () => {
      stagedLoad ??= loadJobAddon(stagedJobAddonDeps(REPO_ROOT, hostJobAddonDeps()));
      return stagedLoad;
    },
  };
}

/** The product's `connect` in the sandbox: binary, config directory and host seams forced. */
export const connectInSandbox: ProductConnect<SandboxConnectOptions, ClaudeCodeHarness> = (
  options,
  request,
) => {
  const { jobAddon, ...product } = options ?? {};
  return connectWith(
    {
      ...product,
      binaryPath: request.binaryPath,
      claudeCode: { ...product.claudeCode, configDir: request.configDir },
    },
    () => ({ ...nodeHost(), ...jobAddonSeam(jobAddon), ...request.host }),
  );
};

/** `session()` options of a sandboxed test: the binary is always the pinned one. */
export type SandboxSessionFunctionOptions = SandboxConnectOptions & SessionOptions;

/**
 * The product's `session()` in the sandbox: binary, config directory and
 * host seams forced as in {@link connectInSandbox}; its Harness stays
 * private, as in the product.
 */
export function sessionInSandbox(
  options: SandboxSessionFunctionOptions | undefined,
  request: ProductConnectRequest,
): Promise<Session> {
  const { jobAddon, ...product } = options ?? {};
  return sessionWith(
    {
      ...product,
      binaryPath: request.binaryPath,
      claudeCode: { ...product.claudeCode, configDir: request.configDir },
    },
    () => ({ ...nodeHost(), ...jobAddonSeam(jobAddon), ...request.host }),
  );
}

/** The warm-up session of J11: one text turn answered by the mock, then a graceful close. */
export async function warmUp(harness: ClaudeCodeHarness): Promise<void> {
  const session = await harness.sessions.create();
  await session.ask('[[mock:text]] warm-up');
  await session.close();
}

/** An integration suite of the Claude Code adapter. */
export class ClaudeIntegrationSuite extends IntegrationSuite<
  SandboxConnectOptions,
  ClaudeCodeHarness
> {
  /** `testConnect` plus `sessions.create`; the Harness is disposed after the test. */
  async testSession(
    options: { readonly connect?: SandboxConnectOptions; readonly session?: SessionOptions } = {},
  ): Promise<Session> {
    const harness = await this.testConnect(options.connect);
    return harness.sessions.create(options.session);
  }

  /**
   * The product's `session()` (connect and create in one call, the Harness
   * private) in the test's sandbox; the session is disposed after the test.
   */
  async testSessionFunction(options?: SandboxSessionFunctionOptions): Promise<Session> {
    return this.testLaunch((request) => sessionInSandbox(options, request));
  }

  /**
   * Whether the CLI under test is the pinned one (tooling/cli-pin.json).
   * The canary (K16, plan §5.9 W7-T2) runs these suites against a newer
   * published CLI (`HUDHUD_CLI_CHANNEL=newest`).
   */
  get pinnedCli(): boolean {
    return this.cli.version === PINNED_VERSION;
  }

  /**
   * The `compat` status connect must report for the CLI under test: the
   * tested window is the pin (the bump moves both, K16), so a canary's newer
   * CLI is `'untested'` (reported, never refused; ADR-0004 §4).
   */
  get expectedCompatStatus(): 'tested' | 'untested' {
    return this.pinnedCli ? 'tested' : 'untested';
  }

  /**
   * The advisory verification connect must report for the CLI under test:
   * the committed digest table holds the pinned binary, so a canary's newer
   * binary matches no known digest (K8, K9; `unverified`, not refused).
   */
  get expectedVerification(): BinaryInfo['verification'] {
    return this.pinnedCli
      ? {
          status: 'verified',
          method: 'sha256-manifest',
          mode: 'advisory',
          detail: `sha256 matches ${this.cli.version}`,
        }
      : {
          status: 'unverified',
          method: 'sha256-manifest',
          mode: 'advisory',
          detail: 'no known digest matches',
        };
  }
}

/** The pinned version (tooling/cli-pin.json). */
const PINNED_VERSION: string = (
  JSON.parse(readFileSync(path.join(REPO_ROOT, 'tooling', 'cli-pin.json'), 'utf8')) as {
    readonly version: string;
  }
).version;

/** Creates the suite of the calling test file and registers its Vitest hooks. */
export function integrationSuite(): ClaudeIntegrationSuite {
  const suite = new ClaudeIntegrationSuite({
    connect: connectInSandbox,
    warmUp,
    repoRoot: REPO_ROOT,
  });
  registerIntegrationHooks(suite, { beforeAll, afterAll, beforeEach, onTestFinished });
  return suite;
}
