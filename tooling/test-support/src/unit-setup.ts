// Setup file of the `unit` Vitest project: installs the unit-test guard in
// every worker before any test module loads, and fails every test that made
// it refuse something, even when the code under test caught the refusal
// (R8-4, `unit-guard.ts`).

import { afterEach } from 'vitest';

import { assertNoRefusals, installUnitGuard } from './unit-guard.js';

installUnitGuard();

afterEach(assertNoRefusals);
