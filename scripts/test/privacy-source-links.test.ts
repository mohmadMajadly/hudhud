// The privacy gate's one exception for the repository owner's GitHub handle
// (owner ruling on R6-4, 2026-10-17): it may stand in the source links of a
// published package manifest (`repository.url`, `homepage`, `bugs.url`, as
// `https://github.com/<owner>/hudhud` URLs) and nowhere else.

import { describe, expect, it } from 'vitest';

import {
  packageSourceLinkLines,
  parseAddedLines,
  scanAddedLines,
  scanText,
} from '../lib/privacy.mjs';

/** A stand-in for the owner's handle, as the private denylist would hold it. */
const OWNER = 'exampleowner';
const DENYLIST = [OWNER];

type Manifest = Readonly<Record<string, unknown>>;

function linked(dir: string, owner = OWNER, extra: Manifest = {}): Manifest {
  return {
    name: `@hudhudjs/${dir}`,
    version: '0.0.0',
    license: 'Apache-2.0',
    repository: {
      type: 'git',
      url: `git+https://github.com/${owner}/hudhud.git`,
      directory: `packages/${dir}`,
    },
    homepage: `https://github.com/${owner}/hudhud/tree/main/packages/${dir}#readme`,
    bugs: { url: `https://github.com/${owner}/hudhud/issues` },
    publishConfig: { access: 'public', provenance: true },
    ...extra,
  };
}

const text = (manifest: Manifest): string => `${JSON.stringify(manifest, null, 2)}\n`;
const denied = (path: string, content: string): number =>
  scanText(path, content, DENYLIST).filter((finding) => finding.rule === 'denylist').length;

describe('the owner handle in package source links (R6-4 ruling)', () => {
  it('passes in repository.url, homepage and bugs.url of a published manifest', () => {
    const content = text(linked('core'));
    expect(packageSourceLinkLines('packages/core/package.json', content)).toEqual(
      new Set([7, 10, 12]),
    );
    // Before the ruling the gate refused all three lines.
    expect(denied('packages/core/package.json', content)).toBe(0);
  });

  it('passes in the staged added lines of such a manifest, recognised from the whole file', () => {
    const content = text(linked('core'));
    const diff = [
      'diff --git a/packages/core/package.json b/packages/core/package.json',
      '--- a/packages/core/package.json',
      '+++ b/packages/core/package.json',
      '@@ -4,0 +5,9 @@',
      ...content
        .split('\n')
        .slice(4, 13)
        .map((line) => `+${line}`),
    ].join('\n');
    const added = parseAddedLines(diff);
    const links = new Map([
      ['packages/core/package.json', packageSourceLinkLines('packages/core/package.json', content)],
    ]);
    expect(scanAddedLines(added, DENYLIST, links)).toEqual([]);
    // Without the whole-file recognition (the old gate), every link is refused.
    expect(scanAddedLines(added, DENYLIST)).toHaveLength(3);
  });

  it('is still refused in another field of the same manifest', () => {
    for (const extra of [
      { description: `by ${OWNER}` },
      { author: OWNER },
      { funding: { url: `https://github.com/${OWNER}/hudhud/issues` } },
      { contributors: [`https://github.com/${OWNER}`] },
    ]) {
      const content = text(linked('core', OWNER, extra));
      expect(denied('packages/core/package.json', content)).toBeGreaterThan(0);
    }
  });

  it('is still refused in source files, docs and other manifests', () => {
    const content = text(linked('core'));
    for (const path of [
      'packages/core/README.md',
      'packages/core/src/index.ts',
      'docs/guide/getting-started.md',
      'package.json',
      'packages/core/sub/package.json',
      'tooling/test-support/package.json',
    ]) {
      expect(denied(path, content)).toBe(3);
    }
    expect(
      denied('scripts/lib/tarball.mjs', `const url = 'https://github.com/${OWNER}/hudhud';\n`),
    ).toBe(1);
  });

  it('is still refused in a manifest that does not publish or does not match the shape', () => {
    const unpublished = { ...linked('win32-job-arm64') };
    delete (unpublished as { publishConfig?: unknown }).publishConfig;
    const cases: [string, Manifest][] = [
      ['packages/win32-job-arm64/package.json', unpublished],
      // another repository name, directory or homepage path
      [
        'packages/core/package.json',
        linked('core', OWNER, {
          repository: {
            type: 'git',
            url: `git+https://github.com/${OWNER}/other.git`,
            directory: 'packages/core',
          },
        }),
      ],
      [
        'packages/core/package.json',
        linked('core', OWNER, {
          repository: {
            type: 'git',
            url: `git+https://github.com/${OWNER}/hudhud.git`,
            directory: 'packages/hudhud',
          },
        }),
      ],
      [
        'packages/core/package.json',
        linked('core', OWNER, { homepage: `https://github.com/${OWNER}` }),
      ],
      // links of two different owners
      [
        'packages/core/package.json',
        linked('core', OWNER, { bugs: { url: 'https://github.com/someone/hudhud/issues' } }),
      ],
    ];
    for (const [path, manifest] of cases) {
      expect(packageSourceLinkLines(path, text(manifest))).toEqual(new Set());
      expect(denied(path, text(manifest))).toBeGreaterThan(0);
    }
  });

  it('is still refused when a link line is repeated or not alone on its line', () => {
    const repeated = text(
      linked('core', OWNER, { x: { url: `git+https://github.com/${OWNER}/hudhud.git` } }),
    );
    expect(packageSourceLinkLines('packages/core/package.json', repeated)).toEqual(new Set());
    expect(denied('packages/core/package.json', repeated)).toBe(4);
    const compact = JSON.stringify(linked('core'));
    expect(packageSourceLinkLines('packages/core/package.json', compact)).toEqual(new Set());
    expect(denied('packages/core/package.json', compact)).toBe(1);
    expect(packageSourceLinkLines('packages/core/package.json', '{ not json')).toEqual(new Set());
    for (const odd of [
      '[]',
      'null',
      text(linked('core', OWNER, { repository: null })),
      text(linked('core', OWNER, { repository: [`git+https://github.com/${OWNER}/hudhud.git`] })),
      text(linked('core', OWNER, { repository: `github:${OWNER}/hudhud` })),
      text(linked('core', OWNER, { repository: { type: 'git', url: 42 } })),
    ]) {
      expect(packageSourceLinkLines('packages/core/package.json', odd)).toEqual(new Set());
    }
  });

  it('still refuses another denylist term on an allowed line', () => {
    const content = text(linked('core'));
    expect(
      scanText('packages/core/package.json', content, [OWNER, 'hudhud.git']).filter(
        (finding) => finding.rule === 'denylist',
      ),
    ).toHaveLength(1);
  });
});
