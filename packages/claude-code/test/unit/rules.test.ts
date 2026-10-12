// Tool rule strings against the CLI tokenizer constraints (ADR-0011 §4).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ruleProblem, ruleProblemText, type RuleProblem } from '../../src/rules.js';

/**
 * A model of the CLI tokenizer for `--allowed-tools`: split on commas and
 * whitespace outside parentheses (02 §2.4).
 */
function tokenize(csv: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of csv) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth <= 0 && (char === ',' || /\s/u.test(char))) {
      if (current !== '') out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current !== '') out.push(current);
  return out;
}

describe('ruleProblem', () => {
  it.each([
    'Read',
    'Bash',
    'mcp__server__tool',
    'Bash(git log:*)',
    'Bash(git log *)',
    'Read(a,b)',
    'Bash(echo (nested) ok)',
    'Skill(my-skill)',
    'WebFetch(domain:example.com)',
    'Edit(/src/**)',
    'Write(-dash-inside)',
  ])('accepts %j', (rule) => {
    expect(ruleProblem(rule)).toBeUndefined();
  });

  it.each<[string, RuleProblem]>([
    ['', 'empty'],
    ['Read,Write', 'separator'],
    ['Read Write', 'separator'],
    ['Read\tWrite', 'control-character'],
    ['Read\u00a0Write', 'separator'],
    ['Bash(x),Read', 'separator'],
    ['Bash(', 'unbalanced-parentheses'],
    ['Bash)(', 'unbalanced-parentheses'],
    ['Bash(x))', 'unbalanced-parentheses'],
    ['-Read', 'leading-dash'],
    ['--allowed-tools=Bash', 'leading-dash'],
    ['Read\n', 'control-character'],
    ['Read\u0000', 'control-character'],
    ['Read\u001b[31m', 'control-character'],
    ['Read\u007f', 'control-character'],
    ['Read\u0085', 'control-character'],
    ['Read\u2028', 'control-character'],
    ['Read\u2029', 'control-character'],
    ['Read\uD800', 'ill-formed'],
  ])('refuses %j as %s', (rule, problem) => {
    expect(ruleProblem(rule)).toBe(problem);
    expect(ruleProblemText(problem)).toMatch(/^[a-z]/);
  });

  it('describes every problem', () => {
    const problems: RuleProblem[] = [
      'empty',
      'separator',
      'unbalanced-parentheses',
      'leading-dash',
      'control-character',
      'ill-formed',
    ];
    expect(new Set(problems.map(ruleProblemText)).size).toBe(problems.length);
  });

  it('accepted rules are single tokens: joined with commas they split back exactly', () => {
    // Rules built to be valid (a name, optionally a parenthesized specifier
    // with separators and arbitrary text inside), then confirmed accepted.
    const name = fc
      .array(fc.constantFrom('a', 'Z', '_', ':', '*', '.', '/', '9'), {
        minLength: 1,
        maxLength: 10,
      })
      .map((chars) => `R${chars.join('')}`);
    const inner = fc
      .string({ unit: 'binary', maxLength: 12 })
      .map((text) => text.replaceAll(/[()\p{Cc}\u2028\u2029]/gu, ''))
      .filter((text) => text.isWellFormed());
    const rule = fc
      .tuple(name, fc.option(fc.array(inner, { maxLength: 3 })))
      .map(([head, parts]) => (parts === null ? head : `${head}(${parts.join(', ')})`))
      .filter((r) => ruleProblem(r) === undefined);
    fc.assert(
      fc.property(fc.array(rule, { minLength: 1, maxLength: 6 }), (rules) => {
        expect(tokenize(rules.join(','))).toEqual(rules);
        for (const r of rules) expect(r.startsWith('-')).toBe(false);
      }),
    );
    // About 1.5 s on a loaded host; the default 5 s left too little margin.
  }, 30_000);

  it('is total over arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 32 }), (text) => {
        const problem = ruleProblem(text);
        expect(problem === undefined || typeof ruleProblemText(problem) === 'string').toBe(true);
      }),
    );
  });
});
