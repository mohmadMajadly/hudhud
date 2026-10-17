// Resume a session by its id, or fork it into a new one.
// Guide: docs/guide/sessions.md#resume-and-fork

import { connect, isHudhudError } from 'hudhudjs';

const harness = await connect();
try {
  const first = await harness.sessions.create();
  const sessionId = first.id;
  await first.ask('Remember the word "lantern". Reply with OK.');
  await first.close();

  // Same id, same history.
  const resumed = await harness.sessions.resume(sessionId);
  console.log((await resumed.ask('Which word did I ask you to remember?')).text);
  await resumed.close();

  // A copy of the history under a new id; the original stays unchanged.
  const forked = await harness.sessions.resume(sessionId, { fork: true });
  console.log(`fork ${forked.id} of ${forked.info.forkedFrom ?? '?'}`);
  await forked.close();

  try {
    await harness.sessions.resume('00000000-0000-4000-8000-000000000000');
  } catch (error) {
    if (!isHudhudError(error, 'SESSION_NOT_FOUND')) throw error;
    console.log('No session with that id exists.');
  }
} finally {
  await harness[Symbol.asyncDispose]();
}
