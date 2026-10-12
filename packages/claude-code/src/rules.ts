/**
 * Tool rule strings and skill names against the Claude Code argv tokenizer
 * (ADR-0011 §4, plan §1.8).
 *
 * @remarks
 * `--allowed-tools` and `--disallowed-tools` take one comma-separated value;
 * the CLI splits it on commas and whitespace outside parentheses (02 §2.4,
 * the Python SDK changelog 0.2.129 calls the unsplit behaviour an
 * injection). A rule that contained such a separator would turn into two
 * rules, so every rule must be a single token under that tokenizer:
 *
 * - not empty;
 * - no comma and no whitespace outside parentheses (inside, both are part of
 *   a rule's specifier, for example `Bash(git log:*)`);
 * - balanced parentheses, never closing more than were opened;
 * - no leading `-`, so no rule can read as a flag in any tokenizer;
 * - no control characters (C0, DEL, C1), no line or paragraph separators and
 *   no lone UTF-16 surrogates, so the child receives exactly the validated
 *   text and no terminal or log rendering can be spoofed.
 *
 * The functions are pure.
 */

/**
 * Why a rule string was refused.
 */
export type RuleProblem =
  | 'empty'
  | 'separator'
  | 'unbalanced-parentheses'
  | 'leading-dash'
  | 'control-character'
  | 'ill-formed';

// C0 controls, DEL, C1 controls, U+2028/U+2029.
// eslint-disable-next-line no-control-regex -- the point is to find control characters
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const WHITESPACE = /\s/u;

/**
 * The first problem of a tool rule or skill name, or `undefined` when it is a
 * single token under the CLI tokenizer.
 */
export function ruleProblem(rule: string): RuleProblem | undefined {
  if (rule.length === 0) return 'empty';
  if (!rule.isWellFormed()) return 'ill-formed';
  if (CONTROL.test(rule)) return 'control-character';
  if (rule.startsWith('-')) return 'leading-dash';
  let depth = 0;
  for (const char of rule) {
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth < 0) return 'unbalanced-parentheses';
    } else if (depth === 0 && (char === ',' || WHITESPACE.test(char))) {
      return 'separator';
    }
  }
  return depth === 0 ? undefined : 'unbalanced-parentheses';
}

/** Human text for a {@link RuleProblem}. */
export function ruleProblemText(problem: RuleProblem): string {
  switch (problem) {
    case 'empty':
      return 'is empty';
    case 'separator':
      return 'contains a comma or whitespace outside parentheses';
    case 'unbalanced-parentheses':
      return 'has unbalanced parentheses';
    case 'leading-dash':
      return 'starts with "-"';
    case 'control-character':
      return 'contains a control character';
    case 'ill-formed':
      return 'contains a lone UTF-16 surrogate';
  }
}
