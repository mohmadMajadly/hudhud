// Summary of integration timing samples (plan §4.4 flake policy, K15;
// W7-T1). Input: the JSON lines `recordTiming` appends
// (`packages/claude-code/test/integration/support/timing.ts`). Output: per
// platform and sample the count, minimum, median, p95 (nearest rank),
// maximum and the bound the flake policy derives from it, 3x the maximum.
// Pure; scripts/ci-timing.mjs reads the file and writes the summary.

/**
 * @typedef {object} Sample
 * @property {string} sample
 * @property {number} ms
 * @property {string} platform
 */

/**
 * @typedef {object} SampleStats
 * @property {string} platform
 * @property {string} sample
 * @property {number} n
 * @property {number} min
 * @property {number} median
 * @property {number} p95
 * @property {number} max
 * @property {number} bound 3x `max`, rounded up to a whole millisecond.
 */

/** Smallest sample count per quantity the K15 measurement accepts (W7-T1 brief). */
export const MIN_SAMPLES = 15;

/** Margin of the flake policy (plan §4.4): bound = 3x the maximum measured. */
export const MARGIN = 3;

const NAME = /^[a-z0-9][a-z0-9.:[\]_-]{0,99}$/u;

/**
 * Parses the timing log. Every non-empty line must be one well-formed
 * sample; anything else throws with its line number, so a corrupted log
 * never yields a bound.
 *
 * @param {string} text
 * @returns {Sample[]}
 */
export function parseSamples(text) {
  /** @type {Sample[]} */
  const samples = [];
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const where = `line ${String(index + 1)}`;
    /** @type {unknown} */
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`${where}: not JSON`);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${where}: not an object`);
    }
    /** @type {unknown} */
    const sample = Reflect.get(value, 'sample');
    /** @type {unknown} */
    const ms = Reflect.get(value, 'ms');
    /** @type {unknown} */
    const platform = Reflect.get(value, 'platform');
    if (typeof sample !== 'string' || !NAME.test(sample)) {
      throw new Error(`${where}: bad sample name`);
    }
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
      throw new Error(`${where}: bad ms`);
    }
    if (typeof platform !== 'string' || !NAME.test(platform)) {
      throw new Error(`${where}: bad platform`);
    }
    samples.push({ sample, ms, platform });
  }
  return samples;
}

/**
 * The value at nearest rank `ceil(q * n)` of ascending `sorted` (n > 0).
 *
 * @param {readonly number[]} sorted
 * @param {number} q
 * @returns {number}
 */
export function nearestRank(sorted, q) {
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return /** @type {number} */ (sorted[rank - 1]);
}

/**
 * @param {readonly Sample[]} samples
 * @returns {SampleStats[]} Sorted by platform, then sample name.
 */
export function summarize(samples) {
  /** @type {Map<string, { platform: string, sample: string, values: number[] }>} */
  const groups = new Map();
  for (const { platform, sample, ms } of samples) {
    const key = `${platform}\0${sample}`;
    const group = groups.get(key) ?? { platform, sample, values: [] };
    group.values.push(ms);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ platform, sample, values }) => {
      const sorted = values.toSorted((a, b) => a - b);
      const max = /** @type {number} */ (sorted.at(-1));
      return {
        platform,
        sample,
        n: sorted.length,
        min: /** @type {number} */ (sorted[0]),
        median: nearestRank(sorted, 0.5),
        p95: nearestRank(sorted, 0.95),
        max,
        bound: Math.ceil(MARGIN * max),
      };
    })
    .toSorted((a, b) =>
      a.platform === b.platform
        ? a.sample.localeCompare(b.sample, 'en')
        : a.platform.localeCompare(b.platform, 'en'),
    );
}

/**
 * @param {number} ms
 * @returns {string}
 */
function fixed(ms) {
  return ms.toFixed(1);
}

/**
 * A Markdown table of the statistics, with a line per quantity below
 * {@link MIN_SAMPLES}.
 *
 * @param {readonly SampleStats[]} stats
 * @returns {string}
 */
export function renderSummary(stats) {
  const lines = [
    '| platform | sample | n | min ms | median ms | p95 ms | max ms | 3x max ms |',
    '|---|---|---|---|---|---|---|---|',
    ...stats.map(
      (row) =>
        `| ${row.platform} | ${row.sample} | ${String(row.n)} | ${fixed(row.min)} | ${fixed(row.median)} | ${fixed(row.p95)} | ${fixed(row.max)} | ${String(row.bound)} |`,
    ),
  ];
  const short = stats.filter((row) => row.n < MIN_SAMPLES);
  if (stats.length === 0) lines.push('', 'No samples were recorded.');
  for (const row of short) {
    lines.push(
      '',
      `Too few samples: ${row.platform} ${row.sample} has ${String(row.n)}, at least ${String(MIN_SAMPLES)} are needed.`,
    );
  }
  return `${lines.join('\n')}\n`;
}
