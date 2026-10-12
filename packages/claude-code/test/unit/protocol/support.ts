import process from 'node:process';

import type fc from 'fast-check';

/** fast-check parameters: `FC_SEED` reproduces a run (plan §4.1); failures print the seed. */
export function fcParams<T>(numRuns = 500): fc.Parameters<T> {
  const seed = process.env['FC_SEED'];
  return seed === undefined ? { numRuns } : { numRuns, seed: Number(seed) };
}
