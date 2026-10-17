// Security defaults at the child (W6-T4; plan §2.5, §4.4; ADR-0012 §4,
// ADR-0016 §2): the argv and the environment the pinned CLI actually runs
// with, observed from inside it by a probe tool call. The mock makes the CLI
// run its Bash tool; the tool writes the CLI's pid, argv and environment into
// files in the sandbox work directory (Linux: `/proc/<pid>/cmdline` and
// `/proc/<pid>/environ`, the CLI's exact launch; Windows: the CLI's command
// line from `Win32_Process`, read by the test from the host process table
// while the session is open, and the Bash tool's environment, which is the
// CLI's plus what the CLI and Git Bash add for tools; 05 §3, §11 runs 78-80
// show the Bash tool and its environment on both OSes).
//
// Evidence: the always-passed flags and the sandbox recipe, 05 §13.2 and
// 07 §9 p5 (`--setting-sources` must always be passed); the session-state
// variable, 05 §12 runs 16-18 (D11); the env presets, K19 and 02 §10 item 4
// (the whole parent environment reaches every tool without an allowlist).

import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { integrationSuite } from '../support/harness.js';
import {
  allowAll,
  collect,
  diagnostics,
  envValue,
  observedArgv,
  postureEntry,
  postureOf,
  probeChild,
  type ChildProbe,
} from './support.js';

const suite = integrationSuite();

/** Parent variables of the sandbox that no preset may pass on (or hudhud removes). */
const PARENT_EXTRAS = {
  TRACEPARENT: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  TRACESTATE: 'hudhud=parent',
  HUDHUD_IT_UNLISTED: 'unlisted-value',
  HUDHUD_IT_SECRET_TOKEN: 'hudhud-it-secret-value-0001',
  CLAUDE_AGENT_SDK_HUDHUD: 'nested-marker',
  CLAUDE_CODE_SDK_READS_SESSION_STATE: '1',
} as const;

/** What a probed environment must hold for every sandboxed session (pinned keys, plan §2.5). */
function expectPinned(probe: ChildProbe, cfg: string, platform: NodeJS.Platform): void {
  expect(envValue(probe, 'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS', platform)).toBe('1');
  expect(envValue(probe, 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS', platform)).toBe('600000');
  expect(envValue(probe, 'DISABLE_AUTOUPDATER', platform)).toBe('1');
  expect(envValue(probe, 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', platform)).toBe('1');
  expect(envValue(probe, 'CLAUDE_CONFIG_DIR', platform)).toBe(cfg);
  expect(envValue(probe, 'CLAUDE_CODE_SDK_READS_SESSION_STATE', platform)).toBeUndefined();
}

test('default launch: exact argv, allowlisted environment, pinned keys, no TRACEPARENT', async () => {
  await suite.setup({ sandbox: { env: PARENT_EXTRAS } });
  const sandbox = await suite.sandbox();
  const { platform } = sandbox;
  const harness = await suite.testConnect();
  const session = await harness.sessions.create({ onPermission: allowAll });
  const collected = collect(session);
  const probe = await probeChild(session, sandbox.dirs.work, platform);
  await session.close();
  await collected.done;

  // The probe ran inside the spawned CLI (process identity, K1).
  expect(probe.pid).toBe(session.info.pid);
  // Plan §2.5: the always-passed flags in their order, nothing else.
  expect(observedArgv(probe, suite.cli.binaryPath)).toEqual([
    suite.cli.binaryPath,
    '--output-format=stream-json',
    '--input-format=stream-json',
    '--verbose',
    '--setting-sources=user',
    '--permission-mode=default',
    `--session-id=${session.id}`,
    '--permission-prompt-tool=stdio',
  ]);

  expectPinned(probe, sandbox.dirs.cfg, platform);
  // Every parent variable outside the 'harness' allowlist stays out, as do
  // TRACEPARENT/TRACESTATE without the trace option (ADR-0016 §2).
  for (const name of Object.keys(PARENT_EXTRAS)) {
    expect(envValue(probe, name, platform), name).toBeUndefined();
  }
  // The allowlisted routing and credential variables reach it unchanged.
  for (const name of ['ANTHROPIC_BASE_URL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) {
    expect(envValue(probe, name, platform), name).toBe(sandbox.env[name]);
  }
  expect(envValue(probe, 'ANTHROPIC_API_KEY', platform) === sandbox.env['ANTHROPIC_API_KEY']).toBe(
    true,
  );

  // The variables the platform never reads are not passed (plan §2.5
  // allowlist per platform); the pinned ones are hudhud's own values.
  const unread = platform === 'win32' ? ['HOME', 'TMPDIR'] : ['TEMP', 'TMP'];
  const dropped = diagnostics(collected.events, 'env.dropped');
  expect(dropped).toHaveLength(1);
  expect(dropped[0]).toEqual({
    names: [...Object.keys(PARENT_EXTRAS), ...unread, 'DISABLE_AUTOUPDATER'].sort(),
    spawnInjected: [],
  });
  if (probe.exactEnv) {
    // Linux: the CLI's exact environment is the sandbox's minus everything
    // the allowlist drops, plus hudhud's two pinned additions.
    const expected = [
      ...Object.keys(sandbox.env).filter(
        (name) => !unread.includes(name) && !Object.hasOwn(PARENT_EXTRAS, name),
      ),
      'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS',
      'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS',
    ].sort();
    expect([...probe.env.keys()].sort()).toEqual(expected);
  }

  // Nothing of the real user's home reached the model request (05 §13.1:
  // the ancestor ~/.claude leak); the sandbox home stands in for it.
  const bodies = JSON.stringify((await suite.mock()).requests.map((request) => request.body));
  expect(bodies.includes(JSON.stringify(os.homedir()).slice(1, -1))).toBe(false);
  expect(bodies.includes(JSON.stringify(sandbox.dirs.work).slice(1, -1))).toBe(true);

  // Names only: no value of a credential variable or of a dropped variable
  // reaches any event the application sees.
  const published = JSON.stringify(collected.events);
  for (const secret of [sandbox.env['ANTHROPIC_API_KEY'], PARENT_EXTRAS.HUDHUD_IT_SECRET_TOKEN]) {
    expect(secret !== undefined && published.includes(secret)).toBe(false);
  }
});

test('object env form, trace and explicit flags reach the child as configured', async () => {
  await suite.setup({ sandbox: { env: PARENT_EXTRAS } });
  const sandbox = await suite.sandbox();
  const { platform } = sandbox;
  const extra = path.join(sandbox.dirs.work, 'extra');
  mkdirSync(extra);
  const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const harness = await suite.testConnect();
  // No onPermission: the Bash tool runs only because the rule allows it, so
  // the real CLI honours `--allowed-tools` (ADR-0011 §4).
  const session = await harness.sessions.create({
    permissionMode: 'acceptEdits',
    workspaceTrust: 'full',
    env: {
      preset: 'inherit',
      add: { HUDHUD_IT_ADDED: 'added-value', HUDHUD_IT_API_TOKEN: 'hudhud-it-added-secret-0002' },
      remove: ['HUDHUD_IT_UNLISTED'],
    },
    trace: { traceparent },
    claudeCode: { allowedTools: ['Bash'], additionalDirectories: [extra] },
  });
  const collected = collect(session);
  const probe = await probeChild(session, sandbox.dirs.work, platform);
  await session.close();
  await collected.done;

  expect(observedArgv(probe, suite.cli.binaryPath)).toEqual([
    suite.cli.binaryPath,
    '--output-format=stream-json',
    '--input-format=stream-json',
    '--verbose',
    '--setting-sources=user,project,local',
    '--permission-mode=acceptEdits',
    `--session-id=${session.id}`,
    '--allowed-tools=Bash',
    `--add-dir=${extra}`,
  ]);

  expectPinned(probe, sandbox.dirs.cfg, platform);
  // 'inherit' passes the parent, minus what no preset passes on, minus
  // `remove`, plus `add`; the trace option replaces the parent's trace.
  expect(envValue(probe, 'HUDHUD_IT_ADDED', platform)).toBe('added-value');
  expect(envValue(probe, 'HUDHUD_IT_API_TOKEN', platform) === 'hudhud-it-added-secret-0002').toBe(
    true,
  );
  expect(envValue(probe, 'HUDHUD_IT_SECRET_TOKEN', platform)).toBe(
    PARENT_EXTRAS.HUDHUD_IT_SECRET_TOKEN,
  );
  expect(envValue(probe, 'HUDHUD_IT_UNLISTED', platform)).toBeUndefined();
  expect(envValue(probe, 'CLAUDE_AGENT_SDK_HUDHUD', platform)).toBeUndefined();
  expect(envValue(probe, 'TRACEPARENT', platform)).toBe(traceparent);
  expect(envValue(probe, 'TRACESTATE', platform)).toBeUndefined();

  expect(diagnostics(collected.events, 'env.added')).toEqual([
    { names: ['HUDHUD_IT_ADDED', 'HUDHUD_IT_API_TOKEN'] },
  ]);
  expect(diagnostics(collected.events, 'env.removed')).toEqual([{ names: ['HUDHUD_IT_UNLISTED'] }]);
  // The credential named in `add` is listed by name in the posture (K19).
  const entries = postureOf(collected.events);
  expect(postureEntry(entries, 'env.credentialAndRoutingVariables')).toMatchObject({
    value: ['HUDHUD_IT_API_TOKEN'],
    deviates: true,
  });
  expect(postureEntry(entries, 'env')?.value).toEqual({
    form: 'object',
    preset: 'inherit',
    add: ['HUDHUD_IT_ADDED', 'HUDHUD_IT_API_TOKEN'],
    remove: ['HUDHUD_IT_UNLISTED'],
  });
  const published = JSON.stringify(collected.events);
  expect(published.includes('hudhud-it-added-secret-0002')).toBe(false);
  expect(published.includes(PARENT_EXTRAS.HUDHUD_IT_SECRET_TOKEN)).toBe(false);
});
