/**
 * The neutral user input as Claude Code user-message content (plan §1.8;
 * W4-Z, lead decision on W4-T1's question 2).
 *
 * @remarks
 * The session driver hands every checked input to the adapter's
 * `encodeUserInput` hook and feeds the result to the machine as the content
 * of `cmd.send`; the Claude machine stays at the wire level (it checks the
 * content again and builds the `user` frame). Wave 5 passes
 * {@link encodeClaudeUserInput} as that hook.
 *
 * Pure and total over the neutral `UserInput` the binding has already
 * checked (`normalizeUserInput`): a string stays the string; a block list
 * becomes the Messages API blocks, in order, with nothing added or dropped:
 *
 * - `{ type: 'text', text }` as is;
 * - `{ type: 'image', mediaType, dataBase64 }` as
 *   `{ type: 'image', source: { type: 'base64', media_type, data } }`.
 *
 * The result is a fresh value; the input is never changed.
 */

import type { UserInput } from '@hudhudjs/core';

import type { UserContentWire } from './protocol/wire/types.js';

/**
 * The Claude Code `message.content` of a neutral user input (see the module
 * remarks).
 *
 * @internal
 */
export function encodeClaudeUserInput(input: UserInput): UserContentWire {
  if (typeof input === 'string') return input;
  return input.content.map((block) =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : {
          type: 'image',
          source: { type: 'base64', media_type: block.mediaType, data: block.dataBase64 },
        },
  );
}
