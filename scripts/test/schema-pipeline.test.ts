// The schema pipeline end to end on the real sources: deterministic, equal to
// the committed files (what schema:check enforces), and every hand edit,
// deletion or stale file is detected.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PIPELINES, buildOutputs, compareOutputs, writeOutputs } from '../lib/schema/pipeline.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const VALIDATORS = 'packages/core/src/protocol/generated/validators.gen.ts';
const EVENTS = 'packages/core/schemas/events.schema.json';

let outputs: Map<string, string>;

beforeAll(async () => {
  outputs = await buildOutputs(root);
}, 120_000);

describe('buildOutputs', () => {
  it('produces the schemas, data files and validators of every package', () => {
    expect([...outputs.keys()].sort()).toEqual([
      'packages/claude-code/schemas/options.schema.json',
      'packages/claude-code/schemas/wire-inbound.schema.json',
      'packages/claude-code/schemas/wire-outbound.schema.json',
      'packages/claude-code/src/generated/validators.gen.ts',
      'packages/claude-code/src/protocol/generated/validators.gen.ts',
      'packages/core/schemas/capabilities.schema.json',
      'packages/core/schemas/conformance.schema.json',
      'packages/core/schemas/errors.schema.json',
      'packages/core/schemas/events.schema.json',
      'packages/core/schemas/posture.schema.json',
      'packages/core/schemas/version.json',
      'packages/core/src/protocol/generated/validators.gen.ts',
    ]);
    expect(outputs.get('packages/core/schemas/version.json')).toBe(
      '{\n  "wireSchemaVersion": 1\n}\n',
    );
  });

  it('is deterministic: a second build is byte-identical', async () => {
    const second = await buildOutputs(root);
    expect(second).toEqual(outputs);
  }, 120_000);

  it('matches the committed files (schema:check)', () => {
    expect(compareOutputs(root, outputs)).toEqual([]);
  });

  it('writes LF only', () => {
    for (const content of outputs.values()) expect(content.includes('\r')).toBe(false);
  });

  it('refuses two pipelines that generate the same file', async () => {
    const [core] = PIPELINES;
    if (core === undefined) throw new Error('no pipeline');
    await expect(buildOutputs(root, [core, core])).rejects.toThrow(/generated twice/);
  }, 120_000);
});

describe('writeOutputs and compareOutputs', () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hudhud-schema-out-')));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  it('writes every output once and then reports nothing changed', () => {
    expect(writeOutputs(dir, outputs).sort()).toEqual([...outputs.keys()].sort());
    expect(writeOutputs(dir, outputs)).toEqual([]);
    expect(compareOutputs(dir, outputs)).toEqual([]);
  });

  it('detects a hand edit, a deleted file and a stale schema', () => {
    writeOutputs(dir, outputs);
    const events = path.join(dir, EVENTS);
    writeFileSync(
      events,
      readFileSync(events, 'utf8').replace('"title": "hudhud events"', '"title": "edited"'),
    );
    unlinkSync(path.join(dir, VALIDATORS));
    writeFileSync(path.join(dir, 'packages/core/schemas/old.schema.json'), '{}\n');
    mkdirSync(path.join(dir, 'packages/core/schemas/.baseline'));
    expect(compareOutputs(dir, outputs)).toEqual([
      `${EVENTS}: differs from its sources (line 4)`,
      `${VALIDATORS}: missing`,
      'packages/core/schemas/old.schema.json: not produced by any source',
    ]);
  });

  it('detects an edit of the generated validators', () => {
    writeOutputs(dir, outputs);
    const file = path.join(dir, VALIDATORS);
    writeFileSync(file, `${readFileSync(file, 'utf8')}// tampered\n`);
    expect(compareOutputs(dir, outputs)).toEqual([
      `${VALIDATORS}: differs from its sources (line ${String((outputs.get(VALIDATORS) ?? '').split('\n').length)})`,
    ]);
  });

  it('skips a package without a schemas directory', () => {
    expect(compareOutputs(dir, new Map())).toEqual([]);
  });
});
