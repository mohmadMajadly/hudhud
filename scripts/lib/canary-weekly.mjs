// The weekly canary's `should-run` rule (K16, ADR-0014 amendment 3, plan
// §5.9 W7-T2): the integration suite on Windows (and on macOS once the
// macOS gate has passed) against the newest CLI, whenever a version newer
// than the pinned one was published since the last weekly run.
//
// "The last weekly run" is the previous tick of the fixed weekly schedule
// (canary-weekly.yml), less a margin for a delayed scheduled start: reading
// the workflow's own run history back would need the `actions: read`
// permission, and scheduled jobs hold `contents: read` only. Each run
// writes the window it covered (from, to) into its job summary, so the
// summary history shows that consecutive windows leave no gap.

import { CLI_PACKAGE, compareReleases, newerThanPin, parseRelease, dryRun } from './nightly.mjs';

/** The weekly schedule's period. */
export const WEEK_HOURS = 7 * 24;

/**
 * Margin for a delayed scheduled start (GitHub may start a scheduled run
 * late); the same 2 h the nightly uses. A version published in the margin
 * can be tested twice; none is missed.
 */
export const MARGIN_HOURS = 2;

/**
 * The macOS switch. On since the macOS gate (M1, ADR-0014) passed and the
 * darwin entries of tooling/cli-pin.json were pinned (research 11; W7-Z,
 * lead ruling); macOS still runs only while no darwin entry is
 * `pendingGate`. Changing it is a reviewed one-line change of this file
 * (cost: 10x Linux per run, canary-weekly.yml).
 */
export const MACOS_CANARY_ENABLED = true;

/**
 * @param {import('./nightly.mjs').ScheduleFacts} facts
 * @param {boolean} [macosEnabled] The macOS switch; the committed
 *   {@link MACOS_CANARY_ENABLED} unless a test names it.
 * @returns {import('./nightly.mjs').ScheduleDecision}
 */
export function decideWeekly(facts, macosEnabled = MACOS_CANARY_ENABLED) {
  if (facts.mode === 'dry-run') return dryRun(facts);
  const step = newerThanPin(facts);
  if ('decision' in step) return step.decision;
  const pinned = /** @type {[number, number, number]} */ (parseRelease(facts.pin.version));
  const latest = /** @type {[number, number, number]} */ (parseRelease(step.registry.latest));
  const from = new Date(facts.now.getTime() - (WEEK_HOURS + MARGIN_HOURS) * 3_600_000);
  const window = `from ${from.toISOString()} to ${facts.now.toISOString()}`;
  // Versions above `latest` (a `next` tag) are not what users get yet; the
  // weekly tests `latest`, so only versions up to it count.
  const fresh = [...step.registry.published]
    .filter(([version, date]) => {
      const release = /** @type {[number, number, number]} */ (parseRelease(version));
      return (
        compareReleases(release, pinned) > 0 &&
        compareReleases(release, latest) <= 0 &&
        date.getTime() >= from.getTime()
      );
    })
    .map(([version]) => version);
  if (fresh.length === 0 && !facts.dispatched) {
    return {
      run: false,
      mode: 'canary',
      version: '',
      macos: false,
      lines: [
        `Window ${window} (this run, back to the previous weekly tick less a ${String(MARGIN_HOURS)} h margin).`,
        `No ${CLI_PACKAGE} version newer than the pinned ${facts.pin.version} was published in it; the newest, ${step.registry.latest}, was covered by an earlier weekly run.`,
      ],
    };
  }
  const macos = macosEnabled && !facts.pin.darwinPending;
  return {
    run: true,
    mode: 'canary',
    version: step.registry.latest,
    macos,
    lines: [
      `Window ${window} (this run, back to the previous weekly tick less a ${String(MARGIN_HOURS)} h margin).`,
      fresh.length === 0
        ? `Manual dispatch: no version newer than the pinned ${facts.pin.version} was published in the window, and the canary tests the newest, ${step.registry.latest}, on Windows${macos ? ' and macOS' : ''} anyway.`
        : `Published in it and newer than the pinned ${facts.pin.version}: ${fresh.join(', ')}. The weekly canary tests the newest, ${step.registry.latest}, on Windows${macos ? ' and macOS' : ''}.`,
      macos
        ? 'macOS: on (the macOS gate has passed and the darwin entries are pinned).'
        : `macOS: off (${macosEnabled ? 'a darwin entry of the pin is still pending the macOS gate' : 'MACOS_CANARY_ENABLED is false until the macOS gate has passed'}).`,
    ],
  };
}
