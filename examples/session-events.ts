// A session-wide subscription: everything the session reports, bounded and
// isolated from the session itself.
// Guide: docs/guide/events.md, docs/guide/diagnostics.md

import { hudhud, isEventType, type Session } from 'hudhudjs';

async function watch(session: Session): Promise<void> {
  // A slow consumer loses the oldest events and sees a `gap` marker instead
  // of failing its iterator (the default policy is 'error').
  const events = session.events({ overflow: 'drop-oldest-with-gap-marker', maxEvents: 1000 });
  for await (const event of events) {
    if (isEventType(event, 'compat')) {
      console.log(`[compat] Claude Code ${event.compat.version}: ${event.compat.status}`);
    } else if (isEventType(event, 'diagnostic')) {
      console.log(`[diagnostic] ${event.code}: ${event.message}`);
    } else if (isEventType(event, 'api.retry')) {
      console.log(`[api.retry] attempt ${String(event.attempt)}: ${event.error ?? 'unknown'}`);
    } else if (isEventType(event, 'stalled')) {
      console.log(`[stalled] no output for ${String(event.silentForMs)} ms`);
    } else if (isEventType(event, 'gap')) {
      console.log(`[gap] ${String(event.dropped)} events dropped`);
    } else if (isEventType(event, 'session.terminated')) {
      console.log(`[end] intent ${event.intent}, outcome ${event.outcome}`);
    }
  }
  // The iterator ends after the session's last event.
}

const session = await hudhud.session();
const watching = watch(session);
try {
  await session.ask('Say hello.');
} finally {
  await session.close();
  await watching;
}
