// Ask a person before a tool runs. With onPermission set, the CLI sends
// every permission question to the application; nothing is decided by
// timeout, and hudhud cancels the question when it no longer matters.
// Guide: docs/guide/permissions.md

import process from 'node:process';
import { createInterface } from 'node:readline/promises';

import { sanitizeForDisplay } from '@hudhudjs/core/protocol';
import { hudhud, type PermissionHandler } from 'hudhudjs';

const terminal = createInterface({ input: process.stdin, output: process.stdout });

const onPermission: PermissionHandler = async (request, { signal }) => {
  // Every text field comes from the harness: untrusted, sanitize before display.
  const tool = sanitizeForDisplay(request.displayName ?? request.toolName, { singleLine: true });
  const input = sanitizeForDisplay(JSON.stringify(request.input));
  // The signal aborts when the CLI withdraws the question, on interrupt and on close.
  const answer = await terminal.question(`Allow ${tool} with ${input}? [y/N] `, { signal });
  return answer.trim().toLowerCase() === 'y'
    ? { behavior: 'allow' }
    : { behavior: 'deny', message: 'The user declined this tool call.' };
};

const session = await hudhud.session({ permissionMode: 'default', onPermission });
try {
  const result = await session.ask('Create a file notes.txt that says hello.');
  for (const denial of result.permissionDenials) {
    console.log(`denied: ${denial.toolName}`);
  }

  // Later turns can run in another mode, for example accepting edits.
  await session.setPermissionMode('acceptEdits');
} finally {
  await session.close();
  terminal.close();
}
