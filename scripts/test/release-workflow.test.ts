// Structure of the release workflows that the publish relies on (ADR-0014
// amendments 10 and 12, release checklist 1.9, 4.4, 4.5): release.yml calls
// addon-prebuild.yml's phase 2, the publish job needs it and the gate, holds
// the only id-token permission, and no workflow references a secret or an
// npm token. The workflows are read as text: a job is the block from its
// two-space-indented key to the next one, a step command a `run: <command>`
// line inside it.

import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const DIR = new URL('../../.github/workflows/', import.meta.url);

function workflow(name: string): string {
  return readFileSync(new URL(name, DIR), 'utf8').replaceAll('\r\n', '\n');
}

function job(text: string, name: string): string {
  const lines = text.split('\n');
  const jobs = lines.indexOf('jobs:');
  const start = lines.indexOf(`  ${name}:`, jobs);
  if (jobs < 0 || start < 0) throw new Error(`no job ${name}`);
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z][\w-]*:$/u.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

function commands(block: string): string[] {
  return [...block.matchAll(/^ +run: (.+)$/gmu)].map((match) => String(match[1]));
}

function jobNames(text: string): string[] {
  const body = text.slice(text.indexOf('\njobs:\n'));
  return [...body.matchAll(/^ {2}([a-z][\w-]*):$/gmu)].map((match) => String(match[1]));
}

const RELEASE = workflow('release.yml');
const PREBUILD = workflow('addon-prebuild.yml');
const ALL = readdirSync(DIR)
  .filter((name) => name.endsWith('.yml'))
  .map((name) => ({ name, text: workflow(name) }));

describe('release.yml', () => {
  it('runs for release tags, and as a dry run for release-dry branches and dispatches', () => {
    expect(RELEASE).toContain(
      "on:\n  push:\n    tags: ['v*']\n    branches: ['release-dry/**']\n  workflow_dispatch:\n\npermissions: {}\n",
    );
    expect(RELEASE).not.toMatch(/pull_request/u);
  });

  it('never lets two tags race and never cancels a release', () => {
    expect(RELEASE).toContain(
      "group: ${{ github.event_name == 'push' && github.ref_type == 'tag' && 'release-publish' || format('release-dry-{0}', github.ref) }}",
    );
    expect(RELEASE).toContain('cancel-in-progress: false');
  });

  it('runs no job on a fork', () => {
    for (const name of jobNames(RELEASE)) {
      expect(job(RELEASE, name), name).toMatch(
        /^ {4}if: \$\{\{ !github\.event\.repository\.fork\b/mu,
      );
    }
  });

  it('verifies through addon-prebuild phase 2, and publishes only after it and the gate', () => {
    const verify = job(RELEASE, 'verify');
    expect(verify).toContain('uses: ./.github/workflows/addon-prebuild.yml');
    expect(verify).toContain('phase: verify');
    expect(verify).toContain(
      "dry_run: ${{ !(github.event_name == 'push' && github.ref_type == 'tag') }}",
    );
    const publish = job(RELEASE, 'publish');
    expect(publish).toContain('needs: [verify, gate]');
    expect(publish).toContain(
      "if: ${{ !github.event.repository.fork && github.event_name == 'push' && github.ref_type == 'tag' }}",
    );
    expect(publish).toContain('environment: npm-publish');
    expect(commands(publish)).toEqual([
      'node scripts/release.mjs install-npm',
      'node scripts/release.mjs publish --tarballs "$RUNNER_TEMP/release-tarballs" --tag "$GITHUB_REF_NAME"',
    ]);
    expect(publish).toContain('name: release-tarballs');
    expect(publish).toContain('digest-mismatch: error');
    const dry = job(RELEASE, 'publish-dry-run');
    expect(dry).toContain('needs: [verify, gate]');
    expect(dry).toContain("!(github.event_name == 'push' && github.ref_type == 'tag')");
    expect(commands(dry)).toEqual([
      'node scripts/release.mjs install-npm',
      'node scripts/release.mjs publish --tarballs "$RUNNER_TEMP/release-tarballs" --tag "$DRY_TAG" --dry-run',
    ]);
    expect(commands(job(RELEASE, 'gate'))).toEqual([
      'node scripts/release.mjs gate --tag "$GITHUB_REF_NAME"',
      'node scripts/release.mjs gate --tag "$GITHUB_REF_NAME" --report-only',
    ]);
  });

  it('gives id-token: write to the publish job only, and minimal permissions to every job', () => {
    expect(job(RELEASE, 'publish')).toContain(
      'permissions:\n      contents: read\n      id-token: write\n',
    );
    expect(job(RELEASE, 'publish-dry-run')).toContain(
      'permissions:\n      contents: read\n    steps:',
    );
    expect(job(RELEASE, 'gate')).toContain(
      'permissions:\n      contents: read\n      actions: read\n',
    );
    expect(job(RELEASE, 'verify')).toContain('permissions:\n      contents: read\n    uses:');
    for (const { name, text } of ALL) {
      // Permission keys, not the comments that mention them.
      const grants = text.match(/^ +id-token: write$/gmu) ?? [];
      expect(grants.length, name).toBe(name === 'release.yml' ? 1 : 0);
    }
  });

  it('pins npm 11.5.1 or later by version and sha512', () => {
    const version = /^ {2}NPM_VERSION: (\d+)\.(\d+)\.(\d+)$/mu.exec(RELEASE);
    expect(version).not.toBeNull();
    const [major, minor, patch] = [1, 2, 3].map((index) => Number(version?.[index]));
    expect(
      Number(major) > 11 ||
        (major === 11 && (Number(minor) > 5 || (minor === 5 && Number(patch) >= 1))),
    ).toBe(true);
    expect(RELEASE).toMatch(/^ {2}NPM_INTEGRITY: sha512-[A-Za-z0-9+/]{86}==$/mu);
  });
});

describe('every workflow', () => {
  it('references no secret and no npm token; publishing is by OIDC only', () => {
    for (const { name, text } of ALL) {
      expect(text, name).not.toMatch(/secrets\./u);
      expect(text, name).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|registry-url/u);
    }
  });

  it('pins every action by a full commit SHA with a version comment (checklist 1.9)', () => {
    for (const { name, text } of ALL) {
      for (const match of text.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gmu)) {
        const target = String(match[1]);
        if (target.startsWith('./')) continue;
        expect(target, `${name}: ${target}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/u);
        expect(String(match[2]), `${name}: ${target}`).toMatch(/^ # v\d/u);
      }
    }
  });
});

describe('addon-prebuild.yml', () => {
  it('runs phase 2 only when release.yml calls it, never on its own tag trigger', () => {
    expect(PREBUILD).not.toMatch(/^ {2}push:/mu);
    expect(PREBUILD).toContain('  workflow_call:\n');
    expect(PREBUILD).not.toContain('github.event_name');
    expect(job(PREBUILD, 'release-verify')).toContain("if: inputs.phase == 'verify'");
    expect(job(PREBUILD, 'manifest')).toContain(
      "if: inputs.phase != 'verify' && inputs.phase != 'canary'",
    );
    expect(job(PREBUILD, 'test-x64')).toContain("if: inputs.phase != 'canary'");
  });

  it('builds with the pinned SDK and the explicitly chosen Enterprise instance (ADR-0014 amendment 14)', () => {
    const build = job(PREBUILD, 'build');
    // Multi-line steps: positions in the job's text.
    const select = build.indexOf(
      `"$vswhere" -products Microsoft.VisualStudio.Product.Enterprise -version '[17.14,17.15)' -property installationPath`,
    );
    const provision = build.indexOf(
      `\n          node scripts/addon/toolchain.mjs provision-sdk --downloads "$env:RUNNER_TEMP\\sdk" --out 'C:\\hvsdk'\n`,
    );
    const compile = build.indexOf(
      'run: node native/win32-job/build.mjs --toolset-of-record --arch "$ARCH"\n',
    );
    expect(select).toBeGreaterThan(-1);
    expect(provision).toBeGreaterThan(select);
    expect(compile).toBeGreaterThan(provision);
    expect(build).toContain('echo "HUDHUD_VS_INSTALL=${found[0]}" >> "$GITHUB_ENV"');
    expect(build).toContain("'HUDHUD_WINDOWS_SDK=C:\\hvsdk' | Out-File -FilePath $env:GITHUB_ENV");
    // Nothing is installed into the image's Visual Studio instance, and no
    // other instance is installed (ADR-0015 item 12: its licence is the basis).
    expect(build).not.toMatch(/setup\.exe|'modify'|vs_BuildTools|manifest\.mjs components/u);
    expect(build).toContain('runs-on: windows-2022');
    // Phase 2 and the canary require the reproduction; phase 1 reports it.
    expect(build).toContain("if: inputs.phase == 'verify' || inputs.phase == 'canary'");
    expect(build).toContain("if: inputs.phase != 'verify' && inputs.phase != 'canary'");
  });

  it('checks the tag over the packed bytes, then the full check over the same tarballs it uploads', () => {
    const verify = job(PREBUILD, 'release-verify');
    const run = commands(verify);
    expect(run.slice(-3)).toEqual([
      'pnpm run build',
      'node scripts/check-tarball.mjs --release-tag "$RELEASE_TAG" --keep-tarballs "$RUNNER_TEMP/release-tarballs"',
      'node scripts/check-tarball.mjs --tarballs "$RUNNER_TEMP/release-tarballs"',
    ]);
    expect(verify).toContain('node scripts/release.mjs simulate-version');
    // changeset version reads the history (release dry run 39109685744).
    expect(verify).toContain('persist-credentials: false\n          fetch-depth: 0\n');
    expect(verify.indexOf('simulate-version')).toBeLessThan(verify.indexOf('pnpm run build'));
    expect(verify).toContain('name: release-tarballs');
    expect(verify).toContain('retention-days: 7');
  });
});

describe('addon-canary.yml', () => {
  const CANARY = workflow('addon-canary.yml');

  it('rebuilds weekly through addon-prebuild with the canary phase, read-only, never on a fork', () => {
    expect(CANARY).toMatch(
      /^on:\n {2}schedule:\n {4}- cron: '\d+ \d+ \* \* \d'\n {2}workflow_dispatch:\n/mu,
    );
    expect(CANARY).toContain('\npermissions: {}\n');
    expect(jobNames(CANARY)).toEqual(['rebuild']);
    const rebuild = job(CANARY, 'rebuild');
    expect(rebuild).toContain('if: ${{ !github.event.repository.fork }}');
    expect(rebuild).toContain(
      'permissions:\n      contents: read\n    uses: ./.github/workflows/addon-prebuild.yml\n',
    );
    expect(rebuild).toContain('      phase: canary\n      dry_run: false');
  });
});
