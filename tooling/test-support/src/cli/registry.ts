/**
 * The npm registry client of the pinned-CLI fetch (plan §4.6 steps 1-2).
 *
 * Supply-chain rules: every URL, including each redirect target, must be
 * `https://registry.npmjs.org` (no other host, scheme, port or userinfo);
 * redirects are followed by hand, at most a few, and only inside that origin.
 * Every body is size-capped while streaming. The tarball URL must be exactly
 * the canonical one for the package and version. Network access goes through
 * an injected `fetch`, so unit tests never touch the network.
 */

import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

import { CliFetchError } from './errors.js';
import { isValidIntegrity, isValidVersion } from './pin.js';

/** The only origin the fetch talks to. */
export const REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const REGISTRY_HOST = 'registry.npmjs.org';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
/** Upper bound for a registry metadata document of one version. */
export const MAX_DOCUMENT_BYTES: number = 1024 * 1024;

/** The subset of the WHATWG `fetch` the client uses; injected for tests. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Timeouts of the registry client. */
export interface RegistryOptions {
  readonly fetch: FetchLike;
  /** Timeout for a metadata document, including its body. */
  readonly documentTimeoutMs: number;
  /** Timeout for a tarball download, including its body. */
  readonly tarballTimeoutMs: number;
}

/** Parses `value` (relative to `base` when given) and refuses everything outside the allowlist. */
export function assertRegistryUrl(value: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch (error) {
    throw new CliFetchError('host-refused', `not a URL: ${JSON.stringify(value)}`, {
      cause: error,
    });
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== REGISTRY_HOST ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new CliFetchError(
      'host-refused',
      `refusing ${url.protocol}//${url.host}: only ${REGISTRY_ORIGIN} is allowed`,
    );
  }
  return url;
}

/** GET with manual, origin-confined redirects; resolves only on HTTP 200. */
async function get(
  fetchFn: FetchLike,
  start: string,
  accept: string,
  timeoutMs: number,
): Promise<Response> {
  let url = assertRegistryUrl(start);
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hops = 0; ; hops += 1) {
    let response: Response;
    try {
      response = await fetchFn(url.href, { redirect: 'manual', headers: { accept }, signal });
    } catch (error) {
      throw new CliFetchError('registry', `GET ${url.href} failed`, { cause: error });
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (location === null) {
        throw new CliFetchError('registry', `GET ${url.href}: redirect without a location`);
      }
      if (hops >= MAX_REDIRECTS) {
        throw new CliFetchError(
          'registry',
          `GET ${start}: more than ${String(MAX_REDIRECTS)} redirects`,
        );
      }
      url = assertRegistryUrl(location, url);
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new CliFetchError('registry', `GET ${url.href}: HTTP ${String(response.status)}`);
    }
    return response;
  }
}

/** The body of `response` in chunks, refusing more than `maxBytes` in total. */
async function* cappedBody(
  response: Response,
  maxBytes: number,
  what: string,
): AsyncGenerator<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new CliFetchError(
      'registry',
      `${what}: declared ${String(declared)} bytes, limit ${String(maxBytes)}`,
    );
  }
  if (response.body === null) return;
  let total = 0;
  const body: AsyncIterable<Uint8Array> = response.body;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new CliFetchError('registry', `${what}: more than ${String(maxBytes)} bytes`);
    }
    yield chunk;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function getDocument(
  options: RegistryOptions,
  url: string,
): Promise<Record<string, unknown>> {
  const response = await get(options.fetch, url, 'application/json', options.documentTimeoutMs);
  const chunks: Uint8Array[] = [];
  for await (const chunk of cappedBody(response, MAX_DOCUMENT_BYTES, url)) chunks.push(chunk);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new CliFetchError('registry', `${url}: not valid JSON`, { cause: error });
  }
  if (!isRecord(parsed)) throw new CliFetchError('registry', `${url}: not a JSON object`);
  return parsed;
}

/** The canonical tarball URL of `pkg@version` (`@scope/name` -> `.../-/name-version.tgz`). */
export function tarballUrl(pkg: string, version: string): string {
  const bare = pkg.slice(pkg.indexOf('/') + 1);
  return `${REGISTRY_ORIGIN}/${pkg}/-/${bare}-${version}.tgz`;
}

/** What the registry states about one published version. */
export interface VersionDocument {
  readonly tarball: string;
  /** The registry's `dist.integrity` (sha512 SRI). */
  readonly integrity: string;
}

/**
 * Reads the registry document of the exact version `pkg@version` and checks
 * its name, version, the canonical tarball URL and the integrity's form.
 */
export async function fetchVersionDocument(
  options: RegistryOptions,
  pkg: string,
  version: string,
): Promise<VersionDocument> {
  const url = `${REGISTRY_ORIGIN}/${pkg}/${version}`;
  const document = await getDocument(options, url);
  if (document['name'] !== pkg || document['version'] !== version) {
    throw new CliFetchError('registry', `${url}: document is not ${pkg}@${version}`);
  }
  const dist = document['dist'];
  const tarball = isRecord(dist) ? dist['tarball'] : undefined;
  const integrity = isRecord(dist) ? dist['integrity'] : undefined;
  if (typeof tarball !== 'string' || typeof integrity !== 'string') {
    throw new CliFetchError('registry', `${url}: dist.tarball or dist.integrity missing`);
  }
  assertRegistryUrl(tarball);
  if (tarball !== tarballUrl(pkg, version)) {
    throw new CliFetchError('registry', `${url}: unexpected tarball URL ${tarball}`);
  }
  if (!isValidIntegrity(integrity)) {
    throw new CliFetchError('registry', `${url}: dist.integrity is not a sha512 SRI string`);
  }
  return { tarball, integrity };
}

/** What the `latest` dist-tag of a package points to. */
export interface LatestDocument {
  readonly version: string;
  /**
   * The `claudeCodeVersion` field of the document when it is a valid version
   * (the Agent SDK states the CLI version it bundles there).
   */
  readonly claudeCodeVersion: string | undefined;
}

/**
 * The version behind the `latest` dist-tag of `pkg`: what `npm install`
 * gives users, which is the meaning of "newest" for the canary (K16).
 */
export async function fetchLatest(options: RegistryOptions, pkg: string): Promise<LatestDocument> {
  const url = `${REGISTRY_ORIGIN}/${pkg}/latest`;
  const document = await getDocument(options, url);
  const version = document['version'];
  if (document['name'] !== pkg || typeof version !== 'string' || !isValidVersion(version)) {
    throw new CliFetchError('registry', `${url}: no valid version for ${pkg}`);
  }
  const claudeCodeVersion = document['claudeCodeVersion'];
  return {
    version,
    claudeCodeVersion:
      typeof claudeCodeVersion === 'string' && isValidVersion(claudeCodeVersion)
        ? claudeCodeVersion
        : undefined,
  };
}

/**
 * Streams the tarball at `url` into the new file `destination` (created
 * exclusively, owner-only) and returns its sha512 SRI and size. The caller
 * compares the SRI with the expected integrity before reading the file.
 */
export async function downloadTarball(
  options: RegistryOptions,
  url: string,
  destination: string,
  maxBytes: number,
): Promise<{ readonly integrity: string; readonly size: number }> {
  const response = await get(
    options.fetch,
    url,
    'application/octet-stream',
    options.tarballTimeoutMs,
  );
  const hash = createHash('sha512');
  let size = 0;
  const handle = await open(destination, 'wx', 0o600);
  try {
    for await (const chunk of cappedBody(response, maxBytes, url)) {
      hash.update(chunk);
      size += chunk.byteLength;
      await handle.write(chunk);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { integrity: `sha512-${hash.digest('base64')}`, size };
}
