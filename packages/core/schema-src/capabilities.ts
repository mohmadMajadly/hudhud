// Harness capabilities (plan §2.2): source of schemas/capabilities.schema.json.

import Type from 'typebox';

import { openEnum, stringMap, type SchemaDocument } from './common.js';

export const Capability = openEnum(['supported', 'emulated', 'unsupported'] as const);

export const ProcessContainment = openEnum(['job', 'best-effort', 'cgroup'] as const);

export const HarnessCapabilities = Type.Object({
  multiTurn: Capability,
  resume: Capability,
  fork: Capability,
  interrupt: Capability,
  permissionsInBand: Capability,
  workspaceTrust: Type.Object({ none: Capability, context: Capability, full: Capability }),
  processContainment: ProcessContainment,
  reasons: stringMap(Type.String()),
});

export const capabilitiesDocument: SchemaDocument = {
  file: 'capabilities.schema.json',
  title: 'hudhud harness capabilities',
  description: 'What a harness can do, computed at connect.',
  root: 'HarnessCapabilities',
  defs: { Capability, ProcessContainment, HarnessCapabilities },
};
