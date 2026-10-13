// The OS signature check of strict verification (ADR-0011, K8, plan §1.8,
// §5.5 W3-T2): PowerShell and codesign by absolute path, the binary path as a
// separate argument, only `Status` parsed.

import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BoundedCommand, CommandOutcome } from '../../../../src/process/verify/command.js';
import {
  AUTHENTICODE_SCRIPT,
  AUTHENTICODE_STATUSES,
  authenticodeArgv,
  checkOsSignature,
  CODESIGN_PATH,
  DEFAULT_SIGNATURE_TIMEOUT_MS,
  nodeSignatureDeps,
  signaturePlatformOf,
  type SignatureDeps,
  type SignatureFs,
} from '../../../../src/process/verify/os-signature.js';

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const BINARY = 'C:\\Users\\user\\.local\\bin\\claude.exe';

function fakeFs(
  realpaths: Readonly<Record<string, string>>,
  kind: 'file' | 'link' | 'dir' = 'file',
): SignatureFs {
  return {
    realpath: (value) => {
      const target = realpaths[value];
      return target === undefined
        ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        : Promise.resolve(target);
    },
    lstat: () =>
      Promise.resolve({
        isFile: () => kind === 'file',
        isSymbolicLink: () => kind === 'link',
      }),
  };
}

function recorder(outcome: CommandOutcome): {
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

function exited(stdout: string, exitCode: number | null = 0): CommandOutcome {
  return { kind: 'exited', exitCode, signal: exitCode === null ? 'SIGKILL' : null, stdout };
}

function windowsDeps(
  run: SignatureDeps['run'],
  overrides: Partial<SignatureDeps> = {},
): SignatureDeps {
  return {
    platform: 'win32',
    hostEnv: { SystemRoot: 'C:\\Windows' },
    fs: fakeFs({ [POWERSHELL]: POWERSHELL }),
    run,
    ...overrides,
  };
}

describe('signaturePlatformOf', () => {
  it('maps win32 and darwin and nothing else', () => {
    expect(signaturePlatformOf('win32')).toBe('win32');
    expect(signaturePlatformOf('darwin')).toBe('darwin');
    expect(signaturePlatformOf('linux')).toBe('other');
    expect(signaturePlatformOf('freebsd')).toBe('other');
  });
});

describe('the Windows Authenticode check', () => {
  it('runs PowerShell by absolute path with a constant script and the path as its own argument', async () => {
    const { commands, run } = recorder(exited('Valid'));
    await expect(checkOsSignature(BINARY, windowsDeps(run))).resolves.toEqual({
      kind: 'valid',
      detail: 'authenticode Valid',
    });
    expect(commands).toHaveLength(1);
    const command = commands[0];
    expect(command?.file).toBe(POWERSHELL);
    expect(command?.args).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      AUTHENTICODE_SCRIPT,
      BINARY,
    ]);
    expect(command?.cwd).toBe('C:\\Windows\\System32');
    expect(command?.platform).toBe('win32');
    expect(command?.timeoutMs).toBe(DEFAULT_SIGNATURE_TIMEOUT_MS);
    expect(command?.maxStdoutBytes).toBe(4096);
    expect(command?.env).toMatchObject({
      SystemRoot: 'C:\\Windows',
      PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
      USERPROFILE: 'C:\\Windows',
    });
  });

  it('keeps the path out of the script text', () => {
    const evil = "C:\\x\\a'; $(Remove-Item C:\\) #.exe";
    const argv = authenticodeArgv(evil);
    expect(argv.at(-1)).toBe(evil);
    expect(argv.slice(0, -1).join(' ')).not.toContain('Remove-Item');
    expect(AUTHENTICODE_SCRIPT.split('\n').at(-1)).toBe('#');
    expect(AUTHENTICODE_SCRIPT).toContain('GetCommandLineArgs()');
    expect(AUTHENTICODE_SCRIPT).toContain('$a.Length -ne 7');
    expect(AUTHENTICODE_SCRIPT).toContain(
      'Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $a[6]',
    );
    expect(AUTHENTICODE_SCRIPT).toContain('[Console]::Out.Write([string]$s.Status)');
  });

  it.each(['\n', '\r', '\u0085', '\u2028', '\u2029', '\u0000', '\u001b', '\u007f'])(
    'refuses a path with U+%s before running anything',
    async (char) => {
      const { commands, run } = recorder(exited('Valid'));
      await expect(checkOsSignature(`C:\\x\\a${char}b.exe`, windowsDeps(run))).rejects.toThrow(
        RangeError,
      );
      expect(commands).toHaveLength(0);
    },
  );

  it.each(AUTHENTICODE_STATUSES.filter((status) => status !== 'Valid'))(
    'fails on status %s',
    async (status) => {
      const { run } = recorder(exited(`${status}\r\n`));
      await expect(checkOsSignature(BINARY, windowsDeps(run))).resolves.toEqual({
        kind: 'invalid',
        detail: `authenticode ${status}`,
      });
    },
  );

  it.each(['', 'valid', 'Valid Valid', 'Valid\nNotSigned', 'Status: Valid'])(
    'fails on unrecognized output %j',
    async (stdout) => {
      const { run } = recorder(exited(stdout));
      await expect(checkOsSignature(BINARY, windowsDeps(run))).resolves.toEqual({
        kind: 'invalid',
        detail: 'authenticode status unrecognized',
      });
    },
  );

  it.each<[CommandOutcome, string]>([
    [exited('Valid', 3), 'exit 3'],
    [exited('Valid', null), 'exit SIGKILL'],
    [{ kind: 'exited', exitCode: null, signal: null, stdout: '' }, 'exit unknown'],
    [{ kind: 'timeout' }, 'timeout'],
    [{ kind: 'output-too-large' }, 'output-too-large'],
    [{ kind: 'spawn-error', errno: 'ENOENT' }, 'spawn failed: ENOENT'],
    [{ kind: 'spawn-error', errno: undefined }, 'spawn failed: unknown error'],
  ])('fails when the check does not complete (%j)', async (outcome, detail) => {
    const { run } = recorder(outcome);
    await expect(checkOsSignature(BINARY, windowsDeps(run))).resolves.toEqual({
      kind: 'invalid',
      detail: `authenticode check failed: ${detail}`,
    });
  });

  it('passes a configured timeout', async () => {
    const { commands, run } = recorder(exited('Valid'));
    await checkOsSignature(BINARY, windowsDeps(run, { timeoutMs: 5 }));
    expect(commands[0]?.timeoutMs).toBe(5);
  });

  it.each<[Readonly<Record<string, string | undefined>>, string]>([
    [{ SystemRoot: 'C:\\Windows', SYSTEMROOT: 'D:\\Evil' }, 'system-root-ambiguous'],
    [{ SystemRoot: '\\\\server\\share\\Windows' }, 'system-root-invalid'],
    [{ SystemRoot: 'C:\\Windows\\..\\Evil' }, 'system-root-invalid'],
  ])('refuses an unusable SystemRoot %j', async (hostEnv, reason) => {
    const { commands, run } = recorder(exited('Valid'));
    await expect(checkOsSignature(BINARY, windowsDeps(run, { hostEnv }))).resolves.toEqual({
      kind: 'invalid',
      detail: `powershell unavailable: ${reason}`,
    });
    expect(commands).toHaveLength(0);
  });

  it('uses C:\\Windows when SystemRoot is absent', async () => {
    const { commands, run } = recorder(exited('Valid'));
    await checkOsSignature(BINARY, windowsDeps(run, { hostEnv: {} }));
    expect(commands[0]?.file).toBe(POWERSHELL);
  });

  it.each<[SignatureFs, string]>([
    [fakeFs({}), 'not-found'],
    [fakeFs({ [POWERSHELL]: 'C:\\Users\\user\\powershell.exe' }), 'redirected'],
    [fakeFs({ [POWERSHELL]: POWERSHELL }, 'dir'), 'not-regular-file'],
    [fakeFs({ [POWERSHELL]: POWERSHELL }, 'link'), 'not-regular-file'],
  ])('refuses a PowerShell that is not the in-box file (%#)', async (fs, reason) => {
    const { commands, run } = recorder(exited('Valid'));
    await expect(checkOsSignature(BINARY, windowsDeps(run, { fs }))).resolves.toEqual({
      kind: 'invalid',
      detail: `powershell unavailable: ${reason}`,
    });
    expect(commands).toHaveLength(0);
  });

  it('compares the PowerShell realpath ignoring case', async () => {
    const { run } = recorder(exited('Valid'));
    const fs = fakeFs({ [POWERSHELL]: POWERSHELL.toUpperCase() });
    await expect(checkOsSignature(BINARY, windowsDeps(run, { fs }))).resolves.toMatchObject({
      kind: 'valid',
    });
  });
});

describe('the macOS codesign check', () => {
  function darwinDeps(
    run: SignatureDeps['run'],
    fs = fakeFs({ [CODESIGN_PATH]: CODESIGN_PATH }),
  ): SignatureDeps {
    return { platform: 'darwin', hostEnv: {}, fs, run };
  }

  it('runs /usr/bin/codesign --verify --strict with the path as its own argument', async () => {
    const { commands, run } = recorder(exited(''));
    await expect(checkOsSignature('/Users/user/claude', darwinDeps(run))).resolves.toEqual({
      kind: 'valid',
      detail: 'codesign valid',
    });
    expect(commands).toEqual([
      {
        file: '/usr/bin/codesign',
        args: ['--verify', '--strict', '/Users/user/claude'],
        env: { LC_ALL: 'C' },
        cwd: '/',
        platform: 'posix',
        timeoutMs: DEFAULT_SIGNATURE_TIMEOUT_MS,
        maxStdoutBytes: 4096,
      },
    ]);
  });

  it('fails on a non-zero exit or an incomplete run', async () => {
    await expect(
      checkOsSignature('/a/claude', darwinDeps(recorder(exited('', 1)).run)),
    ).resolves.toEqual({ kind: 'invalid', detail: 'codesign failed: exit 1' });
    await expect(
      checkOsSignature('/a/claude', darwinDeps(recorder({ kind: 'timeout' }).run)),
    ).resolves.toEqual({ kind: 'invalid', detail: 'codesign failed: timeout' });
  });

  it('refuses a redirected codesign', async () => {
    const { commands, run } = recorder(exited(''));
    const fs = fakeFs({ [CODESIGN_PATH]: '/tmp/codesign' });
    await expect(checkOsSignature('/a/claude', darwinDeps(run, fs))).resolves.toEqual({
      kind: 'invalid',
      detail: 'codesign unavailable: redirected',
    });
    expect(commands).toHaveLength(0);
  });
});

describe('other platforms', () => {
  it('have no OS signature check and run nothing', async () => {
    const { commands, run } = recorder(exited('Valid'));
    await expect(
      checkOsSignature('/usr/bin/claude', { platform: 'other', hostEnv: {}, fs: fakeFs({}), run }),
    ).resolves.toEqual({ kind: 'unsupported' });
    expect(commands).toHaveLength(0);
  });
});

// The real check on a Windows host: a signed binary (a copy of node.exe)
// under a name full of PowerShell syntax, and an unsigned file.
describe.runIf(process.platform === 'win32')('the Authenticode check on this Windows host', () => {
  let root = '';

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hudhud-sig-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10 });
  });

  function capturing(): { outputs: CommandOutcome[]; deps: SignatureDeps } {
    const outputs: CommandOutcome[] = [];
    return {
      outputs,
      deps: {
        platform: 'win32',
        hostEnv: process.env,
        fs: nodeSignatureDeps.fs,
        run: async (command) => {
          const outcome = await nodeSignatureDeps.run(command);
          outputs.push(outcome);
          return outcome;
        },
      },
    };
  }

  it('reports Valid for a signed binary whose name holds PowerShell syntax, and runs nothing from the name', async () => {
    const dir = path.join(root, "d $(x) ; & 'q' [w]");
    await mkdir(dir);
    const binary = path.join(dir, "n $(Write-Output INJECTED) ; `b' #.exe");
    await copyFile(process.execPath, binary);
    const { outputs, deps } = capturing();
    await expect(checkOsSignature(binary, deps)).resolves.toEqual({
      kind: 'valid',
      detail: 'authenticode Valid',
    });
    expect(outputs).toEqual([{ kind: 'exited', exitCode: 0, signal: null, stdout: 'Valid' }]);
  }, 60_000);

  it('fails for an unsigned file', async () => {
    const binary = path.join(root, 'plain.exe');
    await writeFile(binary, 'MZ not a signed image');
    const { deps } = capturing();
    const result = await checkOsSignature(binary, deps);
    expect(result.kind).toBe('invalid');
  }, 60_000);
});
