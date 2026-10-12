/**
 * fast-check generators for the redaction properties. Every secret is fake.
 *
 * Secrets use only upper-case letters, digits and (inside) spaces or line
 * breaks, while filler, markers and the fixed parts of secret shapes use none
 * of `A-Z0-9`. A redacted output must therefore contain no `A-Z0-9` at all,
 * which also proves that no fragment of a secret survives.
 */
import fc from 'fast-check';

/** A secret value: upper-case letters and digits, inner spaces allowed. */
export const secretValue: fc.Arbitrary<string> = fc.stringMatching(
  /^[A-Z0-9][A-Z0-9 ]{6,20}[A-Z0-9]$/,
);

/** A secret value that may span lines. */
export const multiLineSecret: fc.Arbitrary<string> = fc.stringMatching(
  /^[A-Z0-9]{4,10}(?:(?:\n|\r\n)[A-Z0-9]{4,10}){0,2}$/,
);

/** A token without spaces, as used inside secret shapes. */
export const secretToken: fc.Arbitrary<string> = fc.stringMatching(/^[A-Z0-9]{12,24}$/);

/** Text around secrets: lower-case letters, punctuation, multi-byte characters. */
export const filler: fc.Arbitrary<string> = fc.string({
  unit: fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyz'.split(/(?=.)/u),
    ' ',
    '\n',
    '\r',
    '\t',
    ':',
    '=',
    '"',
    ',',
    '{',
    '}',
    '.',
    '/',
    'é',
    'م',
    '\u{1f600}',
  ),
  maxLength: 16,
});

/** Separators placed around secret shapes. */
export const separator: fc.Arbitrary<string> = fc.constantFrom(' ', '\n', '\r\n', '\t');

/** A secret-shaped value and the part of it that must never appear. */
export interface Shaped {
  readonly text: string;
  readonly secret: string;
}

const SHAPES: readonly ((secret: string) => string)[] = [
  (s) => `sk-ant-${s}`,
  (s) => `sk-ant-api-${s.toLowerCase()}${s}`,
  (s) => `bearer ${s}`,
  (s) => `basic ${s}`,
  (s) => `authorization: bearer ${s}`,
  (s) => `proxy-authorization: basic ${s}`,
  (s) => `x-api-key: ${s}`,
  (s) => `cookie: a=b; s=${s}`,
  (s) => `https://user:${s}@host.example/x`,
  (s) => `https://${s}@host.example`,
  (s) => `{"password":"${s}"}`,
  (s) => `"token": "${s}"`,
  (s) => `api_key=${s}`,
  (s) => `{\\"secret\\":\\"${s}\\"}`,
  (s) => `x-api-key:${s}`,
];

/** One of the secret shapes of plan §1.10 with a fresh secret. */
export const secretShaped: fc.Arbitrary<Shaped> = fc
  .tuple(fc.nat({ max: SHAPES.length - 1 }), secretToken)
  .map(([index, secret]) => ({ text: (SHAPES[index] ?? String)(secret), secret }));
