import type { ProcessIdentity } from '../tree/types.js';
import type { LadderIdentity } from './types.js';

/**
 * What a ladder learns when it awaits the spawned process's identity: the
 * process exited first, or the verified identity (`null` when there is none).
 */
export type AwaitedIdentity =
  { readonly exited: true } | { readonly exited: false; readonly identity: ProcessIdentity | null };

/**
 * Awaits `identity`, or the exit of the process, whichever comes first.
 * A rejected read and an identity of another pid count as no identity.
 * Never rejects.
 *
 * @remarks
 * Not bounded by the ladder clock: the read was started at the spawn and is
 * bounded by its own source (`/proc` is immediate; `ps` and the CIM query
 * time out after 30 s and 60 s), so by the time a ladder needs it, it has
 * normally long settled.
 */
export function awaitIdentity(
  pid: number,
  identity: LadderIdentity,
  exited: Promise<unknown>,
): Promise<AwaitedIdentity> {
  const read = Promise.resolve(identity).then(
    (value): AwaitedIdentity => ({
      exited: false,
      identity: value !== null && value.pid === pid ? value : null,
    }),
    (): AwaitedIdentity => ({ exited: false, identity: null }),
  );
  const exit = exited.then(
    (): AwaitedIdentity => ({ exited: true }),
    (): AwaitedIdentity => ({ exited: true }),
  );
  return Promise.race([read, exit]);
}
