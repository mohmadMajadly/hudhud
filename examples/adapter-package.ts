// Using the Claude Code adapter package directly instead of `hudhudjs`.
// Guide: docs/guide/getting-started.md#install

import { CLAUDE_CODE_COMPAT, connect } from '@hudhudjs/claude-code';

const { minTested, maxTested } = CLAUDE_CODE_COMPAT;
console.log(`hudhud was tested with Claude Code ${minTested} to ${maxTested}`);

const harness = await connect();
try {
  console.log(`found Claude Code ${harness.binary.version} (${harness.compat.status})`);
  const session = await harness.sessions.create();
  try {
    console.log((await session.ask('Say hello.')).text);
  } finally {
    await session.close();
  }
} finally {
  await harness[Symbol.asyncDispose]();
}
