/**
 * Lead-run proof of the recorder against the real pinned CLI (plan §5.4
 * W2-T10: "recorder reproduces the 05 §5 handshake shape on Windows and
 * Linux"). Runs only when explicitly requested AND the pinned binary is
 * already in the cache; it never downloads. Command (from the repository
 * root; the test root must lie outside the home and below no
 * `.claude`/`CLAUDE.md`/`.mcp.json`):
 *
 *   pnpm cli:fetch
 *   HUDHUD_RECORD_FIXTURES=1 HUDHUD_TEST_ROOT=<dir> [HUDHUD_RECORD_OUT=<dir>] \
 *     pnpm vitest run --project unit tooling/test-support/test/fixtures/handshake.real.test.ts
 *
 * PowerShell: `$env:HUDHUD_RECORD_FIXTURES='1'; $env:HUDHUD_TEST_ROOT='T:\'; pnpm vitest run ...`
 * With `HUDHUD_RECORD_OUT`, the normalized fixture is written to
 * `<out>/handshake/<platform>.jsonl` for review (W3-T6 minimizes it).
 *
 * Every isolation check is live: strict forbidden-ancestor policy, mock
 * with the egress trap, zero violations, zero leaked processes, no writes
 * outside the sandbox (the user's own live Claude Code session rewriting
 * `~/.claude.json` and its temp folder is the one documented confound,
 * 05 §13, ignored only when this process runs under Claude Code).
 */

import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HANDSHAKE_TIMEOUTS,
  HANDSHAKE_SHAPE,
  missingShape,
  recordHandshake,
  writeFixture,
} from '../../src/fixtures/recorder.js';
import { probePinnedCli } from '../../src/launcher/pinned-cli.js';
import { createSandbox } from '../../src/launcher/sandbox.js';
import type { LaunchHooks, LaunchOptions } from '../../src/launcher/sandbox.js';
import {
  assertNoOutsideWrites,
  diffOutside,
  outsideWatchList,
  snapshotOutside,
} from '../../src/leaks/outside.js';
import type { OutsideChange } from '../../src/leaks/outside.js';
import { hostProcessTable } from '../../src/leaks/process-table.js';
import { assertNoSurvivors, LeakTracker } from '../../src/leaks/tracker.js';
import { startMockServer } from '../../src/mock/server.js';
import { hangGuard, HOST_TABLE_READ_MS } from '../hang-guard.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const requested = process.env['HUDHUD_RECORD_FIXTURES'] === '1';
const probe = requested
  ? await probePinnedCli({ repoRoot: REPO, env: process.env })
  : {
      available: false as const,
      reason: 'set HUDHUD_RECORD_FIXTURES=1 to run (lead-run, plan §5.4)',
    };

describe('real pinned CLI handshake recording', () => {
  if (!probe.available) {
    it.skip(`skipped: ${probe.reason}`, () => undefined);
    return;
  }
  const { cli } = probe;

  it(
    'reproduces the 05 §5 handshake shape inside a fully isolated sandbox',
    async () => {
      const table = hostProcessTable(process.platform, process.env);
      const watch = outsideWatchList({
        platform: process.platform,
        home: os.homedir(),
        hostEnv: process.env,
        uid: process.getuid?.(),
      });
      const outsideBefore = snapshotOutside(watch);
      const mock = await startMockServer();
      const sandbox = await createSandbox({ cli, mock, name: 'handshake' });
      const tracker = new LeakTracker({ table, marker: sandbox.dirs.root });
      try {
        await tracker.begin();
        const launch = sandbox.launch.bind(sandbox);
        const tracked = {
          ...sandbox,
          launch: async (options?: LaunchOptions, hooks?: LaunchHooks) => {
            const child = await launch(options, hooks);
            await tracker.recordRoot(child.pid);
            return child;
          },
        };
        const { lines, exit } = await recordHandshake(tracked);
        expect(exit).toEqual({ code: 0, signal: null });
        expect(missingShape(lines, HANDSHAKE_SHAPE)).toEqual([]);
        expect(mock.requests.length).toBeGreaterThan(0);
        mock.assertNoViolations();
        await tracker.assertNoLeaks();
        await assertNoSurvivors({ table }, sandbox.dirs.root);
        const out = process.env['HUDHUD_RECORD_OUT'];
        if (out !== undefined && out !== '') {
          await writeFixture(path.join(out, 'handshake', `${process.platform}.jsonl`), lines);
        }
      } finally {
        await mock.close();
        await sandbox.dispose();
      }
      const underClaudeCode = process.env['CLAUDECODE'] === '1';
      const home = os.homedir();
      const confound = (change: OutsideChange): boolean =>
        underClaudeCode &&
        (change.path === path.join(home, '.claude.json') ||
          change.path.startsWith(
            path.join(process.env['TEMP'] ?? os.tmpdir(), 'claude') + path.sep,
          ));
      assertNoOutsideWrites(diffOutside(outsideBefore, snapshotOutside(watch)), confound);
      // Table reads: begin, recordRoot, assertNoLeaks, assertNoSurvivors (a
      // leak would add its kills, but then the test fails anyway); the
      // handshake with its default timeouts.
    },
    hangGuard(
      4 * HOST_TABLE_READ_MS,
      2 * DEFAULT_HANDSHAKE_TIMEOUTS.frameMs + DEFAULT_HANDSHAKE_TIMEOUTS.exitMs,
    ),
  );
});
