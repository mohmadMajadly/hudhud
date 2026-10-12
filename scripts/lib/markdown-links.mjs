// Pure helpers of the offline Markdown link checker: link extraction and
// GitHub-compatible heading anchors. External URLs are out of scope (no
// network in checks); relative file links and #anchors are verified.

/**
 * @typedef {object} Link
 * @property {number} line 1-based line number.
 * @property {string} target Raw link destination.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const INLINE_LINK = /!?\[(?:[^\]\\]|\\.)*\]\(\s*<?([^)\s>]*)>?(?:\s+["'(][^)]*["')])?\s*\)/gu;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+["'(].*["')])?\s*$/u;
const CODE_SPAN = /(`+)(?:(?!\1)[\s\S])*?\1/gu;

/**
 * Splits Markdown into lines with fenced code blocks blanked out, keeping
 * line numbers stable.
 *
 * @param {string} text
 * @returns {string[]}
 */
function proseLines(text) {
  /** @type {string | undefined} */
  let fence;
  return text.split(/\r?\n/u).map((line) => {
    const marker = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (marker?.startsWith(fence.charAt(0)) === true && marker.length >= fence.length) {
        fence = undefined;
      }
      return '';
    }
    if (marker !== undefined) {
      fence = marker;
      return '';
    }
    return line;
  });
}

/**
 * Extracts inline links, images and reference definitions outside code.
 *
 * @param {string} text
 * @returns {Link[]}
 */
export function extractLinks(text) {
  /** @type {Link[]} */
  const links = [];
  for (const [index, raw] of proseLines(text).entries()) {
    const line = raw.replace(CODE_SPAN, (span) => ' '.repeat(span.length));
    const definition = REFERENCE_DEFINITION.exec(line);
    if (definition?.[1] !== undefined) {
      links.push({ line: index + 1, target: definition[1] });
      continue;
    }
    for (const match of line.matchAll(INLINE_LINK)) {
      if (match[1] !== undefined && match[1] !== '')
        links.push({ line: index + 1, target: match[1] });
    }
  }
  return links;
}

/**
 * GitHub's heading-to-anchor rule: lower-case, drop everything except
 * letters, marks, numbers, connector punctuation, spaces and hyphens, then
 * turn spaces into hyphens. Duplicates get `-1`, `-2`, ... suffixes.
 *
 * @param {string} heading Heading text as written.
 * @returns {string}
 */
export function slugify(heading) {
  const rendered = heading
    .replace(/!?\[((?:[^\]\\]|\\.)*)\]\([^)]*\)/gu, '$1') // links -> text
    .replace(/`/gu, '')
    .replace(/<[^>]*>/gu, '') // inline HTML tags
    .replace(/\*+/gu, '');
  return rendered
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /gu, '-');
}

/**
 * All anchors a Markdown document provides.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function anchorsOf(text) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {Set<string>} */
  const anchors = new Set();
  for (const line of proseLines(text)) {
    const heading = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/u.exec(line);
    if (heading?.[1] === undefined) continue;
    const base = slugify(heading[1]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${String(count)}`);
  }
  return anchors;
}

/**
 * Whether a link target is checked by this tool (relative paths and
 * same-document anchors) rather than ignored (URLs with a scheme).
 *
 * @param {string} target
 * @returns {boolean}
 */
export function isLocalTarget(target) {
  return !/^[a-z][a-z0-9+.-]*:/iu.test(target) && !target.startsWith('//');
}

/**
 * Splits a local target into a decoded path and an optional anchor.
 *
 * @param {string} target
 * @returns {{ path: string, anchor: string | undefined }}
 */
export function splitTarget(target) {
  const hash = target.indexOf('#');
  const rawPath = hash === -1 ? target : target.slice(0, hash);
  const anchor = hash === -1 ? undefined : decodeURIComponent(target.slice(hash + 1));
  return { path: decodeURIComponent(rawPath), anchor };
}
