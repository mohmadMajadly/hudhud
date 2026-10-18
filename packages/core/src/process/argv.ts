/**
 * Argv construction primitives (ADR-0011 §3, plan §1.7, §2.6, L4).
 *
 * @remarks
 * Guarantees:
 *
 * - {@link formatFlag} returns exactly one argv element, `--name` or
 *   `--name=value`. A value is never a separate element, so a value that
 *   starts with `-`, contains `=`, commas, spaces, quotes or newlines is never
 *   parsed as a flag of its own (the SDK argv-injection class, 02 §2.4).
 * - No quoting or escaping is ever applied: argv elements go to `spawn` with
 *   `shell: false`, which hands them to the OS as a vector on POSIX and, on
 *   win32, quotes them by the MSVC `CommandLineToArgvW` rules that a native
 *   `.exe` parses back verbatim. Batch files, which `cmd.exe` parses by other
 *   rules (BatBadBut), are refused by `binary-path`.
 * - NUL (which every OS truncates or rejects) and ill-formed UTF-16 (lone
 *   surrogates, which become U+FFFD on the way to the child) are refused, so
 *   the child receives exactly the string that was validated.
 * - {@link assertNoReservedFlags} refuses passthrough argv (the `/raw` tier)
 *   that names a flag the caller reserves, in any spelling a common parser
 *   accepts; see its remarks.
 *
 * The rules of what a harness must or must not receive (rule-string
 * tokenizers, reserved flag lists) belong to the adapter; these functions are
 * harness-neutral.
 *
 * @packageDocumentation
 */

/**
 * Why argv input was refused.
 *
 * @beta
 */
export type ArgvProblem =
  'invalid-name' | 'nul' | 'ill-formed' | 'reserved-flag' | 'end-of-options' | 'not-a-string';

/**
 * Thrown by the argv primitives. The adapter maps it to the public
 * `InvalidOptionsError` (plan §3.1, §2.6).
 *
 * @beta
 */
export class ArgvError extends Error {
  override readonly name = 'ArgvError';
  readonly code = 'INVALID_OPTIONS';
  readonly reason: ArgvProblem;
  /** Index of the offending element, for argv lists. */
  readonly index: number | undefined;
  /** The reserved flag that matched, for `reserved-flag`. */
  readonly flag: string | undefined;

  constructor(
    reason: ArgvProblem,
    message: string,
    where: { readonly index?: number; readonly flag?: string } = {},
  ) {
    super(message);
    this.reason = reason;
    this.index = where.index;
    this.flag = where.flag;
  }
}

const FLAG_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Whether `name` fits the flag name grammar of {@link formatFlag}: lower-case
 * kebab case, `^[a-z][a-z0-9-]*$`.
 *
 * @beta
 */
export function isFlagName(name: string): boolean {
  return FLAG_NAME.test(name);
}

function stringProblem(value: string): 'nul' | 'ill-formed' | undefined {
  if (value.includes('\0')) return 'nul';
  if (!value.isWellFormed()) return 'ill-formed';
  return undefined;
}

/**
 * Formats one flag as a single argv element: `--name` without a value,
 * `--name=value` with one (an empty value gives `--name=`).
 *
 * @param name - satisfies {@link isFlagName}
 * @param value - any string without NUL and without lone surrogates; kept verbatim
 * @throws {@link ArgvError} `invalid-name`, `nul` or `ill-formed`
 * @beta
 */
export function formatFlag(name: string, value?: string): string {
  if (!isFlagName(name)) {
    throw new ArgvError('invalid-name', `flag name ${JSON.stringify(name)} is not kebab case`);
  }
  if (value === undefined) return `--${name}`;
  const problem = stringProblem(value);
  if (problem !== undefined) {
    throw new ArgvError(problem, `value of --${name} contains ${problemText(problem)}`);
  }
  return `--${name}=${value}`;
}

function problemText(problem: 'nul' | 'ill-formed'): string {
  return problem === 'nul' ? 'a NUL character' : 'a lone UTF-16 surrogate';
}

/**
 * Splits a `--name` or `--name=value` element at the first `=`; the inverse
 * of {@link formatFlag}.
 *
 * @returns `undefined` when the element is not a well-formed long flag
 * @beta
 */
export function parseFlag(
  element: string,
): { readonly name: string; readonly value: string | undefined } | undefined {
  if (!element.startsWith('--')) return undefined;
  const body = element.slice(2);
  const eq = body.indexOf('=');
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!isFlagName(name)) return undefined;
  return { name, value: eq === -1 ? undefined : body.slice(eq + 1) };
}

const RESERVED_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Case-folded with `-` and `_` removed: `allowedTools`, `allowed-tools`, `ALLOWED_TOOLS` agree. */
function canonical(name: string): string {
  return name.toLowerCase().replaceAll(/[-_]/g, '');
}

/**
 * Refuses passthrough argv that could set, unset or reorder a reserved flag
 * (plan §2.6, L4: the flags hudhud always passes, the dangerous ones, and
 * flags that move configuration roots).
 *
 * @remarks
 * Every element is scanned, including those that look like values of a
 * preceding flag, because the receiving parser decides what is a value
 * (fail closed). An element is refused when:
 *
 * - it contains NUL or a lone surrogate;
 * - it is `--`, which would turn every later element into an operand;
 * - it is a long flag (`--x` or `--x=v`) whose name, compared case-insensitively
 *   with `-` and `_` ignored, equals a reserved name, equals `no` plus a
 *   reserved name (negation), or is a prefix of a reserved name (parsers that
 *   accept abbreviations);
 * - it is a single-dash element whose body (before any `=`) equals a reserved
 *   name under the same comparison, or contains a reserved one-letter name
 *   (short-flag clusters such as `-xp`).
 *
 * Reserved names are long names (`permission-mode`, `allowedTools`) or
 * one-letter short names (`p`).
 *
 * @throws {@link ArgvError} on the first refused element; `index` and `flag` name it
 * @beta
 */
export function assertNoReservedFlags(args: readonly string[], reserved: readonly string[]): void {
  const long = new Map<string, string>();
  const short = new Map<string, string>();
  for (const name of reserved) {
    if (!RESERVED_NAME.test(name)) {
      throw new ArgvError('invalid-name', `reserved flag name ${JSON.stringify(name)} is invalid`);
    }
    (name.length === 1 ? short : long).set(canonical(name), name);
  }

  args.forEach((arg: unknown, index) => {
    if (typeof arg !== 'string') {
      throw new ArgvError('not-a-string', `argv element ${String(index)} is not a string`, {
        index,
      });
    }
    const problem = stringProblem(arg);
    if (problem !== undefined) {
      throw new ArgvError(
        problem,
        `argv element ${String(index)} contains ${problemText(problem)}`,
        {
          index,
        },
      );
    }
    if (arg === '--') {
      throw new ArgvError('end-of-options', `argv element ${String(index)} is "--"`, { index });
    }
    const flag = reservedMatch(arg, long, short);
    if (flag !== undefined) {
      throw new ArgvError(
        'reserved-flag',
        `argv element ${String(index)} ${JSON.stringify(arg)} names the reserved flag ${JSON.stringify(flag)}`,
        { index, flag },
      );
    }
  });
}

function reservedMatch(
  arg: string,
  long: ReadonlyMap<string, string>,
  short: ReadonlyMap<string, string>,
): string | undefined {
  if (!arg.startsWith('-') || arg.length === 1) return undefined;
  const isLong = arg.startsWith('--');
  const rest = arg.slice(isLong ? 2 : 1);
  const eq = rest.indexOf('=');
  const body = eq === -1 ? rest : rest.slice(0, eq);
  const name = canonical(body);
  const exact = long.get(name);
  if (exact !== undefined) return exact;
  if (isLong) {
    for (const [key, original] of long) {
      if (name.length > 0 && key.startsWith(name)) return original;
      if (name === `no${key}`) return original;
    }
    return undefined;
  }
  for (const letter of body) {
    const hit = short.get(letter.toLowerCase());
    if (hit !== undefined) return hit;
  }
  return undefined;
}
