/**
 * Egress trap of the mock (ADR-0013 §2, §16; plan §4.5; J12).
 *
 * @remarks
 * The CLI under test runs with the mock as `HTTPS_PROXY` and `HTTP_PROXY`
 * (both cases) and `NO_PROXY=127.0.0.1`. Whatever it tries to reach outside
 * the mock arrives here as a `CONNECT` or as an absolute-URI proxy request.
 * The trap records the attempt (method and host, never credentials, headers
 * or bodies) and refuses it with 403. It never opens a connection anywhere:
 * this module imports no networking API at all.
 *
 * Every recorded attempt, and every request to a path outside the allowlist,
 * is a violation; {@link EgressTrap.assertNoViolations} fails the test.
 */

/** What kind of traffic broke the rules. */
export type EgressViolationKind =
  /** `CONNECT host:port`: a tunnel to a non-mock host (05 §2 run 89). */
  | 'connect'
  /** An absolute-URI (proxy-form) request such as `GET http://host/path`. */
  | 'absolute-uri'
  /** An origin-form request outside the allowlist (ADR-0013 §5). */
  | 'path'
  /** A `Host` header that is not the mock's own loopback address. */
  | 'host'
  /** An HTTP `Upgrade` request (WebSocket and similar). */
  | 'upgrade'
  /** A request body over the mock's byte limit. */
  | 'body-too-large'
  /** Bytes the HTTP parser rejected. */
  | 'malformed-request';

/** One recorded violation. Strings are sanitized and bounded; no credentials. */
export interface EgressViolation {
  /** 1-based order of recording since the last {@link EgressTrap.clear}. */
  readonly seq: number;
  readonly kind: EgressViolationKind;
  /** Request method (`CONNECT`, `GET`, ...), or `-` when unknown. */
  readonly method: string;
  /**
   * `host:port` for `connect`, `scheme://host[:port]` for `absolute-uri`,
   * the `Host` header for `host`, the path with redacted query values
   * otherwise.
   */
  readonly target: string;
  /** Extra context, for example the byte limit or the parser error code. */
  readonly detail?: string;
}

/** Thrown by {@link EgressTrap.assertNoViolations}. */
export class EgressViolationError extends Error {
  override readonly name = 'EgressViolationError';
  /** The recorded violations (bounded, see {@link MAX_RECORDED_VIOLATIONS}). */
  readonly violations: readonly EgressViolation[];
  /** All violations, including those not kept because of the bound. */
  readonly total: number;

  constructor(violations: readonly EgressViolation[], total: number) {
    const lines = violations.map(formatViolation);
    const dropped = total - violations.length;
    if (dropped > 0) lines.push(`... and ${String(dropped)} more`);
    super(`mock egress trap: ${String(total)} violation(s)\n${lines.join('\n')}`);
    this.violations = violations;
    this.total = total;
  }
}

/** Upper bound of violations kept in memory; later ones are only counted. */
export const MAX_RECORDED_VIOLATIONS = 1000;

/** Upper bound of the length of a recorded string. */
export const MAX_RECORDED_LENGTH = 256;

/** The response that refuses every `CONNECT` tunnel. */
export const CONNECT_REFUSAL =
  'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';

/** The part of a hijacked `CONNECT` socket the trap uses. */
export interface TrapSocket {
  on(event: 'error', listener: (error: Error) => void): unknown;
  end(data: string): unknown;
}

/** Records violations of one mock server. */
export class EgressTrap {
  #recorded: EgressViolation[] = [];
  #total = 0;

  /** Records one violation and returns it. */
  record(violation: Omit<EgressViolation, 'seq'>): EgressViolation {
    this.#total += 1;
    const entry: EgressViolation = Object.freeze({ seq: this.#total, ...violation });
    if (this.#recorded.length < MAX_RECORDED_VIOLATIONS) this.#recorded.push(entry);
    return entry;
  }

  /** A copy of the recorded violations, oldest first. */
  get violations(): readonly EgressViolation[] {
    return [...this.#recorded];
  }

  /** Number of violations since the last {@link EgressTrap.clear}, including unrecorded ones. */
  get total(): number {
    return this.#total;
  }

  /** Forgets every violation. */
  clear(): void {
    this.#recorded = [];
    this.#total = 0;
  }

  /**
   * Fails the test when anything was recorded.
   *
   * @throws EgressViolationError listing each violation.
   */
  assertNoViolations(): void {
    if (this.#total > 0) throw new EgressViolationError(this.violations, this.#total);
  }

  /**
   * Handles a `CONNECT` request: records `host:port` and refuses with 403.
   *
   * @remarks
   * J12: the `error` listener is attached before anything is written. A
   * client that resets the tunnel during the refusal makes the write fail
   * with `ECONNRESET` or `EPIPE`; without the listener that error is thrown
   * from the socket and takes the whole test process down (07 §0.2).
   */
  handleConnect(url: string | undefined, socket: TrapSocket): void {
    socket.on('error', ignoreSocketError);
    this.record({ kind: 'connect', method: 'CONNECT', target: connectTarget(url ?? '') });
    socket.end(CONNECT_REFUSAL);
  }
}

/** Error listener of trap-owned sockets: the peer may reset at any time. */
export function ignoreSocketError(): void {
  // Intentionally empty: a reset refused tunnel is not a failure of the mock.
}

/** Formats a violation as one line. */
export function formatViolation(violation: EgressViolation): string {
  const detail = violation.detail === undefined ? '' : ` (${violation.detail})`;
  return `#${String(violation.seq)} ${violation.kind}: ${violation.method} ${violation.target}${detail}`;
}

/**
 * Replaces control characters and bounds the length, so a hostile target
 * cannot forge log lines or grow memory.
 */
export function sanitize(text: string, max: number = MAX_RECORDED_LENGTH): string {
  // \p{Cc}: the C0 controls, DEL and the C1 controls.
  const clean = text.replace(/\p{Cc}/gu, '?');
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

/** `host:port` of an authority-form `CONNECT` target, without any userinfo. */
export function connectTarget(url: string): string {
  const at = url.lastIndexOf('@');
  const authority = at === -1 ? url : url.slice(at + 1);
  return authority === '' ? '<empty>' : sanitize(authority);
}

/**
 * `scheme://host[:port]` of an absolute-URI request target, without
 * userinfo, path or query; `undefined` when `target` is not an absolute URI.
 */
export function absoluteTarget(target: string): string | undefined {
  if (target.startsWith('/') || !/^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return undefined;
  }
  return sanitize(`${parsed.protocol}//${parsed.host}`);
}

/** An origin-form target with every query value replaced by `<redacted>`. */
export function redactTarget(target: string): string {
  const question = target.indexOf('?');
  if (question === -1) return sanitize(target);
  const path = target.slice(0, question);
  const names = [...new URLSearchParams(target.slice(question + 1)).keys()];
  const query = names.map((name) => `${name}=<redacted>`).join('&');
  return sanitize(`${path}?${query}`);
}
