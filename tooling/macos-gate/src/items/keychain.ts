/**
 * Gate item 3, Keychain (ADR-0014; research 01 Â§5: credentials live in the
 * macOS Keychain, keyed by config dir).
 *
 * With API-key auth and an isolated `CLAUDE_CONFIG_DIR` and `HOME`, the CLI
 * must not touch the Keychain headless: no `security` child process appears
 * at any sample of its tree, the first frame arrives within the first-frame
 * watchdog, and the turn completes. A control run without any credential
 * records whether the CLI then reaches for the Keychain, and whether a stall
 * would be named `keychain-access` by the watchdog's classifier.
 */

import path from 'node:path';

import { classifyStall, watchdogState } from '../causes.js';
import type { ItemRecorder } from '../report.js';
import { commandName } from '../ps.js';
import { mockMarker } from '../sandbox.js';
import { field, runScenario, type CliSession, type SessionContext } from '../session.js';
import {
  initializeResponse,
  isSuccess,
  pollUntil,
  sessionEvidence,
  shellSnapshotReady,
  TURN_MS,
  WATCHDOG,
} from './common.js';

const CONTROL_MS = 45_000;

/** Samples the tree while waiting for a result; returns the names of every descendant seen. */
async function sampleUntilResult(
  context: SessionContext,
  session: CliSession,
  timeoutMs: number,
): Promise<{ readonly names: ReadonlySet<string>; readonly securitySeen: boolean }> {
  const names = new Set<string>();
  let securitySeen = false;
  const identity = session.identity;
  await pollUntil(
    context.host,
    () => session.findKind('result') !== undefined || session.exit !== undefined,
    timeoutMs,
    async () => {
      if (identity === null || session.exit !== undefined) return;
      const tree = await context.ledger.tree(identity);
      for (const record of tree.descendants) {
        const name = commandName(record.name);
        names.add(name);
        if (name === 'security') securitySeen = true;
      }
    },
  );
  return { names, securitySeen };
}

/** Runs item 3. */
export async function keychainItem(context: SessionContext, r: ItemRecorder): Promise<void> {
  r.note(
    'limitation',
    'Keychain access is detected through security(1) child processes sampled with /bin/ps; an in-process Security framework call by the CLI would not be visible (proxy accepted by the lead).',
  );
  const keyed = await runScenario(context, {}, async ({ session, sandbox }) => {
    session.initialize();
    session.user(`${mockMarker('text')} gate item 3`);
    const sampled = await sampleUntilResult(context, session, TURN_MS);
    r.note('apiKeySession', { ...sessionEvidence(session), descendants: [...sampled.names] });
    const first = session.frames[0];
    const started = session.watchdogInput().startedAt;
    r.check(
      'API key: the first frame arrives within the first-frame watchdog',
      first !== undefined && first.at - started < WATCHDOG.firstFrameMs,
      first === undefined ? 'no frame' : `${String(first.at - started)} ms`,
    );
    const source = field(field(initializeResponse(session), 'account'), 'apiKeySource');
    r.check(
      'API key: apiKeySource is ANTHROPIC_API_KEY',
      source === 'ANTHROPIC_API_KEY',
      String(source),
    );
    r.check('API key: the turn completes', isSuccess(session.findKind('result')), 'result/success');
    r.check(
      'API key: no security(1) child at any sample (no Keychain access)',
      !sampled.securitySeen,
      [...sampled.names].join(', '),
    );
    r.note(
      'keychainsDirInIsolatedHome',
      await context.host.fs.kind(path.posix.join(sandbox.home, 'Library', 'Keychains')),
    );
  });
  r.check('API key run: no egress violation', keyed.violations === 0, String(keyed.violations));

  const control = await runScenario(context, { apiKey: false }, async ({ session, sandbox }) => {
    session.initialize();
    session.user(`${mockMarker('text')} gate item 3 control`);
    const sampled = await sampleUntilResult(context, session, CONTROL_MS);
    const state = watchdogState(session.watchdogInput(), WATCHDOG);
    const ended = session.findKind('result') !== undefined || session.exit !== undefined;
    const tree =
      session.identity === null || ended ? undefined : await context.ledger.tree(session.identity);
    const cause =
      tree === undefined
        ? undefined
        : classifyStall({
            descendants: tree.descendants,
            toolRunning: session.toolRunning,
            shellSnapshotReady: await shellSnapshotReady(context.host, sandbox),
          });
    r.note('controlSession', {
      ...sessionEvidence(session),
      descendants: [...sampled.names],
      securitySeen: sampled.securitySeen,
      watchdog: state,
      stallCause: cause,
    });
    r.check(
      'control (no credential): the CLI ends, or its stall is named',
      ended || (cause !== undefined && cause !== 'unknown'),
      ended ? 'ended' : `stall cause ${String(cause)}`,
    );
  });
  r.check('control run: no egress violation', control.violations === 0, String(control.violations));
  r.check(
    'nothing survives either run',
    keyed.shutdown.sweep.survivors.length + control.shutdown.sweep.survivors.length === 0,
    [...keyed.shutdown.sweep.survivors, ...control.shutdown.sweep.survivors].join(', '),
  );
}
