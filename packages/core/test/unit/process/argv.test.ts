import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ArgvError,
  assertNoReservedFlags,
  formatFlag,
  isFlagName,
  parseFlag,
} from '../../../src/process/argv.js';

/** Flags a harness adapter would reserve (plan Â§2.5, Â§2.6, L4); test data only. */
const RESERVED = [
  'output-format',
  'input-format',
  'verbose',
  'setting-sources',
  'permission-mode',
  'session-id',
  'resume',
  'fork-session',
  'allowedTools',
  'dangerously-skip-permissions',
  'project-config-root',
  'p',
] as const;

function caught(fn: () => unknown): ArgvError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ArgvError);
    return error as ArgvError;
  }
  throw new Error('expected an ArgvError');
}

const flagName = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/);
const safeValue = fc
  .string({ unit: 'binary', maxLength: 64 })
  .filter((value) => !value.includes('\0') && value.isWellFormed());

describe('formatFlag', () => {
  it('formats a bare flag and a flag with a value as one element', () => {
    expect(formatFlag('verbose')).toBe('--verbose');
    expect(formatFlag('resume', 'abc')).toBe('--resume=abc');
  });

  it.each([
    ['-dash-leading', '--resume=-dash-leading'],
    ['--permission-mode=bypassPermissions', '--resume=--permission-mode=bypassPermissions'],
    ['a,b c', '--resume=a,b c'],
    ['k=v=w', '--resume=k=v=w'],
    ['', '--resume='],
    ['"quoted" \\ back', '--resume="quoted" \\ back'],
    ['line\nbreak', '--resume=line\nbreak'],
    ['%PATH% $HOME `x` & | ^', '--resume=%PATH% $HOME `x` & | ^'],
  ])('keeps the value %j verbatim inside one element', (value, expected) => {
    expect(formatFlag('resume', value)).toBe(expected);
  });

  it.each(['', 'A', 'Verbose', '-x', '1x', 'x_y', 'x y', 'x=y', 'x\0', 'Ã©'])(
    'refuses the flag name %j',
    (name) => {
      const error = caught(() => formatFlag(name, 'v'));
      expect(error.reason).toBe('invalid-name');
      expect(error.code).toBe('INVALID_OPTIONS');
      expect(error.name).toBe('ArgvError');
    },
  );

  it('refuses NUL and lone surrogates in values', () => {
    expect(caught(() => formatFlag('model', 'a\0b')).reason).toBe('nul');
    expect(caught(() => formatFlag('model', 'a\uD800b')).message).toContain('surrogate');
    expect(caught(() => formatFlag('model', '\uDC00')).reason).toBe('ill-formed');
  });

  it('property: one element, `--name=` prefix, value verbatim, parses back', () => {
    fc.assert(
      fc.property(flagName, safeValue, (name, value) => {
        const element = formatFlag(name, value);
        expect(element.startsWith(`--${name}=`)).toBe(true);
        expect(element.slice(name.length + 3)).toBe(value);
        expect(parseFlag(element)).toEqual({ name, value });
      }),
      { numRuns: 1000 },
    );
  });

  it('property: any value containing NUL is refused', () => {
    fc.assert(
      fc.property(flagName, safeValue, safeValue, (name, before, after) => {
        expect(caught(() => formatFlag(name, `${before}\0${after}`)).reason).toBe('nul');
      }),
    );
  });

  it('property: names outside the grammar are refused', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 12 }).filter((name) => !isFlagName(name)),
        (name) => {
          expect(caught(() => formatFlag(name)).reason).toBe('invalid-name');
        },
      ),
    );
  });
});

describe('parseFlag', () => {
  it('parses long flags and rejects everything else', () => {
    expect(parseFlag('--verbose')).toEqual({ name: 'verbose', value: undefined });
    expect(parseFlag('--x=a=b')).toEqual({ name: 'x', value: 'a=b' });
    expect(parseFlag('--x=')).toEqual({ name: 'x', value: '' });
    expect(parseFlag('-x')).toBeUndefined();
    expect(parseFlag('value')).toBeUndefined();
    expect(parseFlag('--Bad=1')).toBeUndefined();
    expect(parseFlag('--')).toBeUndefined();
  });
});

describe('assertNoReservedFlags', () => {
  it('accepts values, unreserved flags and an empty list', () => {
    expect(() => {
      assertNoReservedFlags([], RESERVED);
      assertNoReservedFlags(
        ['--debug', 'value', '-d', '--max-budget-usd=1', '-', '--=x', 'p', 'permission-mode'],
        RESERVED,
      );
      assertNoReservedFlags(['--anything'], []);
    }).not.toThrow();
  });

  it.each([
    ['--permission-mode', 'permission-mode'],
    ['--permission-mode=bypassPermissions', 'permission-mode'],
    ['--PERMISSION_MODE', 'permission-mode'],
    ['--permissionMode=x', 'permission-mode'],
    ['--allowed-tools=Bash', 'allowedTools'],
    ['--allowedtools', 'allowedTools'],
    ['--project-config-root=/elsewhere', 'project-config-root'],
    ['--dangerously-skip-permissions', 'dangerously-skip-permissions'],
    ['--no-verbose', 'verbose'],
    ['--perm', 'permission-mode'],
    ['--proj=/x', 'project-config-root'],
    ['---resume', 'resume'],
    ['-p', 'p'],
    ['-P', 'p'],
    ['-xp', 'p'],
    ['-permission-mode', 'permission-mode'],
    ['-resume=abc', 'resume'],
  ])('refuses %j as the reserved flag %j', (arg, flag) => {
    const error = caught(() => {
      assertNoReservedFlags(['ok', arg], RESERVED);
    });
    expect(error.reason).toBe('reserved-flag');
    expect(error.index).toBe(1);
    expect(error.flag).toBe(flag);
    expect(error.message).toContain(JSON.stringify(arg));
  });

  it('scans elements that look like values of a preceding flag (fail closed)', () => {
    const error = caught(() => {
      assertNoReservedFlags(['--append-system-prompt', '--resume=x'], RESERVED);
    });
    expect(error.index).toBe(1);
  });

  it('refuses the end-of-options marker, NUL, lone surrogates and non-strings', () => {
    expect(
      caught(() => {
        assertNoReservedFlags(['a', '--'], RESERVED);
      }).reason,
    ).toBe('end-of-options');
    expect(
      caught(() => {
        assertNoReservedFlags(['a\0'], RESERVED);
      }).reason,
    ).toBe('nul');
    expect(
      caught(() => {
        assertNoReservedFlags(['\uD800'], RESERVED);
      }).reason,
    ).toBe('ill-formed');
    const notString = [1] as unknown as readonly string[];
    const error = caught(() => {
      assertNoReservedFlags(notString, RESERVED);
    });
    expect(error.reason).toBe('not-a-string');
    expect(error.index).toBe(0);
    expect(error.flag).toBeUndefined();
  });

  it.each(['', '-x', '1', 'a b', 'a=b', 'a\0'])('refuses the reserved name %j', (name) => {
    expect(
      caught(() => {
        assertNoReservedFlags([], [name]);
      }).reason,
    ).toBe('invalid-name');
  });

  it('property: every case and separator spelling of a reserved flag is refused', () => {
    const longNames = RESERVED.filter((name) => name.length > 1);
    const spelling = fc
      .tuple(
        fc.constantFrom(...longNames),
        fc.array(fc.constantFrom('', '-', '_'), { minLength: 32, maxLength: 32 }),
        fc.array(fc.boolean(), { minLength: 32, maxLength: 32 }),
        fc.option(safeValue, { nil: undefined }),
      )
      .map(([name, separators, upper, value]) => {
        const letters = Array.from(name.replaceAll('-', ''), (letter, i) => {
          const cased = upper[i] === true ? letter.toUpperCase() : letter.toLowerCase();
          return `${cased}${separators[i] ?? ''}`;
        });
        const flag = `--${letters.join('')}`;
        return { name, arg: value === undefined ? flag : `${flag}=${value}` };
      });
    fc.assert(
      fc.property(spelling, ({ name, arg }) => {
        const error = caught(() => {
          assertNoReservedFlags([arg], RESERVED);
        });
        expect(error.reason).toBe('reserved-flag');
        expect(error.flag).toBe(name);
      }),
      { numRuns: 1000 },
    );
  });

  it('property: operands that do not start with a dash are always accepted', () => {
    fc.assert(
      fc.property(fc.array(safeValue.filter((value) => !value.startsWith('-'))), (args) => {
        expect(() => {
          assertNoReservedFlags(args, RESERVED);
        }).not.toThrow();
      }),
    );
  });
});
