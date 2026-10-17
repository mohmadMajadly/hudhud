// The unstable raw tier: every wire frame, and (only with an explicit
// opt-in) control requests written past hudhud's session machine.
// Guide: docs/guide/raw.md

import { createSessionRaw, raw } from '@hudhudjs/claude-code/raw';
import { connect } from 'hudhudjs';

// Raw control carries the agent's full authority; it is off unless opted in.
const harness = await connect({ claudeCode: { dangerouslyAllowRawControl: true } });
try {
  // createSessionRaw is sessions.create plus extra argv and environment.
  const session = await createSessionRaw(harness, { raw: { extraEnv: { MY_TOOL_MODE: 'ci' } } });
  try {
    const wire = raw(session);
    const tap = (async () => {
      for await (const frame of wire.frames({ overflow: 'drop-oldest-with-gap-marker' })) {
        if (frame.kind === 'gap') console.log(`(${String(frame.dropped)} frames dropped)`);
        else console.log(`${frame.direction} ${String(frame.bytes)} bytes`);
      }
    })();

    await session.ask('Say hello.');
    console.log(await wire.controlRequest('mcp_status', {}, { timeoutMs: 10_000 }));

    await session.close();
    await tap;
  } finally {
    await session[Symbol.asyncDispose]();
  }
} finally {
  await harness[Symbol.asyncDispose]();
}
