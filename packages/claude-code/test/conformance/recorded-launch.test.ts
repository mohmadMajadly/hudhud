// Every committed recording was launched exactly as the product launches
// the same case (lead ruling, W4-T2): the argv of its config line is the
// adapter's `buildArgv` for the case's options (with the ids it ran under),
// and its environment line is what the adapter's `buildChildEnv` sets
// beyond the sandbox. A recording made by another launch, or a case whose
// options changed since the recording, fails here.

import { describe, expect, it } from 'vitest';

import { productLaunchBuilder } from '../../../../tooling/test-support/src/fixtures/record/launch.js';
import type { CaseStart } from '../../../../tooling/test-support/src/fixtures/record/launch.js';
import { launchEnvDiff } from '../../../../tooling/test-support/src/fixtures/record/record.js';
import { SUITES } from '../../../../tooling/test-support/src/fixtures/record/suites.js';
import { buildArgv } from '../../src/argv.js';
import { buildChildEnv } from '../../src/env.js';
import { resolveConnectSessionOptions } from '../../src/options.js';
import { sandboxDirs, sandboxParent } from '../record/sandbox-parent.js';
import { loadConformanceSuites } from './loader.js';
import { denormalize } from './replay.js';

const build = productLaunchBuilder({ resolveConnectSessionOptions, buildArgv, buildChildEnv });

/** The value of `--name=value`. */
function flag(argv: readonly string[], name: string): string | undefined {
  return argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/** How the recording started its session, read from its argv. */
function startOf(argv: readonly string[]): CaseStart {
  const resume = flag(argv, 'resume');
  const sessionId = flag(argv, 'session-id') ?? '';
  if (resume === undefined) return { mode: 'create', sessionId };
  return argv.includes('--fork-session')
    ? { mode: 'fork', resumeId: resume, sessionId }
    : { mode: 'resume', resumeId: resume };
}

describe('every recording was launched as the product launches its case', () => {
  for (const suite of loadConformanceSuites()) {
    const spec = SUITES.find((item) => item.name === suite.name);
    for (const variant of suite.variants) {
      it(variant.id, () => {
        expect(spec, `recorder suite ${suite.name}`).toBeDefined();
        const caseSpec = spec?.cases.find(
          (item) => (item.name === '' ? 'main' : item.name) === variant.case,
        );
        expect(caseSpec, `recorder case ${variant.id}`).toBeDefined();
        const platform = variant.platform === 'win32' ? 'win32' : 'linux';
        const argv = variant.launch.argv.map((arg) => denormalize(arg) as string);
        const declared = caseSpec?.launch(new Map());
        const start = startOf(argv);
        expect(start.mode).toBe(declared?.start.mode);
        const parentEnv = sandboxParent(platform, spec?.credential);
        const product = build({
          launch: { ...declared, start },
          configDir: sandboxDirs(platform).cfg,
          parentEnv,
          platform,
        });
        expect(argv, 'argv').toEqual(product.argv);
        expect(variant.launch.env, 'environment beyond the sandbox').toEqual(
          launchEnvDiff(product.env, parentEnv),
        );
      });
    }
  }
});
