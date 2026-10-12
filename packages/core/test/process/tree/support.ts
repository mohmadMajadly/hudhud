import { readdirSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import type fc from 'fast-check';

import type { LinuxProcTableCalls } from '../../../src/process/os/types.js';

/** Directory of the process-table fixtures (see its manifest.json). */
export const FIXTURES = fileURLToPath(new URL('../../fixtures/process/', import.meta.url));

export function fixture(relative: string): Uint8Array {
  return new Uint8Array(readFileSync(`${FIXTURES}${relative}`));
}

/** fast-check parameters: `FC_SEED` reproduces a run (plan §4.1); failures print the seed. */
export function fcParams<T>(numRuns = 500): fc.Parameters<T> {
  const seed = process.env['FC_SEED'];
  return seed === undefined ? { numRuns } : { numRuns, seed: Number(seed) };
}

const utf8 = new TextDecoder('utf-8', { fatal: false });

/** Node's WHATWG decoder, the reference for the hand-written one. */
export function referenceDecode(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

export function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

/** A read-only fake of `/proc` over the recorded fixture directory. */
export function fixtureProcTable(): LinuxProcTableCalls {
  const root = `${FIXTURES}linux/proc/`;
  return {
    source: 'linux-proc',
    listPids: () => Promise.resolve(readdirSync(root).map(Number)),
    readStat: (pid) => Promise.resolve(fixture(`linux/proc/${String(pid)}/stat`)),
  };
}
