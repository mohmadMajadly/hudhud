/**
 * Pre-initializes a fresh sandbox config directory (J11; ADR-0013 §17;
 * 07 §5).
 *
 * @remarks
 * Concurrent first starts on a never-initialized `CLAUDE_CONFIG_DIR` can
 * skip a global-config write. Before a test fans out several sessions into
 * one sandbox, it runs one complete session here: one user turn answered by
 * the mock, then EOF. The config directory then holds the CLI's own
 * `.claude.json`; nothing is synthesized.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { RecordingSession } from '../fixtures/session.js';
import type { Sandbox } from './sandbox.js';

/** Thrown when the warm-up session does not complete cleanly. */
export class WarmUpError extends Error {
  override readonly name = 'WarmUpError';
}

/**
 * Runs one session in `sandbox` and checks that it exited with 0 and left
 * `<cfg>/.claude.json`.
 *
 * @throws WarmUpError, or the session's timeout error.
 */
export async function warmSandbox(sandbox: Sandbox, timeoutMs = 60_000): Promise<void> {
  const session = await RecordingSession.start(sandbox);
  try {
    session.user('[[mock:text]] warm-up');
    await session.waitType('result', undefined, timeoutMs);
  } finally {
    await session.stop(timeoutMs);
  }
  const exit = session.exit;
  if (exit?.code !== 0) {
    throw new WarmUpError(`warm-up session ended with ${JSON.stringify(exit)}`);
  }
  if (!existsSync(path.join(sandbox.dirs.cfg, '.claude.json'))) {
    throw new WarmUpError(`warm-up left no .claude.json in ${sandbox.dirs.cfg}`);
  }
}
