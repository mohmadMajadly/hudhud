// The publish step of a release (.github/workflows/release.yml; ADR-0014
// amendment 12): which of the checked tarballs to publish, in which order,
// what to do about a version that is already on the registry, the job
// summary with the recovery steps of a partial publish, the gate on the
// tagged commit, and the simulated version PR of a dry run. Pure functions;
// the effects are in scripts/release.mjs.

import { createHash } from 'node:crypto';

import { renderReleaseSums, renderReleaseToolchains } from './addon-digests.mjs';
import { renderManifest } from './addon-manifest.mjs';
import { tagVersion } from './tarball.mjs';

/**
 * The publish order (release checklist 4.5): the platform package first, so
 * the core's exact optional dependency on it always resolves, then the core,
 * the adapter that depends on it, and the umbrella that depends on both.
 */
export const PUBLISH_ORDER = Object.freeze([
  '@hudhudjs/win32-job-x64',
  '@hudhudjs/core',
  '@hudhudjs/claude-code',
  'hudhudjs',
]);

/** The registry every release publishes to and reads from. */
export const REGISTRY = 'https://registry.npmjs.org/';

/**
 * The npm integrity string (`sha512-<base64>`) of a tarball's bytes, as the
 * registry records it in `dist.integrity`.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function integrityOf(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

/**
 * The registry URL of a package's document (a scoped name keeps its `@` and
 * encodes its `/`).
 *
 * @param {string} name
 * @returns {string}
 */
export function packumentUrl(name) {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name)) {
    throw new Error(`not a package name: ${JSON.stringify(name)}`);
  }
  return `${REGISTRY}${name.replace('/', '%2f')}`;
}

/**
 * @typedef {{ kind: 'absent' } | { kind: 'present', integrity: string | undefined }} RegistryState
 *   Whether one version of a package is on the registry, with its recorded integrity.
 */

/**
 * Reads one version's state from the registry's answer for a package's
 * document. A 404 means the package does not exist yet; any status but 200
 * and 404, or an unreadable body, is an error, never "absent".
 *
 * @param {number} status The HTTP status.
 * @param {string} body
 * @param {string} version
 * @returns {RegistryState | string} the state, or why it could not be read
 */
export function parsePackument(status, body, version) {
  if (status === 404) return { kind: 'absent' };
  if (status !== 200) return `the registry answered HTTP ${String(status)}`;
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    return 'the registry answered with a body that is not JSON';
  }
  /** @type {unknown} */
  const versions =
    typeof value === 'object' && value !== null ? Reflect.get(value, 'versions') : undefined;
  if (typeof versions !== 'object' || versions === null) {
    return 'the registry answered without a versions object';
  }
  /** @type {unknown} */
  const entry = Reflect.get(versions, version);
  if (entry === undefined) return { kind: 'absent' };
  /** @type {unknown} */
  const dist = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'dist') : undefined;
  /** @type {unknown} */
  const integrity =
    typeof dist === 'object' && dist !== null ? Reflect.get(dist, 'integrity') : undefined;
  return { kind: 'present', integrity: typeof integrity === 'string' ? integrity : undefined };
}

/**
 * @typedef {object} ReleaseTarball
 * @property {string} file The tarball's path.
 * @property {string | undefined} name The packed manifest's name.
 * @property {string | undefined} version The packed manifest's version.
 * @property {string} integrity {@link integrityOf} its bytes.
 */

/**
 * The release a set of tarballs is: the tag must be `v<semver>`, the
 * tarballs exactly the packages of {@link PUBLISH_ORDER}, one each, and every
 * package of the `fixed` group at the tag's version. Checked before the
 * registry is asked anything.
 *
 * @param {{ tag: string, fixed: readonly string[], tarballs: readonly ReleaseTarball[] }} input
 * @returns {{ ordered: (ReleaseTarball & { name: string, version: string })[], problems: string[] }}
 */
export function orderTarballs(input) {
  /** @type {string[]} */
  const problems = [];
  const version = tagVersion(input.tag);
  if (version === null) {
    problems.push(`the tag ${JSON.stringify(input.tag)} is not v<semver> (for example v0.1.0)`);
  }
  /** @type {Map<string, ReleaseTarball[]>} */
  const byName = new Map();
  for (const tarball of input.tarballs) {
    if (tarball.name === undefined || tarball.version === undefined) {
      problems.push(`${tarball.file}: no readable package.json with a name and a version`);
      continue;
    }
    byName.set(tarball.name, [...(byName.get(tarball.name) ?? []), tarball]);
  }
  /** @type {(ReleaseTarball & { name: string, version: string })[]} */
  const ordered = [];
  for (const name of PUBLISH_ORDER) {
    const found = byName.get(name) ?? [];
    const only = found[0];
    if (only === undefined) {
      problems.push(`${name}: no tarball (every release publishes ${PUBLISH_ORDER.join(', ')})`);
    } else if (found.length > 1) {
      problems.push(`${name}: ${String(found.length)} tarballs, expected 1`);
    } else {
      const tarballVersion = String(only.version);
      if (input.fixed.includes(name) && version !== null && tarballVersion !== version) {
        problems.push(
          `${name} is packed at version ${tarballVersion}, the tag ${input.tag} names ${version}`,
        );
      }
      ordered.push({ ...only, name, version: tarballVersion });
    }
  }
  for (const name of [...byName.keys()].sort()) {
    if (!PUBLISH_ORDER.includes(name))
      problems.push(`${name}: a tarball of a package no release publishes`);
  }
  for (const name of input.fixed) {
    if (!PUBLISH_ORDER.includes(name))
      problems.push(`${name} (fixed group) is not in the publish order`);
  }
  return { ordered, problems };
}

/**
 * @typedef {object} PublishStep
 * @property {string} name
 * @property {string} version
 * @property {string} file
 * @property {'publish' | 'skip'} action
 * @property {string} note Why, for the log and the summary.
 */

/**
 * What to do with each tarball, given what the registry holds (idempotent
 * re-runs): a version that is not there is published; one that is there with
 * the same bytes is skipped; one that is there with other bytes stops the
 * release when its version is the tag's (a published version can never be
 * replaced), and is skipped with a warning when the package keeps a version
 * an earlier release published (the addon package, versioned by its release
 * record, whose README or NOTICE may have changed since).
 *
 * @param {{ tag: string, ordered: readonly (ReleaseTarball & { name: string, version: string })[], registry: ReadonlyMap<string, RegistryState> }} input
 *   `registry` by package name, for the tarball's version.
 * @returns {{ steps: PublishStep[], problems: string[], warnings: string[] }}
 */
export function planPublish(input) {
  const version = tagVersion(input.tag);
  /** @type {PublishStep[]} */
  const steps = [];
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];
  for (const tarball of input.ordered) {
    const state = input.registry.get(tarball.name);
    const at = `${tarball.name}@${tarball.version}`;
    const base = { name: tarball.name, version: tarball.version, file: tarball.file };
    if (state === undefined) {
      problems.push(`${at}: the registry was not asked`);
    } else if (state.kind === 'absent') {
      steps.push({ ...base, action: 'publish', note: 'not on the registry' });
    } else if (state.integrity === tarball.integrity) {
      steps.push({ ...base, action: 'skip', note: 'already on the registry with the same bytes' });
    } else if (tarball.version === version) {
      problems.push(
        `${at} is already on the registry with other bytes (registry ${String(state.integrity)}, this release ${tarball.integrity}); a published version is never replaced: release a new version`,
      );
    } else {
      const warning = `${at} is already on the registry, published by an earlier release, with other bytes (registry ${String(state.integrity)}, this release ${tarball.integrity}); kept as published`;
      warnings.push(warning);
      steps.push({
        ...base,
        action: 'skip',
        note: 'published by an earlier release (other bytes, see the warning)',
      });
    }
  }
  return { steps, problems, warnings };
}

/**
 * The dist-tag a version is published under: `latest` for a release,
 * `next` for a pre-release, so a pre-release never becomes what `npm install
 * <name>` gives.
 *
 * @param {string} version
 * @returns {'latest' | 'next'}
 */
export function distTag(version) {
  return version.includes('-') ? 'next' : 'latest';
}

/**
 * The `npm publish` arguments for one tarball. A real publish requires
 * provenance (`--provenance`: npm fails instead of publishing without it,
 * for example from a private repository); a dry run cannot sign and turns it
 * off, since the packed `publishConfig.provenance` would ask for it.
 *
 * @param {{ file: string, version: string, dryRun: boolean }} input
 * @returns {string[]}
 */
export function publishArgs(input) {
  return [
    'publish',
    input.file,
    '--access',
    'public',
    '--tag',
    distTag(input.version),
    '--registry',
    REGISTRY,
    ...(input.dryRun ? ['--dry-run', '--provenance=false'] : ['--provenance']),
  ];
}

/**
 * @typedef {'published' | 'skipped' | 'failed' | 'not attempted' | 'checked (dry run)'} StepResult
 */

/**
 * The job summary of the publish step: a table of every package, and on a
 * failure after anything is on the registry, the exact recovery steps.
 *
 * @param {{ tag: string, dryRun: boolean, steps: readonly PublishStep[], results: ReadonlyMap<string, StepResult>, problems: readonly string[], warnings: readonly string[] }} input
 * @returns {string} Markdown
 */
export function renderSummary(input) {
  const lines = [`## ${input.dryRun ? 'Release dry run' : 'Release'} ${input.tag}`, ''];
  if (input.steps.length > 0) {
    lines.push('| # | Package | Version | Plan | Result |', '|---|---|---|---|---|');
    input.steps.forEach((step, index) => {
      lines.push(
        `| ${String(index + 1)} | \`${step.name}\` | ${step.version} | ${step.action}: ${step.note} | ${input.results.get(step.name) ?? 'not attempted'} |`,
      );
    });
    lines.push('');
  }
  for (const warning of input.warnings) lines.push(`- Warning: ${warning}`);
  for (const problem of input.problems) lines.push(`- Problem: ${problem}`);
  if (input.warnings.length > 0 || input.problems.length > 0) lines.push('');

  const failed = input.steps.find((step) => input.results.get(step.name) === 'failed');
  const done = input.steps.filter((step) => {
    const result = input.results.get(step.name);
    return result === 'published' || result === 'skipped';
  });
  if (input.dryRun) {
    lines.push(
      input.problems.length === 0 && failed === undefined
        ? 'Dry run: nothing was published. Every tarball passed `npm publish --dry-run`.'
        : 'Dry run: nothing was published. The dry run FAILED (see above).',
    );
    return `${lines.join('\n')}\n`;
  }
  if (failed === undefined && input.problems.length === 0) {
    lines.push(`Every package of ${input.tag} is on the registry.`);
    return `${lines.join('\n')}\n`;
  }
  const remaining = input.steps
    .filter((step) => !done.includes(step))
    .map((step) => `\`${step.name}@${step.version}\``);
  const published = done.filter((step) => input.results.get(step.name) === 'published');
  lines.push(
    done.length > 0 ? '### PARTIAL PUBLISH: recovery' : '### Nothing was published: recovery',
    '',
    done.length > 0
      ? `On the registry now: ${done.map((step) => `\`${step.name}@${step.version}\``).join(', ')}${published.length > 0 ? ` (published by this run: ${published.map((step) => `\`${step.name}\``).join(', ')})` : ''}. Still to publish, in this order: ${remaining.join(', ')}.`
      : `Still to publish, in this order: ${remaining.join(', ')}.`,
    '',
    '1. Do not delete, move or re-push the tag, and do not unpublish anything: a version that was ever published can never be published again.',
    `2. Find the cause in the log of this step${failed === undefined ? '' : ` (the \`npm publish\` of \`${failed.name}\`)`}.`,
    '3. A cause outside the code (registry outage, the trusted publisher settings of a package on npmjs.com, the `npm-publish` environment, a missing permission): fix it, then use "Re-run failed jobs" on this workflow run. The re-run publishes the same checked tarballs (the `release-tarballs` artifact, kept 7 days) and skips every version that is already on the registry with the same bytes.',
    '4. The artifact expired: "Re-run all jobs". release-verify packs the same commit again; a version already on the registry with other bytes stops the run before anything is published (then go to step 5).',
    '5. A cause in the code or the packages: leave the published versions, deprecate them from the owner account (`npm deprecate <name>@<version> "<reason>"`), fix the cause and release the next patch version with a new tag (docs/plan/v1-release-checklist.md, section 7).',
  );
  return `${lines.join('\n')}\n`;
}

/**
 * @typedef {object} WorkflowRun
 * @property {string} [head_sha]
 * @property {string} [head_branch]
 * @property {string} [event]
 * @property {string} [status]
 * @property {string | null} [conclusion]
 * @property {string} [html_url]
 */

/**
 * The gate on the tagged commit: it must be on `main` (GitHub's compare of
 * `main...<sha>` is `identical` or `behind`), and the `ci.yml` run of its
 * push to `main` must have completed with success, so a release ships only a
 * commit whose FULL CI passed.
 *
 * @param {{ sha: string, compareStatus: string | undefined, runs: readonly WorkflowRun[] }} input
 * @returns {string[]} problems, each naming its cause and the remedy
 */
export function gateProblems(input) {
  /** @type {string[]} */
  const problems = [];
  if (input.compareStatus !== 'identical' && input.compareStatus !== 'behind') {
    problems.push(
      `the tagged commit ${input.sha} is not on main (compare main...${input.sha}: ${String(input.compareStatus)}); tag the merge commit of the version PR`,
    );
  }
  const own = input.runs.filter(
    (run) => run.head_sha === input.sha && run.event === 'push' && run.head_branch === 'main',
  );
  if (own.some((run) => run.status === 'completed' && run.conclusion === 'success'))
    return problems;
  if (own.length === 0) {
    problems.push(
      `no ci.yml run of a push to main for ${input.sha}: tag only the merge commit of the version PR, after its push run`,
    );
  } else if (own.some((run) => run.status !== 'completed')) {
    problems.push(
      `the ci.yml run of the push to main for ${input.sha} has not completed: wait for it to pass, then re-run the failed jobs of this run`,
    );
  } else {
    const conclusions = [...new Set(own.map((run) => String(run.conclusion)))].join(', ');
    problems.push(
      `the ci.yml run of the push to main for ${input.sha} concluded ${conclusions}, not success: fix main, release a new version`,
    );
  }
  return problems;
}

/**
 * Why the version PR cannot be simulated in this checkout: `changeset
 * version` writes each changelog entry with the commit that added its
 * changeset and, in a shallow clone, tries to deepen it, which needs
 * credentials (release dry run 39109685744). Null when the history is whole
 * or there is no repository (`rev-parse --is-shallow-repository` failed).
 *
 * @param {number | null} status The exit status of that command.
 * @param {string} stdout Its output.
 * @returns {string | null}
 */
export function shallowProblem(status, stdout) {
  return status === 0 && stdout.trim() === 'true'
    ? 'simulate-version needs the full history (a shallow clone; check out with fetch-depth: 0)'
    : null;
}

/**
 * The files of a release record for another release name with the same
 * builds: what the dry run writes when the committed record is not yet the
 * one the version PR will name (the real record always comes from phase 1
 * of addon-prebuild.yml; native/win32-job/README.md, "Releasing").
 *
 * @param {import('./addon-digests.mjs').Manifest} manifest
 * @param {string} release
 * @returns {{ 'manifest.json': string, SHA256SUMS: string, 'toolchain.json': string }}
 */
export function simulatedRecord(manifest, release) {
  const renamed = { ...manifest, release };
  return {
    'manifest.json': renderManifest(renamed),
    SHA256SUMS: renderReleaseSums(renamed),
    'toolchain.json': renderReleaseToolchains(renamed),
  };
}
