import { describe, expect, it } from 'vitest';

import { awaitIdentity } from '../../../src/process/ladder/identity.js';

const SPAWNED = { pid: 500, startTime: '1000' };
const pending = new Promise<never>(() => undefined);

describe('awaitIdentity', () => {
  it('yields the identity of the spawned pid, or none for another pid, null or a failed read', async () => {
    await expect(awaitIdentity(500, Promise.resolve(SPAWNED), pending)).resolves.toEqual({
      exited: false,
      identity: SPAWNED,
    });
    for (const read of [
      Promise.resolve({ ...SPAWNED, pid: 501 }),
      Promise.resolve(null),
      Promise.reject(new Error('read failed')),
    ]) {
      await expect(awaitIdentity(500, read, pending)).resolves.toEqual({
        exited: false,
        identity: null,
      });
    }
  });

  it('yields the exit when it comes first, however the exit promise settles', async () => {
    await expect(awaitIdentity(500, pending, Promise.resolve())).resolves.toEqual({ exited: true });
    await expect(
      awaitIdentity(500, pending, Promise.reject(new Error('exit observer failed'))),
    ).resolves.toEqual({ exited: true });
  });
});
