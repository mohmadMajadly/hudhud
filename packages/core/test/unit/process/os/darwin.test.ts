// macOS adapter: the exact `ps` command through a recording runner on every
// OS, the real `/bin/ps` on macOS, and the command runner with node children.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createDarwinPsTableCalls,
  PS_ARGS,
  PS_ENV,
  PS_PATH,
  runCommand,
} from '../../../../src/process/os/darwin.js';
import { parsePsOutput } from '../../../../src/process/tree/ps.js';
import {
  CHILD_CWD,
  ChildTracker,
  identityFromPidFile,
  PID_FILE_IDLER,
  withFakeTimeouts,
} from '../spawn-support.js';

const DARWIN = process.platform === 'darwin';
const POSIX = process.platform !== 'win32';
const TIMEOUT = 60_000;

const tracker = new ChildTracker();
let scratch = '';

beforeAll(async () => {
  scratch = await mkdtemp(path.join(CHILD_CWD, 'hudhud-darwin-'));
});

afterAll(async () => {
  await tracker.assertNoneListed();
  await rm(scratch, { recursive: true, force: true, maxRetries: 10 });
}, TIMEOUT);

afterEach(async () => {
  await tracker.assertNoLeaks();
}, TIMEOUT);

describe('createDarwinPsTableCalls', () => {
  it('runs exactly /bin/ps -A -o pid=,ppid=,pgid=,stat=,lstart=,comm= with LC_ALL=C and TZ=UTC0 only', async () => {
    const calls: unknown[] = [];
    const table = createDarwinPsTableCalls((file, args, env) => {
      calls.push({ file, args, env });
      return Promise.resolve(new Uint8Array([0x31]));
    });
    expect(table.source).toBe('darwin-ps');
    await expect(table.runPs()).resolves.toEqual(new Uint8Array([0x31]));
    expect(calls).toEqual([
      {
        file: '/bin/ps',
        args: ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart=,comm='],
        env: { LC_ALL: 'C', TZ: 'UTC0' },
      },
    ]);
    expect(PS_PATH).toBe('/bin/ps');
    expect(Object.isFrozen(PS_ARGS)).toBe(true);
    expect(Object.isFrozen(PS_ENV)).toBe(true);
  });

  it.runIf(DARWIN)(
    'reads the real process table, which lists this process',
    async () => {
      const table = parsePsOutput(await createDarwinPsTableCalls().runPs());
      expect(table.records.find((record) => record.pid === process.pid)?.ppid).toBe(process.ppid);
    },
    TIMEOUT,
  );
});

describe('runCommand (darwin copy)', () => {
  const node = process.execPath;

  it(
    'passes argv and exactly the env, and resolves with stdout',
    async () => {
      const out = await runCommand(
        node,
        [
          '-e',
          'process.stdout.write(JSON.stringify([process.argv.slice(1), process.env.HUDHUD_R]))',
          '& |',
        ],
        { HUDHUD_R: 'r' },
      );
      expect(JSON.parse(Buffer.from(out).toString('utf8'))).toEqual([['& |'], 'r']);
    },
    TIMEOUT,
  );

  it(
    'rejects on a non-zero exit',
    async () => {
      await expect(runCommand(node, ['-e', 'process.exit(3)'], {})).rejects.toThrow(
        /exited with 3/,
      );
    },
    TIMEOUT,
  );

  it.runIf(POSIX)(
    'rejects on an exit by signal',
    async () => {
      await expect(
        runCommand(node, ['-e', "process.kill(process.pid, 'SIGKILL')"], {}),
      ).rejects.toThrow(/exited with SIGKILL/);
    },
    TIMEOUT,
  );

  it(
    'rejects when the command cannot be started',
    async () => {
      await expect(runCommand('/nonexistent/hudhud/ps', [], {})).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
    TIMEOUT,
  );

  it(
    'ends the command through its handle after the timeout',
    async () => {
      // The timeout fires on the fake clock only after the child's identity
      // was recorded, however long that read takes.
      await withFakeTimeouts(async (advance) => {
        const pidFile = path.join(scratch, 'timeout.pid');
        let done = false;
        const settled = runCommand(
          node,
          ['-e', PID_FILE_IDLER, pidFile],
          {},
          {
            timeoutMs: 10_000,
            maxStdoutBytes: 1024,
          },
        )
          .catch((error: unknown) => error)
          .finally(() => {
            done = true;
          });
        tracker.trackDescendant(await identityFromPidFile(pidFile));
        await writeFile(`${pidFile}.go`, '');
        await advance(9_999);
        expect(done).toBe(false);
        await advance(1);
        expect(String(await settled)).toMatch(/timed out after 10000 ms/);
      });
    },
    TIMEOUT,
  );

  it(
    'rejects and ends the command when stdout exceeds the cap',
    async () => {
      const pidFile = path.join(scratch, 'cap.pid');
      const settled = runCommand(
        node,
        ['-e', PID_FILE_IDLER, pidFile, 'flood'],
        {},
        { timeoutMs: 30_000, maxStdoutBytes: 1000 },
      ).catch((error: unknown) => error);
      tracker.trackDescendant(await identityFromPidFile(pidFile));
      await writeFile(`${pidFile}.go`, '');
      expect(String(await settled)).toMatch(/more than 1000 bytes/);
    },
    TIMEOUT,
  );
});
