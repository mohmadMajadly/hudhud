// `FC_SEED` for every property of the `unit` project (plan §4.1). fast-check
// draws a fresh seed per run and prints `{ seed, path }` on a failure;
// `unit-setup.ts` makes `FC_SEED=<seed>` replay that run in every property,
// including those that pass their own parameters without a seed. A seed
// given to a single `fc.assert` still wins over the global one.

import type fc from 'fast-check';

/** Thrown when `FC_SEED` is set but is not a 32-bit signed integer. */
export class FcSeedError extends Error {
  override readonly name = 'FcSeedError';
}

const INT32_MIN = -0x8000_0000;
const INT32_MAX = 0x7fff_ffff;
const DECIMAL = /^-?[0-9]+$/;

/**
 * The fast-check global parameters that `env` asks for: `{ seed }` when
 * `FC_SEED` is set, else nothing (fast-check draws a fresh seed).
 *
 * @throws FcSeedError for an `FC_SEED` that is not a decimal 32-bit signed
 *   integer, the form fast-check prints: a typo must not silently run with
 *   a fresh seed while the developer believes the failure is being replayed.
 */
export function fastCheckSeedFromEnv(env: NodeJS.ProcessEnv): fc.GlobalParameters {
  const text = env['FC_SEED'];
  if (text === undefined) return {};
  const seed = Number(text);
  if (!DECIMAL.test(text) || seed < INT32_MIN || seed > INT32_MAX) {
    throw new FcSeedError(
      `FC_SEED must be the decimal 32-bit seed fast-check printed, got ${JSON.stringify(text)}`,
    );
  }
  return { seed };
}
