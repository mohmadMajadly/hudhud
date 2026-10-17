// The bounded command runner of verify/ (ADR-0011, plan §1.7): real node
// children for the paths a host can produce, a fake child for the rest.

import { EventEmitter, getEventListeners } from 'node:events';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { hostPlatform } from '../../../../src/process/cwd.js';
import {
  runBoundedCommand,
  type BoundedCommand,
  type BoundedSpawn,
} from '../../../../src/process/verify/command.js';
import {
  DARWIN_CHILD_SET_ENV_NAMES,
  WIN32_REQUIRED_ENV_NAMES,
} from '../../../../src/process/win32-env.js';

const CWD = realpathSync(tmpdir());
const ENV: Readonly<Record<string, string>> =
  process.platform === 'win32' ? { SYSTEMROOT: process.env['SystemRoot'] ?? '' } : {};

function nodeCommand(script: string, overrides: Partial<BoundedCommand> = {}): BoundedCommand {
  return {
    file: process.execPath,
    args: ['-e', script],
    env: ENV,
    cwd: CWD,
    platform: hostPlatform(),
    timeoutMs: 20_000,
    maxStdoutBytes: 1024,
    ...overrides,
  };
}

/** A child double: stdout is a PassThrough, the rest an EventEmitter. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  pid: number | undefined;
  readonly kills: string[] = [];

  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }

  kill(signal: string): boolean {
    this.kills.push(signal);
    return true;
  }
}

function fakeSpawn(child: FakeChild, calls: unknown[] = []): BoundedSpawn {
  return ((file: string, args: readonly string[], options: unknown) => {
    calls.push({ file, args, options });
    return child;
  }) as unknown as BoundedSpawn;
}

describe('runBoundedCommand with a real child', { timeout: 60_000 }, () => {
  it('returns the exit code and stdout of a command that exits', async () => {
    const outcome = await runBoundedCommand(
      nodeCommand("process.stdout.write('hello ' + process.argv[1]); process.exit(3)", {
        args: [
          '-e',
          "process.stdout.write('hello ' + process.argv[1]); process.exit(3)",
          '$(x) & y',
        ],
      }),
    );
    expect(outcome).toEqual({
      kind: 'exited',
      exitCode: 3,
      signal: null,
      stdout: 'hello $(x) & y',
    });
  });

  it('passes exactly the given environment (plus the empty libuv names on Windows)', async () => {
    const outcome = await runBoundedCommand(
      nodeCommand('process.stdout.write(JSON.stringify(process.env))', {
        env: { ...ENV, HUDHUD_PROBE_MARK: 'x' },
        maxStdoutBytes: 64 * 1024,
      }),
    );
    expect(outcome.kind).toBe('exited');
    const env = JSON.parse(outcome.kind === 'exited' ? outcome.stdout : '{}') as Record<
      string,
      string
    >;
    expect(env['HUDHUD_PROBE_MARK']).toBe('x');
    for (const [name, value] of Object.entries(env)) {
      if (name === 'HUDHUD_PROBE_MARK' || name.toUpperCase() === 'SYSTEMROOT') continue;
      if (process.platform === 'win32') {
        // The libuv names, passed empty so that nothing is copied from the host.
        expect(WIN32_REQUIRED_ENV_NAMES).toContain(name.toUpperCase());
        expect(value).toBe('');
      } else {
        // Only what a macOS child sets itself at start.
        expect(DARWIN_CHILD_SET_ENV_NAMES).toContain(name);
      }
    }
  });

  it('kills the child and reports a timeout', async () => {
    const started = Date.now();
    const outcome = await runBoundedCommand(
      nodeCommand('setTimeout(() => {}, 60000)', { timeoutMs: 300 }),
    );
    expect(outcome).toEqual({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('kills the child when stdout exceeds the cap', async () => {
    const outcome = await runBoundedCommand(
      nodeCommand("process.stdout.write('x'.repeat(100000)); setTimeout(() => {}, 60000)", {
        maxStdoutBytes: 10,
      }),
    );
    expect(outcome).toEqual({ kind: 'output-too-large' });
  });

  it('reports a spawn failure with its errno', async () => {
    const outcome = await runBoundedCommand(
      nodeCommand('', {
        file:
          process.platform === 'win32'
            ? `${CWD}\\hudhud-missing-${String(process.pid)}.exe`
            : `${CWD}/hudhud-missing-${String(process.pid)}`,
      }),
    );
    expect(outcome).toEqual({ kind: 'spawn-error', errno: 'ENOENT' });
  });

  it('reports a synchronous refusal by Node as a spawn failure', async () => {
    const outcome = await runBoundedCommand(nodeCommand('', { args: ['a\0b'] }));
    expect(outcome).toEqual({ kind: 'spawn-error', errno: 'ERR_INVALID_ARG_VALUE' });
  });
});

describe('runBoundedCommand with a fake child', () => {
  it('spawns without a shell, hidden, not detached, with only stdout piped', async () => {
    const child = new FakeChild(42);
    const calls: unknown[] = [];
    const pending = runBoundedCommand(
      nodeCommand('', {
        file: 'C:\\x\\y.exe',
        args: ['a'],
        platform: 'win32',
        env: { SYSTEMROOT: 'C:\\Windows' },
      }),
      fakeSpawn(child, calls),
    );
    child.emit('close', 0, null);
    await pending;
    expect(calls).toHaveLength(1);
    const call = calls[0] as { file: string; args: string[]; options: Record<string, unknown> };
    expect(call.file).toBe('C:\\x\\y.exe');
    expect(call.args).toEqual(['a']);
    expect(call.options).toMatchObject({
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: false,
      detached: false,
      cwd: CWD,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const env = call.options['env'] as Record<string, string>;
    expect(env['SYSTEMROOT']).toBe('C:\\Windows');
    expect(env['PATH']).toBe('');
  });

  it('ignores an error after a successful spawn and settles on close', async () => {
    const child = new FakeChild(42);
    const pending = runBoundedCommand(nodeCommand(''), fakeSpawn(child));
    child.emit('error', new Error('kill failed'));
    child.stdout.write('ok');
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', null, 'SIGTERM');
    await expect(pending).resolves.toEqual({
      kind: 'exited',
      exitCode: null,
      signal: 'SIGTERM',
      stdout: 'ok',
    });
  });

  it('ignores stdout after the cap was hit and settles once', async () => {
    const child = new FakeChild(42);
    const pending = runBoundedCommand(nodeCommand('', { maxStdoutBytes: 2 }), fakeSpawn(child));
    child.stdout.emit('data', Buffer.from('abc'));
    child.stdout.emit('data', Buffer.from('more'));
    child.emit('close', null, 'SIGKILL');
    await expect(pending).resolves.toEqual({ kind: 'output-too-large' });
    expect(child.kills).toEqual(['SIGKILL']);
  });

  it('an aborted signal kills the child at once; an aborted one spawns nothing (R5-U1)', async () => {
    const child = new FakeChild(7);
    const controller = new AbortController();
    const running = runBoundedCommand(
      nodeCommand('', { signal: controller.signal }),
      fakeSpawn(child),
    );
    controller.abort();
    expect(await running).toEqual({ kind: 'aborted' });
    expect(child.kills).toEqual(['SIGKILL']);
    const calls: unknown[] = [];
    expect(
      await runBoundedCommand(
        nodeCommand('', { signal: AbortSignal.abort() }),
        fakeSpawn(new FakeChild(8), calls),
      ),
    ).toEqual({ kind: 'aborted' });
    expect(calls).toEqual([]);
    // A command that ends by itself lets go of its signal.
    const quiet = new AbortController();
    const done = new FakeChild(9);
    const exited = runBoundedCommand(nodeCommand('', { signal: quiet.signal }), fakeSpawn(done));
    done.emit('close', 0, null);
    expect(await exited).toMatchObject({ kind: 'exited', exitCode: 0 });
    expect(getEventListeners(quiet.signal, 'abort')).toHaveLength(0);
  });

  it('swallows stdout pipe errors (ENOTCONN after a failed spawn)', async () => {
    const child = new FakeChild(undefined);
    const pending = runBoundedCommand(nodeCommand(''), fakeSpawn(child));
    child.stdout.emit('error', Object.assign(new Error('ENOTCONN'), { code: 'ENOTCONN' }));
    child.emit('error', Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(pending).resolves.toEqual({ kind: 'spawn-error', errno: 'EACCES' });
  });
});
