// Snapshot check of the request-shape suite (plan §1.11, §4.4; ADR-0013 §4).
//
// Takes what the mock captured in the current test, normalizes it into a
// structural snapshot, refuses to keep one that carries a secret or a path
// of this machine, and compares it with the committed file next to this one
// (snapshots/<scenario>.<platform>.shape):
//
// - semantic change (removed key, changed literal or type, other number of
//   messages or requests): the test fails with the findings;
// - additive change (new key, new anthropic-beta value, new tool): the test
//   passes and prints a warning, to be triaged at the next CLI bump;
// - HUDHUD_REQUEST_SHAPE_UPDATE=1 writes the file and then FAILS the test on
//   purpose, so a run in update mode can never pass; the diff is reviewed
//   and committed, the run repeated without the variable.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { scanText } from '../../../../../scripts/lib/privacy.mjs';
import {
  FAKE_API_KEY,
  FAKE_AUTH_TOKEN,
} from '../../../../../tooling/test-support/src/launcher/env.js';
import {
  enforceVerdict,
  findLeaks,
  judgeSnapshot,
  RequestShapeError,
  serializeSnapshot,
  shapeContext,
  snapshotOf,
  updateRequested,
  UPDATE_ENV,
} from '../../../../../tooling/test-support/src/snapshots/request-shape.js';
import type { ClaudeIntegrationSuite } from '../support/harness.js';

const SNAPSHOT_DIR = path.join(import.meta.dirname, 'snapshots');
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');

/**
 * Committed file of a scenario on a platform: JSON text with the extension
 * `.shape`, which Prettier does not know, so the committed bytes stay exactly
 * what `serializeSnapshot` wrote (a reformat would be noise in every bump
 * diff). The files are per platform because the CLI's tool list is: measured
 * by this suite on CLI 2.1.296, the Linux build sends no `Glob` and no `Grep`
 * tool and the Windows build sends both; every other part of the requests is
 * equal on the two.
 */
export function snapshotFile(scenario: string): string {
  return path.join(SNAPSHOT_DIR, `${scenario}.${process.platform}.shape`);
}

function readCommitted(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Snapshots the requests the current test sent to the mock and compares them
 * with the committed file of `scenario`. Call it after the session closed.
 */
export async function checkRequestShape(
  suite: ClaudeIntegrationSuite,
  scenario: string,
  expectedRequests: number,
): Promise<void> {
  const mock = await suite.mock();
  const sandbox = await suite.sandbox();
  if (mock.requests.length !== expectedRequests) {
    throw new RequestShapeError(
      `request-shape ${scenario}: the CLI sent ${String(mock.requests.length)} request(s), the scenario expects ${String(expectedRequests)}`,
    );
  }
  const snapshot = snapshotOf(
    scenario,
    mock.requests,
    shapeContext(sandbox, [FAKE_API_KEY, FAKE_AUTH_TOKEN]),
  );
  const text = serializeSnapshot(snapshot);

  // Nothing of this machine may reach a committed file: the exact secrets and
  // directories first, then the repository's own privacy rules.
  const { dirs } = sandbox;
  const forbidden = [
    FAKE_API_KEY,
    FAKE_AUTH_TOKEN,
    dirs.root,
    dirs.home,
    dirs.cfg,
    dirs.tmp,
    dirs.work,
    dirs.appData,
    dirs.localAppData,
    suite.suiteDir,
    sandbox.cli.binaryPath,
    os.homedir(),
    os.tmpdir(),
    REPO_ROOT,
  ];
  const leaks = [
    ...findLeaks(text, forbidden),
    ...scanText(`${scenario}.shape`, text, []).map((item) => `privacy rule ${item.rule}`),
  ];
  if (leaks.length > 0) {
    throw new RequestShapeError(
      `request-shape ${scenario}: the snapshot would carry ${leaks.join(', ')}; not written`,
    );
  }

  const file = snapshotFile(scenario);
  if (updateRequested(process.env)) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(file, text);
    throw new RequestShapeError(
      `request-shape ${scenario}: snapshot written to ${path.relative(REPO_ROOT, file)}; review the diff, then run without ${UPDATE_ENV}`,
    );
  }
  const warning = enforceVerdict(scenario, judgeSnapshot(readCommitted(file), snapshot));
  if (warning !== undefined) console.warn(warning);
}
