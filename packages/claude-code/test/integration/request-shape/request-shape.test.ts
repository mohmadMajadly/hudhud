// Request-shape snapshots (plan §4.4 "request-shape snapshots"; ADR-0013 §4).
//
// What the CLI under test sends to the mock Messages API for representative
// hudhud scenarios, as normalized structural snapshots committed next to
// this file: one set per shape era (snapshots/<era>/*.<platform>.shape; the
// tool list differs between Linux and Windows), the era chosen by the CLI
// version from snapshots/eras.json (ADR-0004 §4, amendment of 2026-10-25),
// so every admitted release is judged against the shapes recorded for it. A
// semantic change fails, an additive change warns; see support.ts for the
// rules and the update mode (HUDHUD_REQUEST_SHAPE_UPDATE=1, which also fails
// the run and writes the set of the era of the CLI under test).
//
// Evidence of the shapes, all for CLI 2.1.296:
// - 05 §2 "Every endpoint the CLI hit": only POST /v1/messages?beta=true
//   with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1; the request headers
//   (user-agent, x-app, x-claude-code-session-id, anthropic-version,
//   anthropic-beta, x-stainless-*); the billing-header system block; the
//   trailing role:"system" message after a tool result (D16).
// - 07 §1 (resume matrix) a2/a8: `--resume` loads the history, so the
//   request carries every earlier message.
// - 05 §14: the same scenario on Linux and Windows.
//
// The newest era is recorded at the pin (2.1.302 since COMPAT-1,
// 2026-10-18), and it is the only era so far. The one change from 2.1.296: from 2.1.299 on the CLI no longer sends the
// anthropic-beta value mid-conversation-system-2026-04-07, while the
// requests still carry the mid-conversation role:"system" messages (the
// bundle registers the feature without a header: 2.1.296
// `v("mid_conversation_system","mid-conversation-system-2026-04-07")`,
// 2.1.299 `Wy("mid_conversation_system")` = `{ header: null }`). Measured on
// Linux and Windows for 2.1.296, 2.1.299, 2.1.300, 2.1.301 and 2.1.302:
// 2.1.299 to 2.1.302 send identical shapes. A run against 2.1.296 now reports
// the extra value as an additive finding (a warning), as the rolling window
// expects of an older admitted release (ADR-0004 §4).

import { expect, test } from 'vitest';

import { integrationSuite } from '../support/harness.js';
import { checkRequestShape } from './support.js';

const suite = integrationSuite();

/** `[[mock:text]]`: the mock answers with a text block. */
const TEXT = '[[mock:text]]';
/** `bash cmd=<base64 of "pwd">`: one Bash tool use, then a text reply. */
const BASH_PWD = '[[mock:bash cmd=cHdk]]';

const allow = (): Promise<{ readonly behavior: 'allow' }> => Promise.resolve({ behavior: 'allow' });

test('text-turn: one user message, one streamed request (05 §2)', async () => {
  const session = await suite.testSession();
  const result = await session.ask(`${TEXT} hello`);
  expect(result).toMatchObject({ outcome: 'completed', isError: false });
  await session.close();
  // The control of session-options below: by default WebFetch is offered,
  // as a tool or, under tool search (2.1.304 on), as a deferred tool.
  const [request] = (await suite.mock()).requests;
  expect(JSON.stringify(request?.body)).toContain('WebFetch');
  await checkRequestShape(suite, 'text-turn', 1);
});

test('tool-use: the tool result comes back with the trailing system message (05 §2, D16)', async () => {
  const session = await suite.testSession({ session: { onPermission: allow } });
  const result = await session.ask(`${BASH_PWD} go`);
  expect(result).toMatchObject({ outcome: 'completed', isError: false });
  await session.close();
  await checkRequestShape(suite, 'tool-use', 2);
});

test('partial-messages: includePartialMessages changes the output, not the request (05 §2)', async () => {
  const session = await suite.testSession({
    session: { claudeCode: { includePartialMessages: true } },
  });
  const result = await session.ask(`${TEXT} hello`);
  expect(result).toMatchObject({ outcome: 'completed', isError: false });
  await session.close();
  await checkRequestShape(suite, 'partial-messages', 1);
});

test('session-options: model, tool removal and appended system prompt reach the request', async () => {
  // The snapshot abstracts text, so the appended prompt is proven present by a probe.
  const probe = 'HUDHUD-REQUEST-SHAPE-PROBE';
  const session = await suite.testSession({
    session: {
      claudeCode: {
        model: 'claude-sonnet-4-5',
        disallowedTools: ['WebFetch', 'WebSearch'],
        appendSystemPrompt: probe,
      },
    },
  });
  const result = await session.ask(`${TEXT} hello`);
  expect(result).toMatchObject({ outcome: 'completed', isError: false });
  await session.close();

  const [request] = (await suite.mock()).requests;
  const body = request?.body as { model?: string; system?: unknown; tools?: { name: string }[] };
  expect(body.model).toBe('claude-sonnet-4-5');
  expect(JSON.stringify(body.system)).toContain(probe);
  const names = body.tools?.map((tool) => tool.name) ?? [];
  expect(names).not.toContain('WebFetch');
  expect(names).not.toContain('WebSearch');
  expect(names).toContain('Bash');
  // Under tool search a deferred tool is not in body.tools at all, so the
  // check above alone would pass without the option: a disallowed tool must
  // not be offered in any form, neither as a tool nor in the list of
  // deferred tools (measured on 2.1.310: the list then omits both).
  expect(JSON.stringify(body)).not.toContain('WebFetch');
  expect(JSON.stringify(body)).not.toContain('WebSearch');
  await checkRequestShape(suite, 'session-options', 1);
});

test('resume: the second request replays the first session history (07 §1 a2, a8)', async () => {
  const harness = await suite.testConnect();
  const first = await harness.sessions.create({ onPermission: allow });
  await first.ask(`${BASH_PWD} first`);
  const { id } = first;
  await first.close();

  const second = await harness.sessions.resume(id, { onPermission: allow });
  expect(second.info.mode).toBe('resume');
  const result = await second.ask(`${TEXT} again`);
  expect(result).toMatchObject({ outcome: 'completed', isError: false });
  await second.close();
  await checkRequestShape(suite, 'resume', 3);
});
