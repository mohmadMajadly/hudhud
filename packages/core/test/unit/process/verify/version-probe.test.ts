// The K4 version probe (plan §1.8): only a spawnable binary, argv and env
// hygiene, a timeout. The "binary" is node itself, never the user's claude.

import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { resolveExecutable } from '../../../../src/process/binary-path.js';
import { hostPlatform, type FileIdentity } from '../../../../src/process/cwd.js';
import type { BoundedCommand, CommandOutcome } from '../../../../src/process/verify/command.js';
import {
  BinaryChangedError,
  BinaryNotVerifiedError,
  type IdentityFs,
  type VerifiedBinary,
} from '../../../../src/process/verify/verify.js';
import {
  DEFAULT_VERSION_PROBE_MAX_BYTES,
  DEFAULT_VERSION_PROBE_TIMEOUT_MS,
  runVersionProbe,
  tempProbeWorkDir,
  VersionProbeError,
  type ProbeWorkDir,
  type VersionProbeOptions,
} from '../../../../src/process/verify/version-probe.js';

const ENV: Readonly<Record<string, string>> =
  process.platform === 'win32' ? { SYSTEMROOT: process.env['SystemRoot'] ?? '' } : {};

/**
 * node itself as an advisory, unverified binary bound to its identity. Not
 * hashed: the probe re-reads only the identity, and hashing a 100 MB file
 * here would only load the machine (verify.test.ts covers hashing).
 */
async function nodeBinary(): Promise<VerifiedBinary> {
  const binary = await resolveExecutable(process.execPath);
  const stats = await stat(binary.path, { bigint: true });
  return {
    path: binary.path,
    fileId: `${String(stats.dev)}:${String(stats.ino)}`,
    size: binary.size,
    mtimeMs: binary.mtimeMs,
    verification: { status: 'unverified', method: 'none', mode: 'advisory' },
  };
}

function probeOptions(overrides: Partial<VersionProbeOptions> = {}): VersionProbeOptions {
  return { args: ['--version'], env: ENV, platform: hostPlatform(), ...overrides };
}

const FAKE: VerifiedBinary = {
  path: '/opt/claude',
  size: 1,
  mtimeMs: 1,
  fileId: '1:1',
  sha256: 'a'.repeat(64),
  verification: { status: 'verified', method: 'sha256-manifest', mode: 'strict' },
};

const SAME_FILE: IdentityFs = {
  realpath: (value) => Promise.resolve(value),
  stat: (): Promise<FileIdentity> =>
    Promise.resolve({
      isFile: () => true,
      isDirectory: () => false,
      dev: 1n,
      ino: 1n,
      size: 1n,
      mtimeMs: 1n,
    }),
};

/** A fake work directory that records what was created and removed. */
function fakeWorkDir(dir = '/tmp/hudhud-probe-x'): ProbeWorkDir & {
  created: string[];
  removed: string[];
} {
  const created: string[] = [];
  const removed: string[] = [];
  return {
    created,
    removed,
    create: () => {
      created.push(dir);
      return Promise.resolve(dir);
    },
    remove: (value) => {
      removed.push(value);
      return Promise.resolve();
    },
  };
}

function fakeRun(outcome: CommandOutcome): {
  commands: BoundedCommand[];
  run: (command: BoundedCommand) => Promise<CommandOutcome>;
} {
  const commands: BoundedCommand[] = [];
  return {
    commands,
    run: (command) => {
      commands.push(command);
      return Promise.resolve(outcome);
    },
  };
}

describe('runVersionProbe against a real binary (node)', { timeout: 60_000 }, () => {
  it('returns the stdout of `--version`', async () => {
    const stdout = await runVersionProbe(await nodeBinary(), probeOptions());
    expect(stdout.trim()).toBe(process.version);
  });

  it('times out and kills the child', async () => {
    const error = await runVersionProbe(
      await nodeBinary(),
      probeOptions({ args: ['-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 300 }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VersionProbeError);
    expect((error as VersionProbeError).reason).toBe('timeout');
    expect((error as VersionProbeError).code).toBe('BINARY_PROBE_FAILED');
  });

  it('caps the output', async () => {
    await expect(
      runVersionProbe(
        await nodeBinary(),
        probeOptions({
          args: ['-e', "process.stdout.write('x'.repeat(10000))"],
          maxStdoutBytes: 100,
        }),
      ),
    ).rejects.toMatchObject({ reason: 'output-too-large' });
  });

  it('runs in a new empty directory of its own and removes it afterwards', async () => {
    const stdout = await runVersionProbe(
      await nodeBinary(),
      probeOptions({
        args: [
          '-e',
          "process.stdout.write(JSON.stringify([process.cwd(), require('node:fs').readdirSync('.')]))",
        ],
      }),
    );
    const [cwd, entries] = JSON.parse(stdout) as [string, string[]];
    expect(entries).toEqual([]);
    expect(cwd).not.toBe(process.cwd());
    expect(cwd).toContain('hudhud-probe-');
    expect(existsSync(cwd)).toBe(false);
  });

  it('removes its directory when the probe fails', async () => {
    const created: string[] = [];
    const workDir: ProbeWorkDir = {
      create: async () => {
        const dir = await tempProbeWorkDir.create();
        created.push(dir);
        return dir;
      },
      remove: (dir) => tempProbeWorkDir.remove(dir),
    };
    await expect(
      runVersionProbe(
        await nodeBinary(),
        probeOptions({ args: ['-e', 'process.exit(3)'], deps: { workDir } }),
      ),
    ).rejects.toMatchObject({ reason: 'exit-code' });
    expect(created).toHaveLength(1);
    expect(existsSync(created[0] ?? '')).toBe(false);
  });

  it('reports a non-zero exit', async () => {
    await expect(
      runVersionProbe(await nodeBinary(), probeOptions({ args: ['-e', 'process.exit(7)'] })),
    ).rejects.toMatchObject({ reason: 'exit-code', subject: '7' });
  });
});

describe('runVersionProbe gates', () => {
  it('passes the fixed argv, env, its own cwd and the default bounds', async () => {
    const { commands, run } = fakeRun({
      kind: 'exited',
      exitCode: 0,
      signal: null,
      stdout: 'v1\n',
    });
    const env = { A: 'b' };
    const workDir = fakeWorkDir();
    await expect(
      runVersionProbe(FAKE, {
        args: ['--version'],
        env,
        platform: 'posix',
        deps: { fs: SAME_FILE, run, workDir },
      }),
    ).resolves.toBe('v1\n');
    expect(workDir.created).toEqual(['/tmp/hudhud-probe-x']);
    expect(workDir.removed).toEqual(['/tmp/hudhud-probe-x']);
    expect(commands).toEqual([
      {
        file: '/opt/claude',
        args: ['--version'],
        env,
        cwd: '/tmp/hudhud-probe-x',
        platform: 'posix',
        timeoutMs: DEFAULT_VERSION_PROBE_TIMEOUT_MS,
        maxStdoutBytes: DEFAULT_VERSION_PROBE_MAX_BYTES,
      },
    ]);
    expect(DEFAULT_VERSION_PROBE_TIMEOUT_MS).toBe(15_000);
  });

  it('never runs a strict binary that is not verified', async () => {
    const { commands, run } = fakeRun({ kind: 'exited', exitCode: 0, signal: null, stdout: '' });
    for (const status of ['unverified', 'failed'] as const) {
      await expect(
        runVersionProbe(
          { ...FAKE, verification: { status, method: 'none', mode: 'strict' } },
          probeOptions({
            platform: 'posix',
            env: {},
            deps: { fs: SAME_FILE, run, workDir: fakeWorkDir() },
          }),
        ),
      ).rejects.toThrow(BinaryNotVerifiedError);
    }
    expect(commands).toHaveLength(0);
  });

  it('never runs a binary whose identity changed', async () => {
    const { commands, run } = fakeRun({ kind: 'exited', exitCode: 0, signal: null, stdout: '' });
    const moved: IdentityFs = { ...SAME_FILE, realpath: () => Promise.resolve('/tmp/other') };
    await expect(
      runVersionProbe(
        FAKE,
        probeOptions({
          platform: 'posix',
          env: {},
          deps: { fs: moved, run, workDir: fakeWorkDir() },
        }),
      ),
    ).rejects.toThrow(BinaryChangedError);
    expect(commands).toHaveLength(0);
  });

  it.each<[string, Partial<VersionProbeOptions>, string]>([
    ['a NUL in an argument', { args: ['--version', 'a\0'] }, 'arg 1'],
    ['an empty env name', { env: { '': 'x' } }, 'env ""'],
    ['= in an env name', { env: { 'A=B': 'x' } }, 'env "A=B"'],
    ['NUL in an env name', { env: { 'A\0': 'x' } }, 'env "A\\u0000"'],
    ['NUL in an env value', { env: { A: 'x\0' } }, 'env "A"'],
  ])('refuses %s before anything runs', async (_name, overrides, subject) => {
    const { commands, run } = fakeRun({ kind: 'exited', exitCode: 0, signal: null, stdout: '' });
    const workDir = fakeWorkDir();
    const error = await runVersionProbe(
      FAKE,
      probeOptions({
        platform: 'posix',
        env: {},
        ...overrides,
        deps: { fs: SAME_FILE, run, workDir },
      }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VersionProbeError);
    expect((error as VersionProbeError).reason).toBe('spec-refused');
    expect((error as VersionProbeError).subject).toBe(subject);
    expect(commands).toHaveLength(0);
    expect(workDir.created).toEqual([]);
  });

  it('refuses a work directory that is not absolute, and removes it', async () => {
    const { commands, run } = fakeRun({ kind: 'exited', exitCode: 0, signal: null, stdout: '' });
    const workDir = fakeWorkDir('tmp/relative');
    await expect(
      runVersionProbe(
        FAKE,
        probeOptions({ platform: 'posix', env: {}, deps: { fs: SAME_FILE, run, workDir } }),
      ),
    ).rejects.toMatchObject({ reason: 'spec-refused', subject: 'cwd not-absolute' });
    expect(commands).toHaveLength(0);
    expect(workDir.removed).toEqual(['tmp/relative']);
  });

  it('on Windows refuses duplicate names and a missing SYSTEMROOT', async () => {
    const { commands, run } = fakeRun({ kind: 'exited', exitCode: 0, signal: null, stdout: '' });
    const win = (env: Record<string, string>): VersionProbeOptions =>
      probeOptions({
        platform: 'win32',
        env,
        deps: { fs: SAME_FILE, run, workDir: fakeWorkDir('C:\\Temp\\hudhud-probe-x') },
      });
    await expect(
      runVersionProbe(FAKE, win({ Path: 'a', PATH: 'b', SystemRoot: 'C:\\Windows' })),
    ).rejects.toMatchObject({
      reason: 'spec-refused',
      subject: 'env "PATH"',
    });
    await expect(runVersionProbe(FAKE, win({}))).rejects.toMatchObject({
      subject: 'env SYSTEMROOT',
    });
    await expect(runVersionProbe(FAKE, win({ SystemRoot: '' }))).rejects.toMatchObject({
      subject: 'env SYSTEMROOT',
    });
    expect(commands).toHaveLength(0);
    // POSIX names are case-sensitive: PATH and Path are two variables.
    await expect(
      runVersionProbe(
        FAKE,
        probeOptions({
          platform: 'posix',
          env: { Path: 'a', PATH: 'b' },
          deps: { fs: SAME_FILE, run, workDir: fakeWorkDir() },
        }),
      ),
    ).resolves.toBe('');
    await expect(runVersionProbe(FAKE, win({ systemroot: 'C:\\Windows' }))).resolves.toBe('');
  });

  it.each<[CommandOutcome, string, string | undefined]>([
    [{ kind: 'spawn-error', errno: 'EACCES' }, 'spawn-error', 'EACCES'],
    [{ kind: 'timeout' }, 'timeout', undefined],
    [{ kind: 'output-too-large' }, 'output-too-large', undefined],
    [{ kind: 'exited', exitCode: null, signal: 'SIGKILL', stdout: '' }, 'exit-code', 'SIGKILL'],
    [{ kind: 'exited', exitCode: null, signal: null, stdout: '' }, 'exit-code', undefined],
  ])('maps %j to a probe failure', async (outcome, reason, subject) => {
    const { run } = fakeRun(outcome);
    const error = await runVersionProbe(
      FAKE,
      probeOptions({
        platform: 'posix',
        env: {},
        deps: { fs: SAME_FILE, run, workDir: fakeWorkDir() },
      }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VersionProbeError);
    expect((error as VersionProbeError).reason).toBe(reason);
    expect((error as VersionProbeError).subject).toBe(subject);
    expect((error as VersionProbeError).message).toBe(
      `version probe failed: ${reason}${subject === undefined ? '' : ` (${subject})`}`,
    );
  });
});
