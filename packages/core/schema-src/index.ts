// Schema entry of @hudhud/core: the neutral schemas (K3) and the validators
// generated into src/protocol/generated/validators.gen.ts.

import { capabilitiesDocument } from './capabilities.js';
import type { SchemaSource } from './common.js';
import { conformanceDocument } from './conformance.js';
import { errorsDocument } from './errors.js';
import { eventsDocument } from './events.js';
import { postureDocument } from './posture.js';

/** Version of the neutral wire model; bumped only on a breaking change. */
export const WIRE_SCHEMA_VERSION = 1;

export const schemaSource: SchemaSource = {
  documents: [
    eventsDocument,
    errorsDocument,
    capabilitiesDocument,
    postureDocument,
    conformanceDocument,
  ],
  data: [{ file: 'version.json', json: { wireSchemaVersion: WIRE_SCHEMA_VERSION } }],
  validators: [
    {
      name: 'validateHudhudEvent',
      schema: 'events.schema.json',
      def: 'HudhudEvent',
      type: { from: '../events/types.js', name: 'HudhudEvent' },
    },
    {
      name: 'validateKnownHudhudEvent',
      schema: 'events.schema.json',
      def: 'KnownHudhudEvent',
      type: { from: '../events/types.js', name: 'HudhudEvent' },
    },
    {
      name: 'validateErrorData',
      schema: 'errors.schema.json',
      def: 'ErrorData',
      type: { from: '../json.js', name: 'JsonObject' },
    },
    {
      name: 'validateHarnessCapabilities',
      schema: 'capabilities.schema.json',
      def: 'HarnessCapabilities',
      type: { from: '../capabilities.js', name: 'HarnessCapabilities' },
    },
    {
      name: 'validateSecurityPosture',
      schema: 'posture.schema.json',
      def: 'SecurityPosture',
      type: { from: '../capabilities.js', name: 'SecurityPosture' },
    },
    {
      name: 'validateConformanceLine',
      schema: 'conformance.schema.json',
      def: 'ConformanceLine',
      type: { from: '../json.js', name: 'JsonObject' },
    },
  ],
};
