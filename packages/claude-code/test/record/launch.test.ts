// The fixture recorder launches every case exactly as the product would
// (lead ruling, W4-T2): the recorder's builder (product-launch.mjs, over the
// built adapter) gives the same argv and environment as the adapter's
// sources for the same options, on every suite case and platform; the
// result keeps every isolation variable of the sandbox; and the only
// differences from the sandbox environment are what hudhud pins and what
// the case adds through hudhud's own `env` option.

import { describe, expect, it } from 'vitest';

import { productLaunchBuilder } from '../../../../tooling/test-support/src/fixtures/record/launch.js';
import type { LaunchRequest } from '../../../../tooling/test-support/src/fixtures/record/launch.js';
import { launchEnvDiff } from '../../../../tooling/test-support/src/fixtures/record/record.js';
import { SUITES } from '../../../../tooling/test-support/src/fixtures/record/suites.js';
import type { SuiteContext } from '../../../../tooling/test-support/src/fixtures/record/suites.js';
import {
  exactLaunch,
  UNREAD_ENV_NAMES,
} from '../../../../tooling/test-support/src/launcher/sandbox.js';
import { buildArgv } from '../../src/argv.js';
import { buildChildEnv, PINNED_ENV_NAMES } from '../../src/env.js';
import { resolveConnectSessionOptions } from '../../src/options.js';
import * as builtArgv from '../../dist/argv.js';
import * as builtEnv from '../../dist/env.js';
import * as builtOptions from '../../dist/options.js';
import { PRODUCT_LAUNCH_API, productLaunch } from './product-launch.mjs';
import { sandboxDirs, sandboxParent } from './sandbox-parent.js';

const fromSources = productLaunchBuilder({
  resolveConnectSessionOptions,
  buildArgv,
  buildChildEnv,
});

const PLATFORMS = ['linux', 'win32'] as const;

/** Every case of every suite, with its request on each platform. */
function requests(): { readonly label: string; readonly request: LaunchRequest }[] {
  return SUITES.flatMap((suite) => {
    const context: SuiteContext = new Map();
    return suite.cases.flatMap((spec) => {
      const launch = spec.launch(context);
      return PLATFORMS.map((platform) => ({
        label: `${suite.name}/${platform}${spec.name === '' ? '' : `.${spec.name}`}`,
        request: {
          launch,
          configDir: sandboxDirs(platform).cfg,
          parentEnv: sandboxParent(platform, suite.credential),
          platform,
        },
      }));
    });
  });
}

/** The names a case adds through hudhud's `env` option. */
function addedNames(request: LaunchRequest): string[] {
  const env = request.launch.options?.['env'];
  if (typeof env !== 'object' || env === null || Array.isArray(env)) return [];
  const add = (env as { readonly add?: Readonly<Record<string, string>> }).add;
  return Object.keys(add ?? {});
}

describe('the recorder launch is the product launch', () => {
  it('is wired to the built adapter builders, nothing else', () => {
    expect(PRODUCT_LAUNCH_API).toEqual({
      resolveConnectSessionOptions: builtOptions.resolveConnectSessionOptions,
      buildArgv: builtArgv.buildArgv,
      buildChildEnv: builtEnv.buildChildEnv,
    });
  });

  it("gives the sources' argv and environment for every suite case on every platform", () => {
    const all = requests();
    expect(all.length).toBeGreaterThanOrEqual(2 * 33);
    for (const { label, request } of all) {
      expect(productLaunch(request), label).toEqual(fromSources(request));
    }
  });

  it('starts every case as hudhud does, with the pinned flags and variables', () => {
    for (const { label, request } of requests()) {
      const { argv, env } = fromSources(request);
      const { start } = request.launch;
      expect(argv.slice(0, 5), label).toEqual([
        '--output-format=stream-json',
        '--input-format=stream-json',
        '--verbose',
        '--setting-sources=user',
        '--permission-mode=default',
      ]);
      const ids =
        start.mode === 'create'
          ? [`--session-id=${start.sessionId}`]
          : start.mode === 'resume'
            ? [`--resume=${start.resumeId}`]
            : [`--resume=${start.resumeId}`, '--fork-session', `--session-id=${start.sessionId}`];
      expect(argv.slice(5, 5 + ids.length), label).toEqual(ids);
      expect(argv.includes('--permission-prompt-tool=stdio'), label).toBe(
        request.launch.permissionHandler === true,
      );
      expect(env['CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS'], label).toBe('1');
      expect(env['CLAUDE_CONFIG_DIR'], label).toBe(request.configDir);
    }
  });

  it('keeps the sandbox: only pinned and case-added variables differ, and isolation holds', () => {
    for (const { label, request } of requests()) {
      const { env } = fromSources(request);
      const fold = (name: string): string =>
        request.platform === 'win32' ? name.toUpperCase() : name;
      const allowed = new Set([...PINNED_ENV_NAMES, ...addedNames(request)].map(fold));
      for (const [name, value] of Object.entries(launchEnvDiff(env, request.parentEnv))) {
        // A sandbox variable is dropped only as the second spelling of one
        // Windows variable (HTTPS_PROXY and https_proxy).
        // A sandbox variable is left out only as the second spelling of one
        // Windows variable (HTTPS_PROXY and https_proxy), or because the
        // platform never reads it (the sandbox's UNREAD_ENV_NAMES).
        const unread = UNREAD_ENV_NAMES[request.platform === 'win32' ? 'win32' : 'posix'];
        const kept =
          value === null &&
          (unread.includes(name.toUpperCase()) ||
            (request.platform === 'win32' &&
              Object.keys(env).some((other) => fold(other) === fold(name))));
        expect(allowed.has(fold(name)) || kept, `${label}: ${name}`).toBe(true);
      }
      expect(
        () => exactLaunch({ exact: { argv: [], env } }, request.parentEnv, request.platform),
        label,
      ).not.toThrow();
    }
  });
});
