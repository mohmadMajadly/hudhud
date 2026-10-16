/**
 * hudhud umbrella package.
 *
 * @remarks
 * Re-exports only; this package must never contain logic (ADR-0004, E4). The
 * unstable `@hudhudjs/claude-code/raw` tier and the adapter-author entry points
 * of `@hudhudjs/core` are deliberately not re-exported here.
 *
 * @packageDocumentation
 */

export * from '@hudhudjs/core';
export * from '@hudhudjs/claude-code';
