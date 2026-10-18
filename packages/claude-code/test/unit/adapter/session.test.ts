// What the assembled session wires (W5 rulings 1 to 7): the launch (argv,
// environment, cwd, no shell), the session's diagnostics (posture, env,
// guard under 'allow'), user input through the Claude encoder, the
// permission bridge's isolation, the registry rebind on the reported id,
// auth fail-fast (K10), version drift, the binary re-verified at a session,
// and the graceful close's sweep after the exit (ruling 4).

import { describe, expect, it } from 'vitest';

import { AuthenticationFailedError, type HudhudEvent } from '@hudhudjs/core';

import { buildArgv } from '../../../src/argv.js';
import { connectWith, sessionWith } from '../../../src/connect.js';
import { buildChildEnv } from '../../../src/env.js';
import { resolveConnectOptions, resolveSessionOptions } from '../../../src/options.js';
import {
  BINARY,
  captureEvents,
  CLI_PID,
  CLI_START,
  controlOk,
  diagnosticData,
  FakeHost,
  PROJECT,
  settle,
  VERSION,
  type FakeCli,
} from './fake-host.js';

function diagnostic(events: readonly HudhudEvent[] | undefined, code: string): HudhudEvent {
  const found = (events ?? []).find(
    (event) => event.type === 'diagnostic' && (event as { code?: string }).code === code,
  );
  if (found === undefined) throw new Error(`no ${code} diagnostic`);
  return found;
}

function dataOf(event: HudhudEvent): Record<string, unknown> {
  return (event as { data?: Record<string, unknown> }).data ?? {};
}

describe('the launch', () => {
  it('spawns the realpath with the argv and the environment the options build, in the cwd', async () => {
    const fake = new FakeHost();
    const harness = await connectWith(
      { binaryPath: BINARY, claudeCode: { bare: true } },
      fake.make,
    );
    const options = {
      cwd: PROJECT,
      permissionMode: 'plan' as const,
      env: { preset: 'harness' as const, add: { MY_TOOL: '1' }, remove: ['HOME'] },
      claudeCode: { model: 'some-model', allowedTools: ['Read', 'Bash(git status)'] },
    };
    const session = await harness.sessions.create(options);
    const { spec } = fake.cli;
    const connect = resolveConnectOptions({ binaryPath: BINARY, claudeCode: { bare: true } });
    const { effective } = resolveSessionOptions(options);
    expect(spec.file).toBe(BINARY);
    expect(spec.cwd).toBe(PROJECT);
    expect(spec.args).toEqual(
      buildArgv(connect.effective, effective, { mode: 'create', sessionId: session.id }),
    );
    expect(spec.args.every((arg) => arg.startsWith('--'))).toBe(true);
    expect(spec.env).toEqual(
      buildChildEnv(effective, connect.effective, fake.host.env, 'posix').env,
    );
    expect(spec.env).not.toHaveProperty('HOME');
    expect(spec.env).toMatchObject({ MY_TOOL: '1', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' });
    await session.close();
    await harness[Symbol.asyncDispose]();
  });

  it('resume and fork pass --resume (and --fork-session with a new --session-id)', async () => {
    const fake = new FakeHost();
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const resumed = await harness.sessions.resume(id);
    expect(fake.cli.flag('resume')).toBe(id);
    expect(fake.cli.spec.args).not.toContain('--fork-session');
    expect(resumed.info).toMatchObject({ id, mode: 'resume' });
    await resumed.close();
    const forked = await harness.sessions.resume(id, { fork: true });
    expect(fake.cli.flag('resume')).toBe(id);
    expect(fake.cli.spec.args).toContain('--fork-session');
    expect(forked.info).toMatchObject({ mode: 'fork', forkedFrom: id });
    expect(fake.cli.flag('session-id')).toBe(forked.id);
    expect(forked.id).not.toBe(id);
    await forked.close();
    await harness[Symbol.asyncDispose]();
  });

  it('runs on win32 with the job and the Windows paths', async () => {
    const fake = new FakeHost({
      platform: 'win32',
      cwd: 'C:\\work',
      job: 'loaded',
      env: { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows', USERPROFILE: 'D:\\profile' },
    });
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const session = await harness.sessions.create();
    expect(session.info.containment).toBe('job');
    expect(fake.cli.spec.cwd).toBe('C:\\work');
    expect(fake.cli.spec.env).toMatchObject({ SystemRoot: 'C:\\Windows' });
    await session.close();
    await harness[Symbol.asyncDispose]();
  });
});

describe("the session's diagnostics", () => {
  it('reach an application subscriber made after create resolved (pre-handshake replay)', async () => {
    const fake = new FakeHost({ env: { PATH: '/usr/bin', NODE_OPTIONS: '--x' } });
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const session = await harness.sessions.create();
    const events = session.events();
    await session.close();
    const seen: HudhudEvent[] = [];
    for await (const event of events) seen.push(event);
    expect(
      seen.slice(0, 4).map((event) => [event.type, (event as { code?: string }).code]),
    ).toEqual([
      ['compat', undefined],
      ['diagnostic', 'security.posture'],
      ['diagnostic', 'env.dropped'],
      ['session.started', undefined],
    ]);
    expect(seen.map((event) => event.seq)).toEqual(seen.map((_, index) => index));
    await harness[Symbol.asyncDispose]();
  });

  it('publish the posture, the environment changes and the guard results', async () => {
    const fake = new FakeHost();
    fake.guardFs.dir(`${PROJECT}/.git`).json(`${PROJECT}/.claude/settings.json`, {
      env: { ANTHROPIC_BASE_URL: 'http://allowed.example' },
    });
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const captured = captureEvents(harness);
    const session = await harness.sessions.create({
      cwd: PROJECT,
      workspaceTrust: 'full',
      projectCredentialEnv: 'allow',
      env: {
        preset: 'harness',
        add: { ANTHROPIC_API_KEY: 'sk-ant-fake-hudhud-other' },
        remove: ['HOME'],
      },
    });
    await session.close();
    const events = captured[0];
    const posture = dataOf(diagnostic(events, 'security.posture'))['entries'] as {
      setting: string;
      value: unknown;
      deviates: boolean;
    }[];
    const entry = (setting: string): unknown => posture.find((e) => e.setting === setting);
    expect(entry('workspaceTrust')).toMatchObject({ value: 'full', deviates: true });
    expect(entry('projectCredentialEnv')).toMatchObject({ value: 'allow', deviates: true });
    // The allowed project base URL is reported (K23, W3-Z ruling 3).
    expect(entry('managedPolicy')).toMatchObject({ value: 'not-fetched-custom-base-url' });
    expect(entry('env.credentialAndRoutingVariables')).toMatchObject({
      value: ['ANTHROPIC_API_KEY'],
    });
    expect(dataOf(diagnostic(events, 'settings-guard.allowed'))).toEqual({
      variables: ['ANTHROPIC_BASE_URL'],
      apiKeyHelper: false,
      unparseable: [],
      scope: 'git-roots',
    });
    expect(dataOf(diagnostic(events, 'env.added'))).toEqual({ names: ['ANTHROPIC_API_KEY'] });
    expect(dataOf(diagnostic(events, 'env.removed'))).toEqual({ names: ['HOME'] });
    // Nothing of the parent was dropped: no env.dropped.
    expect(() => diagnostic(events, 'env.dropped')).toThrow();
    // Names, never values.
    const text = JSON.stringify(events);
    expect(text).not.toContain('allowed.example');
    expect(text).not.toContain('sk-ant-fake-hudhud-other');
    expect(text).not.toContain('sk-ant-fake-hudhud-0000000000000000');
    await harness[Symbol.asyncDispose]();
  });

  it('report the parent variables the preset dropped, and on win32 the blanked libuv names', async () => {
    const fake = new FakeHost({
      env: { PATH: '/usr/bin', NODE_OPTIONS: '--require=evil.js', CLAUDECODE: '1' },
    });
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const captured = captureEvents(harness);
    const session = await harness.sessions.create();
    await session.close();
    expect(dataOf(diagnostic(captured[0], 'env.dropped'))).toEqual({
      names: ['CLAUDECODE', 'NODE_OPTIONS'],
      spawnInjected: [],
    });
    expect(fake.clis[0]?.spec.env).not.toHaveProperty('NODE_OPTIONS');
    const win = new FakeHost({
      platform: 'win32',
      cwd: 'C:\\work',
      env: { SystemRoot: 'C:\\Windows' },
    });
    const winHarness = await connectWith({ binaryPath: BINARY }, win.make);
    const winCaptured = captureEvents(winHarness);
    const winSession = await winHarness.sessions.create();
    await winSession.close();
    expect(dataOf(diagnostic(winCaptured[0], 'env.dropped'))['spawnInjected']).toContain(
      'HOMEDRIVE',
    );
    await harness[Symbol.asyncDispose]();
    await winHarness[Symbol.asyncDispose]();
  });

  it("'allow' with an unparseable project file reports managedPolicy as unknown (Q6)", async () => {
    const fake = new FakeHost();
    fake.guardFs.dir(`${PROJECT}/.git`).file(`${PROJECT}/.claude/settings.json`, '{oops');
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const session = await harness.sessions.create({
      cwd: PROJECT,
      workspaceTrust: 'full',
      projectCredentialEnv: 'allow',
    });
    const events = session.events();
    await session.close();
    const seen: HudhudEvent[] = [];
    for await (const event of events) seen.push(event);
    const entries = diagnosticData(seen, 'security.posture')['entries'] as {
      setting: string;
      value: unknown;
    }[];
    expect(entries.find((entry) => entry.setting === 'managedPolicy')?.value).toBe(
      'unknown-project-settings-unreadable',
    );
    expect(diagnosticData(seen, 'settings-guard.allowed')).toMatchObject({
      unparseable: [`${PROJECT}/.claude/settings.json`],
    });
    await harness[Symbol.asyncDispose]();
  });

  it("'allow' with nothing to allow adds no settings-guard.allowed diagnostic", async () => {
    const fake = new FakeHost();
    fake.guardFs.dir(`${PROJECT}/.git`);
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const captured = captureEvents(harness);
    const session = await harness.sessions.create({
      cwd: PROJECT,
      workspaceTrust: 'full',
      projectCredentialEnv: 'allow',
    });
    await session.close();
    expect(() => diagnostic(captured[0], 'settings-guard.allowed')).toThrow();
    await harness[Symbol.asyncDispose]();
  });

  it("the guard skips the child's config directory, not the parent's (R1-4)", async () => {
    // The parent names a config directory the explicit env map does not pass
    // on, so the CLI uses ~/.claude. The guard's ancestor fallback (forced
    // by a symlinked .git) must skip ~/.claude as the user's config
    // directory, not read its user settings as project settings.
    const fake = new FakeHost({
      cwd: '/home/user/proj',
      env: {
        PATH: '/usr/bin',
        HOME: '/home/user',
        CLAUDE_CONFIG_DIR: '/srv/cc',
        ANTHROPIC_API_KEY: 'sk-ant-fake-hudhud-0000000000000000',
      },
    });
    fake.guardFs
      .dir('/srv/cc')
      .dir('/elsewhere/gitdir')
      .link('/home/user/proj/.git', '/elsewhere/gitdir')
      .json('/home/user/.claude/settings.json', {
        env: { ANTHROPIC_BASE_URL: 'http://users-own.example' },
      });
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const captured = captureEvents(harness);
    const session = await harness.sessions.create({
      cwd: '/home/user/proj',
      workspaceTrust: 'full',
      env: {
        PATH: '/usr/bin',
        HOME: '/home/user',
        ANTHROPIC_API_KEY: 'sk-ant-fake-hudhud-0000000000000000',
      },
    });
    await session.close();
    expect(fake.cli.spec.env['CLAUDE_CONFIG_DIR']).toBeUndefined();
    expect(dataOf(diagnostic(captured[0], 'settings-guard.git-root-unresolved'))).toMatchObject({
      reason: 'git-entry-symlink',
    });
    await harness[Symbol.asyncDispose]();
  });

  it('the guard diagnostics of a refusing guard that passed are published too', async () => {
    const fake = new FakeHost();
    // No .git anywhere and a symlinked settings file: the fallback and the link are reported.
    fake.guardFs
      .json('/elsewhere/settings.json', {})
      .link(`${PROJECT}/.claude/settings.json`, '/elsewhere/settings.json');
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const captured = captureEvents(harness);
    const session = await harness.sessions.create({ cwd: PROJECT, workspaceTrust: 'full' });
    await session.close();
    expect(dataOf(diagnostic(captured[0], 'settings-guard.symlink-followed'))).toMatchObject({
      path: `${PROJECT}/.claude/settings.json`,
    });
    await harness[Symbol.asyncDispose]();
  });
});

describe('the session driver wiring', () => {
  it('sends user input through the Claude encoder (ruling 5)', async () => {
    const fake = new FakeHost();
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const session = await harness.sessions.create();
    await session.ask({
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', mediaType: 'image/png', dataBase64: 'aGk=' },
      ],
    });
    const user = fake.cli.written.find((frame) => frame['type'] === 'user');
    expect((user?.['message'] as Record<string, unknown>)['content']).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
    ]);
    await session.close();
    await harness[Symbol.asyncDispose]();
  });

  it('a throwing permission handler is answered with a deny, never an allow', async () => {
    const fake = new FakeHost({
      script: {
        onWrite: (frame, cli) => {
          if (frame['type'] === 'user') {
            cli.emit({ type: 'system', subtype: 'init', session_id: cli.sessionId, uuid: 'i' });
            cli.emit({
              type: 'control_request',
              request_id: 'perm-1',
              request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, tool_use_id: 't1' },
            });
            return true;
          }
          if (frame['type'] === 'control_response') {
            cli.emit({
              type: 'result',
              subtype: 'success',
              is_error: false,
              result: 'ok',
              num_turns: 1,
              session_id: cli.sessionId,
              user_message_uuid: String(
                cli.written.find((written) => written['type'] === 'user')?.['uuid'],
              ),
            });
            cli.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
            return true;
          }
          return undefined;
        },
      },
    });
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const session = await harness.sessions.create({
      onPermission: () => Promise.reject(new Error('handler bug')),
    });
    expect(fake.cli.spec.args).toContain('--permission-prompt-tool=stdio');
    await session.ask('run it');
    const answer = fake.cli.written.find((frame) => frame['type'] === 'control_response');
    expect(JSON.stringify(answer)).toContain('"behavior":"deny"');
    expect(JSON.stringify(answer)).not.toContain('"behavior":"allow"');
    await session.close();
    await harness[Symbol.asyncDispose]();
  });

  it('auth fail-fast names the credential (K10, ruling 7)', async () => {
    const fake = new FakeHost({
      script: {
        onWrite: (frame, cli) => {
          if (frame['type'] !== 'user') return undefined;
          cli.emit({ type: 'system', subtype: 'init', session_id: cli.sessionId, uuid: 'i' });
          cli.emit({
            type: 'result',
            subtype: 'success',
            is_error: true,
            api_error_status: 401,
            num_turns: 1,
            session_id: cli.sessionId,
            user_message_uuid: String(frame['uuid']),
          });
          return true;
        },
      },
    });
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const session = await harness.sessions.create();
    const error = await session.ask('hi').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuthenticationFailedError);
    expect(error).toMatchObject({ details: { credentialSource: 'ANTHROPIC_API_KEY' } });
    await session.closed;
    expect(fake.cli.exitStatus).not.toBeNull();
    await harness[Symbol.asyncDispose]();
  });

  it('an untested drift is a warning; the session runs', async () => {
    const fake = new FakeHost({ script: { init: { claude_code_version: '2.1.400' } } });
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const captured = captureEvents(harness);
    const session = await harness.sessions.create();
    expect(session.info.version).toBe('2.1.400');
    await session.close();
    expect(dataOf(diagnostic(captured[0], 'binary.version-changed'))).toEqual({
      probedVersion: VERSION,
      version: '2.1.400',
      knownBroken: false,
    });
    await harness[Symbol.asyncDispose]();
  });

  it('a binary updated to another version after connect is probed and reported at the session', async () => {
    const fake = new FakeHost();
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    fake.binary = {
      ...fake.binary,
      mtimeMs: 5000,
      ino: 9,
      sha256: 'd'.repeat(64),
      version: '2.1.400',
    };
    const captured = captureEvents(harness);
    const session = await harness.sessions.create();
    expect(session.info.version).toBe('2.1.400');
    await session.close();
    expect(dataOf(diagnostic(captured[0], 'binary.version-changed'))).toEqual({
      probedVersion: VERSION,
      version: '2.1.400',
      reverified: true,
    });
    expect(captured[0]?.[0]).toMatchObject({
      type: 'compat',
      compat: { version: '2.1.400', status: 'untested' },
    });
    // The connect facts stay as connected; later sessions use the new binary.
    expect(harness.binary.version).toBe(VERSION);
    expect(harness.current.version).toBe('2.1.400');
    await harness[Symbol.asyncDispose]();
  });
});

describe('the registry follows the reported session id (ruling 6)', () => {
  it('rebinds on system/init and releases at the end', async () => {
    const observed = '99999999-9999-4999-8999-999999999999';
    const fake = new FakeHost({ script: { sessionId: observed } });
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const session = await harness.sessions.resume(id);
    expect(harness.registry.has(id)).toBe(true);
    await session.ask('hi');
    expect(harness.registry.has(observed)).toBe(true);
    expect(harness.registry.has(id)).toBe(false);
    await session.close();
    await settle();
    expect(harness.registry.size).toBe(0);
    await harness[Symbol.asyncDispose]();
  });

  it('a reported id that another live session holds aborts the session (J6)', async () => {
    const fake = new FakeHost();
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const first = await harness.sessions.create();
    fake.script = { sessionId: first.id };
    const captured = captureEvents(harness);
    const second = await harness.sessions.resume('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    const cli: FakeCli = fake.cli;
    await second.ask('hi').catch(() => undefined);
    await second.closed;
    expect(dataOf(diagnostic(captured[0], 'session.id-in-use'))).toEqual({
      sessionId: first.id,
    });
    expect(cli.exitStatus).not.toBeNull();
    expect(harness.registry.has(first.id)).toBe(true);
    await first.close();
    await harness[Symbol.asyncDispose]();
  });

  it('an id the registry cannot hold keeps the claim on the expected id', async () => {
    const fake = new FakeHost({ script: { sessionId: 'x'.repeat(200) } });
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const session = await harness.sessions.resume(id);
    await session.ask('hi');
    expect(harness.registry.has(id)).toBe(true);
    await session.close();
    await harness[Symbol.asyncDispose]();
  });
});

describe('the graceful close sweeps after the exit (ruling 4)', () => {
  it('kills a descendant that outlived the CLI and reports the sweep', async () => {
    const fake = new FakeHost();
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const captured = captureEvents(harness);
    const session = await harness.sessions.create();
    // The CLI left a tool running (the rg child of research W3-T6).
    fake.processes.set(5000, { pid: 5000, ppid: CLI_PID, pgid: 90, startTime: '800', name: 'rg' });
    await session.close();
    expect(fake.signals).toContain('5000:SIGKILL');
    const sweep = dataOf(diagnostic(captured[0], 'termination.sweep-after-exit'));
    expect(sweep).toMatchObject({ status: 'done' });
    expect(fake.processes.has(5000)).toBe(false);
    expect(fake.processes.has(CLI_PID)).toBe(false);
    expect(CLI_START).toBe('777');
    await harness[Symbol.asyncDispose]();
  });
});

describe('session(): one call', () => {
  it('opens a strict session in one call', async () => {
    const fake = new FakeHost();
    const session = await sessionWith(
      { binaryPath: BINARY, binaryVerification: 'strict', permissionMode: 'acceptEdits' },
      fake.make,
    );
    expect(session.info.version).toBe(VERSION);
    await session.close();
  });

  it('an abort during the handshake ends the session and rejects with AbortError', async () => {
    const fake = new FakeHost({ script: { initFrame: () => null } });
    const controller = new AbortController();
    const pending = sessionWith({ binaryPath: BINARY, signal: controller.signal }, fake.make).catch(
      (error: unknown) => error,
    );
    await settle();
    await settle();
    expect(fake.clis).toHaveLength(1);
    controller.abort('stop');
    expect(await pending).toMatchObject({ code: 'ABORTED' });
    expect(fake.cli.exitStatus).not.toBeNull();
  });
});

describe('no answer to initialize within the watchdog', () => {
  it('is HANDSHAKE_TIMEOUT after the ladder ran', async () => {
    const fake = new FakeHost({ script: { initFrame: () => null } });
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const pending = harness.sessions.create({ firstFrameTimeoutMs: 1000 }).catch((e: unknown) => e);
    await settle();
    fake.clock.advance(1000);
    expect(await pending).toMatchObject({ code: 'HANDSHAKE_TIMEOUT' });
    expect(fake.cli.exitStatus).not.toBeNull();
    await harness[Symbol.asyncDispose]();
  });

  it('answering late still works with the default', async () => {
    let answer: (() => void) | undefined;
    const fake = new FakeHost({
      script: {
        initFrame: (requestId) => {
          answer = () => {
            fake.cli.emit(fake.cli.initResponse(requestId));
          };
          return null;
        },
      },
    });
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const pending = harness.sessions.create();
    await settle();
    answer?.();
    const session = await pending;
    expect(controlOk('x', {})).toMatchObject({ type: 'control_response' });
    await session.close();
    await harness[Symbol.asyncDispose]();
  });
});
