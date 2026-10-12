// An injected `fetch` that plays registry.npmjs.org for the CLI fetch tests.
// No test in this directory touches the network.

import { expect } from 'vitest';

import type { FetchLike, RegistryOptions } from '../../src/cli/registry.js';
import { archive, bytes, entry, gzip, sha256, sri } from './tar-builder.js';

export type Route = (init: RequestInit) => Response | Promise<Response>;

export interface FakeRegistry {
  readonly fetch: FetchLike;
  readonly calls: string[];
  readonly routes: Map<string, Route>;
  readonly options: RegistryOptions;
}

export function fakeRegistry(routes = new Map<string, Route>()): FakeRegistry {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    expect(init.redirect).toBe('manual');
    const route = routes.get(url);
    if (route === undefined) return new Response('not found', { status: 404 });
    return route(init);
  };
  return {
    fetch,
    calls,
    routes,
    options: { fetch, documentTimeoutMs: 5_000, tarballTimeoutMs: 5_000 },
  };
}

export function json(value: unknown, status = 200): Route {
  return () =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

export function binary(data: Uint8Array): Route {
  return () => new Response(data, { status: 200 });
}

/** A fake platform release: tarball, document and the digests a pin would hold. */
export interface Release {
  readonly pkg: string;
  readonly version: string;
  readonly platform: string;
  readonly file: string;
  readonly binary: Uint8Array;
  readonly tgz: Uint8Array;
  readonly documentUrl: string;
  readonly tarballUrl: string;
  readonly integrity: string;
  readonly sha256: string;
  readonly size: number;
}

export function release(
  platform: string,
  version: string,
  content = `fake ${platform} ${version}\n`,
): Release {
  const pkg = `@anthropic-ai/claude-code-${platform}`;
  const file = platform.startsWith('win32-') ? 'claude.exe' : 'claude';
  const binaryBytes = bytes(content.repeat(50));
  const tgz = gzip(
    archive(
      entry({ name: 'package/LICENSE.md', body: bytes('license') }),
      entry({ name: 'package/README.md', body: bytes('readme') }),
      entry({ name: `package/${file}`, body: binaryBytes }),
      entry({ name: 'package/package.json', body: bytes(`{"name":"${pkg}"}`) }),
    ),
  );
  return {
    pkg,
    version,
    platform,
    file,
    binary: binaryBytes,
    tgz,
    documentUrl: `https://registry.npmjs.org/${pkg}/${version}`,
    tarballUrl: `https://registry.npmjs.org/${pkg}/-/claude-code-${platform}-${version}.tgz`,
    integrity: sri(tgz),
    sha256: sha256(binaryBytes),
    size: binaryBytes.byteLength,
  };
}

export function versionDocument(r: Release, overrides: Record<string, unknown> = {}): unknown {
  return {
    name: r.pkg,
    version: r.version,
    dist: { tarball: r.tarballUrl, integrity: r.integrity, shasum: 'ignored' },
    ...overrides,
  };
}

/** Serves `r`'s document and tarball (the tarball optionally replaced). */
export function serve(registry: FakeRegistry, r: Release, tarball: Uint8Array = r.tgz): void {
  registry.routes.set(r.documentUrl, json(versionDocument(r)));
  registry.routes.set(r.tarballUrl, binary(tarball));
}

/** A pin document for the given releases (all of one version). */
export function pinDocument(...releases: Release[]): unknown {
  const platforms: Record<string, unknown> = {};
  for (const r of releases) {
    platforms[r.platform] = {
      package: r.pkg,
      file: r.file,
      integrity: r.integrity,
      sha256: r.sha256,
      size: r.size,
    };
  }
  return { version: releases[0]?.version, platforms };
}

export const SDK = '@anthropic-ai/claude-agent-sdk';
export const SDK_LATEST = `https://registry.npmjs.org/${SDK}/latest`;

/** A manifest.json as the Agent SDK ships it, listing the given releases. */
export function manifestFor(cliVersion: string, ...releases: Release[]): unknown {
  const platforms: Record<string, unknown> = {};
  for (const r of releases) {
    platforms[r.platform] = { binary: r.file, checksum: r.sha256, size: r.size };
  }
  return { version: cliVersion, platforms };
}

/**
 * Serves a fake Agent SDK release whose `latest` bundles `claudeCodeVersion`
 * and whose tarball holds `manifest` (raw text when a string; omitted when
 * undefined). Returns the SDK tarball URL.
 */
export function serveSdk(
  registry: FakeRegistry,
  sdkVersion: string,
  claudeCodeVersion: unknown,
  manifest?: unknown,
  tamper?: (tgz: Uint8Array) => Uint8Array,
): string {
  const files = [
    entry({ name: 'package/sdk.mjs', body: bytes('throw new Error("never imported");\n') }),
    entry({ name: 'package/package.json', body: bytes(`{"name":"${SDK}"}`) }),
  ];
  if (manifest !== undefined) {
    const text = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
    files.push(entry({ name: 'package/manifest.json', body: bytes(text) }));
  }
  const tgz = gzip(archive(...files));
  const tarballUrl = `https://registry.npmjs.org/${SDK}/-/claude-agent-sdk-${sdkVersion}.tgz`;
  const doc = {
    name: SDK,
    version: sdkVersion,
    claudeCodeVersion,
    dist: { tarball: tarballUrl, integrity: sri(tgz) },
  };
  registry.routes.set(SDK_LATEST, json(doc));
  registry.routes.set(`https://registry.npmjs.org/${SDK}/${sdkVersion}`, json(doc));
  registry.routes.set(tarballUrl, binary(tamper === undefined ? tgz : tamper(tgz)));
  return tarballUrl;
}
