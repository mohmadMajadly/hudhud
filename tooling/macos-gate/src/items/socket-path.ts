/**
 * Gate item 5, socket path (ADR-0014; ADR-0010 "Sockets", research 05 §13).
 *
 * `$TMPDIR` on macOS is `/var/folders/.../T/`. The CLI's messaging socket is
 * `${TMPDIR}/cc-socks/<pid>.sock` unless that exceeds the `sun_path` limit
 * (104 bytes on macOS, including the NUL), then a fallback under `/tmp`.
 *
 * - hudhud's isolated temp dir (a fresh root under the runner's `TMPDIR`):
 *   the reported path is shorter than 104 bytes, lies inside the isolated
 *   TMPDIR, and is a socket while the CLI runs.
 * - An over-long TMPDIR: the reported path is still shorter than 104 bytes,
 *   lies outside that TMPDIR (the fallback), and the turn completes.
 */

import type { ItemRecorder } from '../report.js';
import { mockMarker } from '../sandbox.js';
import { runScenario, type SessionContext } from '../session.js';
import { initField, isSuccess, sessionEvidence, TURN_MS } from './common.js';

/** `sun_path` of macOS: 104 bytes including the terminating NUL. */
export const SUN_PATH_BYTES = 104;
/** A TMPDIR name long enough to push `<tmp>/cc-socks/<pid>.sock` past the limit. */
export const LONG_TMP_NAME = `long-tmpdir-${'x'.repeat(84)}`;

/** True when a socket path fits `sun_path`. */
export function fitsSunPath(socketPath: string): boolean {
  return Buffer.byteLength(socketPath, 'utf8') < SUN_PATH_BYTES;
}

/** True when `child` lies strictly inside `dir` (as given or as its realpath). */
export function isInside(child: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => child.startsWith(`${dir.replace(/\/+$/, '')}/`));
}

/** Runs item 5. */
export async function socketPathItem(context: SessionContext, r: ItemRecorder): Promise<void> {
  const { host } = context;

  const short = await runScenario(context, {}, async ({ session, sandbox }) => {
    session.initialize();
    session.user(`${mockMarker('text')} gate item 5`);
    await session.waitKind('system/init', TURN_MS);
    const socket = initField(session, 'messaging_socket_path');
    const kind = socket === undefined ? null : await host.fs.kind(socket);
    const result = await session.waitKind('result', TURN_MS);
    const tmpDirs = [sandbox.tmp, await host.fs.realpath(sandbox.tmp)];
    r.note('isolated', {
      tmpdir: tmpDirs,
      socket,
      bytes: socket === undefined ? 0 : Buffer.byteLength(socket),
      kind,
      session: sessionEvidence(session),
    });
    r.check(
      'isolated TMPDIR: system/init reports messaging_socket_path',
      socket !== undefined,
      String(socket),
    );
    if (socket === undefined) return;
    r.check(
      'isolated TMPDIR: the socket path fits sun_path (< 104 bytes)',
      fitsSunPath(socket),
      `${String(Buffer.byteLength(socket))} bytes`,
    );
    r.check(
      'isolated TMPDIR: the socket lies inside the isolated TMPDIR',
      isInside(socket, tmpDirs),
      socket,
    );
    r.check(
      'isolated TMPDIR: the path is a socket while the CLI runs',
      kind === 'socket',
      String(kind),
    );
    r.check('isolated TMPDIR: the turn completes', isSuccess(result), 'result/success');
    return socket;
  });
  r.note(
    'isolatedSocketAfterExit',
    short.value === undefined ? null : await host.fs.kind(short.value),
  );

  const long = await runScenario(
    context,
    { tmpName: LONG_TMP_NAME },
    async ({ session, sandbox }) => {
      session.initialize();
      session.user(`${mockMarker('text')} gate item 5 fallback`);
      const result = await session.waitKind('result', TURN_MS);
      const socket = initField(session, 'messaging_socket_path');
      const tmpDirs = [sandbox.tmp, await host.fs.realpath(sandbox.tmp)];
      r.note('fallback', { tmpdir: tmpDirs, socket, session: sessionEvidence(session) });
      r.check(
        'long TMPDIR: system/init reports messaging_socket_path',
        socket !== undefined,
        String(socket),
      );
      if (socket === undefined) return;
      r.check(
        'long TMPDIR: the fallback socket path fits sun_path (< 104 bytes)',
        fitsSunPath(socket),
        `${String(Buffer.byteLength(socket))} bytes`,
      );
      r.check(
        'long TMPDIR: the socket falls back outside the over-long TMPDIR',
        !isInside(socket, tmpDirs),
        socket,
      );
      r.check('long TMPDIR: the turn completes', isSuccess(result), 'result/success');
      return socket;
    },
  );
  r.note(
    'fallbackSocketAfterExit',
    long.value === undefined ? null : await host.fs.kind(long.value),
  );
  r.check(
    'no egress violation',
    short.violations + long.violations === 0,
    `${String(short.violations)} + ${String(long.violations)}`,
  );
  r.check(
    'nothing survives either run',
    short.shutdown.sweep.survivors.length + long.shutdown.sweep.survivors.length === 0,
    [...short.shutdown.sweep.survivors, ...long.shutdown.sweep.survivors].join(', '),
  );
}
