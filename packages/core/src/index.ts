/**
 * Sans-IO protocol and session core of hudhud.
 *
 * @remarks
 * Pre-alpha foundation: only version constants are exported. The design is
 * described in docs/architecture.md and the ADRs under docs/adr/.
 *
 * @packageDocumentation
 */

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
