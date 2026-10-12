/**
 * Redaction of diagnostic text and JSON (ADR-0016 §1, ADR-0012 §4).
 *
 * @remarks
 * Redaction is mandatory and cannot be disabled per call. Every masked value
 * is replaced by {@link REDACTED}. The rules run in this order on every call:
 *
 * 1. Known secrets (literal values): each value passed in `secrets` (usually
 *    {@link secretsFromEnv} of the child environment) is masked wherever it
 *    occurs, overlapping occurrences included. A multi-line value is also
 *    masked line by line, so it is caught when it is printed across lines
 *    or arrives line by line ({@link StderrTail}).
 * 2. Sensitive header and field lines: `name: value` where `name` is a
 *    sensitive field name ({@link isSensitiveFieldName}, which covers
 *    `authorization`, `proxy-authorization`, `x-api-key`, `cookie`,
 *    `set-cookie` and any name ending in a credential word such as `token`,
 *    `secret`, `password` or `key`): the value is masked up to the end of
 *    the line.
 * 3. `Bearer` and `Basic` credentials (scheme names in any case): the token
 *    after the scheme is masked.
 * 4. Anthropic keys: every `sk-ant-` token is masked as a whole.
 * 5. URL userinfo: `scheme://user:password@host` becomes
 *    `scheme://<redacted>@host` (up to the last `@` before the host).
 * 6. Sensitive assignments: `name=value`, `name: "value"`, `"name": "value"`
 *    and the backslash-escaped JSON form `\"name\":\"value\"`, for sensitive
 *    names. Quoted values are masked up to the closing quote or the end of
 *    the line; unquoted values up to whitespace or one of `" ' & , ; < > { } [ ]`.
 *
 * What is NOT redacted (documented limits):
 *
 * - Secrets with no recognizable shape that are neither passed in `secrets`
 *   nor written after a sensitive name: for example a provider key of an
 *   unknown format printed on its own, or a password in free prose.
 * - Values of environment variables whose names are not accepted by
 *   {@link isCredentialEnvName}, unless their shape matches a rule above.
 * - Whitespace-only secret values (masking them would erase all spacing);
 *   such values carry no usable secret.
 * - Unquoted `name=value` values that contain whitespace: only the part up to
 *   the first whitespace is masked (rule 6). Literal secrets are unaffected.
 * - JSON escaped more than once (`\\\"token\\\"`): only the literal and
 *   shape rules apply to it.
 * - URL userinfo containing an unencoded `/`, `?` or `#` (invalid per
 *   RFC 3986): masked only up to that character.
 * - Booleans and `null` in {@link redactJson}; numbers are masked when their
 *   decimal form contains a known secret.
 *
 * Over-redaction is accepted where a rule cannot tell secrets from ordinary
 * text (for example `Invalid token: expired` loses `expired`). Environment
 * variables are reported by name only, never by value
 * ({@link credentialEnvNames}).
 *
 * The functions are pure: no clock, no randomness, no I/O.
 *
 * @packageDocumentation
 */

/**
 * The marker that replaces every masked value.
 *
 * @public
 */
export const REDACTED = '<redacted>';

/**
 * Names of environment variables whose values are treated as secrets
 * (plan §1.10). Deliberately broad: it errs on the side of masking.
 */
const CREDENTIAL_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;

/**
 * Whether `name` is the name of an environment variable whose value hudhud
 * treats as a secret: it contains `KEY`, `TOKEN`, `SECRET`, `PASSWORD`,
 * `CREDENTIAL` or `AUTH` in any case (plan §1.10). Deliberately broad.
 *
 * @public
 */
export function isCredentialEnvName(name: string): boolean {
  return CREDENTIAL_ENV_NAME.test(name);
}

/** An environment map as passed to a child process. */
export type EnvMap = Readonly<Record<string, string | undefined>>;

/**
 * The values of every credential variable of `env` (non-empty, not
 * whitespace-only), for use as the `secrets` of {@link redactText}.
 *
 * @remarks
 * The returned values are secrets themselves: keep them in memory only and
 * never log them. Report variables by name with {@link credentialEnvNames}.
 *
 * @public
 */
export function secretsFromEnv(env: EnvMap): readonly string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && isCredentialEnvName(name) && value.trim() !== '') {
      values.add(value);
    }
  }
  return [...values];
}

/**
 * The sorted names (never values) of the credential variables of `env`, for
 * diagnostics (ADR-0012 §4).
 *
 * @public
 */
export function credentialEnvNames(env: EnvMap): readonly string[] {
  return Object.keys(env)
    .filter((name) => env[name] !== undefined && isCredentialEnvName(name))
    .sort();
}

/**
 * Last words of field names that mark the field as sensitive. Only the last
 * word counts, so `inputTokens` and `apiKeySource` stay readable while
 * `apiKey`, `x-api-key` and `ANTHROPIC_AUTH_TOKEN` are masked.
 */
const SENSITIVE_WORDS: ReadonlySet<string> = new Set([
  'key',
  'apikey',
  'privatekey',
  'token',
  'accesstoken',
  'authtoken',
  'refreshtoken',
  'idtoken',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'pwd',
  'credential',
  'credentials',
  'auth',
  'oauth',
  'authorization',
  'cookie',
  'bearer',
]);

const WORD = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g;

/**
 * Whether a field, header or variable name marks its value as sensitive:
 * its last alphabetic word (camelCase, snake_case, kebab-case and dotted
 * names are split) is a credential word such as `key`, `token`, `secret`,
 * `password`, `credential(s)`, `auth`, `authorization` or `cookie`.
 *
 * @public
 */
export function isSensitiveFieldName(name: string): boolean {
  const words = name.match(WORD);
  const last = words?.at(-1);
  return last !== undefined && SENSITIVE_WORDS.has(last.toLowerCase());
}

/**
 * Normalizes secret values: drops empty and whitespace-only values and adds
 * each non-blank line of a multi-line value. Longest first.
 */
function normalizeSecrets(secrets: readonly string[]): string[] {
  const out = new Set<string>();
  for (const secret of secrets) {
    if (secret.trim() === '') continue;
    out.add(secret);
    for (const piece of secret.split(/\r\n|\r|\n/)) {
      if (piece.trim() !== '') out.add(piece);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

type Interval = readonly [start: number, end: number];

/** Replaces each union of overlapping or adjacent intervals by one marker. */
function maskIntervals(text: string, intervals: Interval[]): string {
  if (intervals.length === 0) return text;
  intervals.sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = 0;
  let close = -1;
  for (const [start, end] of intervals) {
    if (start > close) {
      if (close !== -1) out += REDACTED;
      out += text.slice(cursor, start);
    }
    if (end > close) {
      close = end;
      cursor = end;
    }
  }
  return out + REDACTED + text.slice(cursor);
}

/** Rule 1: every occurrence (overlapping included) of every literal secret. */
function maskLiterals(text: string, secrets: readonly string[]): string {
  const intervals: Interval[] = [];
  for (const secret of secrets) {
    let at = text.indexOf(secret);
    while (at !== -1) {
      intervals.push([at, at + secret.length]);
      at = text.indexOf(secret, at + 1);
    }
  }
  return maskIntervals(text, intervals);
}

const NAME_COLON = /(?<![A-Za-z0-9_.-])([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*:[ \t]*/g;

/** Rule 2: `sensitive-name: value` masks the rest of the line. */
function maskHeaderLines(text: string): string {
  return text
    .split(/(\r\n|\r|\n)/)
    .map((line) => {
      for (const match of line.matchAll(NAME_COLON)) {
        const valueAt = match.index + match[0].length;
        const next = line.charAt(valueAt);
        if (isSensitiveFieldName(String(match[1])) && next !== '' && next !== '"' && next !== "'") {
          return line.slice(0, valueAt) + REDACTED;
        }
      }
      return line;
    })
    .join('');
}

const AUTH_SCHEME = /\b(Bearer|Basic)([ \t]+)[^\s"'\\<>]+/gi;
const ANTHROPIC_KEY = /sk-ant-[^\s"'\\<>]+/g;
const URL_USERINFO = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s"'<>\\/?#]*@/g;

/**
 * A (possibly quoted, possibly backslash-escaped) name and its separator.
 * Only the name and separator are consumed, so names inside values are
 * found too.
 */
const NAME_SEPARATOR = /(?<![A-Za-z0-9_.-])(\\?["']|)([A-Za-z_][A-Za-z0-9_.-]*)\1[ \t]*[:=][ \t]*/g;

/** The value after a separator (sticky): escaped-quoted, quoted or bare. */
const VALUE =
  /\\"(?:(?!\\")[^\r\n])*(?:\\"|$)|"(?:[^"\\\r\n]|\\.)*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s"'&,;<>{}[\]]+/my;

/** The part of a matched value inside its quotes (an open quote runs to the end). */
function innerValue(value: string, at: number): Interval {
  for (const quote of ['\\"', '"', "'"]) {
    if (value.startsWith(quote)) {
      const closed = value.length >= 2 * quote.length && value.endsWith(quote);
      return [at + quote.length, at + value.length - (closed ? quote.length : 0)];
    }
  }
  return [at, at + value.length];
}

/** Rule 6: values of sensitive names in assignments. */
function maskAssignments(text: string): string {
  const intervals: Interval[] = [];
  for (const match of text.matchAll(NAME_SEPARATOR)) {
    if (!isSensitiveFieldName(String(match[2]))) continue;
    const at = match.index + match[0].length;
    VALUE.lastIndex = at;
    const value = VALUE.exec(text)?.[0];
    if (value === undefined) continue;
    const inner = innerValue(value, at);
    if (inner[1] > inner[0]) intervals.push(inner);
  }
  return maskIntervals(text, intervals);
}

/**
 * Applies every redaction rule to `text` with already normalized secrets.
 *
 * @internal
 */
export function redactNormalized(text: string, secrets: readonly string[]): string {
  let out = maskLiterals(text, secrets);
  out = maskHeaderLines(out);
  out = out.replace(AUTH_SCHEME, `$1$2${REDACTED}`);
  out = out.replace(ANTHROPIC_KEY, REDACTED);
  out = out.replace(URL_USERINFO, `$1${REDACTED}@`);
  return maskAssignments(out);
}

/**
 * Prepared secret values for repeated redaction (see {@link redactNormalized}).
 *
 * @internal
 */
export function prepareSecrets(secrets: readonly string[]): readonly string[] {
  return normalizeSecrets(secrets);
}

/**
 * Masks secrets in diagnostic text.
 *
 * @param text - any text, typically stderr or an error message
 * @param secrets - known secret values, typically {@link secretsFromEnv}
 * @returns `text` with every rule of this module applied
 *
 * @public
 */
export function redactText(text: string, secrets: readonly string[]): string {
  return redactNormalized(text, normalizeSecrets(secrets));
}

/**
 * A JSON value accepted by {@link redactJson}.
 *
 * @public
 */
export type RedactableJson =
  | null
  | boolean
  | number
  | string
  | readonly RedactableJson[]
  | { readonly [key: string]: RedactableJson };

/**
 * Policy of {@link redactJson}.
 *
 * @public
 */
export interface RedactionPolicy {
  /** Known secret values, typically {@link secretsFromEnv}. */
  readonly secrets: readonly string[];
  /**
   * Nesting depth beyond which a subtree is replaced by {@link REDACTED}
   * (fail closed; also bounds work on cyclic input). Default 64.
   */
  readonly maxDepth?: number;
}

/**
 * Masks secrets in a JSON value and returns a new value.
 *
 * @remarks
 * Strings and object keys go through {@link redactText}. The value of every
 * key accepted by {@link isSensitiveFieldName} is replaced as a whole,
 * whatever its type. Numbers whose decimal form contains a known secret are
 * replaced. Keys that collide after redaction keep the last value. Values
 * that are not JSON (for example `undefined`) are replaced. Keys are copied
 * as own data properties, so `__proto__` stays inert.
 *
 * @public
 */
export function redactJson(value: RedactableJson, policy: RedactionPolicy): RedactableJson {
  const secrets = normalizeSecrets(policy.secrets);
  const maxDepth = policy.maxDepth ?? 64;
  const visit = (node: RedactableJson, depth: number): RedactableJson => {
    switch (typeof node) {
      case 'string':
        return redactNormalized(node, secrets);
      case 'number': {
        const text = String(node);
        return redactNormalized(text, secrets) === text ? node : REDACTED;
      }
      case 'boolean':
        return node;
      case 'object': {
        if (node === null) return null;
        if (depth >= maxDepth) return REDACTED;
        if (Array.isArray(node)) {
          return node.map((item: RedactableJson) => visit(item, depth + 1));
        }
        return Object.fromEntries(
          Object.entries(node).map(([key, item]) => [
            redactNormalized(key, secrets),
            isSensitiveFieldName(key) ? REDACTED : visit(item, depth + 1),
          ]),
        );
      }
      case 'bigint':
      case 'function':
      case 'symbol':
      case 'undefined':
        return REDACTED;
    }
  };
  return visit(value, 0);
}

/**
 * Masks a possibly cut fragment at the end of already redacted text: the
 * trailing token (everything after the last whitespace) and the longest
 * trailing prefix of any single-line secret. Used where a line was cut before
 * its end, so a secret may be only partly present.
 *
 * @internal
 */
export function maskCutEnd(redacted: string, secrets: readonly string[]): string {
  let cut = redacted.length;
  const lastSpace = redacted.search(/\S*$/);
  if (lastSpace < cut) cut = lastSpace;
  for (const secret of secrets) {
    if (/[\r\n]/.test(secret)) continue;
    for (let length = Math.min(secret.length, redacted.length); length > 0; length -= 1) {
      if (redacted.endsWith(secret.slice(0, length))) {
        cut = Math.min(cut, redacted.length - length);
        break;
      }
    }
  }
  return cut < redacted.length ? redacted.slice(0, cut) + REDACTED : redacted;
}
