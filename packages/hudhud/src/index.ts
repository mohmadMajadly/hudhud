/**
 * hudhud umbrella package.
 *
 * @remarks
 * Re-exports only; this package must never contain logic (ADR-0004, E4).
 * `@hudhud/claude-code` is re-exported here as soon as it has a public export;
 * the smoke test fails until then if it gains one and this file is not updated.
 *
 * @packageDocumentation
 */

export * from '@hudhud/core';
