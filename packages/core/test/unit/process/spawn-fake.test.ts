// spawnProcess against a fake child: the branches a real OS cannot be made
// to produce on demand (synchronous spawn throws, a missing pid, pipe errors
// at chosen moments). The real-process tests are in spawn.test.ts.

import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  osCallsFor,
  processTableStartTime,
  ProcessSpawnError,
  ProcessStreamError,
  spawnProcess,
  SpawnSpecError,
  type SpawnFunction,
  type SpawnSpec,
  type StartTimeReader,
} from '../../../src/process/spawn.js';
import { bytes, fixture, fixtureProcTable } from '../../process/tree/support.js';

class FakeChild extends EventEmitter {
  stdin: Writable = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kills: string[] = [];

  kill(signal: string): boolean {
    this.kills.push(signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: Readonly<Record<string, unknown>>;
}

/** A spawn that records its call and hands back `child`, emitting 'spawn' unless told otherwise. */
function fakeSpawn(
  child: FakeChild,
  behaviour: 'spawn' | { readonly error: Error } | 'silent' = 'spawn',
): { readonly spawn: SpawnFunction; readonly calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn = (file: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ file, args, options });
    queueMicrotask(() => {
      if (behaviour === 'spawn') child.emit('spawn');
      else if (behaviour !== 'silent') child.emit('error', behaviour.error);
    });
    return child;
  };
  return { spawn: spawn as unknown as SpawnFunction, calls };
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

const reader: StartTimeReader = { source: 'linux-proc', read: () => Promise.resolve('99') };

const SPEC: SpawnSpec = {
  file: '/opt/harness/bin/harness',
  args: ['--a=1'],
  cwd: '/work',
  env: { HUDHUD_API_KEY: 'sk-fake-0123456789', PATH: '/usr/bin' },
};

function deps(spawn: SpawnFunction, platform: NodeJS.Platform = 'linux') {
  return { spawn, platform, startTime: reader };
}

describe('spawnProcess options', () => {
  it('spawns with no shell, hidden window, not detached, three pipes and a null-prototype env copy', async () => {
    const child = new FakeChild();
    const { spawn, calls } = fakeSpawn(child);
    const handle = await spawnProcess(SPEC, deps(spawn));
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.file).toBe(SPEC.file);
    expect(call?.args).toEqual(['--a=1']);
    expect(call?.args).not.toBe(SPEC.args);
    expect(call?.options).toMatchObject({
      cwd: '/work',
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: false,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const env = call?.options['env'] as Record<string, string>;
    expect(Object.getPrototypeOf(env)).toBeNull();
    expect({ ...env }).toEqual(SPEC.env);
    expect(handle.identity).toEqual({ pid: 4242, startTime: '99' });
  });
});

describe('spawnProcess spec checks', () => {
  it('refuses Windows env names that are equal ignoring case', async () => {
    const child = new FakeChild();
    const { spawn, calls } = fakeSpawn(child);
    const spec = {
      ...SPEC,
      file: 'C:\\h\\harness.exe',
      cwd: 'C:\\work',
      env: { Path: 'a', PATH: 'b' },
    };
    await expect(spawnProcess(spec, deps(spawn, 'win32'))).rejects.toEqual(
      new SpawnSpecError('env-duplicate-name', 'PATH'),
    );
    expect(calls).toHaveLength(0);
    // The same names are distinct on POSIX.
    await expect(
      spawnProcess({ ...SPEC, env: { Path: 'a', PATH: 'b' } }, deps(spawn)),
    ).resolves.toBeDefined();
  });

  it('refuses .bat and .cmd on Windows', async () => {
    const { spawn } = fakeSpawn(new FakeChild());
    const spec = { ...SPEC, file: 'C:\\h\\harness.CMD', cwd: 'C:\\work' };
    await expect(spawnProcess(spec, deps(spawn, 'win32'))).rejects.toMatchObject({
      problem: 'file-refused',
      subject: 'batch-file',
    });
  });
});

describe('spawn failures', () => {
  it.each([
    ['EACCES', 'eacces'],
    ['EPERM', 'eperm'],
    ['EMFILE', 'unknown'],
  ])('maps an %s error event to %s and destroys the pipes', async (code, reason) => {
    const child = new FakeChild();
    const { spawn } = fakeSpawn(child, { error: errno(code) });
    const error: unknown = await spawnProcess(SPEC, deps(spawn)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProcessSpawnError);
    expect(error).toMatchObject({ code: 'SPAWN_FAILED', reason, errno: code });
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stdin.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });

  it('maps a synchronous throw from spawn, with or without an errno', async () => {
    const throwing =
      (error: unknown): SpawnFunction =>
      () => {
        throw error;
      };
    await expect(spawnProcess(SPEC, deps(throwing(errno('EPERM'))))).rejects.toMatchObject({
      reason: 'eperm',
    });
    await expect(spawnProcess(SPEC, deps(throwing(new TypeError('bad'))))).rejects.toMatchObject({
      reason: 'unknown',
      errno: undefined,
      message: 'spawn failed: unknown error',
    });
  });

  it('swallows ENOTCONN on every pipe after a failed spawn (07 §6)', async () => {
    const child = new FakeChild();
    const { spawn } = fakeSpawn(child, { error: errno('ENOENT') });
    await expect(spawnProcess(SPEC, deps(spawn))).rejects.toMatchObject({ reason: 'enoent' });
    // An 'error' without a listener would throw right here.
    expect(() => {
      child.stdout.emit('error', errno('ENOTCONN'));
      child.stderr.emit('error', errno('ENOTCONN'));
      child.stdin.emit('error', errno('ENOTCONN'));
    }).not.toThrow();
  });

  it('refuses a spawned child without a pid', async () => {
    const child = new FakeChild();
    child.pid = undefined;
    const { spawn } = fakeSpawn(child);
    await expect(spawnProcess(SPEC, deps(spawn))).rejects.toBeInstanceOf(ProcessSpawnError);
    expect(child.stdout.destroyed).toBe(true);
  });
});

describe('handle', () => {
  it('swallows a late child error and keeps working', async () => {
    const child = new FakeChild();
    const handle = await spawnProcess(SPEC, deps(fakeSpawn(child).spawn));
    expect(() => child.emit('error', errno('EPERM'))).not.toThrow();
    expect(handle.killViaHandle('SIGTERM')).toBe(true);
    expect(child.kills).toEqual(['SIGTERM']);
  });

  it('ends stdout normally on ENOTCONN and fails it on any other pipe error', async () => {
    const a = new FakeChild();
    const first = await spawnProcess(SPEC, deps(fakeSpawn(a).spawn));
    a.stdout.write('x');
    const iterator = first.stdout[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    a.stdout.destroy(errno('ENOTCONN'));
    await expect(iterator.next()).resolves.toMatchObject({ done: true });

    const b = new FakeChild();
    const second = await spawnProcess(SPEC, deps(fakeSpawn(b).spawn));
    b.stdout.destroy(errno('ECONNRESET'));
    const error: unknown = await (async () => {
      for await (const chunk of second.stdout) expect(chunk).toBeUndefined();
    })().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProcessStreamError);
    expect(error).toMatchObject({ stream: 'stdout', reason: 'failed', errno: 'ECONNRESET' });
  });

  it('a stdin error seen before the handle existed fails the first write', async () => {
    const child = new FakeChild();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: StartTimeReader = {
      source: 'linux-proc',
      read: async () => {
        await gate;
        return '5';
      },
    };
    const pending = spawnProcess(SPEC, { ...deps(fakeSpawn(child).spawn), startTime: slow });
    await vi.waitFor(() => {
      expect(child.stdin.listenerCount('error')).toBe(1);
    });
    child.stdin.emit('error', errno('EPIPE'));
    release();
    const handle = await pending;
    await expect(handle.write('x')).rejects.toMatchObject({ reason: 'failed', errno: 'EPIPE' });
  });

  it('a stdin that closes before flushing rejects the pending write', async () => {
    const child = new FakeChild();
    // A sink that completes its write only when the test says so.
    let complete: (error?: Error | null) => void = () => undefined;
    child.stdin = new Writable({
      write: (_chunk, _encoding, callback) => {
        complete = callback;
      },
    });
    const handle = await spawnProcess(SPEC, deps(fakeSpawn(child).spawn));
    const pending = handle.write('stuck');
    await vi.waitFor(() => {
      expect(child.stdin.listenerCount('close')).toBe(1);
    });
    child.stdin.emit('close');
    await expect(pending).rejects.toMatchObject({ stream: 'stdin', reason: 'failed' });
    // A completion after the close changes nothing.
    complete(errno('EPIPE'));
    await expect(handle.write('next')).rejects.toMatchObject({
      reason: 'failed',
      errno: undefined,
    });
  });

  it('reports an exit that happened before the identity read as an exit, not an identity', async () => {
    const child = new FakeChild();
    const exiting: StartTimeReader = {
      source: 'linux-proc',
      read: () => {
        child.exit(null, 'SIGKILL');
        return Promise.resolve('1');
      },
    };
    const handle = await spawnProcess(SPEC, {
      ...deps(fakeSpawn(child).spawn),
      startTime: exiting,
    });
    expect(handle.identity).toBeNull();
    expect(handle.identityProblem).toBe('exited');
    await expect(handle.exited).resolves.toEqual({ code: null, signal: 'SIGKILL' });
  });

  it('feeds stderr into the redacted tail and ends it with the pipe', async () => {
    const child = new FakeChild();
    const handle = await spawnProcess(SPEC, deps(fakeSpawn(child).spawn));
    child.stderr.write('key sk-fake-0123456789 here\npartial');
    child.stderr.emit('error', errno('EIO'));
    child.stderr.end();
    await vi.waitFor(() => {
      expect(handle.stderrTail()).toBe('key <redacted> here\npartial');
    });
  });
});

describe('processTableStartTime', () => {
  it('reads one /proc/<pid>/stat on Linux', async () => {
    const table = fixtureProcTable();
    const start = processTableStartTime(table);
    expect(start.source).toBe('linux-proc');
    await expect(start.read(8)).resolves.toMatch(/^[0-9]+$/);
    const gone = processTableStartTime({ ...table, readStat: () => Promise.resolve(null) });
    await expect(gone.read(8)).resolves.toBeNull();
    const garbage = processTableStartTime({
      ...table,
      readStat: () => Promise.resolve(bytes('garbage')),
    });
    await expect(garbage.read(8)).resolves.toBeNull();
  });

  it('reads the whole table elsewhere and finds the pid', async () => {
    const start = processTableStartTime({
      source: 'win32-cim',
      queryProcesses: () => Promise.resolve(fixture('win32/cim-array.out')),
    });
    expect(start.source).toBe('win32-cim');
    await expect(start.read(4)).resolves.toBe('13435773053817224');
    await expect(start.read(0xfffffff0)).resolves.toBeNull();
  });
});

describe('osCallsFor', () => {
  it('composes the adapters of each platform without running anything', () => {
    const linux = osCallsFor('linux', 7);
    expect(linux).toMatchObject({ platform: 'linux', hostPid: 7 });
    expect(linux.processTable.source).toBe('linux-proc');
    const darwin = osCallsFor('darwin', 7);
    expect(darwin.processTable.source).toBe('darwin-ps');
    expect('signals' in darwin).toBe(true);
    const win32 = osCallsFor('win32', 7);
    expect(win32.processTable.source).toBe('win32-cim');
    expect('terminate' in win32).toBe(true);
    expect(() => osCallsFor('aix', 7)).toThrow(/unsupported platform: aix/);
  });
});
