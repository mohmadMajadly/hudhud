import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  describeRecord,
  formatJsonl,
  HANDSHAKE_SHAPE,
  missingShape,
  recordHandshake,
  writeFixture,
} from '../../src/fixtures/recorder.js';
import { FAKE_API_KEY } from '../../src/launcher/env.js';
import { createSandbox } from '../../src/launcher/sandbox.js';
import type { LaunchOptions, Sandbox } from '../../src/launcher/sandbox.js';
import { makeFakeCli, scopedPolicy } from '../launcher/fake-cli.js';
import type { FakeCli } from '../launcher/fake-cli.js';

let fake: FakeCli;
let root = '';

beforeAll(async () => {
  fake = await makeFakeCli();
}, 120_000);

afterAll(async () => {
  await fake.dispose();
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hudhud-recorder-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A sandbox of the fake CLI whose launches get the script as first argument. */
async function fakeSandbox(mode: string): Promise<Sandbox> {
  const sandbox = await createSandbox({
    cli: fake.cli,
    mock: { url: 'http://127.0.0.1:47311' },
    testRoot: root,
    ancestorPolicy: scopedPolicy(root),
    env: { FAKE_CLI_MODE: mode },
  });
  const launch = sandbox.launch.bind(sandbox);
  return {
    ...sandbox,
    launch: (options: LaunchOptions = {}) =>
      launch({ ...options, args: [fake.script, ...(options.args ?? [])] }),
  };
}

describe('recordHandshake', () => {
  it('records the 05 §5 handshake shape, normalized and redacted', async () => {
    const sandbox = await fakeSandbox('normal');
    const { lines, exit, session } = await recordHandshake(sandbox, {
      frameMs: 30_000,
      exitMs: 30_000,
    });
    expect(exit.code).toBe(0);
    expect(missingShape(lines, HANDSHAKE_SHAPE)).toEqual([]);
    const text = formatJsonl(lines);
    expect(text).not.toContain(FAKE_API_KEY);
    expect(text).not.toContain(sandbox.dirs.root);
    expect(text).not.toContain(sandbox.dirs.root.replaceAll('\\', '/'));
    expect(text).not.toContain(`"pid":${String(session.process.pid)},`);
    expect(text).not.toContain(`${String(session.process.pid)}.json`);
    expect(text).toContain('"pid":1001');
    expect(text).toContain('<work>');
    expect(text).toContain('<cfg>');
    expect(text).toContain('<proj>');
    expect(text).toContain('<uuid-1>');
    expect(text).toContain('"claude_code_version":"<version>"');
    expect(text).toContain('"duration_ms":0');
    expect(text).toContain('"key":"<redacted>"');
    for (const line of text.trimEnd().split('\n')) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(['dir', 't', 'v']);
      expect(Number.isInteger(parsed['t'])).toBe(true);
    }
    const file = path.join(root, 'out', 'handshake', 'win32.jsonl');
    await writeFixture(file, lines);
    expect(await readFile(file, 'utf8')).toBe(text);
    await sandbox.dispose();
  }, 60_000);

  it('uses default timeouts', async () => {
    const sandbox = await fakeSandbox('normal');
    const { exit } = await recordHandshake(sandbox);
    expect(exit.code).toBe(0);
  }, 120_000);

  it('stops the CLI and rethrows when a frame never comes', async () => {
    const sandbox = await fakeSandbox('no-result');
    await expect(recordHandshake(sandbox, { frameMs: 300, exitMs: 30_000 })).rejects.toThrow(
      /timeout/,
    );
  }, 60_000);
});

describe('shape helpers', () => {
  it('labels records', () => {
    expect(describeRecord({ dir: 'exit', v: { code: 1, signal: null } })).toBe('exit 1');
    expect(describeRecord({ dir: 'exit', v: { code: null, signal: 'SIGKILL' } })).toBe('exit null');
    expect(describeRecord({ dir: 'out', v: 'plain' })).toBe('out text');
    expect(describeRecord({ dir: 'cmd', v: { stdin: 'eof' } })).toBe('cmd json');
    expect(describeRecord({ dir: 'out', v: { type: 'assistant' } })).toBe('out assistant');
    expect(
      describeRecord({
        dir: 'in',
        v: { type: 'control_request', request_id: 'r1', request: { subtype: 'interrupt' } },
      }),
    ).toBe('in control_request/interrupt r1');
    expect(
      describeRecord({
        dir: 'out',
        v: { type: 'control_response', response: { subtype: 'error', request_id: 'r2' } },
      }),
    ).toBe('out control_response/error r2');
    expect(describeRecord({ dir: 'out', v: { type: 'x', subtype: 3, request_id: 4 } })).toBe(
      'out x',
    );
  });

  it('reports what is missing from an ordered shape', () => {
    const lines = [
      { dir: 'out', v: { type: 'system', subtype: 'init' } },
      { dir: 'exit', v: { code: 0 } },
    ];
    expect(missingShape(lines, ['out system/init', 'exit 0'])).toEqual([]);
    expect(missingShape(lines, ['exit 0', 'out system/init'])).toEqual(['out system/init']);
  });
});
