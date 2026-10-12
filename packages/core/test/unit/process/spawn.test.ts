// Real-process tests of spawnHarnessProcess with `node -e` children (plan
// §5.4 W2-T6). Every child is tracked and checked for leaks by pid and start
// time after each test (plan §4.7).

import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import fc from 'fast-check';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { REDACTED } from '../../../src/observability/redact.js';
import {
  ProcessSpawnError,
  ProcessStreamError,
  spawnHarnessProcess,
  WIN32_REQUIRED_ENV_NAMES,
  type HarnessProcess,
  type StartTimeReader,
} from '../../../src/process/spawn.js';
import { findIdentity } from '../../../src/process/tree/descendants.js';
import {
  BASE_ENV,
  CHILD_CWD,
  ChildTracker,
  hostSnapshot,
  readAll,
  sleep,
  within,
} from './spawn-support.js';

const WIN32 = process.platform === 'win32';
const LINUX = process.platform === 'linux';
const TIMEOUT = 60_000;

const tracker = new ChildTracker();
let scratch = '';

beforeAll(async () => {
  scratch = await mkdtemp(path.join(CHILD_CWD, 'hudhud-spawn-'));
});

afterAll(async () => {
  await tracker.assertNoneListed();
  await rm(scratch, { recursive: true, force: true });
}, TIMEOUT);

afterEach(async () => {
  vi.unstubAllEnvs();
  await tracker.assertNoLeaks();
}, TIMEOUT);

/** The child's environment as it sees it, as JSON. */
const PRINT_ENV = 'process.stdout.write(JSON.stringify(process.env))';

/** The child's argv after the script, as JSON. */
const PRINT_ARGV = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';

/**
 * The complete environment a child must see for `given` (which includes
 * BASE_ENV): exactly `given` on POSIX; on Windows also every libuv required
 * name `given` lacks, set to '' by spawn (never the host's value).
 */
function expectedChildEnv(given: Readonly<Record<string, string>>): Record<string, string> {
  if (!WIN32) return { ...given };
  const defaults: Record<string, string> = {
    HOMEDRIVE: '',
    HOMEPATH: '',
    LOGONSERVER: '',
    PATH: '',
    SYSTEMDRIVE: '',
    TEMP: '',
    USERDOMAIN: '',
    USERNAME: '',
    USERPROFILE: '',
    WINDIR: '',
  };
  const givenUpper = new Set(Object.keys(given).map((name) => name.toUpperCase()));
  const missing = Object.entries(defaults).filter(([name]) => !givenUpper.has(name));
  return { ...Object.fromEntries(missing), ...given };
}

describe('environment', () => {
  it(
    'is exactly the given map: nothing inherited from the host',
    async () => {
      vi.stubEnv('NODE_OPTIONS', '--max-old-space-size=64');
      vi.stubEnv('HUDHUD_HOST_CANARY', 'host-only-value');
      vi.stubEnv('NODE_CHANNEL_FD', '3');
      const env = { HUDHUD_A: '1', HUDHUD_EMPTY: '', HUDHUD_TEXT: 'مرحبا = x; y' };
      const child = await tracker.node(PRINT_ENV, { env });
      const seen = JSON.parse((await readAll(child)).toString('utf8')) as Record<string, string>;
      expect(seen).toEqual(expectedChildEnv({ ...BASE_ENV, ...env }));
      expect(seen).not.toHaveProperty('NODE_OPTIONS');
      expect(seen).not.toHaveProperty('HUDHUD_HOST_CANARY');
      expect(seen).not.toHaveProperty('NODE_CHANNEL_FD');
      await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    },
    TIMEOUT,
  );

  it.runIf(WIN32)(
    'on Windows is exact when the map provides every variable libuv requires',
    async () => {
      const env: Record<string, string> = { HUDHUD_B: '2' };
      for (const name of WIN32_REQUIRED_ENV_NAMES) env[name] = `hudhud-${name.toLowerCase()}`;
      env['SYSTEMROOT'] = BASE_ENV['SYSTEMROOT'] ?? '';
      const child = await tracker.node(PRINT_ENV, { env });
      const seen = JSON.parse((await readAll(child)).toString('utf8')) as Record<string, string>;
      expect(seen).toEqual(env);
    },
    TIMEOUT,
  );

  it(
    'never inherits an inherited (prototype) property of the map',
    async () => {
      const env = Object.create({ HUDHUD_PROTO: 'from-prototype' }) as Record<string, string>;
      Object.assign(env, BASE_ENV, { HUDHUD_OWN: 'own' });
      const child = await tracker.node(PRINT_ENV, { spec: { env } });
      const seen = JSON.parse((await readAll(child)).toString('utf8')) as Record<string, string>;
      expect(seen).toEqual(expectedChildEnv({ ...BASE_ENV, HUDHUD_OWN: 'own' }));
    },
    TIMEOUT,
  );
});

describe('no shell', () => {
  it(
    'passes shell metacharacters and variable references literally',
    async () => {
      const marker = path.join(scratch, 'pwned');
      const args = [
        '&',
        '|',
        '^',
        '%HUDHUD_X%',
        '!HUDHUD_X!',
        '$HUDHUD_X',
        '$(echo hi)',
        '`echo hi`',
        `& echo pwned > ${marker}`,
        `| echo pwned > ${marker}`,
        `; echo pwned > ${marker}`,
        '"quoted"',
        'a b',
        'tab\there',
        'back\\slash\\',
        '\\"',
        '\\\\"',
        '',
        "'single'",
        '<in >out',
        '--flag=value with spaces',
        'line\nbreak',
      ];
      const child = await tracker.node(PRINT_ARGV, { args, env: { HUDHUD_X: 'expanded' } });
      expect(JSON.parse((await readAll(child)).toString('utf8'))).toEqual(args);
      expect(existsSync(marker)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'property: any argv without NUL arrives unchanged (CreateProcess quoting on Windows)',
    async () => {
      const special = fc.constantFrom(
        '"',
        '\\',
        ' ',
        '\t',
        '&',
        '|',
        '^',
        '%',
        '!',
        '$',
        '`',
        "'",
        '\n',
        '*',
        '?',
      );
      const arg = fc.oneof(
        fc.string({ unit: special, maxLength: 12 }),
        fc.string({ unit: 'grapheme', maxLength: 12 }),
        fc.string({ unit: fc.oneof(special, fc.constantFrom('a', 'é', '😀')), maxLength: 16 }),
      );
      const seed = Number(process.env['FC_SEED'] ?? 20261012);
      const args = fc.sample(arg, { seed, numRuns: 300 });
      const child = await tracker.node(PRINT_ARGV, { args });
      expect(JSON.parse((await readAll(child)).toString('utf8'))).toEqual(args);
    },
    TIMEOUT,
  );
});

describe('identity', () => {
  it(
    'captures pid and start time right after spawn, matching the host process table',
    async () => {
      const child = await tracker.node('process.stdin.resume()');
      expect(child.identity).not.toBeNull();
      expect(child.identity?.pid).toBe(child.pid);
      expect(child.identityProblem).toBeNull();
      expect(child.identitySource).toBe(WIN32 ? 'win32-cim' : LINUX ? 'linux-proc' : 'darwin-ps');
      const snapshot = await hostSnapshot();
      const record =
        child.identity === null ? null : findIdentity(snapshot.records, child.identity);
      expect(record?.ppid).toBe(process.pid);
      child.endStdin();
      await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    },
    TIMEOUT,
  );

  it(
    'uses an injected start-time reader, and reports a failed or empty read',
    async () => {
      const fixed: StartTimeReader = { source: 'linux-proc', read: () => Promise.resolve('42') };
      const a = await tracker.node('process.stdin.resume()', { spec: { startTime: fixed } });
      expect(a.identity).toEqual({ pid: a.pid, startTime: '42' });
      expect(a.identitySource).toBe('linux-proc');

      const failing: StartTimeReader = {
        source: 'darwin-ps',
        read: () => Promise.reject(new Error('ps failed')),
      };
      const b = await tracker.node('process.stdin.resume()', { spec: { startTime: failing } });
      expect(b.identity).toBeNull();
      expect(b.identityProblem).toBe('read-failed');

      const empty: StartTimeReader = { source: 'win32-cim', read: () => Promise.resolve(null) };
      const c = await tracker.node('process.stdin.resume()', { spec: { startTime: empty } });
      expect(c.identity).toBeNull();
      expect(c.identityProblem).toBe('not-listed');
    },
    TIMEOUT,
  );

  it(
    'is null when the child exited before the read completed (its pid may be reused)',
    async () => {
      const slow: StartTimeReader = {
        source: 'linux-proc',
        read: async () => {
          await sleep(1500);
          return '7';
        },
      };
      const child = await tracker.node('process.exit(3)', { spec: { startTime: slow } });
      expect(child.identity).toBeNull();
      expect(child.identityProblem).toBe('exited');
      expect(child.exitStatus).toEqual({ code: 3, signal: null });
      await expect(child.exited).resolves.toEqual({ code: 3, signal: null });
      expect(child.killViaHandle('SIGKILL')).toBe(false);
    },
    TIMEOUT,
  );
});

describe('stdin', () => {
  it(
    'serializes writes in call order, also when they are not awaited',
    async () => {
      const child = await tracker.node(
        "const h = require('node:crypto').createHash('sha256'); let n = 0;" +
          "process.stdin.on('data', (c) => { h.update(c); n += c.length; });" +
          "process.stdin.on('end', () => process.stdout.write(n + ' ' + h.digest('hex')));",
      );
      const parts = Array.from({ length: 200 }, (_, i) => `${String(i)}:${'x'.repeat(i * 37)}\n`);
      parts.push('مرحبا 👋\n');
      const binary = new Uint8Array([0, 1, 2, 255, 254]);
      const writes = parts.map((part) => child.write(part));
      writes.push(child.write(binary));
      await Promise.all(writes);
      child.endStdin();
      child.endStdin();
      const expected = createHash('sha256');
      for (const part of parts) expected.update(part, 'utf8');
      expected.update(binary);
      const total = Buffer.byteLength(parts.join(''), 'utf8') + binary.length;
      expect((await readAll(child)).toString('utf8')).toBe(
        `${String(total)} ${expected.digest('hex')}`,
      );
    },
    TIMEOUT,
  );

  it(
    'backpressure: with a slow reader each write waits, so the host holds at most one chunk',
    async () => {
      // The child reads one chunk, pauses, reports its count, resumes.
      const child = await tracker.node(
        "let n = 0; process.stdin.on('data', (c) => { n += c.length; process.stdin.pause();" +
          "setTimeout(() => { process.stdout.write(n + '\\n'); process.stdin.resume(); }, 2); });" +
          "process.stdin.on('end', () => process.stdout.write('end ' + n + '\\n'));",
      );
      let consumed = 0;
      let lines = '';
      const reading = (async () => {
        for await (const chunk of child.stdout) {
          lines += Buffer.from(chunk).toString('latin1');
          const all = lines.split('\n');
          lines = all.pop() ?? '';
          for (const line of all) consumed = Number(line.replace('end ', ''));
        }
      })();
      const CHUNK = 256 * 1024;
      const TOTAL = 8 * 1024 * 1024;
      const chunk = new Uint8Array(CHUNK).fill(0x61);
      let written = 0;
      let maxAhead = 0;
      while (written < TOTAL) {
        await child.write(chunk);
        written += CHUNK;
        maxAhead = Math.max(maxAhead, written - consumed);
      }
      child.endStdin();
      await reading;
      expect(consumed).toBe(TOTAL);
      // Unbounded buffering would let the host run up to TOTAL ahead.
      expect(maxAhead).toBeLessThanOrEqual(2 * 1024 * 1024);
    },
    TIMEOUT,
  );

  /** Writes 1 MiB chunks until a write fails; returns the failure. */
  async function writeUntilFailure(child: HarnessProcess): Promise<unknown> {
    const big = new Uint8Array(1024 * 1024);
    for (let i = 0; i < 64; i += 1) {
      try {
        await child.write(big);
      } catch (error) {
        return error;
      }
    }
    return undefined;
  }

  it(
    'EPIPE: a write to a stdin the live child closed rejects without an unhandled error',
    async () => {
      const child = await tracker.node(
        "require('node:fs').closeSync(0); process.stdout.write('closed'); setTimeout(() => {}, 4000);",
      );
      const iterator = child.stdout[Symbol.asyncIterator]();
      expect(Buffer.from((await iterator.next()).value ?? []).toString()).toBe('closed');
      const failure = await writeUntilFailure(child);
      // On POSIX the pipe breaks while the child still runs; on Windows the
      // child's pipe handle outlives fd 0, so the write fails at its exit.
      if (!WIN32) expect(child.exitStatus).toBeNull();
      expect(failure).toBeInstanceOf(ProcessStreamError);
      expect(failure).toMatchObject({ stream: 'stdin', reason: 'failed' });
      expect((failure as ProcessStreamError).errno).toMatch(
        /^(EPIPE|EOF|ECONNRESET|ERR_STREAM_DESTROYED)$/,
      );
      await expect(child.write('again')).rejects.toBe(failure);
      child.killViaHandle('SIGKILL');
      await child.exited;
      await iterator.return?.();
    },
    TIMEOUT,
  );

  it(
    'a write after the child exited rejects; later writes reject with the same error',
    async () => {
      const child = await tracker.node('process.exit(0)');
      await child.exited;
      const failure = await writeUntilFailure(child);
      expect(failure).toBeInstanceOf(ProcessStreamError);
      expect(failure).toMatchObject({ stream: 'stdin', reason: 'failed' });
      await expect(child.write('again')).rejects.toBe(failure);
    },
    TIMEOUT,
  );

  it(
    'a write after endStdin rejects with reason "ended"',
    async () => {
      const child = await tracker.node('process.stdin.resume()');
      child.endStdin();
      await expect(child.write('late')).rejects.toMatchObject({ stream: 'stdin', reason: 'ended' });
      await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    },
    TIMEOUT,
  );
});

describe('stdout', () => {
  it(
    'backpressure: an unread stdout blocks the child, the host does not buffer it',
    async () => {
      // The child writes 8 MiB and reports its progress on stderr.
      const child = await tracker.node(
        'const b = Buffer.alloc(65536, 120); let w = 0;' +
          'function pump() { while (w < 8 * 1048576) { w += b.length;' +
          "process.stderr.write('w ' + w + '\\n');" +
          "if (!process.stdout.write(b)) { process.stdout.once('drain', pump); return; } } }" +
          'pump();',
      );
      const progress = (): number => {
        const all = [...child.stderrTail().matchAll(/w (\d+)/g)];
        return Number(all.at(-1)?.[1] ?? 0);
      };
      let consumed = 0;
      let sampled = -1;
      for await (const chunk of child.stdout) {
        consumed += chunk.length;
        if (sampled < 0 && consumed >= 1024 * 1024) {
          // Stop reading for a while: the child must stall.
          await sleep(500);
          sampled = progress() - consumed;
        }
      }
      expect(consumed).toBe(8 * 1024 * 1024);
      expect(sampled).toBeGreaterThanOrEqual(0);
      expect(sampled).toBeLessThanOrEqual(2 * 1024 * 1024);
      await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    },
    TIMEOUT,
  );

  it(
    'has a single consumer',
    async () => {
      const child = await tracker.node("process.stdout.write('one')");
      expect((await readAll(child)).toString()).toBe('one');
      await expect(readAll(child)).rejects.toThrow(/single consumer/);
    },
    TIMEOUT,
  );
});

describe('stderr tail', () => {
  it(
    'is bounded and redacted with the secrets of the env and the spec',
    async () => {
      const key = 'sk-test-0123456789abcdef';
      const extra = 'extra-secret-value-42';
      const child = await tracker.node(
        'const k = process.env.HUDHUD_API_KEY;' +
          "for (let i = 0; i < 20000; i++) process.stderr.write('noise ' + i + ' ' + k + '\\n');" +
          "process.stderr.write('last ' + k + ' " +
          extra +
          "\\n');",
        { env: { HUDHUD_API_KEY: key }, spec: { secrets: [extra] } },
      );
      await child.exited;
      await readAll(child);
      const tail = child.stderrTail();
      expect(tail.length).toBeLessThanOrEqual(2048);
      expect(tail).not.toContain(key);
      expect(tail).not.toContain(extra);
      expect(tail).toContain(`last ${REDACTED} ${REDACTED}`);
    },
    TIMEOUT,
  );

  it(
    'honours the size options',
    async () => {
      const child = await tracker.node("process.stderr.write('a'.repeat(5000) + '\\nshort\\n')", {
        spec: { stderrTail: { maxChars: 100 } },
      });
      await readAll(child);
      await child.exited;
      await sleep(50);
      const tail = child.stderrTail();
      expect(tail.length).toBeLessThanOrEqual(100);
      expect(tail.endsWith('short\n')).toBe(true);
    },
    TIMEOUT,
  );
});

describe('spawn failures', () => {
  it(
    'maps a missing executable to ProcessSpawnError enoent',
    async () => {
      const missing = path.join(scratch, 'missing', WIN32 ? 'node.exe' : 'node');
      const error: unknown = await spawnHarnessProcess({
        file: missing,
        args: [],
        cwd: CHILD_CWD,
        env: BASE_ENV,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProcessSpawnError);
      expect(error).toMatchObject({ code: 'SPAWN_FAILED', reason: 'enoent', errno: 'ENOENT' });
    },
    TIMEOUT,
  );

  it(
    'maps a missing cwd to enoent; the pipes ENOTCONN that follows on Windows is swallowed (07 §6)',
    async () => {
      // On Windows a cwd of 259+ characters fails exactly like this (J10).
      const cwd = path.join(scratch, 'x'.repeat(120), 'y'.repeat(120), 'z'.repeat(40));
      const error: unknown = await spawnHarnessProcess({
        file: process.execPath,
        args: ['-e', '0'],
        cwd,
        env: BASE_ENV,
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ reason: 'enoent' });
      // Give the pipes time to report; an unhandled 'error' would fail the run.
      await sleep(200);
    },
    TIMEOUT,
  );

  it.runIf(!WIN32)(
    'maps a file without execute permission to eacces',
    async () => {
      const file = path.join(scratch, 'not-executable');
      await writeFile(file, '#!/bin/sh\nexit 0\n');
      await chmod(file, 0o644);
      await expect(
        spawnHarnessProcess({ file, args: [], cwd: CHILD_CWD, env: BASE_ENV }),
      ).rejects.toMatchObject({ reason: 'eacces', errno: 'EACCES' });
    },
    TIMEOUT,
  );

  it(
    'refuses a spec before spawning anything',
    async () => {
      const base = { file: process.execPath, args: [], cwd: CHILD_CWD, env: BASE_ENV };
      await expect(spawnHarnessProcess({ ...base, file: 'node' })).rejects.toMatchObject({
        name: 'SpawnSpecError',
        problem: 'file-refused',
      });
      await expect(spawnHarnessProcess({ ...base, cwd: 'relative' })).rejects.toMatchObject({
        problem: 'cwd-refused',
      });
      await expect(spawnHarnessProcess({ ...base, args: ['ok', 'a\0b'] })).rejects.toMatchObject({
        problem: 'arg-nul',
        subject: '1',
      });
      for (const name of ['', 'A=B', 'A\0']) {
        await expect(spawnHarnessProcess({ ...base, env: { [name]: 'v' } })).rejects.toMatchObject({
          problem: 'env-name',
        });
      }
      await expect(spawnHarnessProcess({ ...base, env: { A: 'v\0' } })).rejects.toMatchObject({
        problem: 'env-value',
        subject: 'A',
        message: expect.not.stringContaining('v\0') as unknown,
      });
      const nonString = { A: 1 } as unknown as Record<string, string>;
      await expect(spawnHarnessProcess({ ...base, env: nonString })).rejects.toMatchObject({
        problem: 'env-value',
      });
    },
    TIMEOUT,
  );
});

describe('handle', () => {
  it(
    'killViaHandle ends its own child and reports false after the exit',
    async () => {
      const child = await tracker.node('setInterval(() => {}, 1000)');
      expect(child.exitStatus).toBeNull();
      expect(child.killViaHandle('SIGTERM')).toBe(true);
      const exit = await within(child.exited, 10_000, 'exit after SIGTERM');
      expect(exit.signal).toBe('SIGTERM');
      expect(child.exitStatus).toEqual(exit);
      expect(child.killViaHandle('SIGKILL')).toBe(false);
    },
    TIMEOUT,
  );

  it.runIf(LINUX)(
    'inherits no descriptor besides the three pipes (Linux /proc/self/fd)',
    async () => {
      const marker = path.join(scratch, 'inherit-marker');
      await writeFile(marker, 'x');
      const fd = openSync(marker, 'r');
      try {
        const child = await tracker.node(
          "const fs = require('node:fs'); const out = {};" +
            "for (const d of fs.readdirSync('/proc/self/fd')) { try { out[d] = fs.readlinkSync('/proc/self/fd/' + d); } catch {} }" +
            'process.stdout.write(JSON.stringify(out))',
        );
        const fds = JSON.parse((await readAll(child)).toString('utf8')) as Record<string, string>;
        expect(Object.values(fds)).not.toContain(marker);
        for (const std of ['0', '1', '2']) expect(fds[std]).toMatch(/^(pipe|socket):/);
      } finally {
        closeSync(fd);
      }
    },
    TIMEOUT,
  );
});
