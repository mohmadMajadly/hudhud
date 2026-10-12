import { describe, expect, it } from 'vitest';

import { classifyLaunch, classifyStall, watchdogState } from '../src/causes.js';
import { result } from './sim.js';

const record = (
  name: string,
): { pid: number; ppid: number; pgid: number; startTime: string; name: string } => ({
  pid: 10,
  ppid: 1,
  pgid: 10,
  startTime: '1',
  name,
});

describe('classifyLaunch', () => {
  it('names spawn errors', () => {
    expect(classifyLaunch(result('', { error: 'ENOENT', code: null }))).toBe('binary-missing');
    expect(classifyLaunch(result('', { error: 'EACCES', code: null }))).toBe('launch-denied');
    expect(classifyLaunch(result('', { error: 'EPERM', code: null }))).toBe('launch-denied');
    expect(classifyLaunch(result('', { error: 'ETIMEDOUT', code: null }))).toBe('launch-hang');
    expect(classifyLaunch(result('', { error: 'E2BIG', code: null }))).toBe('spawn-error');
  });

  it('names exits', () => {
    expect(classifyLaunch(result('2.1.296'))).toBe('ok');
    expect(classifyLaunch(result('', { code: null, signal: 'SIGKILL' }))).toBe('killed-at-launch');
    expect(classifyLaunch(result('partial', { code: null, signal: 'SIGKILL' }))).toBe(
      'exit-failure',
    );
    expect(classifyLaunch(result('', { code: null, signal: 'SIGABRT' }))).toBe('exit-failure');
    expect(classifyLaunch(result('', { code: 1 }))).toBe('exit-failure');
  });
});

describe('classifyStall', () => {
  it('names a Keychain lookup first', () => {
    expect(
      classifyStall({
        descendants: [record('/usr/bin/security'), record('-zsh')],
        toolRunning: true,
        shellSnapshotReady: false,
      }),
    ).toBe('keychain-access');
  });

  it('names a login shell without a snapshot', () => {
    for (const shell of ['-zsh', '/bin/bash', 'sh']) {
      expect(
        classifyStall({
          descendants: [record(shell)],
          toolRunning: true,
          shellSnapshotReady: false,
        }),
      ).toBe('shell-snapshot');
    }
  });

  it('separates a slow tool and an unknown stall', () => {
    const shell = [record('/bin/zsh'), record('/bin/sleep')];
    expect(classifyStall({ descendants: shell, toolRunning: true, shellSnapshotReady: true })).toBe(
      'tool-running',
    );
    expect(
      classifyStall({ descendants: shell, toolRunning: false, shellSnapshotReady: true }),
    ).toBe('unknown');
    expect(classifyStall({ descendants: [], toolRunning: false, shellSnapshotReady: false })).toBe(
      'unknown',
    );
  });
});

describe('watchdogState', () => {
  const limits = { firstFrameMs: 30, idleMs: 10 };

  it('times out the first frame', () => {
    expect(
      watchdogState({ now: 29, startedAt: 0, lastFrameAt: undefined, turnOpen: true }, limits),
    ).toBe('ok');
    expect(
      watchdogState({ now: 30, startedAt: 0, lastFrameAt: undefined, turnOpen: true }, limits),
    ).toBe('first-frame-timeout');
  });

  it('reports a stall only while a turn is open', () => {
    expect(watchdogState({ now: 20, startedAt: 0, lastFrameAt: 10, turnOpen: true }, limits)).toBe(
      'stalled',
    );
    expect(watchdogState({ now: 19, startedAt: 0, lastFrameAt: 10, turnOpen: true }, limits)).toBe(
      'ok',
    );
    expect(watchdogState({ now: 99, startedAt: 0, lastFrameAt: 10, turnOpen: false }, limits)).toBe(
      'ok',
    );
  });
});
