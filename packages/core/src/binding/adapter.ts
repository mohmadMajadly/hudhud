/**
 * Adapter registration and the `adapterApiVersion` check (ADR-0004 §3,
 * plan §2.2).
 *
 * @remarks
 * An adapter declares the adapter API version it was built against. A
 * version this core does not implement is refused when the adapter is
 * defined (at import), never at first use.
 *
 * @packageDocumentation
 */

import { AdapterApiVersionError, InvalidOptionsError } from './errors.js';

/**
 * The adapter API version implemented by this core.
 *
 * @remarks
 * An integer negotiated at adapter registration; an adapter built against an
 * unsupported value is refused at registration, not at first use (ADR-0004).
 *
 * @public
 */
export const adapterApiVersion = 1;

/**
 * What an adapter declares about itself.
 *
 * @beta
 */
export interface AdapterDefinition {
  /** The harness name, for example `claude-code`. */
  readonly name: string;
  /** The adapter API version the adapter was built against. */
  readonly adapterApiVersion: number;
}

const NAME = /^[a-z][a-z0-9-]{0,63}$/u;

/**
 * Registers an adapter definition: checks it and returns it frozen.
 *
 * @throws {@link InvalidOptionsError} when the name is not a lower-case
 * identifier (`^[a-z][a-z0-9-]{0,63}$`)
 * @throws {@link AdapterApiVersionError} when `adapterApiVersion` is not the
 * one this core implements
 * @beta
 */
export function defineAdapter<T extends AdapterDefinition>(def: T): T {
  const name: unknown = def.name;
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new InvalidOptionsError('An adapter name must be a lower-case identifier.', {
      details: { path: 'name', rule: 'adapter-name' },
    });
  }
  const version: unknown = def.adapterApiVersion;
  if (version !== adapterApiVersion) {
    throw new AdapterApiVersionError(
      `Adapter ${name} was built for adapter API ${String(version)}; this core implements ${String(adapterApiVersion)}.`,
      {
        details: {
          adapter: name,
          supported: [adapterApiVersion],
          ...(typeof version === 'number' && Number.isFinite(version)
            ? { requested: version }
            : {}),
        },
      },
    );
  }
  return Object.freeze({ ...def });
}
