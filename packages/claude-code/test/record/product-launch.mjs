// The product's launch builders, as the fixture recorder uses them (lead
// ruling, W4-T2): the built adapter modules, nothing copied. The adapter's
// test tree is the one place that may import both the adapter and
// @hudhud/test-support (test-support may not depend on the adapter), so the
// composition root of `pnpm fixtures:record` lives here.
// `launch.test.ts` checks that this builder gives exactly the sources'
// launch for every recorded case.

import { buildArgv } from '../../dist/argv.js';
import { buildChildEnv } from '../../dist/env.js';
import { resolveConnectSessionOptions } from '../../dist/options.js';
import { productLaunchBuilder } from '../../../../tooling/test-support/dist/fixtures/record/launch.js';

/** The adapter builders the recorder calls. */
export const PRODUCT_LAUNCH_API = { resolveConnectSessionOptions, buildArgv, buildChildEnv };

/** The recorder's launch builder over the built adapter. */
export const productLaunch = productLaunchBuilder(PRODUCT_LAUNCH_API);
