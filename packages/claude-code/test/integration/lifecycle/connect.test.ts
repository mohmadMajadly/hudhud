// Lifecycle (W6-T1, plan §4.4 "lifecycle", §5.8): what `connect` reports
// about the pinned CLI through the product's real pipeline (discovery,
// verification, the one `--version` probe, the version policy, the posture
// and the capabilities; plan §1.8 "Connect"), and how a session repeats it.

import type { SecurityPostureEntry } from '@hudhud/core';
import { beforeEach, expect, test } from 'vitest';

import { CLAUDE_CODE_COMPAT } from '../../../src/index.js';
import { integrationSuite } from '../support/harness.js';
import { diagnostics, ofType, record, terminatedOf, identityFirst } from './events.js';

const suite = integrationSuite();

// Every CLI reaches the product only once its identity was read (see identityFirst).
beforeEach(() => {
  suite.onSpawn(identityFirst);
});

function entry(entries: readonly SecurityPostureEntry[], setting: string): SecurityPostureEntry {
  const found = entries.find((candidate) => candidate.setting === setting);
  if (found === undefined) throw new Error(`no posture entry ${setting}`);
  return found;
}

// 05 §1 (the pinned binary and its sha256), K4 (one probe), K8/K9 (advisory
// verification against the digest table), ADR-0004 §4 (the tested window).
test('connect: binary info, compat, capabilities and posture of the pinned CLI', async () => {
  const harness = await suite.testConnect();

  expect(harness.binary).toEqual({
    path: suite.cli.binaryPath,
    version: suite.cli.version,
    source: 'option',
    verification: {
      status: 'verified',
      method: 'sha256-manifest',
      mode: 'advisory',
      detail: `sha256 matches ${suite.cli.version}`,
    },
  });

  // The pin is the tested window (K16: the bump moves both together).
  expect(harness.compat).toEqual({
    harness: 'claude-code',
    version: suite.cli.version,
    minTested: CLAUDE_CODE_COMPAT.minTested,
    maxTested: CLAUDE_CODE_COMPAT.maxTested,
    knownBroken: [...CLAUDE_CODE_COMPAT.knownBroken],
    status: 'tested',
  });

  const { capabilities } = harness;
  expect(capabilities).toMatchObject({
    multiTurn: 'supported',
    resume: 'supported',
    fork: 'supported',
    interrupt: 'supported',
    permissionsInBand: 'supported',
    workspaceTrust: { none: 'supported', context: 'unsupported', full: 'supported' },
  });
  expect(capabilities.reasons['workspaceTrust.context']).toMatch(/07 §10/);
  // K2: the job only on Windows with the addon loaded; otherwise best effort, with the reason.
  if (process.platform === 'win32' && capabilities.processContainment === 'job') {
    expect(capabilities.reasons['processContainment']).toBeUndefined();
  } else {
    expect(capabilities.processContainment).toBe('best-effort');
    expect(capabilities.reasons['processContainment']).toMatch(/^job addon unavailable: /);
  }

  // The posture of the sandboxed connect (plan §2.4; K23): the isolated
  // config directory and the mock as base URL deviate, nothing else does.
  const { entries } = harness.securityPosture;
  expect(entry(entries, 'claudeCode.configDir')).toEqual({
    setting: 'claudeCode.configDir',
    value: 'isolated',
    defaultValue: 'user',
    deviates: true,
  });
  expect(entry(entries, 'managedPolicy')).toMatchObject({
    value: 'not-fetched-custom-base-url',
    deviates: true,
  });
  expect(entry(entries, 'binaryVerification')).toMatchObject({
    value: 'advisory',
    deviates: false,
  });
  expect(
    entries
      .filter((candidate) => candidate.deviates)
      .map((candidate) => candidate.setting)
      .sort(),
  ).toEqual(['claudeCode.configDir', 'managedPolicy']);
  // Values never carry paths or secrets (K23).
  const text = JSON.stringify(entries);
  expect(text).not.toContain((await suite.sandbox()).dirs.cfg);
  expect(text).not.toContain('sk-ant-');
});

// The session repeats connect's facts (plan §2.2 `events()` starts with the
// replayed `compat`) and publishes its own posture first (plan §2.4, §1.8
// step 3); a deviating session option shows in it and reaches the CLI.
test('a session replays compat and publishes its posture through the pipeline', async () => {
  const harness = await suite.testConnect();
  const session = await harness.sessions.create({ permissionMode: 'plan' });
  const recording = record(session);
  await session.close();
  const events = await recording.done;

  expect(events[0]).toMatchObject({ type: 'compat', seq: 0, compat: harness.compat });
  const [posture] = diagnostics(events, 'security.posture');
  const published = posture?.data?.['entries'];
  expect(Array.isArray(published)).toBe(true);
  // JSON data of the diagnostic; its entries are compared field by field below.
  const sessionEntries = (Array.isArray(published)
    ? published
    : []) as unknown as readonly SecurityPostureEntry[];
  // The connect entries, then the session's own.
  for (const connectEntry of harness.securityPosture.entries) {
    expect(sessionEntries).toContainEqual(connectEntry);
  }
  expect(entry(sessionEntries, 'permissionMode')).toEqual({
    setting: 'permissionMode',
    value: 'plan',
    defaultValue: 'default',
    deviates: true,
  });
  // The CLI runs in the mode the posture names (its initialize response).
  expect(ofType(events, 'session.started')[0]?.permissionMode).toBe('plan');
  expect(terminatedOf(events)).toMatchObject({ intent: 'close', outcome: 'closed' });
});

// Version drift (K4, W5 ruling 1): a session re-verifies the binary at its
// spawn gate and compares the version its CLI reports with the probe. Under
// the integration rules the binary can be neither replaced (the harness
// re-checks the pinned file before every launch) nor made to report another
// version, so what is reproducible is the absence of drift: the probed, the
// reported and the replayed versions agree and no drift diagnostic appears.
// The drift paths themselves are covered by the session-factory and session
// machine unit tests.
test('version drift reporting: no drift between the probe and the running CLI', async () => {
  const harness = await suite.testConnect();
  const first = await harness.sessions.create();
  const second = await harness.sessions.create();
  const recordings = [record(first), record(second)];
  for (const session of [first, second]) {
    await session.ask('[[mock:text]] version');
    expect(session.info.version).toBe(harness.binary.version);
    await session.close();
  }
  for (const recording of recordings) {
    const events = await recording.done;
    expect(diagnostics(events, 'binary.version-changed')).toEqual([]);
    expect(ofType(events, 'session.started')[0]?.version).toBe(harness.binary.version);
    expect(ofType(events, 'compat')[0]?.compat.status).toBe('tested');
    const turnStarted = ofType(events, 'turn.started')[0];
    expect(JSON.stringify(turnStarted?.raw)).toContain(
      `"claude_code_version":"${harness.binary.version}"`,
    );
  }
  expect(harness.binary.version).toBe(suite.cli.version);
});
