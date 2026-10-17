// End-to-end proof of the integration harness (W6-T0): the product connects
// to the pinned, hash-verified CLI in a sandbox, opens a session, runs one
// text turn against the in-process mock and closes it gracefully. The
// harness asserts after the test that every Harness was disposed, the
// egress trap recorded nothing and no process leaked.

import type { HudhudEvent } from '@hudhudjs/core';
import { expect, test } from 'vitest';

import { integrationSuite } from '../support/harness.js';

const suite = integrationSuite();

const REPLY = 'Hello from the integration harness.';

test('connect, create a session, run one text turn against the mock, close', async () => {
  const harness = await suite.testConnect();
  expect(harness.binary.path).toBe(suite.cli.binaryPath);
  expect(harness.binary.version).toBe(suite.cli.version);
  expect(harness.compat.status).toBe(suite.expectedCompatStatus);

  const session = await harness.sessions.create();
  const sandbox = await suite.sandbox();
  expect(session.info.mode).toBe('create');
  expect(session.info.version).toBe(suite.cli.version);
  expect(session.info.apiKeySource).toBe('ANTHROPIC_API_KEY');

  const events: HudhudEvent[] = [];
  const collected = (async () => {
    for await (const event of session.events()) events.push(event);
  })();

  const marker = Buffer.from(REPLY, 'utf8').toString('base64');
  const result = await session.ask(`[[mock:text t=${marker}]] hello`);
  expect(result).toMatchObject({ outcome: 'completed', isError: false, text: REPLY });

  await session.close();
  await collected;

  const types = events.map((event) => event.type);
  expect(types[0]).toBe('compat');
  expect(types).toContain('session.started');
  expect(types).toContain('turn.started');
  expect(types).toContain('turn.completed');
  const assistant = events.filter((event) => event.type === 'message.assistant');
  expect(assistant.map((event) => ('text' in event ? event.text : undefined))).toContain(REPLY);
  const terminated = events.at(-1);
  expect(terminated).toMatchObject({ type: 'session.terminated', outcome: 'closed' });

  // The CLI talked to the mock, in the sandbox, with the fake key only.
  const mock = await suite.mock();
  const turns = mock.requests.filter((request) =>
    JSON.stringify(request.body).includes('[[mock:text'),
  );
  expect(turns).toHaveLength(1);
  expect(turns[0]?.headers['x-api-key']).toBe('<redacted>');
  expect(mock.violations).toEqual([]);
  expect(sandbox.dirs.root.startsWith(suite.suiteDir)).toBe(true);
});
