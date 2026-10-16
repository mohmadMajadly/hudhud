// Permission decisions against the pinned CLI (W6-T2, plan §5.8, §4.4;
// ADR-0007, ADR-0012 §3). Each test drives hudhud's own session with a
// permission handler (`--permission-prompt-tool=stdio`, `--permission-mode`
// always explicit) and asserts three things: what the application saw
// (events, handler calls), what hudhud wrote to the CLI (the wire tap of
// `support.ts`), and what reached the model (the mock's captured requests).
// Evidence: 05 §6 (runs 19-30, recorded again as the conformance suites
// permission-allow, permission-deny, permission-deny-interrupt).

import type { JsonObject, PermissionDecision, PermissionRequest, Session } from '@hudhudjs/core';
import { expect, test } from 'vitest';

import { integrationSuite } from '../support/harness.js';
import {
  b64,
  canUseToolIds,
  frameKind,
  inputObject,
  leaked,
  markerExists,
  member,
  onlyAnswer,
  PERMISSION_CMD,
  PERMISSION_MARKER,
  type SessionTap,
  settingsFiles,
  tappedSession,
  toolResultsSent,
} from './support.js';

const suite = integrationSuite();

/** Opens a session in `default` mode with `onPermission`, tapped from the start. */
async function permissionSession(
  onPermission: (request: PermissionRequest) => Promise<PermissionDecision>,
): Promise<{ session: Session; tap: SessionTap }> {
  return tappedSession(suite, { permissionMode: 'default', onPermission });
}

test('allow: the tool runs in the sandbox and its output reaches the model (05 §6 run 19, permission-allow)', async () => {
  const asked: PermissionRequest[] = [];
  const { session, tap } = await permissionSession((request) => {
    asked.push(request);
    return Promise.resolve<PermissionDecision>({
      behavior: 'allow',
      updatedInput: inputObject(request.input),
    });
  });
  const { work } = (await suite.sandbox()).dirs;
  expect(session.info.mode).toBe('create');
  expect(await tap.event('session.started')).toMatchObject({ permissionMode: 'default' });

  const result = await session.ask(PERMISSION_MARKER);
  await session.close();
  await tap.ended;

  expect(result).toMatchObject({ outcome: 'completed', isError: false, permissionDenials: [] });
  expect(result.text).toContain('RESULT<<hi');
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ toolName: 'Bash', input: { command: PERMISSION_CMD } });
  // The tool really ran in the sandbox's working directory.
  expect(markerExists(work)).toBe(true);

  const [requestId] = canUseToolIds(tap);
  expect(asked[0]?.requestId).toBe(requestId);
  expect(onlyAnswer(tap, String(requestId))).toEqual({
    subtype: 'success',
    request_id: requestId,
    response: { behavior: 'allow', updatedInput: inputObject(asked[0]?.input ?? null) },
  });
  expect(tap.eventsOf('permission.resolved')).toMatchObject([
    { requestId, behavior: 'allow', by: 'application' },
  ]);
  expect(tap.eventsOf('tool.result')).toMatchObject([{ status: 'completed' }]);
  const results = toolResultsSent(await suite.mock());
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ isError: false });
  expect(results[0]?.text.trim()).toBe('hi');
  expect(tap.events.at(-1)).toMatchObject({ type: 'session.terminated', outcome: 'closed' });
});

test('deny: the tool does not run, the deny message is the tool result, the turn continues (05 §6, permission-deny)', async () => {
  const { session, tap } = await permissionSession(() =>
    Promise.resolve<PermissionDecision>({
      behavior: 'deny',
      message: 'host says no',
    }),
  );
  const { work } = (await suite.sandbox()).dirs;

  const result = await session.ask(PERMISSION_MARKER);
  await session.close();
  await tap.ended;

  expect(result).toMatchObject({ outcome: 'completed', isError: false });
  expect(result.permissionDenials).toMatchObject([{ toolName: 'Bash' }]);
  expect(markerExists(work)).toBe(false);
  const [requestId] = canUseToolIds(tap);
  expect(onlyAnswer(tap, String(requestId))).toEqual({
    subtype: 'success',
    request_id: requestId,
    response: { behavior: 'deny', message: 'host says no' },
  });
  expect(tap.eventsOf('permission.resolved')).toMatchObject([
    { requestId, behavior: 'deny', by: 'application' },
  ]);
  expect(toolResultsSent(await suite.mock())).toMatchObject([
    { isError: true, text: 'host says no' },
  ]);
  expect(tap.events.at(-1)).toMatchObject({ type: 'session.terminated', outcome: 'closed' });
});

test('deny with interrupt: the turn is cancelled with aborted_tools (05 §6, permission-deny-interrupt)', async () => {
  const { session, tap } = await permissionSession(() =>
    Promise.resolve<PermissionDecision>({
      behavior: 'deny',
      message: 'host says no',
      interrupt: true,
    }),
  );
  const { work } = (await suite.sandbox()).dirs;

  const result = await session.ask(PERMISSION_MARKER);
  await session.close();
  await tap.ended;

  expect(result).toMatchObject({
    outcome: 'cancelled',
    isError: true,
    terminalReason: 'aborted_tools',
    synthesized: false,
  });
  expect(markerExists(work)).toBe(false);
  const [requestId] = canUseToolIds(tap);
  expect(onlyAnswer(tap, String(requestId))).toEqual({
    subtype: 'success',
    request_id: requestId,
    response: { behavior: 'deny', message: 'host says no', interrupt: true },
  });
  // The model is never called again after the interrupting deny.
  const mock = await suite.mock();
  expect(
    mock.requests.filter((request) => JSON.stringify(request.body).includes('[[mock:bash')),
  ).toHaveLength(1);
  expect(tap.events.at(-1)).toMatchObject({ type: 'session.terminated', outcome: 'closed' });
});

test('settings destinations are stripped: only session updates reach the CLI, no settings file is written (ADR-0012 §3, 05 §6 suggestions)', async () => {
  const sessionRule: JsonObject = {
    type: 'addRules',
    rules: [{ toolName: 'Bash' }],
    behavior: 'allow',
    destination: 'session',
  };
  const configUpdates: JsonObject[] = ['localSettings', 'userSettings', 'projectSettings'].map(
    (destination) => ({
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'echo hi *' }],
      behavior: 'allow',
      destination,
    }),
  );
  // Both snapshots are taken while no CLI runs: before the spawn and after
  // the close (`closed`: the process tree was cleaned up). A live CLI keeps
  // rewriting `cfg/.claude.json` through a `.claude.json.lock` directory
  // for a few hundred milliseconds after the session opened (W7-T1: fs
  // watch traces on Windows and Linux, none after the close), so a walk at
  // that moment raced it (CI run 38980330927, ENOENT on the lock directory).
  const sandbox = await suite.sandbox();
  const before = await settingsFiles(sandbox.dirs.root);
  const asked: PermissionRequest[] = [];
  const { session, tap } = await permissionSession((request) => {
    asked.push(request);
    return Promise.resolve<PermissionDecision>({
      behavior: 'allow',
      updatedInput: inputObject(request.input),
      updatedPermissions: [...configUpdates, sessionRule],
    });
  });

  const first = await session.ask(PERMISSION_MARKER);
  // The session rule took effect in the CLI: the same command runs again without asking.
  const second = await session.ask(PERMISSION_MARKER);
  await session.close();
  await tap.ended;

  expect(first).toMatchObject({ outcome: 'completed', isError: false });
  expect(second).toMatchObject({ outcome: 'completed', isError: false });
  expect(asked).toHaveLength(1);
  // The CLI was offered the config destinations itself (05 §6) and hudhud passed them through unapplied.
  expect(asked[0]?.suggestions.length).toBeGreaterThan(0);
  const [requestId] = canUseToolIds(tap);
  expect(onlyAnswer(tap, String(requestId))).toEqual({
    subtype: 'success',
    request_id: requestId,
    response: {
      behavior: 'allow',
      updatedInput: inputObject(asked[0]?.input ?? null),
      updatedPermissions: [sessionRule],
    },
  });
  expect(tap.eventsOf('diagnostic')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'permission.updates-stripped',
        data: { requestId, strippedCount: 3 },
      }),
    ]),
  );
  // No settings file anywhere in the sandbox (config, home, work) was created or changed.
  expect(await settingsFiles(sandbox.dirs.root)).toEqual(before);
  // No control request that writes settings was ever sent.
  expect(tap.controlRequestsOut('update_settings')).toEqual([]);
  expect(tap.controlRequestsOut('apply_flag_settings')).toEqual([]);
  expect(leaked('localSettings', await suite.mock(), tap)).toEqual([]);
});

/** Text only the application's handler knows; it must never reach the CLI or the model. */
const SECRET = 'handler-secret-7f3a9c';

/** The fixed deny messages of the permission machine (`permission.ts`). */
const HANDLER_FAILED = 'hudhud: permission handler failed';
const INVALID_DECISION = 'hudhud: invalid permission decision';

const FAILING_HANDLERS: readonly {
  readonly name: string;
  readonly handler: (request: PermissionRequest) => Promise<PermissionDecision>;
  readonly diagnostic: { readonly code: string; readonly data: Readonly<Record<string, string>> };
  readonly message: string;
}[] = [
  {
    name: 'throws synchronously',
    handler: () => {
      throw new TypeError(SECRET);
    },
    diagnostic: { code: 'permission.handler-failed', data: { error: 'TypeError' } },
    message: HANDLER_FAILED,
  },
  {
    name: 'rejects',
    handler: async () => {
      await Promise.resolve();
      throw new RangeError(SECRET);
    },
    diagnostic: { code: 'permission.handler-failed', data: { error: 'RangeError' } },
    message: HANDLER_FAILED,
  },
  {
    name: 'returns an allow with an unknown key',
    handler: () =>
      Promise.resolve({ behavior: 'allow', note: SECRET } as unknown as PermissionDecision),
    diagnostic: { code: 'permission.invalid-decision', data: { reason: 'unknown-key' } },
    message: INVALID_DECISION,
  },
  {
    name: 'returns an unknown behaviour',
    handler: () => Promise.resolve({ behavior: SECRET } as unknown as PermissionDecision),
    diagnostic: { code: 'permission.invalid-decision', data: { reason: 'bad-behavior' } },
    message: INVALID_DECISION,
  },
  {
    name: 'returns no object',
    handler: () => Promise.resolve(SECRET as unknown as PermissionDecision),
    diagnostic: { code: 'permission.invalid-decision', data: { reason: 'not-object' } },
    message: INVALID_DECISION,
  },
];

test.each(FAILING_HANDLERS)(
  'fail closed when the handler $name: a fixed non-interrupting deny, a diagnostic to the application, no handler text at the CLI or the model (ADR-0007, 05 §6)',
  async ({ handler, diagnostic, message }) => {
    const { session, tap } = await permissionSession(handler);
    const { work } = (await suite.sandbox()).dirs;

    const result = await session.ask(PERMISSION_MARKER);
    await session.close();
    await tap.ended;

    // The turn goes on (a deny, not an interrupt) and the tool never ran.
    expect(result).toMatchObject({ outcome: 'completed', isError: false });
    expect(result.permissionDenials).toMatchObject([{ toolName: 'Bash' }]);
    expect(markerExists(work)).toBe(false);
    const [requestId] = canUseToolIds(tap);
    expect(onlyAnswer(tap, String(requestId))).toEqual({
      subtype: 'success',
      request_id: requestId,
      response: { behavior: 'deny', message, interrupt: false },
    });
    expect(tap.eventsOf('permission.resolved')).toMatchObject([
      { requestId, behavior: 'deny', by: 'application' },
    ]);
    // The application learns what failed, by class name or refusal only.
    const diagnostics = tap
      .eventsOf('diagnostic')
      .filter((event) => event.code.startsWith('permission.'));
    expect(diagnostics).toMatchObject([
      { code: diagnostic.code, data: { requestId, ...diagnostic.data } },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(SECRET);
    // The model saw the fixed text, never the handler's.
    const mock = await suite.mock();
    expect(toolResultsSent(mock)).toMatchObject([{ isError: true, text: message }]);
    expect(leaked(SECRET, mock, tap)).toEqual([]);
    expect(tap.events.at(-1)).toMatchObject({ type: 'session.terminated', outcome: 'closed' });
  },
);

test('no handler: hudhud does not pass the stdio prompt tool, so the CLI denies a mutating tool itself (05 §6 "Without --permission-prompt-tool")', async () => {
  const { session, tap } = await tappedSession(suite, { permissionMode: 'default' });
  const { work } = (await suite.sandbox()).dirs;

  const result = await session.ask(PERMISSION_MARKER);
  await session.close();
  await tap.ended;

  expect(result).toMatchObject({ outcome: 'completed', isError: false });
  expect(result.permissionDenials).toMatchObject([{ toolName: 'Bash' }]);
  expect(markerExists(work)).toBe(false);
  // Never asked over the control channel, never answered, never allowed.
  expect(canUseToolIds(tap)).toEqual([]);
  expect(tap.eventsOf('permission.requested')).toEqual([]);
  expect(tap.eventsOf('permission.denied')).toMatchObject([{ toolName: 'Bash' }]);
  expect(tap.written.filter((frame) => member(frame, 'type') === 'control_response')).toEqual([]);
  expect(toolResultsSent(await suite.mock())).toMatchObject([{ isError: true }]);
});

test('no handler, read-only tool: the CLI auto-allows echo in default mode and runs it in the sandbox (05 §6, §14, tool-bash)', async () => {
  const { session, tap } = await tappedSession(suite, { permissionMode: 'default' });

  const result = await session.ask(`[[mock:bash cmd=${b64('echo hi')}]] run it`);
  await session.close();
  await tap.ended;

  expect(result).toMatchObject({ outcome: 'completed', isError: false, permissionDenials: [] });
  expect(canUseToolIds(tap)).toEqual([]);
  expect(tap.eventsOf('tool.call')).toMatchObject([
    { toolName: 'Bash', kind: 'execute', input: { command: 'echo hi' } },
  ]);
  expect(tap.eventsOf('tool.result')).toMatchObject([{ status: 'completed' }]);
  const results = toolResultsSent(await suite.mock());
  expect(results).toMatchObject([{ isError: false }]);
  expect(results[0]?.text.trim()).toBe('hi');
});

test('setPermissionMode: an allowed mode is sent and applies to the next turn; bypass and unknown modes are refused before anything is written (02 set_permission_mode, ADR-0012 §3)', async () => {
  const { session, tap } = await tappedSession(suite, {
    permissionMode: 'default',
    onPermission: () => Promise.resolve<PermissionDecision>({ behavior: 'deny', message: 'no' }),
  });
  expect(await tap.event('session.started')).toMatchObject({ permissionMode: 'default' });

  await session.ask('[[mock:text]] one');
  await session.setPermissionMode('acceptEdits');
  const writtenBefore = tap.written.length;
  await expect(session.setPermissionMode('bypassPermissions')).rejects.toMatchObject({
    code: 'INVALID_OPTIONS',
  });
  await expect(session.setPermissionMode('manual')).rejects.toMatchObject({
    code: 'INVALID_OPTIONS',
  });
  expect(tap.written).toHaveLength(writtenBefore);
  const second = session.send('[[mock:text]] two');
  const result = await second.done;
  await session.close();
  await tap.ended;

  expect(result).toMatchObject({ outcome: 'completed', isError: false });
  expect(tap.controlRequestsOut('set_permission_mode').map((frame) => frame.frame)).toMatchObject([
    { type: 'control_request', request: { subtype: 'set_permission_mode', mode: 'acceptEdits' } },
  ]);
  // Each turn's system/init reports the mode in force: the first default, the second the new one.
  const inits = tap.frames.filter(
    (frame) =>
      frame.direction === 'in' &&
      frameKind(frame.frame).type === 'system' &&
      frameKind(frame.frame).subtype === 'init',
  );
  expect(inits.map((frame) => member(frame.frame, 'permissionMode'))).toEqual([
    'default',
    'acceptEdits',
  ]);
  const [sentMode] = tap.controlRequestsOut('set_permission_mode');
  expect(inits[1]?.seq).toBeGreaterThan(sentMode?.seq ?? Infinity);
});
