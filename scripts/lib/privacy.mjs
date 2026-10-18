// Pure scanning logic of the privacy gate. No I/O here: the CLI wrapper in
// scripts/privacy-scan.mjs feeds text in and prints findings.

/**
 * @typedef {object} Finding
 * @property {string} path File path relative to the repository root.
 * @property {number} line 1-based line number; 0 means the file name itself.
 * @property {string} rule Identifier of the rule that matched.
 * @property {string} excerpt Masked excerpt that is safe to print.
 */

/**
 * @typedef {object} Rule
 * @property {string} id
 * @property {RegExp} pattern Must have the global flag.
 * @property {(match: RegExpExecArray) => boolean} [isAllowed]
 * @property {(match: RegExpExecArray) => string} mask
 */

/**
 * @typedef {object} AddedLine
 * @property {string} path
 * @property {number} line
 * @property {string} text
 */

/** Generic or service account names that identify nobody. */
const ALLOWED_HOME_NAMES = new Set([
  'default',
  'name',
  'node', // default account of the official Docker node images
  'public',
  'runner',
  'runneradmin',
  'user',
  'username',
]);

/**
 * Placeholder spellings that stand for "some user": shell or cmd variables
 * ($USER, ${USER}, %USERNAME%), ..., *, ___, xxx.
 */
const PLACEHOLDER_NAME = /^(?:[$%].*|\*+|\.{3}|_+|x+)$/iu;

/**
 * @param {string} name
 * @returns {boolean}
 */
function isAllowedHomeName(name) {
  return ALLOWED_HOME_NAMES.has(name.toLowerCase()) || PLACEHOLDER_NAME.test(name);
}

/**
 * The user-name segment of a home-path match: the text after the last path
 * separator (user names never contain one, see NAME below).
 *
 * @param {RegExpExecArray} match
 * @returns {string}
 */
function homeName(match) {
  return match[0].replace(/^.*[\\/]/su, '');
}

/**
 * @param {RegExpExecArray} match
 * @returns {boolean}
 */
function homeNameAllowed(match) {
  return isAllowedHomeName(homeName(match));
}

/**
 * @param {RegExpExecArray} match
 * @returns {string}
 */
function maskHome(match) {
  return match[0].slice(0, match[0].length - homeName(match).length) + '***';
}

/**
 * @param {RegExpExecArray} match
 * @returns {string}
 */
function maskToken(match) {
  return match[0].slice(0, Math.min(8, Math.floor(match[0].length / 3))) + '***';
}

/**
 * Prefix of the one fake Anthropic key the repository may contain: the key
 * the sandboxed test launcher gives the pinned CLI, shaped like a real key
 * so the CLI treats it as one (test-support `FAKE_API_KEY`). It authenticates
 * nowhere: every request goes to the in-process mock.
 */
export const FAKE_ANTHROPIC_KEY_PREFIX = 'sk-ant-fake-hudhud-';

/** The fake key: the prefix, then letters and digits only (no `-`). */
const FAKE_ANTHROPIC_KEY = /^sk-ant-fake-hudhud-[A-Za-z0-9]*$/u;

/**
 * Allows exactly the fake key. Its tail admits no `-`, so a real key cannot
 * hide behind the prefix: the prefix followed by a real key is one match
 * whose tail holds a `-`, and stays a finding.
 *
 * @param {RegExpExecArray} match
 * @returns {boolean}
 */
function fakeAnthropicKeyAllowed(match) {
  return FAKE_ANTHROPIC_KEY.test(match[0]);
}

const ALLOWED_EMAILS = new Set(['noreply@anthropic.com']);
const ALLOWED_EMAIL_DOMAINS = ['users.noreply.github.com'];

/**
 * @param {RegExpExecArray} match
 * @returns {boolean}
 */
function emailAllowed(match) {
  const email = match[0].toLowerCase();
  if (ALLOWED_EMAILS.has(email)) return true;
  const domain = email.slice(email.lastIndexOf('@') + 1);
  return ALLOWED_EMAIL_DOMAINS.includes(domain);
}

/**
 * @param {RegExpExecArray} match
 * @returns {string}
 */
function maskEmail(match) {
  const at = match[0].lastIndexOf('@');
  return '***' + match[0].slice(at);
}

// Characters that cannot be part of a user name inside a path.
const NAME = String.raw`([^\\/\s"'<>|:*?\x60(){}\[\],;]+)`;
// A POSIX home path must start at the file-system root: not inside a word,
// URL host, relative path or placeholder such as `<dir>/home/...`.
const ROOTED = String.raw`(?<![\w.~:>-])`;

/** @type {readonly Rule[]} */
export const RULES = Object.freeze([
  {
    id: 'home-path-windows',
    pattern: new RegExp(String.raw`\b[A-Za-z]:(?:\\{1,2}|/)Users(?:\\{1,2}|/)` + NAME, 'giu'),
    isAllowed: homeNameAllowed,
    mask: maskHome,
  },
  {
    id: 'home-path-msys-wsl',
    pattern: new RegExp(ROOTED + String.raw`/(?:mnt/)?[A-Za-z]/Users/` + NAME, 'giu'),
    isAllowed: homeNameAllowed,
    mask: maskHome,
  },
  {
    id: 'home-path-macos',
    pattern: new RegExp(ROOTED + String.raw`/Users/` + NAME, 'gu'),
    isAllowed: homeNameAllowed,
    mask: maskHome,
  },
  {
    id: 'home-path-linux',
    pattern: new RegExp(ROOTED + String.raw`/home/` + NAME, 'gu'),
    isAllowed: homeNameAllowed,
    mask: maskHome,
  },
  {
    id: 'email',
    pattern: /(?<![\w.%+-])[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/gu,
    isAllowed: emailAllowed,
    mask: maskEmail,
  },
  {
    id: 'anthropic-key',
    pattern: /\bsk-ant-[\w-]{10,}/gu,
    isAllowed: fakeAnthropicKeyAllowed,
    mask: maskToken,
  },
  {
    id: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/gu,
    mask: maskToken,
  },
  {
    id: 'github-fine-grained-token',
    pattern: /\bgithub_pat_\w{22,}/gu,
    mask: maskToken,
  },
  {
    id: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
    mask: maskToken,
  },
  {
    id: 'private-key',
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/gu,
    mask: (match) => match[0],
  },
  {
    id: 'npm-token',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/gu,
    mask: maskToken,
  },
  {
    id: 'npmrc-auth-token',
    pattern: /_authToken\s*=\s*(?!\$\{)[\w.~+/-]{8,}/gu,
    mask: () => '_authToken=***',
  },
  {
    id: 'slack-token',
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/gu,
    mask: maskToken,
  },
  {
    id: 'google-api-key',
    pattern: /\bAIza[\w-]{35}\b/gu,
    mask: maskToken,
  },
]);

/** Minimum length of a denylist term; shorter terms would match everywhere. */
export const MIN_DENYLIST_TERM_LENGTH = 3;

/**
 * Parses a denylist file: one term per line, `#` starts a comment, blank
 * lines are ignored. Matching is case-insensitive substring matching.
 *
 * @param {string} text
 * @returns {string[]}
 * @throws {Error} When a term is shorter than {@link MIN_DENYLIST_TERM_LENGTH}.
 */
export function parseDenylist(text) {
  /** @type {string[]} */
  const terms = [];
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const term = raw.replace(/#.*$/u, '').trim();
    if (term === '') continue;
    if (term.length < MIN_DENYLIST_TERM_LENGTH) {
      throw new Error(
        `denylist line ${String(index + 1)}: terms must be at least ${String(MIN_DENYLIST_TERM_LENGTH)} characters`,
      );
    }
    terms.push(term.toLowerCase());
  }
  return terms;
}

/**
 * Scans one line of text.
 *
 * @param {string} text
 * @param {readonly string[]} denylist Lower-cased denylist terms.
 * @param {boolean} [sourceLink] Whether the line is one of the source links
 *   of a published package manifest ({@link packageSourceLinkLines}); then a
 *   denylist term may stand as the owner segment of its
 *   `https://github.com/<owner>/hudhud` URL, and nowhere else on the line.
 * @returns {{ rule: string, excerpt: string }[]}
 */
export function scanLine(text, denylist, sourceLink = false) {
  /** @type {{ rule: string, excerpt: string }[]} */
  const hits = [];
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      if (rule.isAllowed?.(match) === true) continue;
      hits.push({ rule: rule.id, excerpt: rule.mask(match) });
    }
  }
  const lower = sourceLink
    ? text.toLowerCase().replace(OWNER_SEGMENT, 'github.com/-/hudhud')
    : text.toLowerCase();
  for (const [index, term] of denylist.entries()) {
    if (lower.includes(term)) {
      // Never print the term itself: the denylist is private.
      hits.push({ rule: 'denylist', excerpt: `term #${String(index + 1)}` });
    }
  }
  return hits;
}

/**
 * The owner segment of this repository's GitHub URL, as the source links
 * spell it (lower-cased line): `github.com/<owner>/hudhud`.
 */
const OWNER_SEGMENT = /github\.com\/[a-z0-9](?:[a-z0-9-]{0,38})\/hudhud/gu;

/** A package manifest under `packages/`; group 1 is the package directory. */
const PACKAGE_MANIFEST = /^packages\/([^/]+)\/package\.json$/u;

/**
 * The lines (1-based) of a published package manifest that hold its source
 * links: `repository.url`, `homepage` and `bugs.url` (owner ruling on R6-4,
 * 2026-10-17: the repository owner's GitHub handle is allowed in the
 * package metadata only). A manifest qualifies only when it is
 * `packages/<dir>/package.json`, declares `publishConfig`, and its three
 * links are exactly `git+https://github.com/<owner>/hudhud.git` (with
 * `directory` `packages/<dir>`), `https://github.com/<owner>/hudhud/tree/main/packages/<dir>#readme`
 * and `https://github.com/<owner>/hudhud/issues` with one `<owner>`; each
 * such line must be the field alone on its line and occur once in the file.
 * Anything else gives no line, so the handle stays refused everywhere else.
 *
 * @param {string} path Repository-relative path.
 * @param {string} text The whole file.
 * @returns {Set<number>}
 */
export function packageSourceLinkLines(path, text) {
  /** @type {Set<number>} */
  const allowed = new Set();
  const dir = PACKAGE_MANIFEST.exec(path)?.[1];
  if (dir === undefined) return allowed;
  /** @type {unknown} */
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return allowed;
  }
  /**
   * @param {unknown} value
   * @param {string} key
   * @returns {unknown}
   */
  const field = (value, key) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Reflect.get(value, key)
      : undefined;
  if (field(manifest, 'publishConfig') === undefined) return allowed;
  const repository = field(manifest, 'repository');
  const url = field(repository, 'url');
  const owner =
    typeof url === 'string'
      ? /^git\+https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/hudhud\.git$/u.exec(
          url,
        )?.[1]
      : undefined;
  if (owner === undefined) return allowed;
  const web = `https://github.com/${owner}/hudhud`;
  const homepage = `${web}/tree/main/packages/${dir}#readme`;
  const bugs = `${web}/issues`;
  if (
    field(repository, 'type') !== 'git' ||
    field(repository, 'directory') !== `packages/${dir}` ||
    field(manifest, 'homepage') !== homepage ||
    field(field(manifest, 'bugs'), 'url') !== bugs
  ) {
    return allowed;
  }
  const expected = [
    JSON.stringify({ url }).slice(1, -1).replace('":"', '": "'),
    JSON.stringify({ homepage }).slice(1, -1).replace('":"', '": "'),
    JSON.stringify({ url: bugs }).slice(1, -1).replace('":"', '": "'),
  ];
  const lines = text.split(/\r?\n/u).map((line) => line.trim().replace(/,$/u, ''));
  /** @type {number[]} */
  const found = [];
  for (const wanted of expected) {
    const at = lines.flatMap((line, index) => (line === wanted ? [index + 1] : []));
    if (at.length !== 1) return new Set();
    found.push(/** @type {number} */ (at[0]));
  }
  for (const line of found) allowed.add(line);
  return allowed;
}

/**
 * Replaces every denylist term in `text` with `***` (case-insensitive), so
 * that printed paths and excerpts never reveal a private term.
 *
 * @param {string} text
 * @param {readonly string[]} denylist Lower-cased denylist terms.
 * @returns {string}
 */
export function redact(text, denylist) {
  let result = text;
  for (const term of denylist) {
    let at = result.toLowerCase().indexOf(term);
    while (at !== -1) {
      result = result.slice(0, at) + '***' + result.slice(at + term.length);
      at = result.toLowerCase().indexOf(term, at + 3);
    }
  }
  return result;
}

/**
 * @param {string} path
 * @param {number} line
 * @param {{ rule: string, excerpt: string }} hit
 * @param {readonly string[]} denylist
 * @returns {Finding}
 */
function toFinding(path, line, hit, denylist) {
  return {
    path: redact(path, denylist),
    line,
    rule: hit.rule,
    excerpt: redact(hit.excerpt, denylist),
  };
}

/**
 * Scans a multi-line text: a whole file, so the source links of a published
 * package manifest are recognised ({@link packageSourceLinkLines}).
 *
 * @param {string} path
 * @param {string} text
 * @param {readonly string[]} denylist
 * @returns {Finding[]}
 */
export function scanText(path, text, denylist) {
  const links = packageSourceLinkLines(path, text);
  /** @type {Finding[]} */
  const findings = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    for (const hit of scanLine(line, denylist, links.has(index + 1))) {
      findings.push(toFinding(path, index + 1, hit, denylist));
    }
  }
  return findings;
}

/**
 * Scans a file name (not its content).
 *
 * @param {string} path
 * @param {readonly string[]} denylist
 * @returns {Finding[]}
 */
export function scanPathName(path, denylist) {
  return scanLine(path, denylist).map((hit) => toFinding(path, 0, hit, denylist));
}

/**
 * Scans the added lines of a diff.
 *
 * @param {readonly AddedLine[]} lines
 * @param {readonly string[]} denylist
 * @param {ReadonlyMap<string, ReadonlySet<number>>} [sourceLinks] Per path,
 *   the source-link lines of the staged file ({@link packageSourceLinkLines}
 *   of its whole staged content); none by default.
 * @returns {Finding[]}
 */
export function scanAddedLines(lines, denylist, sourceLinks = new Map()) {
  return lines.flatMap(({ path, line, text }) =>
    scanLine(text, denylist, sourceLinks.get(path)?.has(line) === true).map((hit) =>
      toFinding(path, line, hit, denylist),
    ),
  );
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

/**
 * Extracts the added lines from `git diff` output produced with
 * `--no-color --no-ext-diff --unified=0` and `core.quotePath=false`.
 *
 * @param {string} diff
 * @returns {AddedLine[]}
 */
export function parseAddedLines(diff) {
  /** @type {AddedLine[]} */
  const added = [];
  // A deleted file (`+++ /dev/null`) has no added lines, so its empty path is
  // never reported.
  let path = '';
  let inHunk = false;
  let next = 0;
  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      path = '';
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('+++ ')) {
        const target = line.slice(4).replace(/\t$/u, '');
        path = target === '/dev/null' ? '' : target.replace(/^b\//u, '');
        continue;
      }
      const hunk = HUNK_HEADER.exec(line);
      if (hunk !== null) {
        inHunk = true;
        next = Number(hunk[1]);
      }
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk !== null) {
      next = Number(hunk[1]);
      continue;
    }
    if (line.startsWith('+')) {
      added.push({ path, line: next, text: line.slice(1) });
      next += 1;
    } else if (line.startsWith(' ')) {
      next += 1;
    }
  }
  return added;
}

/**
 * Formats findings for humans. Excerpts are already masked.
 *
 * @param {readonly Finding[]} findings
 * @returns {string}
 */
export function formatFindings(findings) {
  return findings
    .map(
      (f) => `${f.path}:${f.line === 0 ? '(file name)' : String(f.line)}: [${f.rule}] ${f.excerpt}`,
    )
    .join('\n');
}
