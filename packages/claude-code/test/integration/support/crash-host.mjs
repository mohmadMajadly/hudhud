// The host process of the host-crash tests (plan §4.4 "host crash", §5.8
// W6-T3; 07 §2): a separate Node.js process that runs the product exactly as
// the in-process composition root does (`harness.ts`), so a test can kill
// this host abruptly without ever touching the Vitest worker.
//
// Composition root (plan §1.11): it injects the built adapter's
// `connectWith` over its real host (`nodeHost()`) with the sandbox seams of
// test-support's `productHostSeams`, the same launch checks the in-process
// harness applies (the verified pinned binary, unchanged; the working
// directory inside the sandbox; every isolation variable kept). The pinned
// CLI is verified again in this process (`resolvePinnedCli`: sha256, size,
// stamp). It runs the built modules (`dist`), so a test run needs a prior
// `pnpm build`, like every integration run (CONTRIBUTING).
//
// Protocol: argv[2] is a JSON file written by the test (`crash-host.ts`);
// this process reports to the test one JSON object per stdout line:
//   {type:'root', pid, startTime, source}       every spawned session process (by its spawn identity)
//   {type:'refused', message}                   every launch the sandbox refused
//   {type:'session', pid, cliPid, containment}  the session is open
//   {type:'permission', tool}                   a permission request (allowed; read-only
//                                               commands such as `sleep` ask none)
//   {type:'result', outcome}                    the turn ended (the test normally kills the host first)
//   {type:'error', message}                     anything failed; the host then disposes and exits 1
// The host ends itself after `lifetimeMs` and when its stdin ends (the test
// is gone), disposing the Harness first, so it never outlives its test.

import { readFileSync } from 'node:fs';
import process from 'node:process';

import { hostJobAddonDeps, loadJobAddon } from '@hudhudjs/core/process';

import { nodeHost } from '../../../dist/adapter.js';
import { connectWith } from '../../../dist/connect.js';
import { resolvePinnedCli } from '../../../../../tooling/test-support/dist/launcher/pinned-cli.js';
import {
  productHostSeams,
  samePath,
} from '../../../../../tooling/test-support/dist/launcher/product-host.js';
import { stagedJobAddonDeps } from '../../../../../tooling/test-support/dist/launcher/staged-addon.js';

/**
 * The test's request (`crash-host.ts`).
 *
 * @typedef {object} HostConfig
 * @property {string} repoRoot
 * @property {string} cacheRoot
 * @property {'pinned' | 'newest'} cliChannel the test's `HUDHUD_CLI_CHANNEL`
 *   (the canary runs on `newest`, K16)
 * @property {string} binaryPath the verified pinned binary the test resolved
 * @property {Pick<import('../../../../../tooling/test-support/src/launcher/sandbox.js').Sandbox, 'dirs' | 'env' | 'mockUrl' | 'platform'>} sandbox
 * @property {string} prompt the session's first turn
 * @property {number} lifetimeMs
 * @property {'staged' | 'host' | 'unavailable'} jobAddon where the job addon
 *   comes from (`JobAddonMode` of `harness.ts`): the staged addon's verified
 *   digest, the product's own loader, or the loader with the addon package
 *   unresolvable (`package-missing`)
 */

const parsed = /** @type {unknown} */ (JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')));
const config = /** @type {HostConfig} */ (parsed);

/**
 * One report line to the test.
 *
 * @param {Record<string, unknown>} message
 */
function report(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** @type {import('../../../src/connect.js').ClaudeCodeHarness | undefined} */
let harness;
let ending = false;

/**
 * Disposes the Harness (and its sessions), then exits.
 *
 * @param {number} code
 */
async function end(code) {
  if (ending) return;
  ending = true;
  try {
    await harness?.[Symbol.asyncDispose]();
  } finally {
    process.exit(code);
  }
}

setTimeout(() => {
  report({ type: 'error', message: `lifetime of ${String(config.lifetimeMs)} ms exceeded` });
  void end(1);
}, config.lifetimeMs).unref();
process.stdin.on('end', () => void end(1));
process.stdin.resume();

try {
  const cli = await resolvePinnedCli({
    repoRoot: config.repoRoot,
    cacheRoot: config.cacheRoot,
    // The same pin as the test's: the canary's run pin on the newest channel.
    env: { HUDHUD_CLI_CHANNEL: config.cliChannel },
  });
  if (!samePath(cli.binaryPath, config.binaryPath, config.sandbox.platform)) {
    throw new Error(`verified ${cli.binaryPath}, the test expects ${config.binaryPath}`);
  }
  const refusal = () => {
    throw new Error('the host-crash sandbox launches only through the product');
  };
  const sandbox = { ...config.sandbox, cli, launch: refusal, dispose: refusal };
  const seams = productHostSeams({
    sandbox,
    onRoot: (root) => {
      void root.identity.then((read) => {
        report({
          type: 'root',
          pid: root.pid,
          startTime: read.identity?.startTime ?? null,
          problem: read.identity === null ? read.problem : null,
          source: root.identitySource,
        });
      });
    },
    onRefused: (error) => {
      report({ type: 'refused', message: String(error) });
    },
  });
  // The seams of `jobAddonSeam` in `harness.ts` (this host runs the built modules).
  /** @type {{ loadJobAddon?: () => import('@hudhudjs/core/process').JobAddonLoad }} */
  let jobAddon = {};
  if (config.jobAddon === 'unavailable') {
    jobAddon = {
      loadJobAddon: () =>
        loadJobAddon({
          ...hostJobAddonDeps(),
          requireResolve: (/** @type {string} */ specifier) => {
            throw Object.assign(new Error(`Cannot find module '${specifier}'`), {
              code: 'MODULE_NOT_FOUND',
            });
          },
        }),
    };
  } else if (config.jobAddon === 'staged') {
    const load = loadJobAddon(stagedJobAddonDeps(config.repoRoot, hostJobAddonDeps()));
    jobAddon = { loadJobAddon: () => load };
  }
  harness = await connectWith(
    { binaryPath: cli.binaryPath, claudeCode: { configDir: sandbox.dirs.cfg } },
    () => ({ ...nodeHost(), ...jobAddon, ...seams }),
  );
  if (
    !samePath(harness.binary.path, cli.binaryPath, sandbox.platform) ||
    harness.binary.version !== cli.version
  ) {
    throw new Error(`the product connected ${harness.binary.path} ${harness.binary.version}`);
  }
  const session = await harness.sessions.create({
    onPermission: (request) => {
      report({ type: 'permission', tool: request.toolName });
      return Promise.resolve({ behavior: 'allow' });
    },
  });
  report({
    type: 'session',
    pid: session.info.pid,
    cliPid: session.info.cliPid ?? null,
    containment: session.info.containment,
  });
  const result = await session.ask(config.prompt);
  report({ type: 'result', outcome: result.outcome });
} catch (error) {
  report({ type: 'error', message: String(error) });
  await end(1);
}
