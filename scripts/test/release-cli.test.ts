// The entry point of the release steps (scripts/release.mjs): the usage
// contract and the refusals that come before any registry or GitHub request
// or any change to the working copy. The publish itself is exercised by the
// release workflow's dry run (`npm publish --dry-run`), the version PR's
// simulation by the same run.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = path.join(fileURLToPath(new URL('..', import.meta.url)), 'release.mjs');

/** The environment of a run outside GitHub Actions, without any npm token. */
function bareEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(?:GITHUB_|ACTIONS_|RUNNER_|NODE_AUTH_TOKEN|NPM_TOKEN|npm_config_)/iu.test(key)) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}

function run(args: string[], env: NodeJS.ProcessEnv = bareEnv()) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
}

describe('release.mjs', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'hudhud-release-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 2 with the usage on an unknown command or flag', () => {
    for (const args of [[], ['deploy'], ['publish', '--tag'], ['gate', '--tag', 'v0.1.0', '--x']]) {
      const result = run(args);
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.stderr).toContain('usage: node scripts/release.mjs publish --tarballs <dir>');
      expect(result.stdout).toBe('');
    }
  });

  it('refuses a real publish anywhere but on its tag in Actions with an OIDC token', () => {
    const outside = run(['publish', '--tarballs', dir, '--tag', 'v0.1.0']);
    expect(outside.status).toBe(2);
    expect(outside.stderr).toContain(
      'a real publish runs only in the release workflow on the tag v0.1.0',
    );
    const actions = {
      GITHUB_ACTIONS: 'true',
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: 'v0.1.0',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.invalid/',
    };
    const otherTag = run(
      ['publish', '--tarballs', dir, '--tag', 'v0.1.0'],
      bareEnv({ ...actions, GITHUB_REF_NAME: 'v0.2.0' }),
    );
    expect(otherTag.status).toBe(2);
    const noOidc = run(
      ['publish', '--tarballs', dir, '--tag', 'v0.1.0'],
      bareEnv({ ...actions, ACTIONS_ID_TOKEN_REQUEST_URL: '' }),
    );
    expect(noOidc.status).toBe(2);
  });

  it('refuses any npm token in the environment of a real publish', () => {
    const result = run(
      ['publish', '--tarballs', dir, '--tag', 'v0.1.0'],
      bareEnv({
        GITHUB_ACTIONS: 'true',
        GITHUB_REF_TYPE: 'tag',
        GITHUB_REF_NAME: 'v0.1.0',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.invalid/',
        NODE_AUTH_TOKEN: 'fake',
        npm_config__authToken: 'fake',
      }),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'npm trusted publishing only: unset NODE_AUTH_TOKEN, npm_config__authToken',
    );
  });

  it('checks the tarballs before asking the registry anything', () => {
    writeFileSync(path.join(dir, 'notes.txt'), 'x');
    const result = run(['publish', '--tarballs', dir, '--tag', 'v0.1.0', '--dry-run']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('## Release dry run v0.1.0');
    expect(result.stdout).toContain(
      'notes.txt: no readable package.json with a name and a version',
    );
    expect(result.stdout).toContain('@hudhudjs/win32-job-x64: no tarball');
    expect(result.stdout).not.toContain('on the registry');
  });

  it('the simulated version PR never runs on a tag', () => {
    const result = run(['simulate-version'], bareEnv({ GITHUB_REF_TYPE: 'tag' }));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('simulate-version never runs on a tag');
  });

  it('installs npm only from a tarball whose sha512 is the pin', () => {
    const file = path.join(dir, 'npm.tgz');
    writeFileSync(file, 'not npm');
    const pin = {
      NPM_VERSION: '11.21.0',
      NPM_INTEGRITY: `sha512-${'A'.repeat(86)}==`,
    };
    const wrong = run(['install-npm', '--file', file], bareEnv(pin));
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain(
      `the npm 11.21.0 tarball is sha512-${createHash('sha512').update('not npm').digest('base64')}, the pin is sha512-AAAA`,
    );
    expect(wrong.stderr).toContain('nothing installed');
    const unpinned = run(['install-npm', '--file', file], bareEnv({ NPM_VERSION: 'latest' }));
    expect(unpinned.status).toBe(2);
    expect(unpinned.stderr).toContain('install-npm needs NPM_VERSION (x.y.z) and NPM_INTEGRITY');
  });

  it('the gate needs the commit, the repository and a token', () => {
    const result = run(['gate', '--tag', 'v0.1.0']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'the gate needs GITHUB_SHA, GITHUB_REPOSITORY and GITHUB_TOKEN',
    );
  });
});
