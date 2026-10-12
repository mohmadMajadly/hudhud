// Layer boundaries of the hudhud monorepo (ADR-0004, ADR-0006).
// ESLint enforces the same sans-IO boundary file by file; this enforces it
// on the resolved module graph, including type-only imports.

const ADAPTERS = String.raw`^(packages/(claude-code|hudhud)/|node_modules/(@hudhud/claude-code|hudhud)/)`;
const PROTOCOL = '^packages/core/src/protocol/';
const PROCESS = String.raw`^(packages/core/(src|dist)/process/|node_modules/@hudhud/core/(src|dist)/process/)`;

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'No dependency cycles anywhere.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-not-to-adapters',
      severity: 'error',
      comment: 'The core must not depend on adapters or on the umbrella package (ADR-0004).',
      from: { path: '^packages/core/' },
      to: { path: ADAPTERS },
    },
    {
      name: 'protocol-not-to-process',
      severity: 'error',
      comment: 'The sans-IO protocol layer must not depend on the process layer (ADR-0006).',
      from: { path: PROTOCOL },
      to: { path: PROCESS },
    },
    {
      name: 'protocol-sans-io',
      severity: 'error',
      comment: 'The sans-IO protocol layer must not use Node built-ins (ADR-0006).',
      from: { path: PROTOCOL },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'protocol-no-npm-runtime-deps',
      severity: 'error',
      comment:
        'The sans-IO protocol layer has no third-party runtime dependencies; generated validators are bundled (ADR-0005, ADR-0006).',
      from: { path: PROTOCOL },
      to: {
        dependencyTypes: [
          'npm',
          'npm-dev',
          'npm-optional',
          'npm-peer',
          'npm-no-pkg',
          'npm-unknown',
        ],
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
      name: 'src-not-to-tests-or-tooling',
      severity: 'error',
      comment: 'Published sources must not depend on tests or repository tooling.',
      from: { path: '^packages/[^/]+/src/' },
      to: { path: String.raw`(^scripts/|^packages/[^/]+/test/)` },
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
    doNotFollow: { path: String.raw`(^|/)node_modules/|^packages/[^/]+/dist/` },
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
