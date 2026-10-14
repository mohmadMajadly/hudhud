// Property (fast-check): for random valid session options, the assembled
// adapter spawns exactly the argv of buildArgv (every element a `--flag`,
// no value outside its own element, ADR-0011 §3), exactly the environment
// of buildChildEnv (nothing added on the way, ADR-0012 §4), and publishes
// the posture claudePostureEntries computes for those options (K19, K23).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildPosture, type HudhudEvent } from '@hudhud/core';

import { buildArgv } from '../../../src/argv.js';
import { connectWith } from '../../../src/connect.js';
import { buildChildEnv } from '../../../src/env.js';
import {
  resolveConnectOptions,
  resolveSessionOptions,
  type SessionOptions,
} from '../../../src/options.js';
import { claudePostureEntries } from '../../../src/posture.js';
import { BINARY, captureEvents, FakeHost, PROJECT } from './fake-host.js';

/** Strings an option may carry: spaces, dashes, `=`, commas, quotes, shell syntax. */
const text = fc.stringMatching(/^[ -~]{1,24}$/u);

const sessionOptions: fc.Arbitrary<SessionOptions> = fc.record(
  {
    permissionMode: fc.constantFrom('default', 'acceptEdits', 'plan', 'dontAsk', 'auto'),
    workspaceTrust: fc.constantFrom('none', 'full'),
    env: fc.oneof(
      fc.constantFrom('harness', 'inherit'),
      fc.record({
        preset: fc.constantFrom('harness', 'inherit'),
        add: fc.dictionary(fc.stringMatching(/^[A-Z][A-Z0-9_]{0,8}$/u), text, { maxKeys: 3 }),
      }),
    ),
    autoUpdate: fc.constantFrom('disabled', 'harness-default'),
    nonessentialTraffic: fc.constantFrom('disabled', 'harness-default'),
    dangerouslyAllowConfigWrites: fc.boolean(),
    claudeCode: fc.record(
      {
        model: text,
        appendSystemPrompt: text,
        maxTurns: fc.integer({ min: 1, max: 99 }),
        includePartialMessages: fc.boolean(),
        allowedTools: fc.subarray(['Read', 'Bash(git status)', 'Edit', 'mcp__srv__tool']),
        additionalDirectories: fc.array(fc.stringMatching(/^\/[a-z]{1,8}$/u), { maxLength: 2 }),
      },
      { requiredKeys: [] },
    ),
  },
  { requiredKeys: [] },
);

function postureOf(events: readonly HudhudEvent[] | undefined): unknown {
  const event = events?.find((e) => (e as { code?: string }).code === 'security.posture');
  return (event as { data?: { entries?: unknown } } | undefined)?.data?.entries;
}

describe('the launch of random options (property)', () => {
  it('spawns exactly the built argv and environment and publishes the computed posture', async () => {
    const fake = new FakeHost();
    fake.guardFs.dir(`${PROJECT}/.git`);
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const connect = resolveConnectOptions({ binaryPath: BINARY }).effective;
    await fc.assert(
      fc.asyncProperty(sessionOptions, async (options) => {
        const captured = captureEvents(harness);
        const session = await harness.sessions.create(options);
        const { spec } = fake.cli;
        await session.close();
        const { effective } = resolveSessionOptions(options);
        expect(spec.args).toEqual(
          buildArgv(connect, effective, { mode: 'create', sessionId: session.id }),
        );
        for (const arg of spec.args) expect(arg.startsWith('--')).toBe(true);
        const env = buildChildEnv(effective, connect, fake.host.env, 'posix').env;
        expect(spec.env).toEqual(env);
        const expected = buildPosture(
          claudePostureEntries({
            connect,
            session: effective,
            env,
            userSettings: {
              present: false,
              readable: true,
              customBaseUrl: false,
              thirdPartyProvider: false,
            },
            platform: 'posix',
          }),
        ).entries.map((entry) => ({ ...entry }));
        expect(postureOf(captured.at(-1))).toEqual(expected);
      }),
      { numRuns: 60 },
    );
    await harness[Symbol.asyncDispose]();
  });
});
