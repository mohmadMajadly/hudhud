// The release-tag check of the tarball check (scripts/lib/tarball.mjs
// `checkReleaseTag`; ADR-0014 amendment 10, review finding R7-2): before
// anything is published, the tag must name the version of every package of
// the fixed group, the addon package must carry the version of its release
// record, the published packages must not be private and the changesets
// must be consumed.

import { describe, expect, it } from 'vitest';

import {
  checkReleaseTag,
  pendingChangesets,
  tagVersion,
  type PackageJson,
  type ReleaseTagInput,
  type TarEntry,
} from '../lib/tarball.mjs';

const FIXED = ['hudhudjs', '@hudhudjs/core', '@hudhudjs/claude-code'];

function pack(directory: string, manifest: PackageJson): ReleaseTagInput['packs'][number] {
  const entries: TarEntry[] = [
    { path: 'package.json', data: Buffer.from(JSON.stringify(manifest)), mode: 0o644 },
  ];
  return { directory, entries };
}

const PUBLISH = { publishConfig: { access: 'public', provenance: true } };

/** The packages as the version PR leaves them for `v0.1.0`. */
function released(version = '0.1.0', addon = '0.1.0'): ReleaseTagInput['packs'][number][] {
  return [
    pack('packages/hudhud', { name: 'hudhudjs', version, ...PUBLISH }),
    pack('packages/core', { name: '@hudhudjs/core', version, ...PUBLISH }),
    pack('packages/claude-code', { name: '@hudhudjs/claude-code', version, ...PUBLISH }),
    pack('packages/win32-job-x64', {
      name: '@hudhudjs/win32-job-x64',
      version: addon,
      ...PUBLISH,
    }),
    pack('packages/win32-job-arm64', {
      name: '@hudhudjs/win32-job-arm64',
      version: addon,
      private: true,
    }),
  ];
}

const READY: ReleaseTagInput = {
  tag: 'v0.1.0',
  recordRelease: '0.1.0',
  fixed: FIXED,
  changesetFiles: ['README.md', 'config.json'],
  packs: released(),
};

describe('tagVersion and pendingChangesets', () => {
  it('reads v<semver> tags only', () => {
    expect(tagVersion('v0.1.0')).toBe('0.1.0');
    expect(tagVersion('v1.0.0')).toBe('1.0.0');
    expect(tagVersion('v1.0.0-rc.1')).toBe('1.0.0-rc.1');
    for (const tag of ['0.1.0', 'v0.1', 'v01.0.0', 'v1.0.0+build', 'release-1', 'v1.0.0 ']) {
      expect(tagVersion(tag)).toBeNull();
    }
  });

  it('lists every Markdown file but the README as an unconsumed changeset', () => {
    expect(pendingChangesets(['README.md', 'config.json'])).toEqual([]);
    expect(pendingChangesets(['wave-1-core.md', 'README.md', 'a.md', 'config.json'])).toEqual([
      'a.md',
      'wave-1-core.md',
    ]);
  });
});

describe('checkReleaseTag (R7-2)', () => {
  it('passes a tag whose versions, flags and changesets are released', () => {
    expect(checkReleaseTag(READY)).toEqual([]);
  });

  it('passes a library release that keeps an earlier addon release', () => {
    expect(checkReleaseTag({ ...READY, tag: 'v0.2.0', packs: released('0.2.0', '0.1.0') })).toEqual(
      [],
    );
  });

  it('works for a first version of 1.0.0 as well as 0.x (an owner decision)', () => {
    expect(checkReleaseTag({ ...READY, tag: 'v1.0.0', packs: released('1.0.0') })).toEqual([]);
  });

  it('refuses a tag cut before the version PR (the reviewer scenario)', () => {
    const before = [
      pack('packages/hudhud', { name: 'hudhudjs', version: '0.0.0', private: true, ...PUBLISH }),
      pack('packages/core', {
        name: '@hudhudjs/core',
        version: '0.0.0',
        private: true,
        ...PUBLISH,
      }),
      pack('packages/claude-code', {
        name: '@hudhudjs/claude-code',
        version: '0.0.0',
        private: true,
        ...PUBLISH,
      }),
      pack('packages/win32-job-x64', {
        name: '@hudhudjs/win32-job-x64',
        version: '0.0.0',
        private: true,
        ...PUBLISH,
      }),
      pack('packages/win32-job-arm64', {
        name: '@hudhudjs/win32-job-arm64',
        version: '0.0.0',
        private: true,
      }),
    ];
    expect(
      checkReleaseTag({
        ...READY,
        packs: before,
        changesetFiles: ['README.md', 'config.json', 'wave-1-core.md'],
      }),
    ).toEqual([
      'hudhudjs is private but has publishConfig: lift "private" in the version PR (checklist 4.2)',
      '@hudhudjs/core is private but has publishConfig: lift "private" in the version PR (checklist 4.2)',
      '@hudhudjs/claude-code is private but has publishConfig: lift "private" in the version PR (checklist 4.2)',
      '@hudhudjs/win32-job-x64 is private but has publishConfig: lift "private" in the version PR (checklist 4.2)',
      'hudhudjs is packed at version 0.0.0, the tag v0.1.0 names 0.1.0',
      '@hudhudjs/core is packed at version 0.0.0, the tag v0.1.0 names 0.1.0',
      '@hudhudjs/claude-code is packed at version 0.0.0, the tag v0.1.0 names 0.1.0',
      "@hudhudjs/win32-job-x64 is packed at version 0.0.0, the release record the core's table names is 0.1.0",
      'unconsumed changesets (run pnpm changeset version in the version PR): wave-1-core.md',
    ]);
  });

  it('refuses a fixed-group package at another version than the tag', () => {
    const packs = released();
    packs[1] = pack('packages/core', { name: '@hudhudjs/core', version: '0.1.1', ...PUBLISH });
    expect(checkReleaseTag({ ...READY, packs })).toEqual([
      '@hudhudjs/core is packed at version 0.1.1, the tag v0.1.0 names 0.1.0',
    ]);
  });

  it('refuses an addon package at another version than its record', () => {
    expect(checkReleaseTag({ ...READY, recordRelease: '0.0.0-dev' })).toEqual([
      "@hudhudjs/win32-job-x64 is packed at version 0.1.0, the release record the core's table names is 0.0.0-dev",
    ]);
  });

  it('refuses a package a publish would take by accident', () => {
    const packs = released();
    packs[4] = pack('packages/win32-job-arm64', {
      name: '@hudhudjs/win32-job-arm64',
      version: '0.1.0',
    });
    expect(checkReleaseTag({ ...READY, packs })).toEqual([
      '@hudhudjs/win32-job-arm64 has no publishConfig and is not private: a publish would take it',
    ]);
  });

  it('refuses a malformed tag, a missing fixed group and missing packages', () => {
    expect(
      checkReleaseTag({
        ...READY,
        tag: 'v0.1',
        fixed: [],
        packs: [{ directory: 'packages/x', entries: [] }],
      }),
    ).toEqual([
      'the tag "v0.1" is not v<semver> (for example v0.1.0)',
      '.changeset/config.json has no fixed group: the tag names no package version',
      'packages/x: the tarball has no readable package.json with a name',
      '@hudhudjs/win32-job-x64 was not packed',
    ]);
    expect(checkReleaseTag({ ...READY, packs: released().slice(1) })).toEqual([
      'hudhudjs (fixed group) was not packed',
    ]);
  });
});
