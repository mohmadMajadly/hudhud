// The option types equal their TypeBox schema sources (ADR-0005), and the
// committed option validators are exactly what the schema pipeline
// generates from them.
//
// The option schema is not yet registered in scripts/lib/schema/pipeline.mjs
// (a shared file owned by the wave closer), so `schema:check` does not cover
// src/generated/validators.gen.ts yet; this test regenerates it with the
// pipeline entry the closer registers (OPTIONS_PIPELINE) and compares byte
// for byte.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Static } from 'typebox';
import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import type { TypesEqual } from '../../../core/test/unit/type-equality.js';
import { buildOutputs } from '../../../../scripts/lib/schema/pipeline.mjs';
import type * as schema from '../../schema-src/options.js';
import type * as options from '../../src/options.js';

const root = fileURLToPath(new URL('../../../..', import.meta.url));

/** The pipeline entry of the option schema (plan §1.3). */
const OPTIONS_PIPELINE = {
  packageDir: 'packages/claude-code',
  schemaId: 'claude-code-options',
  entry: 'schema-src/options.ts',
  validators: 'src/generated/validators.gen.ts',
} as const;

const VALIDATORS = 'packages/claude-code/src/generated/validators.gen.ts';
const SCHEMA = 'packages/claude-code/schemas/options.schema.json';

describe('option types equal their schema sources', () => {
  it('JSON parts', () => {
    expectTypeOf<
      TypesEqual<options.ConnectOptionsData, Static<typeof schema.ConnectOptions>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<options.SessionOptionsData, Static<typeof schema.SessionOptions>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<options.ResumeOptionsData, Static<typeof schema.ResumeOptions>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<options.ConnectSessionOptionsData, Static<typeof schema.ConnectSessionOptions>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<options.ClaudeCodeSessionOptions, Static<typeof schema.ClaudeCodeSessionOptions>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<options.ClaudeCodeConnectOptions, Static<typeof schema.ClaudeCodeConnectOptions>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<options.EnvOption, Static<typeof schema.EnvOption>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<options.PermissionMode, Static<typeof schema.PermissionMode>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<options.WorkspaceTrust, Static<typeof schema.WorkspaceTrust>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<options.SettingSource, Static<typeof schema.SettingSource>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<options.SubscriberOptionsData, Static<typeof schema.SubscriberOptionsData>>
    >().toEqualTypeOf<true>();
  });

  it('host values stay outside the JSON parts', () => {
    expectTypeOf<options.SessionOptionsData>().not.toHaveProperty('onPermission');
    expectTypeOf<options.SessionOptionsData>().not.toHaveProperty('signal');
    expectTypeOf<options.ConnectOptionsData>().not.toHaveProperty('signal');
  });
});

describe('generated option validators', () => {
  let outputs: Map<string, string>;

  beforeAll(async () => {
    outputs = await buildOutputs(root, [OPTIONS_PIPELINE]);
  }, 120_000);

  it('are byte-identical to the pipeline output', () => {
    expect([...outputs.keys()].sort()).toEqual([SCHEMA, VALIDATORS]);
    expect(readFileSync(`${root}/${VALIDATORS}`, 'utf8')).toBe(outputs.get(VALIDATORS));
  });

  it('describe a strict schema rooted at the session() options', () => {
    const json = JSON.parse(outputs.get(SCHEMA) ?? '{}') as {
      $ref: string;
      $defs: Record<
        string,
        { additionalProperties?: unknown; properties?: Record<string, unknown> }
      >;
    };
    expect(json.$ref).toBe('#/$defs/ConnectSessionOptions');
    for (const def of [
      'ConnectOptions',
      'SessionOptions',
      'ResumeOptions',
      'ConnectSessionOptions',
      'ClaudeCodeSessionOptions',
      'ClaudeCodeConnectOptions',
      'Termination',
      'Trace',
      'SubscriberOptionsData',
      'EnvObjectForm',
    ]) {
      expect(json.$defs[def]?.additionalProperties).toBe(false);
    }
    const connect = Object.keys(json.$defs['ConnectOptions']?.properties ?? {});
    const sessionKeys = Object.keys(json.$defs['SessionOptions']?.properties ?? {});
    const combined = Object.keys(json.$defs['ConnectSessionOptions']?.properties ?? {});
    expect(new Set(combined)).toEqual(new Set([...connect, ...sessionKeys]));
  });
});
