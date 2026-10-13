// The recorder's single-source launch (W4-T2): the product's builders are
// injected; this side only turns a case into product input. The adapter's
// own test (packages/claude-code/test/record/launch.test.ts) checks the
// real builders.

import { describe, expect, it } from 'vitest';

import {
  caseOptions,
  productLaunchBuilder,
  type LaunchRequest,
  type ProductLaunchApi,
} from '../../../src/fixtures/record/launch.js';

const REQUEST: LaunchRequest = {
  launch: { start: { mode: 'create', sessionId: 's-1' } },
  configDir: '/sandbox/cfg',
  parentEnv: { HOME: '/sandbox/home' },
  platform: 'linux',
};

describe('caseOptions', () => {
  it('sets the sandbox config directory and keeps the case options', () => {
    expect(caseOptions(REQUEST)).toEqual({ claudeCode: { configDir: '/sandbox/cfg' } });
    expect(
      caseOptions({
        ...REQUEST,
        launch: {
          ...REQUEST.launch,
          options: { permissionMode: 'plan', claudeCode: { maxTurns: 1 } },
        },
      }),
    ).toEqual({ permissionMode: 'plan', claudeCode: { maxTurns: 1, configDir: '/sandbox/cfg' } });
    // A non-object claudeCode is replaced (the product would refuse it anyway).
    expect(
      caseOptions({ ...REQUEST, launch: { ...REQUEST.launch, options: { claudeCode: [] } } }),
    ).toEqual({ claudeCode: { configDir: '/sandbox/cfg' } });
    expect(
      caseOptions({ ...REQUEST, launch: { ...REQUEST.launch, options: { claudeCode: null } } }),
    ).toEqual({ claudeCode: { configDir: '/sandbox/cfg' } });
  });

  it('registers a handler that the recorder never calls', () => {
    const options = caseOptions({
      ...REQUEST,
      launch: { ...REQUEST.launch, permissionHandler: true },
    });
    const handler = options['onPermission'];
    expect(handler).toBeTypeOf('function');
    expect(() => (handler as () => unknown)()).toThrow(/answers permission requests on the wire/u);
    expect(caseOptions(REQUEST)).not.toHaveProperty('onPermission');
  });
});

describe('productLaunchBuilder', () => {
  it('calls the product builders in order with the case input and the sandbox parent', () => {
    const calls: unknown[][] = [];
    const api: ProductLaunchApi<'connect', 'session'> = {
      resolveConnectSessionOptions: (input) => {
        calls.push(['resolve', input]);
        return { connect: 'connect', session: 'session' };
      },
      buildArgv: (connect, session, start) => {
        calls.push(['argv', connect, session, start]);
        return ['--a'];
      },
      buildChildEnv: (session, connect, parent, platform) => {
        calls.push(['env', session, connect, parent, platform]);
        return { env: { B: '1' } };
      },
    };
    const build = productLaunchBuilder(api);
    expect(build(REQUEST)).toEqual({ argv: ['--a'], env: { B: '1' } });
    expect(calls).toEqual([
      ['resolve', { claudeCode: { configDir: '/sandbox/cfg' } }],
      ['argv', 'connect', 'session', REQUEST.launch.start],
      ['env', 'session', 'connect', REQUEST.parentEnv, 'posix'],
    ]);
    build({ ...REQUEST, platform: 'win32' });
    expect(calls.at(-1)?.at(-1)).toBe('win32');
  });
});
