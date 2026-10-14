/**
 * hudhud umbrella package.
 *
 * @remarks
 * Re-exports only; this package must never contain logic (ADR-0004, E4). The
 * unstable `@hudhud/claude-code/raw` tier and the adapter-author entry points
 * of `@hudhud/core` are deliberately not re-exported here.
 *
 * @packageDocumentation
 */

export * from '@hudhud/core';
export * from '@hudhud/claude-code';
