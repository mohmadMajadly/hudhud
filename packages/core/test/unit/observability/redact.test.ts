import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  REDACTED,
  credentialEnvNames,
  isCredentialEnvName,
  isSensitiveFieldName,
  maskCutEnd,
  prepareSecrets,
  redactJson,
  redactText,
  secretsFromEnv,
  type RedactableJson,
} from '../../../src/observability/redact.js';
import { secretShaped, secretValue, separator, filler } from './arbitraries.js';

// All secrets below are fake, built for these tests.
const R = REDACTED;

describe('environment names and values', () => {
  it.each([
    ['ANTHROPIC_API_KEY', true],
    ['ANTHROPIC_AUTH_TOKEN', true],
    ['aws_secret_access_key', true],
    ['DB_PASSWORD', true],
    ['GOOGLE_APPLICATION_CREDENTIALS', true],
    ['OAUTH_CLIENT', true],
    ['PATH', false],
    ['HOME', false],
    ['ANTHROPIC_BASE_URL', false],
  ])('isCredentialEnvName(%s) is %s', (name, expected) => {
    expect(isCredentialEnvName(name)).toBe(expected);
  });

  it('collects distinct non-blank values of credential variables only', () => {
    const env = {
      ANTHROPIC_API_KEY: 'fake-key-1',
      OTHER_TOKEN: 'fake-key-1',
      DB_PASSWORD: '   ',
      EMPTY_SECRET: '',
      UNSET_SECRET: undefined,
      PATH: '/usr/bin',
    };
    expect(secretsFromEnv(env)).toEqual(['fake-key-1']);
  });

  it('reports credential variable names sorted, never values', () => {
    const env = { Z_TOKEN: 'v1', A_KEY: 'v2', PATH: 'p', GONE_SECRET: undefined };
    const names = credentialEnvNames(env);
    expect(names).toEqual(['A_KEY', 'Z_TOKEN']);
    expect(JSON.stringify(names)).not.toMatch(/v1|v2/);
  });
});

describe('isSensitiveFieldName', () => {
  it.each([
    'apiKey',
    'api_key',
    'x-api-key',
    'APIKey',
    'ANTHROPIC_AUTH_TOKEN',
    'accessToken',
    'authorization',
    'Proxy-Authorization',
    'cookie',
    'Set-Cookie',
    'password',
    'client.secret',
    'credentials',
    'auth',
    'oauth',
    'privatekey',
  ])('masks %s', (name) => {
    expect(isSensitiveFieldName(name)).toBe(true);
  });

  it.each([
    'inputTokens',
    'input_tokens',
    'apiKeySource',
    'keyboard',
    'author',
    'monkey',
    '_2',
    '',
  ])('keeps %s', (name) => {
    expect(isSensitiveFieldName(name)).toBe(false);
  });
});

describe('redactText', () => {
  it('masks literal secrets wherever they occur, overlapping included', () => {
    expect(redactText('a hunter2 b hunter2', ['hunter2'])).toBe(`a ${R} b ${R}`);
    expect(redactText('xabcabcx', ['abca', 'cab'])).toBe(`x${R}cx`);
    expect(redactText('[abc][bcd]', ['abc', 'bcd'])).toBe(`[${R}][${R}]`);
    expect(redactText('abcd', ['ab', 'cd'])).toBe(R);
  });

  it('masks multi-line secrets whole and line by line', () => {
    const pem = 'BEGIN\nMIIfakeLINE1\r\n   \nMIIfakeLINE2';
    expect(redactText(`k=${pem}.`, [pem])).toBe(`k=${R}.`);
    expect(redactText('one MIIfakeLINE2 two', [pem])).toBe(`one ${R} two`);
  });

  it('ignores empty and whitespace-only secrets', () => {
    expect(redactText('a b  c', ['', ' ', '\n'])).toBe('a b  c');
  });

  it('leaves text without secrets unchanged', () => {
    const text = 'Error: connect ECONNREFUSED 127.0.0.1:443\n  at x (file.js:1:2)\ninput_tokens=5';
    expect(redactText(text, [])).toBe(text);
  });

  it.each([
    ['Authorization: Bearer abc.def', `Authorization: ${R}`],
    ['proxy-authorization:Basic dXNlcjpwYXNz', `proxy-authorization:${R}`],
    ['x-api-key: sk-test-123\nnext', `x-api-key: ${R}\nnext`],
    ['Cookie: a=b; session=xyz', `Cookie: ${R}`],
    ['set-cookie: id=1; HttpOnly\r\nok', `set-cookie: ${R}\r\nok`],
    ['note: x, token: abc def', `note: x, token: ${R}`],
    ['Authorization:', 'Authorization:'],
  ])('masks header line %j', (input, expected) => {
    expect(redactText(input, [])).toBe(expected);
  });

  it.each([
    ['using Bearer abc.def-ghi now', `using Bearer ${R} now`],
    ['bearer\tabc', `bearer\t${R}`],
    ['BASIC dXNlcjpwYXNz.', `BASIC ${R}`],
  ])('masks auth scheme credentials %j', (input, expected) => {
    expect(redactText(input, [])).toBe(expected);
  });

  it('masks Anthropic keys whole', () => {
    expect(redactText('key sk-ant-AbC_d-9 end', [])).toBe(`key ${R} end`);
    expect(redactText('"sk-ant-oat01-x"', [])).toBe(`"${R}"`);
  });

  it.each([
    ['https://user:pa55@localhost:8080/p', `https://${R}@localhost:8080/p`],
    ['git+ssh://u@h', `git+ssh://${R}@h`],
    ['http://u:p@ss@host/x?y=a@b', `http://${R}@host/x?y=a@b`],
    ['https://host.example/a@b', 'https://host.example/a@b'],
  ])('masks URL userinfo %j', (input, expected) => {
    expect(redactText(input, [])).toBe(expected);
  });

  it.each([
    ['ANTHROPIC_API_KEY=abc123 rest', `ANTHROPIC_API_KEY=${R} rest`],
    ['?access_token=abc&x=1', `?access_token=${R}&x=1`],
    ['{"password":"p w","user":"u"}', `{"password":"${R}","user":"u"}`],
    ["{'secret': 'x y'}", `{'secret': '${R}'}`],
    ['"apiKey": "unterminated value', `"apiKey": "${R}`],
    ['{\\"token\\":\\"abc\\",\\"n\\":1}', `{\\"token\\":\\"${R}\\",\\"n\\":1}`],
    ['{\\"token\\":\\"abc', `{\\"token\\":\\"${R}`],
    ['note: "password": "hunter2"', `note: "password": "${R}"`],
    ['"token": "a\\"b"', `"token": "${R}"`],
    ['token=""', 'token=""'],
    ['token={"a":1}', 'token={"a":1}'],
    ['input_tokens=12 output_tokens=3', 'input_tokens=12 output_tokens=3'],
    ['monkey=banana', 'monkey=banana'],
  ])('masks sensitive assignments %j', (input, expected) => {
    expect(redactText(input, [])).toBe(expected);
  });

  it('applies literal secrets before shape rules', () => {
    expect(redactText('Bearer zzsecretzz', ['zzsecretzz'])).toBe(`Bearer ${R}`);
  });

  it('never leaks a literal secret mixed into arbitrary text', () => {
    fc.assert(
      fc.property(
        fc.array(secretValue, { minLength: 1, maxLength: 4 }),
        fc.array(fc.oneof(fc.string({ unit: 'binary', maxLength: 12 }), fc.nat({ max: 3 })), {
          maxLength: 12,
        }),
        (secrets, parts) => {
          const text = parts
            .map((part) =>
              typeof part === 'number' ? (secrets[part % secrets.length] ?? '') : part,
            )
            .join('');
          const out = redactText(text, secrets);
          for (const secret of secrets) expect(out).not.toContain(secret);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('never leaks the secret part of a secret-shaped value', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(filler, separator, secretShaped, separator), {
          minLength: 1,
          maxLength: 5,
        }),
        (parts) => {
          const text = parts
            .map(([before, s1, shaped, s2]) => before + s1 + shaped.text + s2)
            .join('');
          const out = redactText(text, []);
          for (const [, , shaped] of parts) expect(out).not.toContain(shaped.secret);
          // Secrets alone use A-Z0-9 (arbitraries.ts): no fragment survives.
          expect(out).not.toMatch(/[A-Z0-9]/);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('never leaks values of credential variables of an arbitrary environment', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom(
            'ANTHROPIC_API_KEY',
            'ANTHROPIC_AUTH_TOKEN',
            'MY_SECRET',
            'DB_PASSWORD',
            'X_CREDENTIAL',
          ),
          secretValue,
        ),
        fc.array(fc.string({ unit: 'grapheme', maxLength: 10 }), { maxLength: 6 }),
        (env, filler) => {
          const values = Object.values(env);
          const text = [...filler, ...values, ...filler].join(' ');
          const out = redactText(text, secretsFromEnv(env));
          for (const value of values) expect(out).not.toContain(value);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('redactJson', () => {
  const policy = { secrets: ['hunter2'] };

  it('masks sensitive keys whole, strings, keys and numbers', () => {
    const input: RedactableJson = {
      apiKey: { nested: 'x' },
      headers: { Authorization: 'Bearer abc', accept: 'json' },
      note: 'pw is hunter2',
      hunter2: 1,
      pin: 12345,
      ok: 7,
      flags: [true, null, 'Bearer zz'],
      usage: { input_tokens: 3 },
    };
    expect(redactJson(input, { secrets: ['hunter2', '2345'] })).toEqual({
      apiKey: R,
      headers: { Authorization: R, accept: 'json' },
      note: `pw is ${R}`,
      [R]: 1,
      pin: R,
      ok: 7,
      flags: [true, null, `Bearer ${R}`],
      usage: { input_tokens: 3 },
    });
  });

  it('keeps __proto__ keys as inert own data', () => {
    const input = JSON.parse('{"__proto__":{"polluted":"hunter2"}}') as RedactableJson;
    const out = redactJson(input, policy);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(JSON.stringify(out)).toBe(`{"__proto__":{"polluted":"${R}"}}`);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('replaces subtrees deeper than maxDepth and terminates on cycles', () => {
    expect(redactJson({ a: { b: { c: 1 } } }, { secrets: [], maxDepth: 2 })).toEqual({
      a: { b: R },
    });
    expect(redactJson([[[1]]], { secrets: [], maxDepth: 1 })).toEqual([R]);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const out = redactJson(cyclic as RedactableJson, policy);
    expect(JSON.stringify(out)).toContain(R);
  });

  it('replaces values that are not JSON', () => {
    const odd = [undefined, () => 1, Symbol('s'), 1n] as unknown as RedactableJson;
    expect(redactJson(odd, policy)).toEqual([R, R, R, R]);
  });

  it('keeps scalars that hold no secret', () => {
    expect(redactJson(null, policy)).toBeNull();
    expect(redactJson(false, policy)).toBe(false);
    expect(redactJson(1.5, policy)).toBe(1.5);
    expect(redactJson('plain', policy)).toBe('plain');
  });

  it('never leaks a secret anywhere in an arbitrary JSON value', () => {
    fc.assert(
      fc.property(
        fc.array(secretValue, { minLength: 1, maxLength: 3 }),
        fc.jsonValue(),
        (secrets, value) => {
          const planted = {
            data: value,
            [secrets[0] ?? '']: secrets,
            text: `x${secrets.join(' ')}y`,
          };
          const out = JSON.stringify(redactJson(planted as RedactableJson, { secrets }));
          for (const secret of secrets) expect(out).not.toContain(secret);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('maskCutEnd', () => {
  const secrets = prepareSecrets(['ABCDEF', 'two words', 'L1\nL2']);

  it('masks the trailing token of a cut line', () => {
    expect(maskCutEnd('see https://user:pa', secrets)).toBe(`see ${R}`);
    expect(maskCutEnd('ends with space ', secrets)).toBe('ends with space ');
    expect(maskCutEnd('', secrets)).toBe('');
  });

  it('masks a trailing prefix of a known secret, spaces included', () => {
    expect(maskCutEnd('value two ', secrets)).toBe(`value ${R}`);
    expect(maskCutEnd('value ABCDEF', secrets)).toBe(`value ${R}`);
    expect(maskCutEnd('x L', secrets)).toBe(`x ${R}`);
  });
});
