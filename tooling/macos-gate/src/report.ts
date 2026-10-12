/**
 * Results of the macOS gate (ADR-0014 "macOS gate list", plan §5.4 M1):
 * one machine-readable record per gate item, the run report, and the
 * Markdown job summary. Pure.
 *
 * An item passes only when it ran at least one check, every check passed and
 * the item did not throw. Evidence is free-form JSON for the reviewer; it
 * never decides the status.
 */

/** Schema tag of every file the harness writes. */
export const REPORT_SCHEMA = 'hudhud-macos-gate/1';

/** The seven ratified gate items, in order (ADR-0014). */
export const GATE_ITEMS = [
  { id: 1, key: 'provenance', title: 'Binary provenance' },
  { id: 2, key: 'process-tree', title: 'Process tree' },
  { id: 3, key: 'keychain', title: 'Keychain' },
  { id: 4, key: 'shell-snapshot', title: 'zsh login-shell snapshot hang' },
  { id: 5, key: 'socket-path', title: 'Socket path' },
  { id: 6, key: 'path-identity', title: 'Path identity' },
  { id: 7, key: 'ci-runner', title: 'CI runner' },
] as const;

export type GateItemId = (typeof GATE_ITEMS)[number]['id'];

type GateItem = (typeof GATE_ITEMS)[number];

const ITEM_BY_ID = Object.fromEntries(GATE_ITEMS.map((item) => [item.id, item])) as Readonly<
  Record<GateItemId, GateItem>
>;

export type ItemStatus = 'pass' | 'fail';

/** One verified assumption. */
export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** The machine-readable result of one gate item. */
export interface ItemResult {
  readonly schema: typeof REPORT_SCHEMA;
  readonly id: GateItemId;
  readonly key: string;
  readonly title: string;
  readonly status: ItemStatus;
  readonly checks: readonly Check[];
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly durationMs: number;
  /** The message of an exception that ended the item early. */
  readonly error?: string;
}

/** Process cleanup at the end of the run (plan §4.7, by verified identity). */
export interface CleanupReport {
  /** Identities signalled by the final sweep (`pid@startTime`, `-pgid` for groups). */
  readonly signalled: readonly string[];
  /** Identities still alive afterwards. Any entry fails the run. */
  readonly survivors: readonly string[];
}

/** The whole run on one runner. */
export interface GateReport {
  readonly schema: typeof REPORT_SCHEMA;
  readonly cliVersion: string;
  /** `darwin-arm64` or `darwin-x64`: the platform this runner exercised. */
  readonly platform: string;
  readonly runner: Readonly<Record<string, string>>;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly items: readonly ItemResult[];
  readonly cleanup: CleanupReport;
  readonly status: ItemStatus;
}

/** The status rule of an item. */
export function itemStatus(checks: readonly Check[], error: string | undefined): ItemStatus {
  return error === undefined && checks.length > 0 && checks.every((check) => check.ok)
    ? 'pass'
    : 'fail';
}

/** Collects checks and evidence while an item runs. */
export class ItemRecorder {
  readonly id: GateItemId;
  private readonly checks: Check[] = [];
  private readonly evidence: Record<string, unknown> = {};

  constructor(id: GateItemId) {
    this.id = id;
  }

  /** Records a check and returns `ok`, so a procedure can stop early on a failed precondition. */
  check(name: string, ok: boolean, detail: string): boolean {
    this.checks.push({ name, ok, detail });
    return ok;
  }

  /** Records evidence under `key` (a later value replaces an earlier one). */
  note(key: string, value: unknown): void {
    this.evidence[key] = value;
  }

  /** The item's result. */
  finish(durationMs: number, error?: string): ItemResult {
    const item = ITEM_BY_ID[this.id];
    return {
      schema: REPORT_SCHEMA,
      id: this.id,
      key: item.key,
      title: item.title,
      status: itemStatus(this.checks, error),
      checks: [...this.checks],
      evidence: { ...this.evidence },
      durationMs,
      ...(error === undefined ? {} : { error }),
    };
  }
}

/** The status of the run: every item passed, all seven ran, and nothing survived cleanup. */
export function runStatus(items: readonly ItemResult[], cleanup: CleanupReport): ItemStatus {
  const ran = new Set(items.map((item) => item.id));
  return GATE_ITEMS.every((item) => ran.has(item.id)) &&
    items.every((item) => item.status === 'pass') &&
    cleanup.survivors.length === 0
    ? 'pass'
    : 'fail';
}

/** Escapes text for a Markdown table cell (one line, no pipes, no HTML). */
export function cell(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[|<>`]/g, (char) => `&#${String(char.charCodeAt(0))};`)
    .slice(0, 300);
}

/** The Markdown job summary of a report. */
export function renderSummary(report: GateReport): string {
  const lines = [
    `## macOS gate: ${report.platform}, CLI ${report.cliVersion}: **${report.status.toUpperCase()}**`,
    '',
    `Runner: ${cell(
      Object.entries(report.runner)
        .map(([key, value]) => `${key}=${value}`)
        .join(', '),
    )}`,
    '',
    '| # | Item | Status | Failed checks |',
    '| --- | --- | --- | --- |',
  ];
  for (const item of report.items) {
    const failed = item.checks.filter((check) => !check.ok).map((check) => check.name);
    if (item.error !== undefined) failed.push(`error: ${item.error}`);
    lines.push(
      `| ${String(item.id)} | ${cell(item.title)} | ${item.status} | ${cell(failed.join('; ')) || '-'} |`,
    );
  }
  lines.push(
    '',
    `Cleanup: ${String(report.cleanup.signalled.length)} signalled, ${String(report.cleanup.survivors.length)} survivors${report.cleanup.survivors.length > 0 ? ` (${cell(report.cleanup.survivors.join(', '))})` : ''}.`,
    '',
  );
  for (const item of report.items) {
    lines.push(`<details><summary>${String(item.id)}. ${cell(item.title)}</summary>`, '');
    lines.push('| Check | OK | Detail |', '| --- | --- | --- |');
    for (const check of item.checks) {
      lines.push(`| ${cell(check.name)} | ${check.ok ? 'yes' : 'NO'} | ${cell(check.detail)} |`);
    }
    lines.push('', '</details>', '');
  }
  return lines.join('\n');
}
