// Every failure is a HudhudError with a stable code, a retryable flag and
// JSON details. A turn that ends with an error is a result, not a failure.
// Guide: docs/guide/troubleshooting.md

import { connect, isHudhudError } from 'hudhudjs';

/** Runs `operation` again while it fails with a retryable error, up to `attempts` times. */
async function withRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isHudhudError(error) || !error.retryable || attempt >= attempts) throw error;
      console.warn(`attempt ${String(attempt)} failed with ${error.code}; retrying`);
    }
  }
}

try {
  const harness = await connect();
  try {
    // HANDSHAKE_TIMEOUT, for example, is retryable: starting again may succeed.
    const session = await withRetry(() => harness.sessions.create());
    const result = await session.ask('Say hello.');
    // isError: the CLI reported an error result (for example max-turns); the session is fine.
    console.log(result.isError ? `error result: ${result.outcome}` : result.text);
    await session.close();
  } finally {
    await harness[Symbol.asyncDispose]();
  }
} catch (error) {
  if (!isHudhudError(error)) throw error;
  if (error.code === 'BINARY_NOT_FOUND') {
    console.error('Claude Code is not installed, or not where hudhud looks.', error.details);
  } else if (error.code === 'HANDSHAKE_TIMEOUT' || error.code === 'HANDSHAKE_FAILED') {
    console.error('Claude Code started but did not answer the handshake.', error.details);
  } else {
    console.error(`${error.code} (retryable: ${String(error.retryable)}): ${error.message}`);
  }
}
