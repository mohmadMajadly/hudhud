/**
 * Endpoint allowlist of the mock Messages API (ADR-0013 §5).
 *
 * @remarks
 * With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` the pinned CLI sends only
 * `POST /v1/messages?beta=true` (05 §2). That single entry is the default;
 * a test may add exact extras. Every request outside the list is an egress
 * violation that fails the test. Matching is exact on the method and on the
 * whole origin-form request target (path and query), so `/v1/messages`
 * without the query, or with another query, is not covered by the default.
 */

/** One allowed request: exact method and exact origin-form target. */
export interface AllowlistEntry {
  /** Upper-case HTTP method, for example `POST`. */
  readonly method: string;
  /** Origin-form request target including the query, for example `/v1/messages?beta=true`. */
  readonly target: string;
}

/** The only endpoint the pinned CLI uses under the nonessential-traffic switch (05 §2). */
export const DEFAULT_ALLOWLIST: readonly AllowlistEntry[] = Object.freeze([
  Object.freeze({ method: 'POST', target: '/v1/messages?beta=true' }),
]);

/** An immutable allowlist. */
export interface Allowlist {
  /** The entries, defaults first. */
  readonly entries: readonly AllowlistEntry[];
  /** Whether `method` on the origin-form `target` is allowed. */
  allows(method: string, target: string): boolean;
}

/**
 * Builds the allowlist of one mock server: the defaults plus `extras`.
 *
 * @throws TypeError when an extra entry is not an upper-case method with an
 * origin-form target (a leading `/`), which would never match a request.
 */
export function createAllowlist(extras: readonly AllowlistEntry[] = []): Allowlist {
  for (const entry of extras) {
    if (!/^[A-Z]+$/.test(entry.method)) {
      throw new TypeError(`allowlist method must be upper-case letters: ${entry.method}`);
    }
    if (!entry.target.startsWith('/')) {
      throw new TypeError(`allowlist target must be origin-form (start with "/"): ${entry.target}`);
    }
  }
  const entries = Object.freeze([
    ...DEFAULT_ALLOWLIST,
    ...extras.map((entry) => Object.freeze({ method: entry.method, target: entry.target })),
  ]);
  return {
    entries,
    allows: (method, target) =>
      entries.some((entry) => entry.method === method && entry.target === target),
  };
}
