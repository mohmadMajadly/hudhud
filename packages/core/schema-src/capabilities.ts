// Harness capabilities (plan §2.2): source of schemas/capabilities.schema.json.

import Type from 'typebox';

import { stringMap, type SchemaDocument } from './common.js';

export const Capability = Type.Enum(['supported', 'emulated', 'unsupported']);

export const ProcessContainment = Type.Enum(['job', 'best-effort', 'cgroup']);

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
