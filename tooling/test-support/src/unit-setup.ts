// Setup file of the `unit` Vitest project: installs the unit-test guard in
// every worker before any test module loads, and fails every test that made
// it refuse something, even when the code under test caught the refusal
// (R8-4, `unit-guard.ts`). It also applies `FC_SEED` to every fast-check
// property (`fast-check-seed.ts`).

import process from 'node:process';

import fc from 'fast-check';
import { afterEach } from 'vitest';

import { fastCheckSeedFromEnv } from './fast-check-seed.js';
import { assertNoRefusals, installUnitGuard } from './unit-guard.js';

installUnitGuard();

afterEach(assertNoRefusals);

fc.configureGlobal({ ...fc.readConfigureGlobal(), ...fastCheckSeedFromEnv(process.env) });
