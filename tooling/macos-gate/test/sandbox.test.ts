import { describe, expect, it } from 'vitest';

import { findScenario } from '../../test-support/src/mock/scenario.js';
import {
  bashMarker,
  createSandbox,
  FAKE_API_KEY,
  mockMarker,
  SESSION_ARGS,
  sandboxEnv,
} from '../src/sandbox.js';
import { SimHost } from './sim.js';

describe('sandbox', () => {
  it('creates a fresh run root with its four directories', async () => {
    const sim = new SimHost();
    const sandbox = await createSandbox(sim.fs, '/base');
    expect(sandbox).toEqual({
      root: '/base/hhg-AAAAA1',
      home: '/base/hhg-AAAAA1/home',
      config: '/base/hhg-AAAAA1/cfg',
      tmp: '/base/hhg-AAAAA1/tmp',
      work: '/base/hhg-AAAAA1/work',
    });
    expect(await sim.fs.kind(sandbox.work)).toBe('directory');
    expect((await createSandbox(sim.fs, '/base', 'long')).tmp).toBe('/base/hhg-AAAAA2/long');
  });

  it('builds an explicit environment: fake key, isolated dirs, egress trap (05 §13.2)', async () => {
    const sim = new SimHost();
    const sandbox = await createSandbox(sim.fs, '/base');
    const env = sandboxEnv({ sandbox, mockUrl: 'http://127.0.0.1:1', user: 'runner' });
    expect(env).toMatchObject({
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: sandbox.home,
      SHELL: '/bin/zsh',
      TMPDIR: sandbox.tmp,
      CLAUDE_CODE_TMPDIR: sandbox.tmp,
      CLAUDE_CONFIG_DIR: sandbox.config,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
      ANTHROPIC_API_KEY: FAKE_API_KEY,
      HTTPS_PROXY: 'http://127.0.0.1:1',
      http_proxy: 'http://127.0.0.1:1',
      NO_PROXY: '127.0.0.1',
    });
    expect(FAKE_API_KEY).not.toMatch(/^sk-ant-/);
    expect(Object.keys(env)).not.toContain('XDG_RUNTIME_DIR');
    expect(sandboxEnv({ sandbox, mockUrl: 'u', user: 'r', apiKey: false })).not.toHaveProperty(
      'ANTHROPIC_API_KEY',
    );
    expect(SESSION_ARGS).toContain('--setting-sources=');
    expect(SESSION_ARGS).toContain('--permission-mode=default');
  });

  it('writes markers the test-support scenario provider understands', () => {
    const scenario = (text: string): ReturnType<typeof findScenario> =>
      findScenario([{ role: 'user', content: text }]);
    expect(scenario(`${mockMarker('slow', { chunks: '4', ms: '9' })} go`)).toMatchObject({
      name: 'slow',
      args: new Map([
        ['chunks', '4'],
        ['ms', '9'],
      ]),
    });
    const bash = scenario(`${bashMarker('sleep 45')} go`);
    expect(bash?.name).toBe('bash');
    expect(Buffer.from(bash?.args.get('cmd') ?? '', 'base64').toString('utf8')).toBe('sleep 45');
    expect(mockMarker('text')).toBe('[[mock:text]]');
  });
});
