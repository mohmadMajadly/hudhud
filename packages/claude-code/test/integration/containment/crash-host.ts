// The test side of the host-crash tests (plan §4.4, §5.8 W6-T3; 07 §2): it
// starts `support/crash-host.mjs` as a child Node.js process that runs the
// product in the test's sandbox, records it with the test's leak tracker,
// relays its reports, and kills it abruptly through its own child handle
// (`SIGKILL`; `TerminateProcess` on Windows). The Vitest worker itself is
// never signalled.

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import type { ClaudeIntegrationSuite } from '../support/harness.js';

/** The repository root (the pin and the CLI cache). */
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');
/** The host script (composition root, see its header). */
const HOST_SCRIPT = path.resolve(import.meta.dirname, '..', 'support', 'crash-host.mjs');

/** A report of the host (see `crash-host.mjs`). */
export type HostReport =
  | {
      readonly type: 'root';
      readonly pid: number;
      readonly startTime: string | null;
      readonly problem: string | null;
      readonly source: string;
    }
  | { readonly type: 'refused'; readonly message: string }
  | {
      readonly type: 'session';
      readonly pid: number;
      readonly cliPid: number | null;
      readonly containment: string;
    }
  | { readonly type: 'permission'; readonly tool: string }
  | { readonly type: 'result'; readonly outcome: string }
  | { readonly type: 'error'; readonly message: string };

/** A running host. */
export interface CrashHost {
  readonly pid: number;
  /** Every report so far, in order. */
  readonly reports: readonly HostReport[];
  /** Resolves with the first report of `type` (rejects on an `error` report or the host's exit). */
  next<T extends HostReport['type']>(
    type: T,
    guardMs: number,
  ): Promise<Extract<HostReport, { type: T }>>;
  /** Kills the host abruptly through its child handle and waits for its exit. */
  crash(): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  /** Stderr of the host so far (for failure messages). */
  stderr(): string;
}

/** The host's own lifetime: it ends itself after this (it never outlives its test). */
const HOST_LIFETIME_MS = 110_000;

/** The minimal environment of the host process: nothing of the worker's environment reaches it. */
function hostEnv(tmp: string, home: string): Record<string, string> {
  if (process.platform !== 'win32') return { TMPDIR: tmp, HOME: home };
  const systemRoot = process.env['SYSTEMROOT'] ?? process.env['SystemRoot'] ?? 'C:\\Windows';
  return { SYSTEMROOT: systemRoot, TEMP: tmp, TMP: tmp, USERPROFILE: home };
}

/**
 * Starts the host in the test's sandbox with `prompt` as the session's
 * first turn, and records it as a root of the test's leak tracker.
 */
export async function startCrashHost(
  suite: ClaudeIntegrationSuite,
  prompt: string,
): Promise<CrashHost> {
  const { sandbox, tracker } = await suite.setup();
  const config = path.join(sandbox.dirs.tmp, 'crash-host.json');
  await writeFile(
    config,
    JSON.stringify({
      repoRoot: REPO_ROOT,
      cacheRoot: suite.cli.cacheRoot,
      binaryPath: suite.cli.binaryPath,
      sandbox: {
        dirs: sandbox.dirs,
        env: sandbox.env,
        mockUrl: sandbox.mockUrl,
        platform: sandbox.platform,
      },
      prompt,
      lifetimeMs: HOST_LIFETIME_MS,
    }),
    { flag: 'wx', mode: 0o600 },
  );
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [HOST_SCRIPT, config], {
    cwd: sandbox.dirs.work,
    env: hostEnv(sandbox.dirs.tmp, sandbox.dirs.home),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error('the crash host did not start');
  // Recorded at once (it is alive: its stdin keeps it running), so the
  // tracker samples the CLI and its tree as the host's descendants.
  await tracker.recordRoot(pid);

  const reports: HostReport[] = [];
  const waiters: (() => void)[] = [];
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    reports.push(JSON.parse(line) as HostReport);
    for (const wake of waiters.splice(0)) wake();
  });
  let gone = false;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      gone = true;
      resolve({ code, signal });
      for (const wake of waiters.splice(0)) wake();
    });
  });

  return {
    pid,
    reports,
    next<T extends HostReport['type']>(type: T, guardMs: number) {
      return new Promise<Extract<HostReport, { type: T }>>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`no '${type}' report within ${String(guardMs)} ms: ${stderr}`));
        }, guardMs);
        /** Settles when it can; else waits for the next report or the exit. */
        const check = (): void => {
          const found = reports.find((report) => report.type === type);
          const failed = reports.find((report) => report.type === 'error');
          if (found !== undefined) resolve(found as Extract<HostReport, { type: T }>);
          else if (failed !== undefined) reject(new Error(`crash host: ${failed.message}`));
          else if (gone) reject(new Error(`crash host exited before '${type}': ${stderr}`));
          else {
            waiters.push(check);
            return;
          }
          clearTimeout(timer);
        };
        check();
      });
    },
    async crash() {
      child.kill('SIGKILL');
      return exited;
    },
    stderr: () => stderr,
  };
}
