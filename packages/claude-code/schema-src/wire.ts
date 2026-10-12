// Schema entry of the Claude Code wire (K3): the inbound and outbound wire
// schemas and the validators generated into
// src/protocol/generated/validators.gen.ts.

import type { SchemaSource, ValidatorExport } from '../../core/schema-src/common.js';
import { wireInboundDocument } from './wire-inbound.js';
import { wireOutboundDocument } from './wire-outbound.js';

const TYPES = '../wire/types.js';

/** A validator of one wire definition that narrows to the type of the same name. */
function wireValidator(schema: string, def: string): ValidatorExport {
  return { name: `validate${def}`, schema, def, type: { from: TYPES, name: def } };
}

const inbound = 'wire-inbound.schema.json';
const outbound = 'wire-outbound.schema.json';

export const schemaSource: SchemaSource = {
  documents: [wireInboundDocument, wireOutboundDocument],
  data: [],
  validators: [
    wireValidator(inbound, 'InboundEnvelope'),
    wireValidator(inbound, 'ControlResponseFrame'),
    wireValidator(inbound, 'InitializeResponse'),
    wireValidator(inbound, 'InterruptResponse'),
    wireValidator(inbound, 'CanUseToolRequestFrame'),
    wireValidator(inbound, 'SystemInitFrame'),
    wireValidator(inbound, 'ApiRetryFrame'),
    wireValidator(inbound, 'SessionStateChangedFrame'),
    wireValidator(inbound, 'PermissionDeniedFrame'),
    wireValidator(inbound, 'AssistantFrame'),
    wireValidator(inbound, 'ResultFrame'),
    wireValidator(inbound, 'CommandLifecycleFrame'),
    wireValidator(outbound, 'OutboundFrame'),
  ],
};
