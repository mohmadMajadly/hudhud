import { builtinModules } from 'node:module';

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const nodeBuiltins = builtinModules.filter((name) => !name.startsWith('_'));

const BUILTIN_MESSAGE = 'The sans-IO core must not import Node built-ins (ADR-0006).';

/**
 * @typedef {{ name: string, message: string, importNames?: string[] }} RestrictedPath
 * @typedef {{ group: string[], message: string, importNames?: string[] }} RestrictedPattern
 */

/**
 * Import restrictions of a sans-IO directory: no Node built-ins and no
 * process layer, plus the directory's own `paths` and `patterns`.
 *
 * @param {{ paths: RestrictedPath[], patterns: RestrictedPattern[] }} extra
 * @returns {import('eslint').Linter.RuleEntry}
 */
function sansIoImports(extra) {
  return [
    'error',
    {
      paths: [
        ...nodeBuiltins.map((name) => ({ name, message: BUILTIN_MESSAGE })),
        ...nodeBuiltins.map((name) => ({ name: `node:${name}`, message: BUILTIN_MESSAGE })),
        ...extra.paths,
      ],
      patterns: [
        { group: ['node:*'], message: BUILTIN_MESSAGE },
        {
          group: ['**/process', '**/process/**', '@hudhud/core/process'],
          message: 'The protocol layer must not depend on the process layer (ADR-0006).',
        },
        ...extra.patterns,
      ],
    },
  ];
}

/** @type {RestrictedPath} */
const CORE_ROOT_ENTRY = {
  name: '@hudhud/core',
  message:
    'The sans-IO protocol layer must not depend on the binding layer behind the @hudhud/core root entry (ADR-0006).',
};

const INTEGRATION_MESSAGE =
  'Integration tests must use testConnect from @hudhud/test-support, never connect/session from the package root (ADR-0013).';

/** The composition root of the integration harness (plan §1.11). */
const INTEGRATION_SUPPORT = 'packages/*/test/integration/support/**/*.ts';

/**
 * The import restrictions of integration tests: never `connect`/`session`
 * from the package root; outside the composition root, also never the
 * product's connect internals or host (`connectWith`, `sessionWith`,
 * `nodeHost`), which only the composition root wires into the harness.
 *
 * @param {boolean} internals whether the connect internals are refused too
 */
function integrationImports(internals) {
  return {
    paths: ['@hudhud/claude-code', 'hudhud'].map((name) => ({
      name,
      importNames: ['connect', 'session'],
      message: INTEGRATION_MESSAGE,
    })),
    patterns: [
      {
        group: ['**/src', '**/src/index', '**/src/index.js', '**/src/index.ts'],
        importNames: ['connect', 'session'],
        message: INTEGRATION_MESSAGE,
      },
      ...(internals
        ? [
            {
              group: ['**/src/connect', '**/src/connect.js', '**/src/connect.ts'],
              importNames: ['connect', 'session', 'connectWith', 'sessionWith'],
              message: INTEGRATION_MESSAGE,
            },
            {
              group: ['**/src/adapter', '**/src/adapter.js', '**/src/adapter.ts'],
              importNames: ['nodeHost'],
              message: INTEGRATION_MESSAGE,
            },
          ]
        : []),
    ],
  };
}

/** @type {RestrictedPattern} */
const NOT_TO_ADAPTERS = {
  group: ['@hudhud/claude-code', '@hudhud/claude-code/**', 'hudhud'],
  message: 'The core must not depend on adapters (ADR-0004).',
};

/**
 * The sans-IO core (ADR-0006): pure `(state, input) -> (state, effects[])`
 * with an injected clock and id generator. No Node built-ins, no host
 * globals, no ambient time or randomness, no dynamic loading. The same
 * boundary is enforced by dependency-cruiser. Applied to the neutral
 * protocol (`packages/core/src/protocol/`) and to the Claude Code protocol
 * (`packages/claude-code/src/protocol/`, K3) with their own import rules.
 *
 * @type {import('eslint').Linter.RulesRecord}
 */
const sansIoRules = {
  'no-restricted-globals': [
    'error',
    ...[
      'process',
      'Buffer',
      'require',
      'module',
      '__dirname',
      '__filename',
      'globalThis',
      'global',
      'window',
      'self',
      'setTimeout',
      'setInterval',
      'setImmediate',
      'clearTimeout',
      'clearInterval',
      'clearImmediate',
      'queueMicrotask',
      'fetch',
      'WebSocket',
      'XMLHttpRequest',
      'performance',
      'crypto',
      'navigator',
    ].map((name) => ({
      name,
      message: `\`${name}\` is host I/O or ambient state; inject it through the binding layer (ADR-0006).`,
    })),
  ],
  'no-restricted-properties': [
    'error',
    { object: 'Date', property: 'now', message: 'Use the injected clock (ADR-0006).' },
    { object: 'Math', property: 'random', message: 'Use the injected id generator (ADR-0006).' },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: "NewExpression[callee.name='Date'][arguments.length=0]",
      message: 'Use the injected clock (ADR-0006).',
    },
    {
      selector: 'ImportExpression',
      message:
        'Dynamic import is I/O; the sans-IO core must not load modules at run time (ADR-0006).',
    },
  ],
};

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      'packages/*/temp/**',
      '**/node_modules/**',
      // Local agent worktrees (gitignored): full copies of the repository.
      '.claude/**',
      '.cache/**',
      // Generated Ajv validators: not linted (generated), but still under
      // dependency-cruiser and checked byte for byte by `schema:check`.
      'packages/*/src/**/generated/**',
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript (strict, checkJs) reports undefined names for every linted
      // file, including JavaScript; the core rule cannot see type-level globals.
      'no-undef': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['packages/*/src/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [NOT_TO_ADAPTERS] }],
    },
  },
  {
    files: ['packages/core/src/protocol/**/*.ts'],
    rules: {
      ...sansIoRules,
      'no-restricted-imports': sansIoImports({
        paths: [CORE_ROOT_ENTRY],
        patterns: [NOT_TO_ADAPTERS],
      }),
    },
  },
  {
    // The Claude Code protocol machines are sans-IO too (K3). Of the core
    // they may import the neutral `@hudhud/core/protocol` entry only.
    files: ['packages/claude-code/src/protocol/**/*.ts'],
    rules: {
      ...sansIoRules,
      'no-restricted-imports': sansIoImports({
        paths: [CORE_ROOT_ENTRY],
        patterns: [
          {
            group: ['@hudhud/core/*', '!@hudhud/core/protocol'],
            message:
              'The Claude protocol layer may import only @hudhud/core/protocol from the core (K3, ADR-0006).',
          },
          {
            group: ['@hudhud/claude-code', '@hudhud/claude-code/**', 'hudhud'],
            message:
              'The Claude protocol layer stays closed: no adapter entry points, no umbrella (K3, ADR-0004).',
          },
        ],
      }),
    },
  },
  {
    // Integration tests reach the CLI only through `testConnect` from
    // @hudhud/test-support: pinned, hash-verified binary, sandboxed config,
    // explicit environment (ADR-0013, plan §1.2). Never the public entry.
    files: ['packages/*/test/integration/**/*.ts'],
    ignores: [INTEGRATION_SUPPORT],
    rules: {
      'no-restricted-imports': ['error', integrationImports(true)],
    },
  },
  {
    // The composition root (plan §1.11) injects the product's `connectWith`
    // over its own host into test-support's harness; it alone may import them.
    files: [INTEGRATION_SUPPORT],
    rules: {
      'no-restricted-imports': ['error', integrationImports(false)],
    },
  },
  {
    files: ['packages/hudhud/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "Program > :not(ExportAllDeclaration, ExportNamedDeclaration[source.type='Literal'])",
          message: 'The umbrella package contains re-exports only, never logic (ADR-0004, E4).',
        },
      ],
    },
  },
);
