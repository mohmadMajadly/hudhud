// The OS signature check of strict verification (ADR-0011, K8, plan §1.8,
// §5.5 W3-T2): PowerShell and codesign by absolute path, the binary path as a
// separate argument, only `Status` and the signer subject parsed, the
// publisher pinned on Windows (W3-Z ruling 9).

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
const SUBJECT = 'CN="Example, Inc.", O="Example, Inc.", C=US';
/** The script's output for a valid signature by {@link SUBJECT}. */
const VALID_OUT = `Valid\n${SUBJECT}`;

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
    publisher: { windowsSubject: SUBJECT },
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
    const { commands, run } = recorder(exited(VALID_OUT));
    await expect(checkOsSignature(BINARY, windowsDeps(run))).resolves.toEqual({
      kind: 'valid',
      detail: 'authenticode Valid, pinned publisher',
      signer: SUBJECT,
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
    expect(AUTHENTICODE_SCRIPT).toContain(
      '[Console]::Out.Write([string]$s.Status + "`n" + [string]$s.SignerCertificate.Subject)',
    );
    expect(AUTHENTICODE_SCRIPT).toContain(
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    );
    // The only cmdlet is the module-qualified Get-AuthenticodeSignature: no
    // other module (New-Object would auto-load Microsoft.PowerShell.Utility
    // and its script module) is loaded.
    expect(AUTHENTICODE_SCRIPT).not.toContain('New-Object');
  });

  it.each(['\n', '\r', '\u0085', '\u2028', '\u2029', '\u0000', '\u001b', '\u007f'])(
    'refuses a path with U+%s before running anything',
    async (char) => {
      const { commands, run } = recorder(exited(VALID_OUT));
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

  it.each(['', 'Valid', 'valid\nX', 'Valid Valid\nX', 'Status: Valid\nX', `\n${SUBJECT}`])(
    'fails on unrecognized output %j',
    async (stdout) => {
      const { run } = recorder(exited(stdout));
      await expect(checkOsSignature(BINARY, windowsDeps(run))).resolves.toEqual({
        kind: 'inconclusive',
        detail: 'authenticode status unrecognized',
      });
    },
  );

  it('fails a valid signature when no publisher is pinned', async () => {
    const { run } = recorder(exited(VALID_OUT));
    const { platform, hostEnv, fs } = windowsDeps(run);
    const unpinned: SignatureDeps = { platform, hostEnv, fs, run };
    await expect(checkOsSignature(BINARY, unpinned)).resolves.toEqual({
      kind: 'invalid',
      detail: 'authenticode Valid, but no publisher is pinned',
      signer: SUBJECT,
    });
    await expect(checkOsSignature(BINARY, windowsDeps(run, { publisher: {} }))).resolves.toEqual({
      kind: 'invalid',
      detail: 'authenticode Valid, but no publisher is pinned',
      signer: SUBJECT,
    });
  });

  it.each([
    ['another publisher', 'CN=Someone Else, O=Someone Else, C=US'],
    ['a subject that only starts with the pin', `${SUBJECT}, OU=x`],
    ['the pin in another case', SUBJECT.toLowerCase()],
    ['the pin with a trailing CR', `${SUBJECT}\r`],
    ['an unsigned file (no signer certificate)', ''],
  ])('fails a valid signature by %s', async (_name, signer) => {
    const { run } = recorder(exited(`Valid\n${signer}`));
    await expect(checkOsSignature(BINARY, windowsDeps(run))).resolves.toEqual({
      kind: 'invalid',
      detail: `authenticode Valid, but the signer is not the pinned publisher: ${JSON.stringify(signer)}`,
      signer,
    });
  });

  it('shows at most 256 characters of a foreign signer', async () => {
    const signer = `CN=${'x'.repeat(1000)}`;
    const { run } = recorder(exited(`Valid\n${signer}`));
    const result = await checkOsSignature(BINARY, windowsDeps(run));
    expect(result).toMatchObject({ kind: 'invalid', signer });
    expect(result.kind === 'invalid' ? result.detail : '').toBe(
      `authenticode Valid, but the signer is not the pinned publisher: ${JSON.stringify(signer.slice(0, 256))}`,
    );
  });

  it.each<[CommandOutcome, string]>([
    [exited(VALID_OUT, 3), 'exit 3'],
    [exited(VALID_OUT, null), 'exit SIGKILL'],
    [{ kind: 'exited', exitCode: null, signal: null, stdout: '' }, 'exit unknown'],
    [{ kind: 'timeout' }, 'timeout'],
    [{ kind: 'output-too-large' }, 'output-too-large'],
    [{ kind: 'spawn-error', errno: 'ENOENT' }, 'spawn failed: ENOENT'],
    [{ kind: 'spawn-error', errno: undefined }, 'spawn failed: unknown error'],
  ])('fails when the check does not complete (%j)', async (outcome, detail) => {
    const { run } = recorder(outcome);
    await expect(checkOsSignature(BINARY, windowsDeps(run))).resolves.toEqual({
      kind: 'inconclusive',
      detail: `authenticode check failed: ${detail}`,
    });
  });

  it('passes a configured timeout', async () => {
    const { commands, run } = recorder(exited(VALID_OUT));
    await checkOsSignature(BINARY, windowsDeps(run, { timeoutMs: 5 }));
    expect(commands[0]?.timeoutMs).toBe(5);
  });

  it.each<[Readonly<Record<string, string | undefined>>, string]>([
    [{ SystemRoot: 'C:\\Windows', SYSTEMROOT: 'D:\\Evil' }, 'system-root-ambiguous'],
    [{ SystemRoot: '\\\\server\\share\\Windows' }, 'system-root-invalid'],
    [{ SystemRoot: 'C:\\Windows\\..\\Evil' }, 'system-root-invalid'],
  ])('refuses an unusable SystemRoot %j', async (hostEnv, reason) => {
    const { commands, run } = recorder(exited(VALID_OUT));
    await expect(checkOsSignature(BINARY, windowsDeps(run, { hostEnv }))).resolves.toEqual({
      kind: 'invalid',
      detail: `powershell unavailable: ${reason}`,
    });
    expect(commands).toHaveLength(0);
  });

  it('uses C:\\Windows when SystemRoot is absent', async () => {
    const { commands, run } = recorder(exited(VALID_OUT));
    await checkOsSignature(BINARY, windowsDeps(run, { hostEnv: {} }));
    expect(commands[0]?.file).toBe(POWERSHELL);
  });

  it.each<[SignatureFs, string]>([
    [fakeFs({}), 'not-found'],
    [fakeFs({ [POWERSHELL]: 'C:\\Users\\user\\powershell.exe' }), 'redirected'],
    [fakeFs({ [POWERSHELL]: POWERSHELL }, 'dir'), 'not-regular-file'],
    [fakeFs({ [POWERSHELL]: POWERSHELL }, 'link'), 'not-regular-file'],
  ])('refuses a PowerShell that is not the in-box file (%#)', async (fs, reason) => {
    const { commands, run } = recorder(exited(VALID_OUT));
    await expect(checkOsSignature(BINARY, windowsDeps(run, { fs }))).resolves.toEqual({
      kind: 'invalid',
      detail: `powershell unavailable: ${reason}`,
    });
    expect(commands).toHaveLength(0);
  });

  it('compares the PowerShell realpath ignoring case', async () => {
    const { run } = recorder(exited(VALID_OUT));
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

  it('fails definitively on a non-zero exit code: codesign verdict', async () => {
    await expect(
      checkOsSignature('/a/claude', darwinDeps(recorder(exited('', 1)).run)),
    ).resolves.toEqual({ kind: 'invalid', detail: 'codesign failed: exit 1' });
  });

  it.each<[CommandOutcome, string]>([
    [{ kind: 'timeout' }, 'timeout'],
    [{ kind: 'output-too-large' }, 'output-too-large'],
    [{ kind: 'spawn-error', errno: 'EACCES' }, 'spawn failed: EACCES'],
    [exited('', null), 'exit SIGKILL'],
  ])('is inconclusive when codesign gives no verdict (%j)', async (outcome, detail) => {
    await expect(checkOsSignature('/a/claude', darwinDeps(recorder(outcome).run))).resolves.toEqual(
      { kind: 'inconclusive', detail: `codesign failed: ${detail}` },
    );
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
//
// Each test's timeout is a hang guard sized from the product bound it
// legitimately consumes (vitest.config.ts HANG_GUARD_MS, W3-Z ruling 4): its
// sequential checks times DEFAULT_SIGNATURE_TIMEOUT_MS, plus a margin for the
// test's own file work. A check took 0.4 s (small file) to 1 s (node.exe) on
// a Windows 11 workstation, but 19 s to 50 s on GitHub-hosted runners, where
// two sequential checks under a 60 s guard timed out (see the os-signature.ts
// remarks). Each check logs its duration, so CI records it.
/**
 * The test's own file work: creating a directory and copying node.exe
 * (93 MB; 30 ms measured on a workstation, not yet measured on a runner, so
 * the allowance is generous).
 */
const FILE_WORK_MARGIN_MS = 30_000;

/** The hang guard of a test that runs `checks` real checks one after another. */
function guardFor(checks: number): number {
  return checks * DEFAULT_SIGNATURE_TIMEOUT_MS + FILE_WORK_MARGIN_MS;
}

describe.runIf(process.platform === 'win32')('the Authenticode check on this Windows host', () => {
  let root = '';

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hudhud-sig-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10 });
  });

  function capturing(label: string): { outputs: CommandOutcome[]; deps: SignatureDeps } {
    const outputs: CommandOutcome[] = [];
    return {
      outputs,
      deps: {
        platform: 'win32',
        hostEnv: process.env,
        fs: nodeSignatureDeps.fs,
        run: async (command) => {
          const started = performance.now();
          const outcome = await nodeSignatureDeps.run(command);
          const ms = Math.round(performance.now() - started);
          console.log(`authenticode check (${label}): ${String(ms)} ms, ${outcome.kind}`);
          outputs.push(outcome);
          return outcome;
        },
      },
    };
  }

  it(
    'reports Valid for a signed binary whose name holds PowerShell syntax, and runs nothing from the name',
    async () => {
      const dir = path.join(root, "d $(x) ; & 'q' [w]");
      await mkdir(dir);
      const binary = path.join(dir, "n $(Write-Output INJECTED) ; `b' #.exe");
      await copyFile(process.execPath, binary);
      // Unpinned: the signature is valid, but any publisher is refused.
      const first = capturing('node.exe, unpinned');
      const unpinned = await checkOsSignature(binary, first.deps);
      expect(unpinned).toMatchObject({
        kind: 'invalid',
        detail: 'authenticode Valid, but no publisher is pinned',
      });
      const signer = unpinned.kind === 'invalid' ? (unpinned.signer ?? '') : '';
      expect(signer).toMatch(/^CN=/);
      expect(first.outputs).toEqual([
        { kind: 'exited', exitCode: 0, signal: null, stdout: `Valid\n${signer}` },
      ]);
      // Pinned to node's own publisher: valid.
      const second = capturing('node.exe, pinned');
      await expect(
        checkOsSignature(binary, { ...second.deps, publisher: { windowsSubject: signer } }),
      ).resolves.toEqual({ kind: 'valid', detail: 'authenticode Valid, pinned publisher', signer });
    },
    guardFor(2),
  );

  it(
    'fails for an unsigned file',
    async () => {
      const binary = path.join(root, 'plain.exe');
      await writeFile(binary, 'MZ not a signed image');
      const { deps } = capturing('unsigned 21 B');
      const result = await checkOsSignature(binary, deps);
      expect(result.kind).toBe('invalid');
    },
    guardFor(1),
  );
});
