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

import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

import type { Session } from '@hudhud/core';

import { nodeHost } from '../../../src/adapter.js';
import { connectWith, sessionWith, type ClaudeCodeHarness } from '../../../src/connect.js';
import type { ConnectOptions, SessionOptions } from '../../../src/options-types.js';
import {
  IntegrationSuite,
  registerIntegrationHooks,
  type ProductConnect,
  type ProductConnectRequest,
} from '../../../../../tooling/test-support/src/launcher/integration.js';

/** The repository root (the pin and the CLI cache). */
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');

/** `connect` options of a sandboxed test: the binary is always the pinned one. */
export type SandboxConnectOptions = Omit<ConnectOptions, 'binaryPath'>;

/** The product's `connect` in the sandbox: binary, config directory and host seams forced. */
export const connectInSandbox: ProductConnect<SandboxConnectOptions, ClaudeCodeHarness> = (
  options,
  request,
) =>
  connectWith(
    {
      ...options,
      binaryPath: request.binaryPath,
      claudeCode: { ...options?.claudeCode, configDir: request.configDir },
    },
    () => ({ ...nodeHost(), ...request.host }),
  );

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
  return sessionWith(
    {
      ...options,
      binaryPath: request.binaryPath,
      claudeCode: { ...options?.claudeCode, configDir: request.configDir },
    },
    () => ({ ...nodeHost(), ...request.host }),
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
}

/** Creates the suite of the calling test file and registers its Vitest hooks. */
export function integrationSuite(): ClaudeIntegrationSuite {
  const suite = new ClaudeIntegrationSuite({
    connect: connectInSandbox,
    warmUp,
    repoRoot: REPO_ROOT,
  });
  registerIntegrationHooks(suite, { beforeAll, afterAll, beforeEach, afterEach });
  return suite;
}
