// Tests of the layer rules (plan §1.2): forbidden imports are planted and
// must fail, allowed ones must pass.
//
// dependency-cruiser runs with the repository's own config over a throw-away
// copy of the workspace layout (real package manifests, a workspace link from
// the adapter to the core, built entry stubs), so module resolution goes
// through the `exports` maps exactly as in the repository. ESLint runs with
// the repository's own config on virtual files at the planted paths.

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const DEPCRUISE = path.join(
  repoRoot,
  'node_modules',
  'dependency-cruiser',
  'bin',
  'dependency-cruiser.mjs',
);

/** Modules every case may import; none of them may violate a rule. */
const SUPPORT: Record<string, string> = {
  'packages/core/src/index.ts': 'export {};\n',
  'packages/core/src/protocol/index.ts': 'export {};\n',
  'packages/core/src/process/index.ts': 'export {};\n',
  'packages/core/src/process/spawn.ts': 'export {};\n',
  'packages/core/src/process/os/types.ts': 'export {};\n',
  'packages/core/src/binding/driver.ts': 'export {};\n',
  'packages/core/dist/index.js': 'export {};\n',
  'packages/core/dist/index.d.ts': 'export {};\n',
  'packages/core/dist/protocol/index.js': 'export {};\n',
  'packages/core/dist/protocol/index.d.ts': 'export {};\n',
  'packages/core/dist/process/index.js': 'export {};\n',
  'packages/core/dist/process/index.d.ts': 'export {};\n',
  'packages/core/node_modules/third-party/package.json':
    '{ "name": "third-party", "version": "1.0.0", "main": "index.js" }\n',
  'packages/core/node_modules/third-party/index.js': 'module.exports = {};\n',
  'packages/claude-code/node_modules/third-party/package.json':
    '{ "name": "third-party", "version": "1.0.0", "main": "index.js" }\n',
  'packages/claude-code/node_modules/third-party/index.js': 'module.exports = {};\n',
  'packages/claude-code/src/index.ts': 'export {};\n',
  'packages/hudhud/src/index.ts': 'export {};\n',
  'packages/claude-code/src/options.ts': 'export {};\n',
  'packages/claude-code/src/raw/index.ts': 'export {};\n',
  'packages/claude-code/src/protocol/wire/types.ts': 'export {};\n',
  'tooling/test-support/src/index.ts': 'export {};\n',
  'tsconfig.json': '{ "compilerOptions": { "allowJs": true } }\n',
  'package.json': '{ "name": "fixture", "private": true, "type": "module" }\n',
};

interface Case {
  readonly title: string;
  readonly file: string;
  readonly code: string;
  /** Exactly the rules this file must violate; empty means it must pass. */
  readonly rules: readonly string[];
}

const CASES: readonly Case[] = [
  {
    title: 'core importing a Claude wire vocabulary path',
    file: 'packages/core/src/planted-wire.ts',
    code: "import type {} from '../../claude-code/src/protocol/wire/types.js';\n",
    rules: ['core-neutral'],
  },
  {
    title: 'Claude protocol importing @hudhud/core/process',
    file: 'packages/claude-code/src/protocol/planted-process.ts',
    code: "import {} from '@hudhud/core/process';\n",
    rules: ['protocol-no-workspace-deps', 'protocol-not-to-binding', 'protocol-not-to-process'],
  },
  {
    title: 'Claude protocol importing a Node built-in',
    file: 'packages/claude-code/src/protocol/planted-builtin.ts',
    code: "import {} from 'node:fs';\n",
    rules: ['protocol-sans-io'],
  },
  {
    title: 'Claude protocol importing @hudhud/core/protocol and its own modules (allowed)',
    file: 'packages/claude-code/src/protocol/planted-allowed.ts',
    code: "import {} from '@hudhud/core/protocol';\nimport type {} from './wire/types.js';\n",
    rules: [],
  },
  {
    title: 'Claude protocol importing the @hudhud/core root entry',
    file: 'packages/claude-code/src/protocol/planted-root.ts',
    code: "import {} from '@hudhud/core';\n",
    rules: ['protocol-no-workspace-deps', 'protocol-not-to-binding'],
  },
  {
    title: 'Claude protocol reaching into the rest of the adapter',
    file: 'packages/claude-code/src/protocol/planted-closed.ts',
    code: "import {} from '../options.js';\n",
    rules: ['adapter-protocol-closed'],
  },
  {
    title: 'adapter importing a deep core path',
    file: 'packages/claude-code/src/planted-deep.ts',
    code: "import {} from '../../core/src/protocol/index.js';\n",
    rules: ['adapter-public-entry-only'],
  },
  {
    title: 'adapter importing the core public entries (allowed)',
    file: 'packages/claude-code/src/planted-public.ts',
    code: [
      "import {} from '@hudhud/core';",
      "import {} from '@hudhud/core/protocol';",
      "import {} from '@hudhud/core/process';",
      "import {} from './options.js';",
      '',
    ].join('\n'),
    rules: [],
  },
  {
    title: 'adapter source outside raw/ importing the unstable tier',
    file: 'packages/claude-code/src/planted-raw.ts',
    code: "import {} from './raw/index.js';\n",
    rules: ['raw-only-from-raw'],
  },
  {
    title: 'process layer importing the binding layer',
    file: 'packages/core/src/process/planted-binding.ts',
    code: "import {} from '../binding/driver.js';\n",
    rules: ['process-not-to-binding'],
  },
  {
    title: 'OS adapter importing Node built-ins and os/types.ts (allowed)',
    file: 'packages/core/src/process/os/posix.ts',
    code: "import {} from 'node:fs';\nimport type {} from './types.js';\n",
    rules: [],
  },
  {
    title: 'OS adapter importing another process module',
    file: 'packages/core/src/process/os/planted-leaf.ts',
    code: "import {} from '../spawn.js';\n",
    rules: ['os-adapters-leaf'],
  },
  {
    title: 'published source importing the tooling workspace',
    file: 'packages/core/src/planted-tooling.ts',
    code: "import {} from '../../../tooling/test-support/src/index.js';\n",
    rules: ['packages-not-to-tooling'],
  },
  {
    title: 'neutral protocol importing a third-party package',
    file: 'packages/core/src/protocol/planted-npm.ts',
    code: "import {} from 'third-party';\n",
    rules: ['protocol-no-npm-runtime-deps'],
  },
  {
    title: 'Claude protocol importing a third-party package',
    file: 'packages/claude-code/src/protocol/planted-npm.ts',
    code: "import {} from 'third-party';\n",
    rules: ['protocol-no-npm-runtime-deps'],
  },
  {
    title: 'Claude protocol importing another workspace package',
    file: 'packages/claude-code/src/protocol/planted-workspace.ts',
    code: "import {} from '../../../hudhud/src/index.js';\n",
    rules: ['adapter-not-to-umbrella', 'protocol-no-workspace-deps'],
  },
  {
    title: 'neutral protocol importing the core root entry',
    file: 'packages/core/src/protocol/planted-root.ts',
    code: "import {} from '../index.js';\n",
    rules: ['protocol-not-to-binding'],
  },
  {
    title: 'neutral protocol importing a Node built-in',
    file: 'packages/core/src/protocol/planted-builtin.ts',
    code: "import {} from 'node:fs';\n",
    rules: ['protocol-sans-io'],
  },
];

interface Violation {
  readonly from: string;
  readonly rule: string;
}

function parseViolations(stdout: string): Violation[] {
  /** The JSON reporter's shape, narrowed to what the test reads. */
  const report = JSON.parse(stdout) as {
    summary: { violations: { from: string; rule: { name: string } }[] };
  };
  return report.summary.violations.map((v) => ({ from: v.from, rule: v.rule.name }));
}

describe('dependency-cruiser layer rules', () => {
  let fixture: string;
  let violations: Violation[];
  let status: number | null;

  beforeAll(() => {
    fixture = realpathSync(mkdtempSync(path.join(tmpdir(), 'hudhud-depcruise-')));
    const write = (file: string, content: string): void => {
      mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
      writeFileSync(path.join(fixture, file), content);
    };
    // The real manifests, so `exports` resolves as in the repository. The
    // planted third-party package is added as a declared runtime dependency,
    // so only the sans-IO rules (not `not-to-undeclared`) can reject it.
    for (const pkg of ['core', 'claude-code']) {
      const manifest = JSON.parse(
        readFileSync(path.join(repoRoot, 'packages', pkg, 'package.json'), 'utf8'),
      ) as { dependencies?: Record<string, string> };
      write(
        `packages/${pkg}/package.json`,
        JSON.stringify({
          ...manifest,
          dependencies: { ...manifest.dependencies, 'third-party': '1.0.0' },
        }),
      );
    }
    for (const [file, content] of Object.entries(SUPPORT)) write(file, content);
    for (const c of CASES) write(c.file, c.code);
    // The workspace link pnpm creates (a junction on Windows).
    mkdirSync(path.join(fixture, 'packages', 'claude-code', 'node_modules', '@hudhud'), {
      recursive: true,
    });
    symlinkSync(
      path.join(fixture, 'packages', 'core'),
      path.join(fixture, 'packages', 'claude-code', 'node_modules', '@hudhud', 'core'),
      'junction',
    );

    const depcruise = (...extra: string[]) =>
      spawnSync(
        process.execPath,
        [
          DEPCRUISE,
          '--config',
          path.join(repoRoot, '.dependency-cruiser.mjs'),
          ...extra,
          'packages',
          'tooling',
        ],
        { cwd: fixture, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
    const report = depcruise('--output-type', 'json');
    if (report.stdout === '') throw new Error(`depcruise produced no report: ${report.stderr}`);
    violations = parseViolations(report.stdout);
    // The JSON reporter always exits 0; the default reporter, as `pnpm
    // depcruise` runs it, sets the exit code.
    status = depcruise().status;
  }, 120_000);

  afterAll(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  it('fails the run when any rule is violated', () => {
    expect(status).not.toBe(0);
  });

  it('reports nothing for the support modules', () => {
    const planted = new Set(CASES.map((c) => c.file));
    expect(violations.filter((v) => !planted.has(v.from))).toEqual([]);
  });

  it.each(CASES)('$title', ({ file, rules }) => {
    const found = [...new Set(violations.filter((v) => v.from === file).map((v) => v.rule))];
    expect(found.sort()).toEqual([...rules].sort());
  });
});

describe('ESLint layer rules', () => {
  // The import, global and syntax restrictions under test are syntactic. Type
  // information is switched off because the planted files exist only in
  // memory and no TypeScript project contains them.
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfig: [tseslint.configs.disableTypeChecked],
  });

  const LAYER_RULES = new Set([
    'no-restricted-imports',
    'no-restricted-globals',
    'no-restricted-properties',
    'no-restricted-syntax',
  ]);

  async function layerFindings(file: string, code: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, file) });
    if (result === undefined) throw new Error('no lint result');
    const fatal = result.messages.filter((m) => m.fatal === true);
    if (fatal.length > 0) throw new Error(fatal.map((m) => m.message).join('\n'));
    return result.messages
      .filter((m) => m.ruleId !== null && LAYER_RULES.has(m.ruleId))
      .map((m) => `${String(m.line)}:${m.ruleId ?? ''}`);
  }

  const CLAUDE_PROTOCOL = 'packages/claude-code/src/protocol/planted.ts';
  const CORE_PROTOCOL = 'packages/core/src/protocol/planted.ts';
  const INTEGRATION = 'packages/claude-code/test/integration/planted.test.ts';

  it.each([
    ['a Node built-in', "import {} from 'node:fs';\n"],
    ['a bare Node built-in', "import {} from 'fs';\n"],
    ['@hudhud/core/process', "import type {} from '@hudhud/core/process';\n"],
    ['the @hudhud/core root entry', "import {} from '@hudhud/core';\n"],
    ['another core subpath', "import {} from '@hudhud/core/schemas/events.schema';\n"],
    ['the adapter entry', "import {} from '@hudhud/claude-code';\n"],
    ['the umbrella', "import {} from 'hudhud';\n"],
  ])('rejects %s in the Claude protocol', async (_name, code) => {
    const findings = await layerFindings(CLAUDE_PROTOCOL, code);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f === '1:no-restricted-imports')).toBe(true);
  });

  it('allows @hudhud/core/protocol in the Claude protocol', async () => {
    expect(
      await layerFindings(
        CLAUDE_PROTOCOL,
        "import {} from '@hudhud/core/protocol';\nimport type {} from './wire/types.js';\n",
      ),
    ).toEqual([]);
  });

  it('applies the sans-IO host restrictions to the Claude protocol', async () => {
    const code = [
      'export const a = setTimeout;',
      'export const b = Date.now();',
      'export const c = new Date();',
      "export const d = import('./x.js');",
      '',
    ].join('\n');
    expect(await layerFindings(CLAUDE_PROTOCOL, code)).toEqual([
      '1:no-restricted-globals',
      '2:no-restricted-properties',
      '3:no-restricted-syntax',
      '4:no-restricted-syntax',
    ]);
  });

  it('keeps the neutral protocol rules and adds the core root entry', async () => {
    expect(await layerFindings(CORE_PROTOCOL, "import {} from '@hudhud/core';\n")).toEqual([
      '1:no-restricted-imports',
    ]);
    expect(await layerFindings(CORE_PROTOCOL, "import {} from 'node:fs';\n")).not.toEqual([]);
    expect(
      await layerFindings(CORE_PROTOCOL, "import {} from '@hudhud/claude-code';\n"),
    ).not.toEqual([]);
  });

  it('rejects connect and session from the package root in integration tests', async () => {
    const code = [
      "import { connect } from '@hudhud/claude-code';",
      "import { session } from 'hudhud';",
      "import * as root from '../../src/index.js';",
      'export const all = [connect, session, root];',
      '',
    ].join('\n');
    expect(await layerFindings(INTEGRATION, code)).toEqual([
      '1:no-restricted-imports',
      '2:no-restricted-imports',
      '3:no-restricted-imports',
    ]);
  });

  it('allows testConnect from test-support in integration tests', async () => {
    expect(
      await layerFindings(
        INTEGRATION,
        "import { testConnect } from '@hudhud/test-support';\nexport const t = testConnect;\n",
      ),
    ).toEqual([]);
  });

  it('does not lint generated validators', async () => {
    expect(
      await eslint.isPathIgnored(
        path.join(repoRoot, 'packages/claude-code/src/protocol/generated/validators.gen.js'),
      ),
    ).toBe(true);
    expect(
      await eslint.isPathIgnored(path.join(repoRoot, 'packages/claude-code/src/protocol/x.ts')),
    ).toBe(false);
  });
});
