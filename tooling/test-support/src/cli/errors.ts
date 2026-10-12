/**
 * Failure classes of the pinned-CLI fetch (plan §4.6). Every failure is
 * fatal: the fetch fails closed and never falls back to an unverified file.
 */
export type CliFetchErrorCode =
  /** `tooling/cli-pin.json` (or a run-local pin) is malformed. */
  | 'pin-invalid'
  /** The requested platform has no pin entry or is still pending its gate. */
  | 'platform-unavailable'
  /** A URL outside the registry allowlist (host, scheme, port, userinfo). */
  | 'host-refused'
  /** The registry answered with an error, an unexpected document or too much data. */
  | 'registry'
  /** The tarball's sha512 differs from the expected integrity. */
  | 'integrity-mismatch'
  /** The archive is malformed, truncated or contains a refused entry. */
  | 'archive-refused'
  /** The extracted binary's sha256 or size differs from the expected value. */
  | 'binary-mismatch'
  /** The cached copy is missing, altered or not trustworthy. */
  | 'cache-invalid'
  /** The independent cross-check source (the Agent SDK manifest) is malformed or inconsistent. */
  | 'cross-check-failed';

/** Error raised by every step of the pinned-CLI fetch. */
export class CliFetchError extends Error {
  /** Machine-readable failure class. */
  readonly code: CliFetchErrorCode;

  constructor(code: CliFetchErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CliFetchError';
    this.code = code;
  }
}
