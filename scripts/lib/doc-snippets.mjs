// Pure helpers of the documentation snippet check (W7-T3). The user
// documentation shows code only as excerpts of the example programs under
// `examples/`, which `pnpm build` type-checks and `pnpm lint` lints. This
// module finds the TypeScript and JavaScript code blocks of a Markdown file
// and checks that each one is a contiguous excerpt of an example: the same
// lines in the same order, compared after removing the excerpt's common
// indentation and trailing whitespace. Blocks in other languages (shell,
// text, JSON) are not checked.

/**
 * @typedef {object} CodeBlock
 * @property {number} line 1-based line of the opening fence.
 * @property {string} language The first word of the info string, lower-case ('' without one).
 * @property {string[]} lines The lines between the fences.
 * @property {boolean} closed Whether a closing fence was found.
 */

/**
 * @typedef {object} SourceFile
 * @property {string} path Repository-relative path, for messages.
 * @property {string} text File content.
 */

/** Info-string languages whose blocks must be excerpts of an example. */
export const CHECKED_LANGUAGES = new Set(['ts', 'typescript', 'js', 'javascript', 'mjs']);

const FENCE = /^ {0,3}(?:`{3,}|~{3,})/u;

/**
 * @typedef {object} Fence
 * @property {number} indent Spaces before the fence.
 * @property {string} char The fence character.
 * @property {number} length Number of fence characters.
 * @property {string} info The info string, trimmed.
 */

/**
 * The fence a line opens or closes, if it is one.
 *
 * @param {string} line
 * @returns {Fence | undefined}
 */
function fenceOf(line) {
  if (!FENCE.test(line)) return undefined;
  const body = line.trimStart();
  const char = body.charAt(0);
  let length = 0;
  while (body.charAt(length) === char) length += 1;
  return { indent: line.length - body.length, char, length, info: body.slice(length).trim() };
}

/**
 * Whether `candidate` closes a block opened by `opening`: the same
 * character, at least as long, no info string.
 *
 * @param {Fence | undefined} candidate
 * @param {Fence} opening
 * @returns {boolean}
 */
function closes(candidate, opening) {
  if (candidate === undefined) return false;
  return (
    candidate.char === opening.char && candidate.length >= opening.length && candidate.info === ''
  );
}

/**
 * Splits text into lines, accepting LF and CRLF.
 *
 * @param {string} text
 * @returns {string[]}
 */
function linesOf(text) {
  return text.split(/\r?\n/u);
}

/**
 * The fenced code blocks of a Markdown text (CommonMark fences: three or
 * more backticks or tildes, indented by at most three spaces; a block ends
 * at a fence of the same character that is at least as long and has no info
 * string, or at the end of the text).
 *
 * @param {string} text
 * @returns {CodeBlock[]}
 */
export function codeBlocks(text) {
  /** @type {CodeBlock[]} */
  const blocks = [];
  /** @type {{ block: CodeBlock, fence: Fence } | undefined} */
  let open;
  for (const [index, line] of linesOf(text).entries()) {
    const fence = fenceOf(line);
    if (open !== undefined) {
      if (closes(fence, open.fence)) {
        open.block.closed = true;
        open = undefined;
      } else {
        // CommonMark removes up to the opening fence's indentation.
        const strip = Math.min(open.fence.indent, line.length - line.trimStart().length);
        open.block.lines.push(line.slice(strip));
      }
      continue;
    }
    if (fence === undefined) continue;
    /** @type {CodeBlock} */
    const block = {
      line: index + 1,
      language: fence.info.split(/\s/u, 1).join('').toLowerCase(),
      lines: [],
      closed: false,
    };
    blocks.push(block);
    open = { block, fence };
  }
  return blocks;
}

/**
 * Lines without trailing whitespace and without their common indentation
 * (blank lines do not count towards it), with leading and trailing blank
 * lines removed.
 *
 * @param {readonly string[]} lines
 * @returns {string[]}
 */
export function normalizeLines(lines) {
  const trimmed = lines.map((line) => line.trimEnd());
  let start = 0;
  while (start < trimmed.length && trimmed[start] === '') start += 1;
  let end = trimmed.length;
  while (end > start && trimmed[end - 1] === '') end -= 1;
  const body = trimmed.slice(start, end);
  const indents = body
    .filter((line) => line !== '')
    .map((line) => line.length - line.trimStart().length);
  const common = indents.length === 0 ? 0 : Math.min(...indents);
  return body.map((line) => line.slice(common));
}

/**
 * Whether `excerpt` (normalized) equals some contiguous run of lines of
 * `source`, normalized the same way.
 *
 * @param {readonly string[]} excerpt normalized, non-empty
 * @param {readonly string[]} source raw lines
 * @returns {boolean}
 */
export function containsExcerpt(excerpt, source) {
  const width = excerpt.length;
  for (let start = 0; start + width <= source.length; start += 1) {
    const window = normalizeLines(source.slice(start, start + width));
    if (window.length === width && window.every((line, i) => line === excerpt[i])) return true;
  }
  return false;
}

/**
 * Checks every TypeScript and JavaScript block of the documents against the
 * example sources. Returns one message per problem, in document order.
 *
 * @param {readonly SourceFile[]} documents Markdown files
 * @param {readonly SourceFile[]} examples example programs
 * @returns {{ problems: string[], checked: number }}
 */
export function checkSnippets(documents, examples) {
  const sources = examples.map((example) => ({ path: example.path, lines: linesOf(example.text) }));
  /** @type {string[]} */
  const problems = [];
  let checked = 0;
  for (const document of documents) {
    for (const block of codeBlocks(document.text)) {
      const where = `${document.path}:${String(block.line)}`;
      if (!block.closed) {
        problems.push(`${where}: code block is not closed`);
        continue;
      }
      if (!CHECKED_LANGUAGES.has(block.language)) continue;
      checked += 1;
      const excerpt = normalizeLines(block.lines);
      if (excerpt.length === 0) {
        problems.push(`${where}: ${block.language} code block is empty`);
      } else if (!sources.some((source) => containsExcerpt(excerpt, source.lines))) {
        problems.push(
          `${where}: ${block.language} code block is not an excerpt of any example under examples/`,
        );
      }
    }
  }
  return { problems, checked };
}
