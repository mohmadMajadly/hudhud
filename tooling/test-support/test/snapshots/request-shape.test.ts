import { describe, expect, it } from 'vitest';

import { FAKE_API_KEY } from '../../src/launcher/env.js';
import {
  compareShapes,
  compareSnapshots,
  enforceVerdict,
  findLeaks,
  formatFindings,
  judgeSnapshot,
  parseSnapshot,
  RequestShapeError,
  SAME_TOOLS_PLACEHOLDER,
  serializeSnapshot,
  ShapeBuilder,
  shapeContext,
  SnapshotFormatError,
  snapshotOf,
  updateRequested,
  UPDATE_ENV,
  type RequestShapeSnapshot,
  type ShapeInput,
  type ShapeSandbox,
  type ShapeValue,
} from '../../src/snapshots/request-shape.js';

// A key-shaped string assembled at run time (the privacy scan refuses the
// shape in source text).
const KEY_SHAPED = ['sk', 'ant', 'api03', 'abc_DEF'].join('-');

const SANDBOX: ShapeSandbox = {
  dirs: {
    root: 'D:\\t\\hudhud-it-ab\\sb1',
    home: 'D:\\t\\hudhud-it-ab\\sb1\\home',
    cfg: 'D:\\t\\hudhud-it-ab\\sb1\\cfg',
    tmp: 'D:\\t\\hudhud-it-ab\\sb1\\tmp',
    work: 'D:\\t\\hudhud-it-ab\\sb1\\work',
    appData: 'D:\\t\\hudhud-it-ab\\sb1\\appdata',
    localAppData: 'D:\\t\\hudhud-it-ab\\sb1\\localappdata',
  },
  cli: { binaryPath: 'D:\\cache\\2.1.296\\claude.exe', version: '2.1.296' },
  mockUrl: 'http://127.0.0.1:5555',
};

const CONTEXT = shapeContext(SANDBOX, [FAKE_API_KEY]);

const UUID = '7dabd554-dc40-48ea-b0d3-10301e5985be';

function request(overrides: Partial<ShapeInput> = {}): ShapeInput {
  return {
    method: 'POST',
    target: '/v1/messages?beta=true',
    headers: {
      accept: 'application/json',
      'anthropic-beta': 'b-two, b-one,b-two,',
      'content-length': '1234',
      host: '127.0.0.1:5555',
      connection: 'keep-alive',
      'accept-encoding': 'gzip',
      'user-agent': 'claude-cli/2.1.296 (external, sdk-cli)',
      'x-api-key': '<redacted>',
      'x-claude-code-session-id': UUID,
      'x-stainless-os': 'Windows',
      'x-stainless-arch': 'x64',
      'x-stainless-runtime-version': 'v26.3.0',
      'x-stainless-package-version': '0.128.0',
      'X-Mixed-Case': 'D:\\t\\hudhud-it-ab\\sb1\\work',
    },
    body: {
      model: 'claude-opus-5-5',
      stream: true,
      max_tokens: 128000,
      temperature: 0.5,
      metadata: { user_id: `{"session_id":"${UUID}"}` },
      messages: [
        { role: 'user', content: 'hello D:\\t\\hudhud-it-ab\\sb1\\work' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: 'x' },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: null },
          ],
        },
      ],
      tools: [
        {
          name: 'Bash',
          description: 'Runs a command',
          input_schema: {
            type: 'object',
            required: ['command', 'a', 'command'],
            properties: { mode: { type: 'string', enum: ['x', 'y'], minimum: 3 } },
          },
        },
        { name: 'Read', description: 'Reads' },
        { name: 'Read', description: 'Reads again' },
      ],
      stop_sequences: ['stop'],
      mixed_tools: [{ name: 1 }, 'x'],
    },
    ...overrides,
  };
}

describe('ShapeBuilder', () => {
  const shape = new ShapeBuilder(CONTEXT).request(request());

  it('keeps method and target, normalizing the target', () => {
    expect(shape.method).toBe('POST');
    expect(shape.target).toBe('/v1/messages?beta=true');
    const other = new ShapeBuilder(CONTEXT).request(request({ target: `/p/${UUID}?x=1` }));
    expect(other.target).toBe('/p/<uuid-1>?x=1');
  });

  it('drops transport headers, blanks platform headers, sets the beta values, normalizes the rest', () => {
    expect(shape.headers).toEqual({
      accept: 'application/json',
      'anthropic-beta': { $set: ['b-one', 'b-two'] },
      'user-agent': 'claude-cli/<version> (external, sdk-cli)',
      'x-api-key': '<redacted>',
      'x-claude-code-session-id': '<uuid-1>',
      'x-mixed-case': '<work>',
      'x-stainless-arch': '<string>',
      'x-stainless-os': '<string>',
      'x-stainless-package-version': '<string>',
      'x-stainless-runtime-version': '<string>',
    });
  });

  it('keeps structure, discriminators and settings and abstracts the rest', () => {
    const body = shape.body as Record<string, ShapeValue>;
    expect(body['model']).toBe('claude-opus-5-5');
    expect(body['stream']).toBe(true);
    expect(body['max_tokens']).toBe(128000);
    expect(body['temperature']).toBe(0.5);
    expect(body['metadata']).toEqual({ user_id: '<string>' });
    expect(body['stop_sequences']).toEqual(['<string>']);
    expect(body['mixed_tools']).toEqual([{ name: '<number>' }, '<string>']);
    expect(Object.keys(body)).toEqual([...Object.keys(body)].sort());
  });

  it('numbers ids by first appearance so correlations survive', () => {
    const body = shape.body as { messages: Record<string, unknown>[] };
    expect(body.messages[0]).toEqual({ role: 'user', content: '<string>' });
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: '<id-1>', name: 'Bash', input: { command: '<string>' } }],
    });
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: '<id-1>', is_error: false, content: '<string>' },
        { type: 'tool_result', tool_use_id: '<id-2>', content: null },
      ],
    });
  });

  it('stores tools as a map by name and string lists of a schema as sets', () => {
    const body = shape.body as { tools: Record<string, ShapeValue> };
    expect(Object.keys(body.tools)).toEqual(['Bash', 'Read', 'Read#2']);
    expect(body.tools['Bash']).toEqual({
      description: '<string>',
      input_schema: {
        properties: {
          mode: { enum: { $set: ['x', 'y'] }, minimum: '<number>', type: 'string' },
        },
        required: { $set: ['a', 'command'] },
        type: 'object',
      },
      name: 'Bash',
    });
  });

  it('shares the id and uuid numbering across the requests of one builder', () => {
    const builder = new ShapeBuilder(CONTEXT);
    builder.request(request());
    const second = builder.request(request());
    expect(second.headers['x-claude-code-session-id']).toBe('<uuid-1>');
    const body = second.body as { messages: { content: { id?: string }[] }[] };
    expect(body.messages[1]?.content[0]?.id).toBe('<id-1>');
  });

  it('marks a body that was not JSON and a value JSON cannot carry', () => {
    expect(new ShapeBuilder(CONTEXT).request(request({ body: undefined })).body).toBe('<not-json>');
    expect(new ShapeBuilder(CONTEXT).request(request({ body: { a: undefined } })).body).toEqual({
      a: '<unsupported>',
    });
  });

  it('keeps no secret, sandbox path or key whatever string they reach', () => {
    const hostile = new ShapeBuilder(CONTEXT).request(
      request({
        headers: { 'x-extra': `${FAKE_API_KEY} ${KEY_SHAPED} D:/t/hudhud-it-ab/sb1/cfg` },
        body: { model: FAKE_API_KEY, type: 'D:\\t\\hudhud-it-ab\\sb1\\home\\x' },
      }),
    );
    const text = JSON.stringify(hostile);
    expect(text).toContain('<redacted> <redacted> <cfg>');
    expect(text).toContain('<home>');
    expect(findLeaks(text, [FAKE_API_KEY, SANDBOX.dirs.root])).toEqual([]);
  });
});

describe('snapshotOf', () => {
  it('shapes each request with one shared builder', () => {
    const snapshot = snapshotOf('text-turn', [request(), request()], CONTEXT);
    expect(snapshot.format).toBe(1);
    expect(snapshot.scenario).toBe('text-turn');
    expect(snapshot.requests).toHaveLength(2);
  });

  const toolsOf = (snapshot: RequestShapeSnapshot): unknown[] =>
    snapshot.requests.map((item) => (item.body as { tools?: unknown }).tools);

  it('replaces the tools of a later request that equal the first requests', () => {
    const different = request({ body: { tools: [{ name: 'Other' }] } });
    const snapshot = snapshotOf('s', [request(), request(), different, request()], CONTEXT);
    const tools = toolsOf(snapshot);
    expect(tools[0]).toHaveProperty('Bash');
    expect(tools[1]).toBe(SAME_TOOLS_PLACEHOLDER);
    expect(tools[2]).toEqual({ Other: { name: 'Other' } });
    expect(tools[3]).toBe(SAME_TOOLS_PLACEHOLDER);
  });

  it('shares nothing when the first request has no tools or no JSON body, or there is none', () => {
    const noTools = request({ body: { model: 'm' } });
    expect(toolsOf(snapshotOf('s', [noTools, request()], CONTEXT))[1]).toHaveProperty('Bash');
    const notJson = request({ body: undefined });
    expect(toolsOf(snapshotOf('s', [notJson, request()], CONTEXT))[1]).toHaveProperty('Bash');
    expect(snapshotOf('s', [], CONTEXT).requests).toEqual([]);
  });

  it('leaves a later request without a JSON body alone', () => {
    const snapshot = snapshotOf('s', [request(), request({ body: undefined })], CONTEXT);
    expect(snapshot.requests[1]?.body).toBe('<not-json>');
  });
});

describe('shapeContext', () => {
  it('uses the tokens of the golden fixtures and the sandbox facts', () => {
    expect(CONTEXT.paths.map((entry) => entry.token)).toEqual([
      '<bin>',
      '<work>',
      '<tmp>',
      '<cfg>',
      '<localappdata>',
      '<appdata>',
      '<home>',
      '<root>',
      '<mock>',
    ]);
    expect(CONTEXT.version).toBe('2.1.296');
    expect(CONTEXT.cwd).toBe(SANDBOX.dirs.work);
    expect(CONTEXT.secrets).toEqual([FAKE_API_KEY]);
    expect(CONTEXT.pids).toEqual([]);
  });
});

describe('compareShapes', () => {
  const base: ShapeValue = {
    keep: 'a',
    gone: 1,
    nested: { x: true, list: ['p', 'q'] },
    set: { $set: ['one', 'two'] },
  };

  it('finds nothing in equal shapes', () => {
    expect(compareShapes(base, base)).toEqual({ failures: [], warnings: [] });
  });

  it('fails on a removed key and warns on an added key, at any depth', () => {
    const actual: ShapeValue = {
      keep: 'a',
      nested: { x: true, list: ['p', 'q'], extra: 'new' },
      set: { $set: ['one', 'two'] },
      added: { deep: 1 },
    };
    const result = compareShapes(base, actual);
    expect(result.failures).toEqual([{ path: '/gone', kind: 'removed', expected: '1' }]);
    expect(result.warnings).toEqual([
      { path: '/nested/extra', kind: 'added', actual: '"new"' },
      { path: '/added', kind: 'added', actual: '{"deep":1}' },
    ]);
  });

  it('fails on a changed literal and on a changed type', () => {
    const actual: ShapeValue = {
      keep: 'b',
      gone: '1',
      nested: [],
      set: { $set: ['one', 'two'] },
    };
    expect(compareShapes(base, actual).failures).toEqual([
      { path: '/keep', kind: 'changed', expected: '"a"', actual: '"b"' },
      { path: '/gone', kind: 'type', expected: '1', actual: '"1"' },
      { path: '/nested', kind: 'type', expected: '{"x":true,"list":["p","q"]}', actual: '[]' },
    ]);
  });

  it('tells null, array, set, object and scalar types apart', () => {
    const kinds: ShapeValue[] = [null, [], { $set: [] }, {}, 'x', 1, true];
    for (const [i, a] of kinds.entries()) {
      for (const [j, b] of kinds.entries()) {
        const result = compareShapes(a, b);
        if (i === j) expect(result.failures).toEqual([]);
        else {
          expect(result.failures[0]?.kind).toMatch(/type|changed/);
        }
      }
    }
    // Only an object with the single key `$set` holding an array is a set.
    for (const lookalike of [{ $set: [], other: 1 }, { other: [] }, { $set: 'x' }]) {
      expect(compareShapes(lookalike, { $set: [] }).failures[0]?.kind).toBe('type');
    }
  });

  it('fails on a removed set member and warns on an added one', () => {
    const result = compareShapes({ $set: ['a', 'b'] }, { $set: ['b', 'c'] });
    expect(result.failures).toEqual([{ path: '/a', kind: 'removed', expected: '"a"' }]);
    expect(result.warnings).toEqual([{ path: '/c', kind: 'added', actual: '"c"' }]);
  });

  it('fails on a different array length and still compares the common prefix', () => {
    const result = compareShapes(['a', 'b', 'c'], ['a', 'x']);
    expect(result.failures).toEqual([
      { path: '', kind: 'length', expected: '3', actual: '2' },
      { path: '/1', kind: 'changed', expected: '"b"', actual: '"x"' },
    ]);
  });

  it('escapes pointer segments and bounds long values', () => {
    const long = 'z'.repeat(300);
    const result = compareShapes({ 'a/b~c': long }, {});
    expect(result.failures[0]?.path).toBe('/a~1b~0c');
    expect(result.failures[0]?.expected).toHaveLength(123);
    expect(result.failures[0]?.expected?.endsWith('...')).toBe(true);
  });
});

describe('compareSnapshots and formatFindings', () => {
  it('fails when the number of requests differs', () => {
    const one = snapshotOf('s', [request()], CONTEXT);
    const two = snapshotOf('s', [request(), request()], CONTEXT);
    expect(compareSnapshots(one, one)).toEqual({ failures: [], warnings: [] });
    const result = compareSnapshots(one, two);
    expect(result.failures).toEqual([
      { path: '/requests', kind: 'length', expected: '1', actual: '2' },
    ]);
  });

  it('names every kind of finding on its own line', () => {
    const text = formatFindings([
      { path: '', kind: 'length', expected: '1', actual: '2' },
      { path: '/a', kind: 'removed', expected: '1' },
      { path: '/b', kind: 'added', actual: '2' },
      { path: '/c', kind: 'changed', expected: '"x"', actual: '"y"' },
      { path: '/d', kind: 'removed' },
      { path: '/e', kind: 'added' },
      { path: '/f', kind: 'type' },
    ]);
    expect(text.split('\n')).toEqual([
      '/: length: expected 1, got 2',
      '/a: removed (was 1)',
      '/b: added (2)',
      '/c: changed: expected "x", got "y"',
      '/d: removed (was ?)',
      '/e: added (?)',
      '/f: type: expected ?, got ?',
    ]);
  });
});

describe('serializeSnapshot and parseSnapshot', () => {
  const snapshot = snapshotOf('text-turn', [request()], CONTEXT);

  it('round-trips through two-space JSON with a trailing newline', () => {
    const text = serializeSnapshot(snapshot);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "scenario": "text-turn"');
    expect(parseSnapshot(text)).toEqual(snapshot);
  });

  it.each([
    ['not json', 'nope', 'not valid JSON'],
    ['not an object', '[]', 'not format 1'],
    ['another format', '{"format":2}', 'not format 1'],
    ['no scenario', '{"format":1,"requests":[]}', 'no scenario name or request list'],
    ['no requests', '{"format":1,"scenario":"s"}', 'no scenario name or request list'],
    ['a request that is not an object', '{"format":1,"scenario":"s","requests":[1]}', 'malformed'],
    [
      'a request without method',
      '{"format":1,"scenario":"s","requests":[{"target":"/","headers":{},"body":null}]}',
      'malformed',
    ],
    [
      'a request without target',
      '{"format":1,"scenario":"s","requests":[{"method":"POST","headers":{},"body":null}]}',
      'malformed',
    ],
    [
      'a request without headers',
      '{"format":1,"scenario":"s","requests":[{"method":"POST","target":"/","body":null}]}',
      'malformed',
    ],
    [
      'a request without body',
      '{"format":1,"scenario":"s","requests":[{"method":"POST","target":"/","headers":{}}]}',
      'malformed',
    ],
  ])('refuses %s', (_name, text, message) => {
    expect(() => parseSnapshot(text)).toThrow(SnapshotFormatError);
    expect(() => parseSnapshot(text)).toThrow(message);
  });
});

describe('judgeSnapshot', () => {
  const committed = snapshotOf('text-turn', [request()], CONTEXT);
  const text = serializeSnapshot(committed);

  it('reports a missing file, an unreadable file and the wrong scenario', () => {
    expect(judgeSnapshot(undefined, committed)).toEqual({ status: 'missing' });
    expect(judgeSnapshot('nope', committed)).toEqual({
      status: 'invalid',
      reason: 'the snapshot is not valid JSON',
    });
    expect(judgeSnapshot(text, { ...committed, scenario: 'other' })).toEqual({
      status: 'invalid',
      reason: 'the snapshot is for scenario text-turn, not other',
    });
  });

  it('matches an equal snapshot', () => {
    expect(judgeSnapshot(text, committed)).toEqual({ status: 'match' });
  });

  it('warns on an additive change only', () => {
    const added = snapshotOf(
      'text-turn',
      [request({ headers: { ...request().headers, 'x-new': 'v' } })],
      CONTEXT,
    );
    const verdict = judgeSnapshot(text, added);
    expect(verdict).toMatchObject({ status: 'additive' });
    expect(verdict.status === 'additive' && verdict.warnings.map((w) => w.path)).toEqual([
      '/requests/0/headers/x-new',
    ]);
  });

  it('fails on a semantic change and still lists the additive ones', () => {
    const changed: RequestShapeSnapshot = snapshotOf(
      'text-turn',
      [
        request({
          headers: { ...request().headers, 'x-new': 'v' },
          body: { model: 'other' },
        }),
      ],
      CONTEXT,
    );
    const verdict = judgeSnapshot(text, changed);
    expect(verdict.status).toBe('semantic');
    if (verdict.status === 'semantic') {
      expect(verdict.failures.length).toBeGreaterThan(0);
      expect(verdict.warnings.map((w) => w.path)).toEqual(['/requests/0/headers/x-new']);
    }
  });
});

describe('enforceVerdict', () => {
  const finding = { path: '/a', kind: 'removed', expected: '1' } as const;

  it('passes a match silently and returns the warning of an additive change', () => {
    expect(enforceVerdict('s', { status: 'match' })).toBeUndefined();
    expect(
      enforceVerdict('s', {
        status: 'additive',
        warnings: [{ path: '/b', kind: 'added', actual: '2' }],
      }),
    ).toBe('request-shape s: additive change (review at the next CLI bump)\n/b: added (2)');
  });

  it('throws a RequestShapeError for everything else', () => {
    const semantic = (): unknown =>
      enforceVerdict('s', { status: 'semantic', failures: [finding], warnings: [] });
    expect(semantic).toThrow(RequestShapeError);
    expect(semantic).toThrow('request-shape s: semantic change\n/a: removed (was 1)');
    try {
      semantic();
    } catch (error) {
      expect((error as RequestShapeError).name).toBe('RequestShapeError');
      expect((error as RequestShapeError).findings).toEqual([finding]);
    }
    expect(() => enforceVerdict('s', { status: 'missing' })).toThrow(
      `no committed snapshot; write it with ${UPDATE_ENV}=1`,
    );
    expect(() => enforceVerdict('s', { status: 'invalid', reason: 'bad' })).toThrow(
      'request-shape s: bad',
    );
    expect(new RequestShapeError('x').findings).toEqual([]);
  });
});

describe('findLeaks', () => {
  it('finds forbidden strings in any spelling without repeating them', () => {
    const forbidden = ['D:\\t\\hudhud-it-ab\\sb1', 'secret-value'];
    expect(findLeaks('{"p":"D:/t/hudhud-it-ab/sb1/x"}', forbidden)).toContain(
      'forbidden string #1',
    );
    expect(findLeaks(JSON.stringify({ p: forbidden[0] }), forbidden)).toContain(
      'forbidden string #1',
    );
    expect(findLeaks('has SECRET-VALUE inside', forbidden)).toEqual(['forbidden string #2']);
    expect(findLeaks('nothing here', ['', ...forbidden])).toEqual([]);
  });

  it('finds keys, drive paths and home directory paths', () => {
    expect(findLeaks(`k ${KEY_SHAPED}`, [])).toEqual(['an Anthropic key']);
    expect(findLeaks('at C:\\x and at c:/y', [])).toEqual(['a Windows drive path']);
    // Assembled at run time: the privacy scan refuses these shapes in source text.
    for (const root of ['home', 'Users']) {
      expect(findLeaks(`see /${root}/someone/x`, [])).toEqual(['a home directory path']);
    }
  });

  it('does not take URLs, words with a colon or plain slashes for paths', () => {
    expect(findLeaks('https://example.org/a b:c a/b /home/ /Users/', [])).toEqual([]);
    expect(findLeaks('{"url":"http://127.0.0.1:5555/x"}', [])).toEqual([]);
  });
});

describe('updateRequested', () => {
  it('is on only for the value 1', () => {
    expect(updateRequested({ [UPDATE_ENV]: '1' })).toBe(true);
    expect(updateRequested({ [UPDATE_ENV]: 'true' })).toBe(false);
    expect(updateRequested({})).toBe(false);
  });
});
