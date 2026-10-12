// Security posture (plan §2.2, ADR-0012): source of schemas/posture.schema.json.

import Type from 'typebox';

import { JsonValueSchema, list, type SchemaDocument } from './common.js';

export const SecurityPostureEntry = Type.Object({
  setting: Type.String(),
  value: JsonValueSchema,
  defaultValue: JsonValueSchema,
  deviates: Type.Boolean(),
});

export const SecurityPosture = Type.Object({ entries: list(SecurityPostureEntry) });

export const postureDocument: SchemaDocument = {
  file: 'posture.schema.json',
  title: 'hudhud security posture',
  description:
    'The security-relevant settings of a harness or session and whether each deviates from its default. Values never carry secrets.',
  root: 'SecurityPosture',
  defs: { SecurityPostureEntry, SecurityPosture },
};
