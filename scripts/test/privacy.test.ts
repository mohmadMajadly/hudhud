import { describe, expect, it } from 'vitest';

import {
  FAKE_ANTHROPIC_KEY_PREFIX,
  MIN_DENYLIST_TERM_LENGTH,
  formatFindings,
  parseAddedLines,
  parseDenylist,
  redact,
  scanAddedLines,
  scanLine,
  scanPathName,
  scanText,
} from '../lib/privacy.mjs';

// Fixtures are assembled at run time so that this file itself passes the
// tree scan without any allowlist entry for it.
const join = (...parts: string[]): string => parts.join('');
const FAKE = {
  windowsHome: join('C:', '\\Users\\', 'alice', '\\project'),
  windowsHomeEscaped: join('"C:', '\\\\Users\\\\', 'alice', '\\\\x"'),
  windowsHomeSlash: join('c:', '/users/', 'alice', '/x'),
  msysHome: join('/c/', 'Users/', 'alice', '/x'),
  wslHome: join('/mnt/c/', 'Users/', 'alice', '/x'),
  macHome: join('cd ', '/Users/', 'alice', '/src'),
  linuxHome: join('HOME=', '/home/', 'alice'),
  email: join('alice', '@', 'example.com'),
  anthropicKey: join('sk-', 'ant-', 'api03-', 'a'.repeat(40)),
  githubClassic: join('gh', 'p_', 'A'.repeat(36)),
  githubOauth: join('gh', 'o_', 'B'.repeat(36)),
  githubFineGrained: join('github', '_pat_', 'C'.repeat(30)),
  awsKeyId: join('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
  privateKey: join('-----BEGIN ', 'OPENSSH PRIVATE', ' KEY-----'),
  npmToken: join('np', 'm_', 'd'.repeat(36)),
  npmrc: join('//registry.npmjs.org/:_auth', 'Token=', 'abcdef123456'),
  slack: join('xo', 'xb-', '1234567890-abc'),
  google: join('AI', 'za', 'e'.repeat(35)),
};

const rulesOf = (text: string, denylist: readonly string[] = []): string[] =>
  scanLine(text, denylist).map((hit) => hit.rule);

describe('scanLine: true positives', () => {
  it.each([
    ['Windows home path', FAKE.windowsHome, 'home-path-windows'],
    ['JSON-escaped Windows home path', FAKE.windowsHomeEscaped, 'home-path-windows'],
    ['lower-case Windows home path with slashes', FAKE.windowsHomeSlash, 'home-path-windows'],
    ['MSYS home path', FAKE.msysHome, 'home-path-msys-wsl'],
    ['WSL home path', FAKE.wslHome, 'home-path-msys-wsl'],
    ['macOS home path', FAKE.macHome, 'home-path-macos'],
    ['Linux home path', FAKE.linuxHome, 'home-path-linux'],
    ['e-mail address', `contact ${FAKE.email}`, 'email'],
    ['Anthropic API key', FAKE.anthropicKey, 'anthropic-key'],
    ['GitHub classic token', FAKE.githubClassic, 'github-token'],
    ['GitHub OAuth token', FAKE.githubOauth, 'github-token'],
    ['GitHub fine-grained token', FAKE.githubFineGrained, 'github-fine-grained-token'],
    ['AWS access key id', FAKE.awsKeyId, 'aws-access-key-id'],
    ['private key header', FAKE.privateKey, 'private-key'],
    ['npm token', FAKE.npmToken, 'npm-token'],
    ['.npmrc literal auth token', FAKE.npmrc, 'npmrc-auth-token'],
    ['Slack token', FAKE.slack, 'slack-token'],
    ['Google API key', FAKE.google, 'google-api-key'],
  ])('flags a %s', (_name, text, rule) => {
    expect(rulesOf(text)).toEqual([rule]);
  });

  it('flags denylist terms case-insensitively without printing them', () => {
    const hits = scanLine('Written by Secret-Handle', ['secret-handle']);
    expect(hits).toEqual([{ rule: 'denylist', excerpt: 'term #1' }]);
    expect(scanLine('Written by someone else', ['secret-handle'])).toEqual([]);
  });

  it('masks what it reports', () => {
    const [home] = scanLine(FAKE.windowsHome, []);
    expect(home?.excerpt).not.toContain('alice');
    const [email] = scanLine(FAKE.email, []);
    expect(email?.excerpt).toBe('***@example.com');
    const [token] = scanLine(FAKE.anthropicKey, []);
    expect(token?.excerpt).not.toContain('a'.repeat(10));
  });
});

describe('scanLine: the fake Anthropic key prefix (W2-Z ruling G)', () => {
  it('is exactly sk-ant-fake-hudhud-', () => {
    expect(FAKE_ANTHROPIC_KEY_PREFIX).toBe(join('sk-', 'ant-', 'fake-', 'hudhud-'));
  });

  it.each([
    ['a real-shaped key', join('sk-', 'ant-', 'api03-', 'b'.repeat(40))],
    ['another fake-looking prefix', join('sk-', 'ant-', 'fake-', 'other-', 'c'.repeat(20))],
    ['the prefix without its last hyphen', join('sk-', 'ant-', 'fake-', 'hudhudx', 'd'.repeat(20))],
    [
      'a real key behind the prefix',
      join(FAKE_ANTHROPIC_KEY_PREFIX, 'sk-', 'ant-', 'api03-', 'e'.repeat(30)),
    ],
    ['a hyphenated tail after the prefix', join(FAKE_ANTHROPIC_KEY_PREFIX, 'abc-', 'f'.repeat(20))],
  ])('still flags %s', (_name, text) => {
    expect(rulesOf(text)).toEqual(['anthropic-key']);
  });

  it('allows the prefix followed by letters and digits only', () => {
    expect(rulesOf(join(FAKE_ANTHROPIC_KEY_PREFIX, 'Abc123'))).toEqual([]);
    expect(rulesOf(`ANTHROPIC_API_KEY=${join(FAKE_ANTHROPIC_KEY_PREFIX, 'x9')} next`)).toEqual([]);
  });
});

describe('scanLine: allowed negatives', () => {
  it.each([
    ['the Anthropic co-author address', 'Co-Authored-By: Claude <noreply@anthropic.com>'],
    ['a GitHub noreply address', join('12345+someone', '@', 'users.noreply.github.com')],
    ['placeholder home paths', 'C:\\Users\\<name>\\x and /home/<user>/x and /Users/$USER/x'],
    [
      'environment-variable home paths',
      '%USERPROFILE%\\x C:\\Users\\%USERNAME%\\x /home/${USER}/x',
    ],
    ['CI and container accounts', '/home/runner/work C:\\Users\\runneradmin\\x /home/node/app'],
    ['shared Windows profiles', 'C:\\Users\\Public\\x C:\\Users\\Default\\x'],
    ['relative or URL paths', '<run>/home/AppData https://example.org/home/page ./home/x'],
    ['package specifiers', '@hudhudjs/core@1.0.0 pnpm@11.24.0 actions/checkout@v7'],
    ['token prefixes in prose', 'keys look like sk-ant-... and ghp_...'],
    ['the test-support fake key', join('sk-ant-', 'fake-hudhud-', 'NotACredential0123456789')],
    ['an npmrc token from the environment', '//registry.npmjs.org/:_authToken=${NPM_TOKEN}'],
    ['an empty line', ''],
  ])('allows %s', (_name, text) => {
    expect(rulesOf(text)).toEqual([]);
  });
});

describe('parseDenylist', () => {
  it('ignores comments and blank lines and lower-cases terms', () => {
    expect(parseDenylist('# comment\n\nAlice-Handle  # trailing\r\nbob\n')).toEqual([
      'alice-handle',
      'bob',
    ]);
  });

  it('rejects terms that would match almost everything', () => {
    expect(() => parseDenylist('ok-term\nab\n')).toThrow(
      `denylist line 2: terms must be at least ${String(MIN_DENYLIST_TERM_LENGTH)} characters`,
    );
  });
});

describe('scanText and scanPathName', () => {
  it('reports 1-based line numbers', () => {
    expect(scanText('a.txt', `ok\r\n${FAKE.email}\n`, [])).toEqual([
      { path: 'a.txt', line: 2, rule: 'email', excerpt: '***@example.com' },
    ]);
  });

  it('scans file names and redacts denylist terms from the reported path', () => {
    expect(scanPathName('notes/Secret-Handle.md', ['secret-handle'])).toEqual([
      { path: 'notes/***.md', line: 0, rule: 'denylist', excerpt: 'term #1' },
    ]);
  });

  it('redacts every occurrence of every term, case-insensitively', () => {
    expect(redact('abcXYZabc-xyz', ['abc', 'xyz'])).toBe('*********-***');
    expect(redact('nothing here', ['abc'])).toBe('nothing here');
    expect(redact('aaaa', ['aa'])).toBe('******');
  });

  it('redacts denylist terms from other rules’ excerpts', () => {
    const [hit] = scanText('f', join('ok ', 'x', '@', 'secret-handle.org'), [
      'secret-handle',
    ]).filter((finding) => finding.rule === 'email');
    expect(hit?.excerpt).toBe('***@***.org');
  });

  it('formats findings', () => {
    expect(
      formatFindings([
        { path: 'a', line: 0, rule: 'denylist', excerpt: 'term #1' },
        { path: 'b', line: 3, rule: 'email', excerpt: '***@x.org' },
      ]),
    ).toBe('a:(file name): [denylist] term #1\nb:3: [email] ***@x.org');
  });
});

describe('parseAddedLines', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,0 +2,2 @@',
    '+first',
    '++++ looks like a header but is content',
    '@@ -10 +12 @@',
    '-removed',
    '+replaced',
    '\\ No newline at end of file',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/with space.md b/with space.md',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/with space.md\t',
    '@@ -0,0 +1 @@',
    '+hello\r',
    ' context line',
    '+after context',
  ].join('\n');

  it('returns added lines with their new line numbers', () => {
    expect(parseAddedLines(diff)).toEqual([
      { path: 'src/a.ts', line: 2, text: 'first' },
      { path: 'src/a.ts', line: 3, text: '+++ looks like a header but is content' },
      { path: 'src/a.ts', line: 12, text: 'replaced' },
      { path: 'with space.md', line: 1, text: 'hello' },
      { path: 'with space.md', line: 3, text: 'after context' },
    ]);
  });

  it('feeds the scanner', () => {
    expect(scanAddedLines([{ path: 'x', line: 7, text: FAKE.email }], [])).toEqual([
      { path: 'x', line: 7, rule: 'email', excerpt: '***@example.com' },
    ]);
  });
});
