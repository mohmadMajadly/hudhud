import { describe, expect, it } from 'vitest';

import {
  CHECKED_LANGUAGES,
  checkSnippets,
  codeBlocks,
  containsExcerpt,
  normalizeLines,
} from '../lib/doc-snippets.mjs';

describe('codeBlocks', () => {
  it('finds backtick and tilde fences with their language and lines', () => {
    const text = [
      '# Title',
      '```ts',
      'const a = 1;',
      '```',
      'prose',
      '~~~~ TypeScript title="x"',
      '```',
      'inner',
      '~~~~~',
      '```',
      'no language',
      '```',
    ].join('\n');
    expect(codeBlocks(text)).toEqual([
      { line: 2, language: 'ts', lines: ['const a = 1;'], closed: true },
      { line: 6, language: 'typescript', lines: ['```', 'inner'], closed: true },
      { line: 10, language: '', lines: ['no language'], closed: true },
    ]);
  });

  it('closes only on a fence of the same character, at least as long, without info', () => {
    const text = ['````ts', '```', '````js', '`````', 'after'].join('\r\n');
    expect(codeBlocks(text)).toEqual([
      { line: 1, language: 'ts', lines: ['```', '````js'], closed: true },
    ]);
  });

  it('strips up to the opening fence indentation from the content', () => {
    const text = ['  ```ts', '    deeper', ' one', 'none', '  ```'].join('\n');
    expect(codeBlocks(text)).toEqual([
      { line: 1, language: 'ts', lines: ['  deeper', 'one', 'none'], closed: true },
    ]);
  });

  it('reports a block that runs to the end of the text as not closed', () => {
    expect(codeBlocks('```ts\nconst a = 1;')).toEqual([
      { line: 1, language: 'ts', lines: ['const a = 1;'], closed: false },
    ]);
  });

  it('ignores fences indented by four spaces (indented code)', () => {
    expect(codeBlocks('    ```ts\n    x\n    ```')).toEqual([]);
  });
});

describe('normalizeLines', () => {
  it('drops outer blank lines, trailing whitespace and the common indentation', () => {
    expect(normalizeLines(['', '    if (a) {  ', '', '      b();', '    }', '   '])).toEqual([
      'if (a) {',
      '',
      '  b();',
      '}',
    ]);
  });

  it('returns nothing for blank input', () => {
    expect(normalizeLines(['', '  '])).toEqual([]);
    expect(normalizeLines([])).toEqual([]);
  });
});

describe('containsExcerpt', () => {
  const source = ['function f() {', '  const a = 1;', '  return a;', '}', ''];

  it('matches a contiguous run, whatever its indentation in the source', () => {
    expect(containsExcerpt(['const a = 1;', 'return a;'], source)).toBe(true);
    expect(containsExcerpt(['function f() {', '  const a = 1;'], source)).toBe(true);
  });

  it('refuses lines out of order, missing lines and longer excerpts', () => {
    expect(containsExcerpt(['return a;', 'const a = 1;'], source)).toBe(false);
    expect(containsExcerpt(['function f() {', '  return a;'], source)).toBe(false);
    expect(containsExcerpt([...source, 'extra'], source)).toBe(false);
  });

  it('does not match a window that starts with a blank line', () => {
    expect(containsExcerpt(['a', 'b'], ['', 'a'])).toBe(false);
  });
});

describe('checkSnippets', () => {
  const examples = [
    { path: 'examples/a.ts', text: 'import x from "x";\n\nexport function go() {\n  x();\n}\n' },
  ];

  it('accepts excerpts, skips other languages and counts the checked blocks', () => {
    const documents = [
      {
        path: 'docs/a.md',
        text: '```ts\nexport function go() {\n  x();\n}\n```\n\n```sh\nnpm i\n```\n\n```js\nx();\n```\n',
      },
    ];
    expect(checkSnippets(documents, examples)).toEqual({ problems: [], checked: 2 });
  });

  it('names every block that is not an excerpt, empty or not closed', () => {
    const documents = [
      { path: 'docs/a.md', text: '```typescript\ny();\n```\n\n```ts\n\n```\n' },
      { path: 'docs/b.md', text: 'text\n```mjs\nx();\n' },
    ];
    expect(checkSnippets(documents, examples)).toEqual({
      problems: [
        'docs/a.md:1: typescript code block is not an excerpt of any example under examples/',
        'docs/a.md:5: ts code block is empty',
        'docs/b.md:2: code block is not closed',
      ],
      checked: 2,
    });
  });

  it('checks the languages it names', () => {
    expect([...CHECKED_LANGUAGES].sort()).toEqual(['javascript', 'js', 'mjs', 'ts', 'typescript']);
  });
});
