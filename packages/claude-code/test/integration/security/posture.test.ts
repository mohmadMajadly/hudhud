// `securityPosture` of a real connect and a real session (W6-T4; plan §1.9,
// §2.4; ADR-0012 §5, §7; K19, K23). The posture is computed by the product
// from its effective options; here it is checked end to end against the
// pinned CLI: the defaults deviate only where the sandbox itself deviates
// (an isolated config directory; a custom base URL, so managed policy is not
// fetched, 07 §3.2 W101-W104 and §11 item 1), every opt-in shows up as a
// deviation, and no value of the environment or a path leaks into it.

import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { SecurityPostureEntry } from '@hudhud/core';
import { expect, test } from 'vitest';

import { integrationSuite } from '../support/harness.js';
import { collect, postureOf } from './support.js';

const suite = integrationSuite();

const deviating = (entries: readonly SecurityPostureEntry[]): string[] =>
  entries.filter((entry) => entry.deviates).map((entry) => entry.setting);

const settings = (entries: readonly SecurityPostureEntry[]): string[] =>
  entries.map((entry) => entry.setting);

/** Connect entries in plan §2.4 order, then the session's, then the derived ones. */
const CONNECT_SETTINGS = [
  'binaryVerification',
  'claudeCode.configDir',
  'claudeCode.bare',
  'claudeCode.dangerouslyAllowRawControl',
  'claudeCode.dangerouslyAllowKnownBrokenVersion',
];
const SESSION_SETTINGS = [
  'permissionMode',
  'dangerouslyAllowBypassPermissions',
  'permissionPrompting',
  'workspaceTrust',
  'claudeCode.settingSources',
  'projectCredentialEnv',
  'env',
  'env.credentialAndRoutingVariables',
  'autoUpdate',
  'nonessentialTraffic',
  'dangerouslyAllowConfigWrites',
  'claudeCode.allowedTools',
  'claudeCode.disallowedTools',
  'claudeCode.additionalDirectories',
  'initialize.workspaceTrust',
  'permissionSuggestions',
];
const DERIVED_SETTINGS = ['managedPolicy', 'raw.extraArgs', 'raw.extraEnv'];

test('defaults: the connect and session posture deviate only where the sandbox does', async () => {
  const sandbox = await suite.sandbox();
  const harness = await suite.testConnect();
  const connectEntries = harness.securityPosture.entries;
  expect(settings(connectEntries)).toEqual([...CONNECT_SETTINGS, ...DERIVED_SETTINGS]);
  expect(deviating(connectEntries)).toEqual(['claudeCode.configDir', 'managedPolicy']);
  expect(connectEntries.find((entry) => entry.setting === 'claudeCode.configDir')?.value).toBe(
    'isolated',
  );
  expect(connectEntries.find((entry) => entry.setting === 'managedPolicy')?.value).toBe(
    'not-fetched-custom-base-url',
  );

  const session = await harness.sessions.create();
  const collected = collect(session);
  await session.ask('[[mock:text]] posture');
  await session.close();
  await collected.done;
  const entries = postureOf(collected.events);
  expect(settings(entries)).toEqual([
    ...CONNECT_SETTINGS,
    ...SESSION_SETTINGS,
    ...DERIVED_SETTINGS,
  ]);
  expect(deviating(entries)).toEqual(['claudeCode.configDir', 'managedPolicy']);
  // The fixed v1 constants are stated (plan §2.4).
  expect(entries.find((entry) => entry.setting === 'initialize.workspaceTrust')?.value).toBe(
    'never-sent',
  );
  expect(entries.find((entry) => entry.setting === 'permissionSuggestions')?.value).toBe(
    'never-applied',
  );
  // No path and no environment value: the config directory is a kind.
  const text = JSON.stringify([connectEntries, entries]);
  expect(text.includes(sandbox.dirs.root)).toBe(false);
  expect(text.includes(sandbox.mockUrl)).toBe(false);
  expect(text.includes(String(sandbox.env['ANTHROPIC_API_KEY']))).toBe(false);
});

test('every opt-in is a deviation of the session posture', async () => {
  const sandbox = await suite.sandbox();
  const extra = path.join(sandbox.dirs.work, 'extra');
  mkdirSync(extra);
  const harness = await suite.testConnect();
  const session = await harness.sessions.create({
    permissionMode: 'acceptEdits',
    workspaceTrust: 'full',
    projectCredentialEnv: 'allow',
    env: { preset: 'inherit', add: { HUDHUD_IT_POSTURE_TOKEN: 'posture-secret-0003' } },
    autoUpdate: 'harness-default',
    nonessentialTraffic: 'harness-default',
    dangerouslyAllowConfigWrites: true,
    onPermission: () => Promise.resolve({ behavior: 'deny', message: 'posture test' }),
    claudeCode: {
      allowedTools: ['Read'],
      disallowedTools: ['WebFetch'],
      additionalDirectories: [extra],
    },
  });
  const collected = collect(session);
  await session.ask('[[mock:text]] posture-opt-in');
  await session.close();
  await collected.done;
  const entries = postureOf(collected.events);
  const expected = [
    'claudeCode.configDir',
    'permissionMode',
    'permissionPrompting',
    'workspaceTrust',
    'claudeCode.settingSources',
    'projectCredentialEnv',
    'env',
    'env.credentialAndRoutingVariables',
    'autoUpdate',
    'nonessentialTraffic',
    'dangerouslyAllowConfigWrites',
    'claudeCode.allowedTools',
    'claudeCode.disallowedTools',
    'claudeCode.additionalDirectories',
    'managedPolicy',
  ];
  expect(deviating(entries)).toEqual(expected);
  expect(
    entries.find((entry) => entry.setting === 'env.credentialAndRoutingVariables')?.value,
  ).toEqual(['HUDHUD_IT_POSTURE_TOKEN']);
  expect(JSON.stringify(entries).includes('posture-secret-0003')).toBe(false);
});
