import { describe, expect, it } from 'vitest';

import {
  cell,
  GATE_ITEMS,
  ItemRecorder,
  itemStatus,
  REPORT_SCHEMA,
  renderSummary,
  runStatus,
  type GateReport,
  type ItemResult,
} from '../src/report.js';

const ok = { name: 'a', ok: true, detail: '' };
const bad = { name: 'b', ok: false, detail: 'why' };

function passing(id: ItemResult['id']): ItemResult {
  const recorder = new ItemRecorder(id);
  recorder.check('fine', true, '');
  return recorder.finish(1);
}

describe('item evaluation', () => {
  it('lists the seven ratified items in order', () => {
    expect(GATE_ITEMS.map((item) => item.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('passes only with at least one check, all checks passing and no error', () => {
    expect(itemStatus([ok], undefined)).toBe('pass');
    expect(itemStatus([], undefined)).toBe('fail');
    expect(itemStatus([ok, bad], undefined)).toBe('fail');
    expect(itemStatus([ok], 'boom')).toBe('fail');
  });

  it('records checks, evidence and the outcome', () => {
    const recorder = new ItemRecorder(5);
    expect(recorder.check('x', true, 'd')).toBe(true);
    expect(recorder.check('y', false, 'e')).toBe(false);
    recorder.note('k', 1);
    recorder.note('k', 2);
    const result = recorder.finish(42, 'stopped');
    expect(result).toEqual({
      schema: REPORT_SCHEMA,
      id: 5,
      key: 'socket-path',
      title: 'Socket path',
      status: 'fail',
      checks: [
        { name: 'x', ok: true, detail: 'd' },
        { name: 'y', ok: false, detail: 'e' },
      ],
      evidence: { k: 2 },
      durationMs: 42,
      error: 'stopped',
    });
    expect(new ItemRecorder(1).finish(0)).not.toHaveProperty('error');
  });

  it('passes the run only when all seven items ran and passed and nothing survived', () => {
    const all = GATE_ITEMS.map((item) => passing(item.id));
    const clean = { signalled: [], survivors: [] };
    expect(runStatus(all, clean)).toBe('pass');
    expect(runStatus(all.slice(1), clean)).toBe('fail');
    expect(runStatus([...all.slice(1), new ItemRecorder(1).finish(0)], clean)).toBe('fail');
    expect(runStatus(all, { signalled: [], survivors: ['12@3'] })).toBe('fail');
  });
});

describe('summary', () => {
  it('escapes table cells', () => {
    expect(cell('a|b\r\nc<d>`e`')).toBe('a&#124;b c&#60;d&#62;&#96;e&#96;');
    expect(cell('x'.repeat(400))).toHaveLength(300);
  });

  it('renders the status table, the failed checks, errors, cleanup and details', () => {
    const failing = new ItemRecorder(2);
    failing.check('sigterm cleans', false, 'left 1');
    failing.check('ps parses', true, 'ok');
    const report: GateReport = {
      schema: REPORT_SCHEMA,
      cliVersion: '2.1.296',
      platform: 'darwin-arm64',
      runner: { node: 'v22', arch: 'arm64' },
      startedAt: 's',
      finishedAt: 'f',
      items: [passing(1), failing.finish(3, 'boom')],
      cleanup: { signalled: ['1@2'], survivors: ['3@4'] },
      status: 'fail',
    };
    const text = renderSummary(report);
    expect(text).toContain('## macOS gate: darwin-arm64, CLI 2.1.296: **FAIL**');
    expect(text).toContain('Runner: node=v22, arch=arm64');
    expect(text).toContain('| 1 | Binary provenance | pass | - |');
    expect(text).toContain('| 2 | Process tree | fail | sigterm cleans; error: boom |');
    expect(text).toContain('Cleanup: 1 signalled, 1 survivors (3@4).');
    expect(text).toContain('| sigterm cleans | NO | left 1 |');
    expect(text).toContain('| ps parses | yes | ok |');
    const clean = renderSummary({ ...report, cleanup: { signalled: [], survivors: [] } });
    expect(clean).toContain('Cleanup: 0 signalled, 0 survivors.');
  });
});
