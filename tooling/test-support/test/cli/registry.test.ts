import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CliFetchError } from '../../src/cli/errors.js';
import {
  MAX_DOCUMENT_BYTES,
  assertRegistryUrl,
  downloadTarball,
  fetchLatest,
  fetchVersionDocument,
  tarballUrl,
} from '../../src/cli/registry.js';
import { binary, fakeRegistry, json, release, versionDocument } from './fake-registry.js';
import { sri } from './tar-builder.js';

const R = release('linux-x64', '2.1.296');

function redirect(location: string | null, status = 302): () => Response {
  return () => new Response(null, { status, headers: location === null ? {} : { location } });
}

/** A registry URL carrying userinfo, built so no address-like literal sits in the source. */
function withUserinfo(username: string, password: string): string {
  const url = new URL('https://registry.npmjs.org/x');
  url.username = username;
  url.password = password;
  return url.href;
}

describe('assertRegistryUrl (host allowlist)', () => {
  it('accepts https://registry.npmjs.org only', () => {
    expect(assertRegistryUrl('https://registry.npmjs.org/x').href).toBe(
      'https://registry.npmjs.org/x',
    );
    expect(assertRegistryUrl('https://REGISTRY.npmjs.org:443/x').href).toBe(
      'https://registry.npmjs.org/x',
    );
    expect(assertRegistryUrl('/y', new URL('https://registry.npmjs.org/x')).href).toBe(
      'https://registry.npmjs.org/y',
    );
  });

  it.each([
    'http://registry.npmjs.org/x',
    'https://registry.npmjs.org.evil.example/x',
    'https://evil.example/registry.npmjs.org/x',
    'https://registry.yarnpkg.com/x',
    'https://registry.npmjs.org:8443/x',
    withUserinfo('user', 'pw'),
    withUserinfo('user', ''),
    'file:///etc/passwd',
    'ftp://registry.npmjs.org/x',
    'not a url',
    '//evil.example/x',
  ])('refuses %s', (url) => {
    expect(() => assertRegistryUrl(url)).toThrow(CliFetchError);
    try {
      assertRegistryUrl(url);
    } catch (error) {
      expect((error as CliFetchError).code).toBe('host-refused');
    }
  });

  it('refuses every other host (property)', () => {
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        const parsed = new URL(url);
        const allowed =
          parsed.protocol === 'https:' &&
          parsed.hostname === 'registry.npmjs.org' &&
          parsed.port === '' &&
          parsed.username === '' &&
          parsed.password === '';
        if (allowed) expect(assertRegistryUrl(url).hostname).toBe('registry.npmjs.org');
        else expect(() => assertRegistryUrl(url)).toThrow(CliFetchError);
      }),
      { numRuns: 500 },
    );
  });
});

describe('fetchVersionDocument', () => {
  it('reads and validates the exact version document', async () => {
    const registry = fakeRegistry(new Map([[R.documentUrl, json(versionDocument(R))]]));
    expect(await fetchVersionDocument(registry.options, R.pkg, R.version)).toEqual({
      tarball: R.tarballUrl,
      integrity: R.integrity,
    });
    expect(registry.calls).toEqual([R.documentUrl]);
  });

  it('follows a same-origin redirect', async () => {
    const moved = 'https://registry.npmjs.org/moved';
    const registry = fakeRegistry(
      new Map([
        [R.documentUrl, redirect('/moved', 301)],
        [moved, json(versionDocument(R))],
      ]),
    );
    expect((await fetchVersionDocument(registry.options, R.pkg, R.version)).integrity).toBe(
      R.integrity,
    );
    expect(registry.calls).toEqual([R.documentUrl, moved]);
  });

  it.each([
    ['another host', 'https://evil.example/doc', 'host-refused'],
    ['plain http on the same host', 'http://registry.npmjs.org/doc', 'host-refused'],
    ['an unparsable location', 'https://[', 'host-refused'],
  ])('refuses a redirect to %s', async (_name, location, expected) => {
    const registry = fakeRegistry(new Map([[R.documentUrl, redirect(location)]]));
    await expect(fetchVersionDocument(registry.options, R.pkg, R.version)).rejects.toMatchObject({
      code: expected,
    });
    expect(registry.calls).toEqual([R.documentUrl]);
  });

  it('refuses a redirect without a location and redirect loops', async () => {
    const none = fakeRegistry(new Map([[R.documentUrl, redirect(null, 307)]]));
    await expect(fetchVersionDocument(none.options, R.pkg, R.version)).rejects.toThrow(
      /without a location/,
    );
    const loop = fakeRegistry(new Map([[R.documentUrl, redirect(R.documentUrl, 308)]]));
    await expect(fetchVersionDocument(loop.options, R.pkg, R.version)).rejects.toThrow(/redirects/);
    expect(loop.calls).toHaveLength(4);
  });

  it('cancels the body of redirect and error responses', async () => {
    let cancelled = 0;
    const body = (): ReadableStream<Uint8Array> =>
      new ReadableStream({
        cancel: () => {
          cancelled += 1;
        },
      });
    const registry = fakeRegistry(
      new Map([
        [R.documentUrl, () => new Response(body(), { status: 302, headers: { location: '/x' } })],
        ['https://registry.npmjs.org/x', () => new Response(body(), { status: 500 })],
      ]),
    );
    await expect(fetchVersionDocument(registry.options, R.pkg, R.version)).rejects.toThrow(
      /HTTP 500/,
    );
    expect(cancelled).toBe(2);
  });

  it('reports fetch failures and HTTP errors as registry errors', async () => {
    const failing = fakeRegistry(
      new Map([
        [
          R.documentUrl,
          () => {
            throw new TypeError('network down');
          },
        ],
      ]),
    );
    await expect(fetchVersionDocument(failing.options, R.pkg, R.version)).rejects.toMatchObject({
      code: 'registry',
    });
    const missing = fakeRegistry();
    await expect(fetchVersionDocument(missing.options, R.pkg, R.version)).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it.each([
    ['not JSON', () => new Response('{', { status: 200 })],
    ['a JSON array', json([])],
    ['an empty body', () => new Response(null, { status: 200 })],
    ['another package', json(versionDocument(R, { name: '@anthropic-ai/claude-code' }))],
    ['another version', json(versionDocument(R, { version: '2.1.297' }))],
    ['no dist', json(versionDocument(R, { dist: undefined }))],
    ['dist not an object', json(versionDocument(R, { dist: 'x' }))],
    ['no integrity', json(versionDocument(R, { dist: { tarball: R.tarballUrl } }))],
    [
      'a sha1 integrity',
      json(versionDocument(R, { dist: { tarball: R.tarballUrl, integrity: 'sha1-abc' } })),
    ],
    [
      'a tarball on another path',
      json(
        versionDocument(R, {
          dist: { tarball: tarballUrl(R.pkg, '2.1.295'), integrity: R.integrity },
        }),
      ),
    ],
    [
      'a declared length above the limit',
      () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(MAX_DOCUMENT_BYTES + 1) },
        }),
    ],
    [
      'a body above the limit',
      () => new Response(' '.repeat(MAX_DOCUMENT_BYTES + 1), { status: 200 }),
    ],
  ])('refuses %s', async (_name, route) => {
    const registry = fakeRegistry(new Map([[R.documentUrl, route]]));
    await expect(fetchVersionDocument(registry.options, R.pkg, R.version)).rejects.toMatchObject({
      code: 'registry',
    });
  });

  it('refuses a tarball URL on another host', async () => {
    const doc = versionDocument(R, {
      dist: { tarball: 'https://evil.example/x.tgz', integrity: R.integrity },
    });
    const registry = fakeRegistry(new Map([[R.documentUrl, json(doc)]]));
    await expect(fetchVersionDocument(registry.options, R.pkg, R.version)).rejects.toMatchObject({
      code: 'host-refused',
    });
  });
});

describe('fetchLatest', () => {
  const latest = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';

  it('returns the version behind the latest dist-tag', async () => {
    const registry = fakeRegistry(
      new Map([[latest, json({ name: '@anthropic-ai/claude-code', version: '2.2.0' })]]),
    );
    expect(await fetchLatest(registry.options, '@anthropic-ai/claude-code')).toEqual({
      version: '2.2.0',
      claudeCodeVersion: undefined,
    });
  });

  it('returns a valid claudeCodeVersion and drops an invalid one', async () => {
    const doc = (cc: unknown): unknown => ({
      name: '@anthropic-ai/claude-code',
      version: '2.2.0',
      claudeCodeVersion: cc,
    });
    const valid = fakeRegistry(new Map([[latest, json(doc('2.1.296'))]]));
    expect((await fetchLatest(valid.options, '@anthropic-ai/claude-code')).claudeCodeVersion).toBe(
      '2.1.296',
    );
    const invalid = fakeRegistry(new Map([[latest, json(doc('2.1.296/..'))]]));
    expect(
      (await fetchLatest(invalid.options, '@anthropic-ai/claude-code')).claudeCodeVersion,
    ).toBeUndefined();
  });

  it.each([
    [{ name: '@anthropic-ai/claude-code', version: '../2.2.0' }],
    [{ name: '@anthropic-ai/claude-code', version: 2 }],
    [{ name: 'other', version: '2.2.0' }],
  ])('refuses %j', async (doc) => {
    const registry = fakeRegistry(new Map([[latest, json(doc)]]));
    await expect(fetchLatest(registry.options, '@anthropic-ai/claude-code')).rejects.toMatchObject({
      code: 'registry',
    });
  });
});

describe('downloadTarball', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hudhud-dl-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  it('streams to a new file and returns its sha512 SRI', async () => {
    const registry = fakeRegistry(new Map([[R.tarballUrl, binary(R.tgz)]]));
    const out = path.join(dir, 'a.tgz');
    expect(await downloadTarball(registry.options, R.tarballUrl, out, 1 << 20)).toEqual({
      integrity: sri(R.tgz),
      size: R.tgz.byteLength,
    });
    expect(new Uint8Array(await readFile(out))).toEqual(R.tgz);
  });

  it('never overwrites an existing file', async () => {
    const registry = fakeRegistry(new Map([[R.tarballUrl, binary(R.tgz)]]));
    const out = path.join(dir, 'b.tgz');
    await downloadTarball(registry.options, R.tarballUrl, out, 1 << 20);
    await expect(
      downloadTarball(registry.options, R.tarballUrl, out, 1 << 20),
    ).rejects.toMatchObject({
      code: 'EEXIST',
    });
  });

  it('refuses a body above the limit while streaming', async () => {
    const registry = fakeRegistry(new Map([[R.tarballUrl, binary(R.tgz)]]));
    await expect(
      downloadTarball(
        registry.options,
        R.tarballUrl,
        path.join(dir, 'c.tgz'),
        R.tgz.byteLength - 1,
      ),
    ).rejects.toThrow(/more than/);
  });

  it('refuses a tarball URL outside the allowlist without fetching', async () => {
    const registry = fakeRegistry();
    await expect(
      downloadTarball(registry.options, 'https://evil.example/x.tgz', path.join(dir, 'd.tgz'), 10),
    ).rejects.toMatchObject({ code: 'host-refused' });
    expect(registry.calls).toEqual([]);
  });
});
