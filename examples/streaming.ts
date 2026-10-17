// send() returns a Turn: iterate its events while it runs, then await done.
// Guide: docs/guide/events.md

import process from 'node:process';

import { hudhud, isEventType } from 'hudhudjs';

// Text deltas are only produced with includePartialMessages (default false).
const session = await hudhud.session({ claudeCode: { includePartialMessages: true } });
try {
  const turn = session.send('Write a haiku about pipes.');
  for await (const event of turn) {
    if (isEventType(event, 'message.delta') && event.deltaType === 'text') {
      process.stdout.write(event.text ?? '');
    } else if (isEventType(event, 'tool.call')) {
      console.log(`\n[tool ${event.toolName}, kind ${event.kind}]`);
    }
    // Every other event, including types added in later versions, is skipped.
  }
  const result = await turn.done;
  console.log(`\noutcome: ${result.outcome}, stop reason: ${result.stopReason ?? 'none'}`);
} finally {
  await session.close();
}
