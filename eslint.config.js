import { builtinModules } from 'node:module';

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const nodeBuiltins = builtinModules.filter((name) => !name.startsWith('_'));

/**
 * The sans-IO core (ADR-0006): pure `(state, input) -> (state, effects[])`
 * with an injected clock and id generator. No Node built-ins, no host
 * globals, no ambient time or randomness, no dynamic loading. The same
 * boundary is enforced by dependency-cruiser.
 *
 * @type {import('eslint').Linter.RulesRecord}
 */
const sansIoRules = {
  'no-restricted-imports': [
    'error',
    {
      paths: [
        ...nodeBuiltins.map((name) => ({
          name,
          message: 'The sans-IO core must not import Node built-ins (ADR-0006).',
        })),
        ...nodeBuiltins.map((name) => ({
          name: `node:${name}`,
          message: 'The sans-IO core must not import Node built-ins (ADR-0006).',
        })),
      ],
      patterns: [
        {
          group: ['node:*'],
          message: 'The sans-IO core must not import Node built-ins (ADR-0006).',
        },
        {
          group: ['**/process', '**/process/**', '@hudhud/core/process'],
          message: 'The protocol layer must not depend on the process layer (ADR-0006).',
        },
        {
          group: ['@hudhud/claude-code', '@hudhud/claude-code/**', 'hudhud'],
          message: 'The core must not depend on adapters (ADR-0004).',
        },
      ],
    },
  ],
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
    ignores: ['**/dist/**', '**/coverage/**', 'packages/*/temp/**', '**/node_modules/**'],
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
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@hudhud/claude-code', '@hudhud/claude-code/**', 'hudhud'],
              message: 'The core must not depend on adapters (ADR-0004).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/core/src/protocol/**/*.ts'],
    rules: sansIoRules,
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
