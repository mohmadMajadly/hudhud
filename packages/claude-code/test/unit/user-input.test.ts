// The neutral user input as Claude Code user-message content (W4-Z, lead
// decision on W4-T1's question 2): the mapping, and that the session
// machine writes exactly the encoded content for every checked input.

import type { UserContentBlock, UserInput } from '@hudhudjs/core';
import { normalizeUserInput } from '@hudhudjs/core/binding';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { encodeClaudeUserInput } from '../../src/user-input.js';
import { SessionRun, ofType, uuid, writes } from './machine/session-support.js';

const PNG = 'iVBORw0KGgo=';

describe('encodeClaudeUserInput', () => {
  it('keeps a string as the string', () => {
    expect(encodeClaudeUserInput('hello')).toBe('hello');
    expect(encodeClaudeUserInput('')).toBe('');
  });

  it('maps text and base64 image blocks to the Messages API blocks, in order', () => {
    const input: UserInput = {
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', mediaType: 'image/png', dataBase64: PNG },
        { type: 'image', mediaType: 'image/webp', dataBase64: 'UklGRg==' },
        { type: 'text', text: 'and this' },
      ],
    };
    expect(encodeClaudeUserInput(input)).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'UklGRg==' } },
      { type: 'text', text: 'and this' },
    ]);
    expect(encodeClaudeUserInput({ content: [] })).toEqual([]);
  });

  it('returns a fresh value and never changes the input', () => {
    const block: UserContentBlock = { type: 'text', text: 'x' };
    const input: UserInput = { content: [block] };
    const before = JSON.stringify(input);
    const encoded = encodeClaudeUserInput(input);
    expect(encoded).not.toBe(input.content);
    expect((encoded as readonly unknown[])[0]).not.toBe(block);
    expect(JSON.stringify(input)).toBe(before);
  });
});

const block: fc.Arbitrary<UserContentBlock> = fc.oneof(
  fc.string().map((text): UserContentBlock => ({ type: 'text', text })),
  fc
    .record({
      mediaType: fc.constantFrom('image/png', 'image/jpeg', 'image/gif', 'image/webp'),
      dataBase64: fc.base64String({ maxLength: 64 }),
    })
    .map(({ mediaType, dataBase64 }): UserContentBlock => ({
      type: 'image',
      mediaType,
      dataBase64,
    })),
);
const userInput: fc.Arbitrary<UserInput> = fc.oneof(
  fc.string(),
  fc.array(block, { maxLength: 6 }).map((content): UserInput => ({ content })),
);

describe('the session machine writes exactly the encoded content', () => {
  it('for every input the binding accepts (property)', () => {
    fc.assert(
      fc.property(userInput, (raw) => {
        // What the driver does: check, then encode.
        const checked = normalizeUserInput(raw);
        const content = encodeClaudeUserInput(checked);
        const run = new SessionRun();
        run.start();
        const effects = run.feed({ type: 'cmd.send', turnId: uuid(1), content });
        expect(ofType(effects, 'turn.fail')).toEqual([]);
        expect(writes(effects)).toEqual([
          expect.objectContaining({ type: 'user', message: { role: 'user', content } }),
        ]);
      }),
      { numRuns: 300 },
    );
  });
});
