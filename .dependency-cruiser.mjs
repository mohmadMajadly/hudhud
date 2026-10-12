// Layer boundaries of the hudhud monorepo (ADR-0004, ADR-0006, plan §1.2).
// ESLint enforces the same sans-IO boundary file by file; this enforces it
// on the resolved module graph, including type-only imports.
// The rules are exercised by scripts/test/depcruise-rules.test.ts.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ADAPTERS = String.raw`^(packages/(claude-code|hudhud)/|node_modules/(@hudhud/claude-code|hudhud)/)`;
// The two sans-IO directories: the neutral core protocol and, since K3, the
// Claude Code protocol machines.
const CORE_PROTOCOL = '^packages/core/src/protocol/';
const CLAUDE_PROTOCOL = '^packages/claude-code/src/protocol/';
const SANS_IO = `(${CORE_PROTOCOL}|${CLAUDE_PROTOCOL})`;
const PROCESS = String.raw`^(packages/core/(src|dist)/process/|node_modules/@hudhud/core/(src|dist)/process/)`;
// The neutral protocol entry of the core, as the Claude protocol resolves it
// through the workspace link or an installed package (K3).
const CORE_PROTOCOL_ENTRY = String.raw`^(packages/core/(src|dist)/protocol/|node_modules/@hudhud/core/(src|dist)/protocol/)`;
// Everything of the core outside the sans-IO protocol: the root entry (the
// binding layer) and the binding, process, observability, security layers.
const CORE_NON_PROTOCOL = String.raw`^(packages/core/(src|dist)/((binding|process|observability|security)/|index\.)|node_modules/@hudhud/core/(src|dist)/((binding|process|observability|security)/|index\.))`;
// The public entry points of the core that an adapter may use (ADR-0004).
const CORE_PUBLIC_ENTRIES = String.raw`^(packages/core|node_modules/@hudhud/core)/dist/((protocol|process)/)?index\.(d\.ts|js)$`;
/** @type {import('dependency-cruiser').DependencyType[]} */
const NPM = ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-no-pkg', 'npm-unknown'];

/**
 * @param {string} manifestPath
 * @param {object} manifest
 * @returns {string}
 */
function packageName(manifestPath, manifest) {
  /** @type {unknown} */
  const name = Reflect.get(manifest, 'name');
  if (typeof name !== 'string' || name === '') throw new Error(`${manifestPath}: no "name"`);
  return name;
}

/**
 * dependency-cruiser classifies imports of workspace packages (resolved
 * through their links to packages/ or tooling/) as "undetermined", so
 * `not-to-undeclared` cannot see them. These rules are generated from the
 * workspace manifests instead: a workspace package may import another one
 * only when its own package.json declares it. Sources (`src/`) count
 * `dependencies`, `peerDependencies` and `optionalDependencies`; everything
 * else in the package (tests, schema sources, scripts) also counts
 * `devDependencies`. Manifests are read relative to the working directory,
 * which is where every path rule here is anchored as well.
 *
 * @returns {import('dependency-cruiser').IForbiddenRuleType[]}
 */
function workspaceDeclarationRules() {
  // Keep in sync with `packages` in pnpm-workspace.yaml (tested).
  const groups = ['packages', 'tooling'];
  /** @type {{ dir: string, name: string, runtime: Set<string>, all: Set<string> }[]} */
  const workspace = [];
  for (const group of groups) {
    if (!existsSync(group)) continue;
    for (const entry of readdirSync(group, { withFileTypes: true })) {
      const manifestPath = path.join(group, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
      /** @type {unknown} */
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof manifest !== 'object' || manifest === null) {
        throw new Error(`${manifestPath}: not a JSON object`);
      }
      /** @param {string} field */
      const names = (field) => {
        /** @type {unknown} */
        const value = Reflect.get(manifest, field);
        return typeof value === 'object' && value !== null ? Object.keys(value) : [];
      };
      const runtime = new Set([
        ...names('dependencies'),
        ...names('peerDependencies'),
        ...names('optionalDependencies'),
      ]);
      workspace.push({
        dir: `${group}/${entry.name}`,
        name: packageName(manifestPath, manifest),
        runtime,
        all: new Set([...runtime, ...names('devDependencies')]),
      });
    }
  }
  /** @param {string} text */
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** @param {{ dir: string, name: string }[]} targets */
  const targetPath = (targets) =>
    `(${targets.map((t) => `^${escape(t.dir)}/|(^|/)node_modules/${escape(t.name)}/`).join('|')})`;

  /** @type {import('dependency-cruiser').IForbiddenRuleType[]} */
  const rules = [];
  for (const from of workspace) {
    const others = workspace.filter((other) => other.dir !== from.dir);
    const notRuntime = others.filter((other) => !from.runtime.has(other.name));
    const notDeclared = others.filter((other) => !from.all.has(other.name));
    const comment = `${from.name} may import only the workspace packages its package.json declares.`;
    if (notRuntime.length > 0) {
      rules.push({
        name: 'workspace-deps-declared',
        severity: 'error',
        comment: `${comment} Sources count runtime dependencies only.`,
        from: { path: `^${escape(from.dir)}/src/` },
        to: { path: targetPath(notRuntime) },
      });
    }
    if (notDeclared.length > 0) {
      rules.push({
        name: 'workspace-deps-declared',
        severity: 'error',
        comment: `${comment} Tests and other non-source files also count devDependencies.`,
        from: { path: `^${escape(from.dir)}/`, pathNot: `^${escape(from.dir)}/src/` },
        to: { path: targetPath(notDeclared) },
      });
    }
  }
  return rules;
}

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    ...workspaceDeclarationRules(),
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'No dependency cycles anywhere.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-neutral',
      severity: 'error',
      comment:
        'The core is harness-neutral: it must not depend on adapters or on the umbrella package (ADR-0004, K3). Formerly core-not-to-adapters.',
      from: { path: '^packages/core/' },
      to: { path: ADAPTERS },
    },
    {
      name: 'protocol-not-to-process',
      severity: 'error',
      comment: 'The sans-IO protocol layers must not depend on the process layer (ADR-0006).',
      from: { path: SANS_IO },
      to: { path: PROCESS },
    },
    {
      name: 'protocol-sans-io',
      severity: 'error',
      comment: 'The sans-IO protocol layers must not use Node built-ins (ADR-0006).',
      from: { path: SANS_IO },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'protocol-no-npm-runtime-deps',
      severity: 'error',
      comment:
        'The neutral sans-IO protocol has no third-party runtime dependencies; generated validators are bundled (ADR-0005, ADR-0006).',
      from: { path: CORE_PROTOCOL },
      to: { dependencyTypes: NPM },
    },
    {
      name: 'protocol-no-npm-runtime-deps',
      severity: 'error',
      comment:
        'The Claude sans-IO protocol has no third-party runtime dependencies; its single exception is the neutral @hudhud/core/protocol entry (ADR-0005, ADR-0006, K3).',
      from: { path: CLAUDE_PROTOCOL },
      to: { dependencyTypes: NPM, pathNot: CORE_PROTOCOL_ENTRY },
    },
    {
      // Workspace packages resolve through their links to packages/ or
      // tooling/ and dependency-cruiser does not classify them as npm, so the
      // two rules above cannot see them; this closes that gap by path.
      name: 'protocol-no-workspace-deps',
      severity: 'error',
      comment: 'The neutral sans-IO protocol depends on no other workspace package (ADR-0006).',
      from: { path: CORE_PROTOCOL },
      to: { path: String.raw`^(packages/(?!core/)|tooling/)` },
    },
    {
      name: 'protocol-no-workspace-deps',
      severity: 'error',
      comment:
        'The Claude sans-IO protocol depends on no other workspace package except the neutral @hudhud/core/protocol entry (K3).',
      from: { path: CLAUDE_PROTOCOL },
      to: { path: String.raw`^(packages/(?!claude-code/)|tooling/)`, pathNot: CORE_PROTOCOL_ENTRY },
    },
    {
      name: 'protocol-not-to-binding',
      severity: 'error',
      comment:
        'The sans-IO protocol layers must not depend on the binding, process, observability or security layers, nor on the @hudhud/core root entry (ADR-0006).',
      from: { path: SANS_IO },
      to: { path: CORE_NON_PROTOCOL },
    },
    {
      name: 'adapter-protocol-closed',
      severity: 'error',
      comment:
        'The Claude protocol machines stay pure: they must not reach into the rest of the adapter (K3).',
      from: { path: CLAUDE_PROTOCOL },
      to: {
        // Third-party packages installed under packages/claude-code/ are the
        // npm rule's concern, not this one's.
        path: String.raw`^(packages/claude-code/(?!node_modules/)|node_modules/@hudhud/claude-code/)`,
        pathNot: CLAUDE_PROTOCOL,
      },
    },
    {
      name: 'process-not-to-binding',
      severity: 'error',
      comment: 'The process layer must not depend on the binding layer (ADR-0006).',
      from: { path: '^packages/core/src/process/' },
      to: {
        path: String.raw`^(packages/core/(src|dist)/binding/|node_modules/@hudhud/core/(src|dist)/binding/)`,
      },
    },
    {
      name: 'adapter-public-entry-only',
      severity: 'error',
      comment:
        'The adapter uses the core through its public entries only: @hudhud/core, @hudhud/core/protocol, @hudhud/core/process (ADR-0004).',
      from: { path: '^packages/claude-code/src/' },
      to: {
        path: String.raw`^(packages/core/|node_modules/@hudhud/core/)`,
        pathNot: CORE_PUBLIC_ENTRIES,
      },
    },
    {
      name: 'adapter-not-to-umbrella',
      severity: 'error',
      comment: 'Adapters must not depend on the umbrella package (ADR-0004).',
      from: { path: '^packages/claude-code/' },
      to: { path: String.raw`^(packages/hudhud/|node_modules/hudhud/)` },
    },
    {
      name: 'umbrella-re-exports-only',
      severity: 'error',
      comment: 'The umbrella package may only re-export hudhud packages (ADR-0004, E4).',
      from: { path: '^packages/hudhud/src/' },
      to: {
        pathNot: String.raw`^(packages/(core|claude-code)/|node_modules/@hudhud/(core|claude-code)/)`,
      },
    },
    {
      name: 'raw-only-from-raw',
      severity: 'error',
      comment:
        'The unstable tier is a leaf: no other adapter source depends on src/raw/ (ADR-0003).',
      from: { path: '^packages/claude-code/src/', pathNot: '^packages/claude-code/src/raw/' },
      to: {
        path: String.raw`^(packages/claude-code/(src|dist)/raw/|node_modules/@hudhud/claude-code/(src|dist)/raw/)`,
      },
    },
    {
      name: 'os-adapters-leaf',
      severity: 'error',
      comment:
        'The thin OS syscall adapters import only Node built-ins and process/os/types.ts, which keeps their OS-scoped coverage exclusion honest (plan §4.8).',
      from: { path: '^packages/core/src/process/os/' },
      to: {
        pathNot: String.raw`^packages/core/src/process/os/types\.ts$`,
        dependencyTypesNot: ['core'],
      },
    },
    {
      name: 'src-not-to-tests-or-tooling',
      severity: 'error',
      comment: 'Published sources must not depend on tests or repository tooling.',
      from: { path: '^packages/[^/]+/src/' },
      to: { path: String.raw`(^scripts/|^packages/[^/]+/test/)` },
    },
    {
      name: 'packages-not-to-tooling',
      severity: 'error',
      comment: 'Published sources must not depend on the private tooling workspace (ADR-0013).',
      from: { path: '^packages/[^/]+/src/' },
      to: { path: String.raw`^(tooling/|node_modules/@hudhud/test-support/)` },
    },
    {
      name: 'src-not-to-dev-deps',
      severity: 'error',
      comment: 'Published sources must not depend on devDependencies.',
      from: { path: '^packages/[^/]+/src/' },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'not-to-undeclared',
      severity: 'error',
      comment: 'Every npm dependency must be declared in the nearest package.json.',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: 'Every import must resolve.',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    // node_modules and build output stay in the graph as leaves, so rules
    // about third-party targets and package self-references (which resolve
    // to dist/ through the exports map) can match.
    doNotFollow: { path: String.raw`(^|/)node_modules/|^(packages|tooling)/[^/]+/dist/` },
    exclude: { path: String.raw`^(packages/[^/]+/temp|coverage)/` },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    combinedDependencies: false,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['types', 'import', 'node', 'default'],
      extensions: ['.ts', '.mjs', '.js', '.d.ts'],
    },
  },
};
