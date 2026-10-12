import { describe, expect, it } from 'vitest';

import {
  anchorsOf,
  extractLinks,
  isLocalTarget,
  slugify,
  splitTarget,
} from '../lib/markdown-links.mjs';

describe('extractLinks', () => {
  it('finds inline links, images and reference definitions outside code', () => {
    const text = [
      'See [ADR](adr/0001.md#context) and ![img](img/a.png "title").',
      'Escaped [a \\] b](x.md) and <https://example.org> autolink.',
      '`[not](a-link.md)` in a code span',
      '```md',
      '[not](inside-fence.md)',
      '```',
      '~~~~',
      '```',
      '[still](inside-tilde-fence.md)',
      '~~~~',
      '[ref]: ../README.md "Title"',
      '[empty]()',
    ].join('\n');
    expect(extractLinks(text)).toEqual([
      { line: 1, target: 'adr/0001.md#context' },
      { line: 1, target: 'img/a.png' },
      { line: 2, target: 'x.md' },
      { line: 11, target: '../README.md' },
    ]);
  });
});

describe('anchors', () => {
  it.each([
    ['Goals and owner rules', 'goals-and-owner-rules'],
    ['macOS gate list (ratified)', 'macos-gate-list-ratified'],
    ['Pre-v1 spike list (G4)', 'pre-v1-spike-list-g4'],
    ['Scope: v1, v1.1, later', 'scope-v1-v11-later'],
    ['`ci-gate` and **bold**', 'ci-gate-and-bold'],
    ['Link [text](x.md) <em>tag</em>', 'link-text-tag'],
    ['ADR-0004: Packages', 'adr-0004-packages'],
    ['snake_case name', 'snake_case-name'],
  ])('slugifies %j', (heading, slug) => {
    expect(slugify(heading)).toBe(slug);
  });

  it('numbers duplicate headings and ignores fenced code', () => {
    const text = [
      '# Title',
      '## Notes',
      '```',
      '## Not a heading',
      '```',
      '### Notes ###',
      '#Nope',
    ].join('\n');
    expect([...anchorsOf(text)]).toEqual(['title', 'notes', 'notes-1']);
  });
});

describe('targets', () => {
  it.each([
    ['docs/a.md', true],
    ['#local', true],
    ['https://example.org', false],
    ['mailto:x', false],
    ['//cdn.example.org/x', false],
  ])('%j is local: %s', (target, local) => {
    expect(isLocalTarget(target)).toBe(local);
  });

  it('splits and decodes path and anchor', () => {
    expect(splitTarget('a%20b.md#x%2Dy')).toEqual({ path: 'a b.md', anchor: 'x-y' });
    expect(splitTarget('a.md')).toEqual({ path: 'a.md', anchor: undefined });
    expect(splitTarget('#only')).toEqual({ path: '', anchor: 'only' });
  });
});
