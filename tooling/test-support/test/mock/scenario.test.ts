import { describe, expect, it } from 'vitest';

import { findScenario, isRecord, textOf, toolResultsOf } from '../../src/mock/scenario.js';

const toolUse = { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash' }] };
const toolResult = (text: string, extra: Record<string, unknown> = {}): unknown => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: text, ...extra }],
});
// What CLI 2.1.296 appends after a tool result (D16, 05 §2).
const trailingSystem = { role: 'system', content: '<total_tokens>1000 tokens left</total_tokens>' };

describe('findScenario', () => {
  it('returns undefined without a marker', () => {
    expect(findScenario([])).toBeUndefined();
    expect(findScenario([{ role: 'user', content: 'hello' }, 'junk', null, 42])).toBeUndefined();
  });

  it('parses name and arguments from string content', () => {
    const scenario = findScenario([
      { role: 'user', content: 'please [[mock:ERRN status=529 n=2 key=a N=3 n=4]] now' },
    ]);
    expect(scenario?.name).toBe('errn');
    expect(Object.fromEntries(scenario?.args ?? [])).toEqual({ status: '529', key: 'a', n: '4' });
    expect(scenario?.step).toBe(0);
    expect(scenario?.userText).toBe('please  now');
    expect(scenario?.toolResults).toEqual([]);
  });

  it('accepts a marker without arguments and with empty values', () => {
    expect(
      Object.fromEntries(
        findScenario([{ role: 'user', content: '[[mock:hang]]' }])?.args ?? [[1, 2]],
      ),
    ).toEqual({});
    expect(findScenario([{ role: 'user', content: '[[mock:text t=]]' }])?.args.get('t')).toBe('');
  });

  it('reads markers from text blocks only', () => {
    const scenario = findScenario([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'first' },
          { type: 'image', source: {} },
          { type: 'text', text: '[[mock:echo]] second' },
        ],
      },
    ]);
    expect(scenario?.name).toBe('echo');
    expect(scenario?.userText).toBe('first\n second');
  });

  it('ignores markers in tool results, assistant and system messages', () => {
    expect(
      findScenario([
        { role: 'assistant', content: '[[mock:hang]]' },
        { role: 'system', content: '[[mock:hang]]' },
        toolResult('[[mock:hang]]'),
      ]),
    ).toBeUndefined();
  });

  it('picks the most recent marked user message', () => {
    const scenario = findScenario([
      { role: 'user', content: '[[mock:text]]' },
      { role: 'assistant', content: 'x' },
      { role: 'user', content: '[[mock:echo]] again' },
    ]);
    expect(scenario?.name).toBe('echo');
    expect(scenario?.step).toBe(0);
  });

  it('counts assistant messages after the marker as the step', () => {
    const scenario = findScenario([
      { role: 'user', content: '[[mock:loop]]' },
      toolUse,
      toolResult('one'),
      toolUse,
      toolResult('two'),
    ]);
    expect(scenario?.step).toBe(2);
    expect(scenario?.toolResults.map((result) => result.text)).toEqual(['two']);
  });

  it('does not assume the last message is the user (trailing system message, D16)', () => {
    const scenario = findScenario([
      { role: 'user', content: '[[mock:bash cmd=ZWNobyBoaQ==]]' },
      toolUse,
      toolResult('hi'),
      trailingSystem,
    ]);
    expect(scenario?.name).toBe('bash');
    expect(scenario?.step).toBe(1);
    expect(scenario?.toolResults).toEqual([{ toolUseId: 'toolu_1', isError: false, text: 'hi' }]);
  });

  it('skips later user messages without tool results when collecting them', () => {
    const scenario = findScenario([
      { role: 'user', content: '[[mock:loop]]' },
      toolUse,
      toolResult('r'),
      { role: 'user', content: 'plain follow-up' },
    ]);
    expect(scenario?.toolResults.map((result) => result.text)).toEqual(['r']);
  });
});

describe('content helpers', () => {
  it('isRecord', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  it('textOf', () => {
    expect(textOf('s')).toBe('s');
    expect(textOf(undefined)).toBe('');
    expect(
      textOf([
        { type: 'text', text: 'a' },
        { type: 'text', text: 1 },
        'x',
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb');
  });

  it('toolResultsOf flattens content and marks errors', () => {
    expect(
      toolResultsOf([
        {
          type: 'tool_result',
          tool_use_id: 't1',
          is_error: true,
          content: [{ type: 'text', text: 'a' }, { type: 'image' }, { text: 'no type' }],
        },
        { type: 'tool_result', content: 7 },
        { type: 'text', text: 'not a result' },
      ]),
    ).toEqual([
      { toolUseId: 't1', isError: true, text: 'a[image][unknown]' },
      { toolUseId: '', isError: false, text: '' },
    ]);
    expect(toolResultsOf('string content')).toEqual([]);
  });
});
