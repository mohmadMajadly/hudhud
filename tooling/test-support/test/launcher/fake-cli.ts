/**
 * A stand-in for the pinned CLI in the launcher, leak and recorder tests: a
 * copy of the running Node.js binary installed into a temporary cache under
 * a pin that names its own digests, so it passes `verifyPinnedCli` exactly
 * like the real binary. The launcher runs it with a script path as the
 * first argument; the enforced flags follow and reach the script as
 * arguments. The script speaks a tiny subset of stream-json.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { cachePaths, createStaging, installBinary } from '../../src/cli/cache.js';
import { binaryFileName, platformPackage } from '../../src/cli/pin.js';
import type { AncestorPolicy } from '../../src/launcher/sandbox.js';
import { fsProbe } from '../../src/launcher/sandbox.js';
import { hostPlatformKey, resolvePinnedCli } from '../../src/launcher/pinned-cli.js';
import type { VerifiedCli } from '../../src/launcher/pinned-cli.js';

export const FAKE_VERSION = '2.1.296';

/** The fake CLI's script. Modes via `FAKE_CLI_MODE`. */
export const FAKE_CLI_SCRIPT = String.raw`'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const mode = process.env.FAKE_CLI_MODE || 'normal';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const session = 'd6e7fffb-1111-4222-8333-444455556666';
const cfg = process.env.CLAUDE_CONFIG_DIR || '';
process.stderr.write('fake cli starting in ' + process.cwd() + '\n');
if (mode === 'dump') out({ type: 'dump', argv: process.argv.slice(2), env: process.env, cwd: process.cwd() });
if (mode === 'hang') setInterval(() => {}, 1000);
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let f;
  try { f = JSON.parse(line); } catch { process.stdout.write('plain text: ' + line + '\n'); return; }
  if (f.type === 'control_request' && f.request && f.request.subtype === 'initialize') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: f.request_id, pending_permission_requests: [],
      response: { pid: process.pid, claude_code_version: '${FAKE_VERSION}', user_output_styles_dir: path.join(cfg, 'output-styles'),
        account: { apiKeySource: 'ANTHROPIC_API_KEY', key: process.env.ANTHROPIC_API_KEY } } } });
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    return;
  }
  if (f.type === 'user') {
    if (mode === 'no-result') return;
    if (mode !== 'no-config') fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ firstStartTime: new Date().toISOString() }));
    const slug = process.cwd().replace(/[^A-Za-z0-9]/g, '-');
    out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: session, claude_code_version: '${FAKE_VERSION}',
      memory_paths: { auto: path.join(cfg, 'projects', slug, 'memory') }, sessions_file: path.join(cfg, 'sessions', process.pid + '.json') });
    out({ type: 'assistant', session_id: session, message: { content: [{ type: 'text', text: 'Hello from mock.' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 123, total_cost_usd: 0.01, session_id: session, result: 'Hello from mock.' });
    if (mode === 'exit-1') process.exit(1);
  }
});
rl.on('close', () => { if (mode !== 'hang') process.exit(0); });
`;

export interface FakeCli {
  readonly root: string;
  readonly cacheRoot: string;
  readonly pinFile: string;
  readonly platformKey: string;
  readonly script: string;
  readonly cli: VerifiedCli;
  dispose(): Promise<void>;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Installs the fake CLI into a fresh temporary cache and verifies it like the real one. */
export async function makeFakeCli(): Promise<FakeCli> {
  const root = await mkdtemp(path.join(tmpdir(), 'hudhud-fakecli-'));
  const cacheRoot = path.join(root, 'cache');
  const platformKey = hostPlatformKey(process.env);
  const file = binaryFileName(platformKey);
  const staging = await createStaging(cacheRoot);
  const staged = path.join(staging, file);
  await copyFile(process.execPath, staged);
  const { size } = await stat(staged);
  const digest = await sha256(staged);
  const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
  const identity = {
    package: platformPackage(platformKey),
    version: FAKE_VERSION,
    platform: platformKey,
    file,
    integrity,
    sha256: digest,
    size,
  };
  await installBinary(
    staged,
    cachePaths(cacheRoot, FAKE_VERSION, platformKey, file),
    identity,
    process.platform,
  );
  await rm(staging, { recursive: true, force: true, maxRetries: 10 });
  const pinFile = path.join(root, 'cli-pin.json');
  await writeFile(
    pinFile,
    JSON.stringify({
      version: FAKE_VERSION,
      platforms: {
        [platformKey]: { package: identity.package, file, integrity, sha256: digest, size },
      },
    }),
  );
  const script = path.join(root, 'fake-cli.cjs');
  await writeFile(script, FAKE_CLI_SCRIPT);
  const cli = await resolvePinnedCli({ repoRoot: root, env: {}, cacheRoot, pinFile, platformKey });
  return {
    root,
    cacheRoot,
    pinFile,
    platformKey,
    script,
    cli,
    dispose: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

/**
 * The launcher tests' ancestor policy: the real file system, but only
 * entries inside `root` count and no home is listed. Lets the launch
 * mechanics run on a host whose temp directory lies under the home (every
 * Windows default); the strict default policy has its own tests.
 */
export function scopedPolicy(root: string): AncestorPolicy {
  const prefix = path.resolve(root) + path.sep;
  return {
    homes: [],
    probe: {
      exists: (file) => path.resolve(file).startsWith(prefix) && fsProbe.exists(file),
      realpath: (dir) => fsProbe.realpath(dir),
    },
  };
}
