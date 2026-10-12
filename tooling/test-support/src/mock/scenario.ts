/**
 * Scenario markers in Messages API requests (ADR-0013 §7; plan §1.11).
 *
 * @remarks
 * A test scripts the mock by putting `[[mock:NAME k=v ...]]` into the text of
 * a user message. The most recent user message whose text blocks carry a
 * marker selects the scenario; the step is the number of assistant messages
 * after it, so tool round trips advance the scenario by themselves. Nothing
 * is positional: the CLI appends `role:"system"` messages after tool results
 * (D16, 05 §2), so the last message is not assumed to be the user's, and
 * markers inside tool results or system messages are ignored.
 */

/** A `tool_result` block of the conversation, reduced to what scenarios quote. */
export interface ToolResultView {
  readonly toolUseId: string;
  readonly isError: boolean;
  /** Text content; non-text blocks appear as `[type]`. */
  readonly text: string;
}

/** The scenario selected by a request. */
export interface Scenario {
  /** Scenario name, lower case. */
  readonly name: string;
  /** Marker arguments; a repeated key keeps its last value. */
  readonly args: ReadonlyMap<string, string>;
  /** Number of assistant messages after the marked user message. */
  readonly step: number;
  /** Text of the marked user message with the marker removed, trimmed. */
  readonly userText: string;
  /** Tool results of the latest user message after the marked one that has any. */
  readonly toolResults: readonly ToolResultView[];
}

const MARKER = /\[\[mock:([a-z0-9_-]+)((?:\s+[a-z0-9_]+=[^\s\]]*)*)\s*\]\]/i;

/** Narrows to a non-null, non-array object. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function blocksOf(content: unknown): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

/** Text of a message content: the string itself, or its `text` blocks joined by newlines. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocksOf(content)
    .filter((block) => block['type'] === 'text' && typeof block['text'] === 'string')
    .map((block) => String(block['text']))
    .join('\n');
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocksOf(content)
    .map((block) =>
      block['type'] === 'text' && typeof block['text'] === 'string'
        ? block['text']
        : `[${typeof block['type'] === 'string' ? block['type'] : 'unknown'}]`,
    )
    .join('');
}

/** The `tool_result` blocks of a message content. */
export function toolResultsOf(content: unknown): readonly ToolResultView[] {
  return blocksOf(content)
    .filter((block) => block['type'] === 'tool_result')
    .map((block) => ({
      toolUseId: typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : '',
      isError: block['is_error'] === true,
      text: resultText(block['content']),
    }));
}

function parseArgs(text: string): Map<string, string> {
  const args = new Map<string, string>();
  for (const pair of text.split(/\s+/)) {
    const eq = pair.indexOf('=');
    if (eq > 0) args.set(pair.slice(0, eq).toLowerCase(), pair.slice(eq + 1));
  }
  return args;
}

/**
 * Finds the scenario of a request from its `messages` array.
 *
 * @returns `undefined` when no user message carries a marker (side requests
 * such as titles get a neutral reply).
 */
export function findScenario(messages: readonly unknown[]): Scenario | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message['role'] !== 'user') continue;
    const text = textOf(message['content']);
    const match = MARKER.exec(text);
    if (match === null) continue;
    const later = messages.slice(index + 1).filter(isRecord);
    const step = later.filter((entry) => entry['role'] === 'assistant').length;
    let toolResults: readonly ToolResultView[] = [];
    for (const entry of later.toReversed()) {
      if (entry['role'] !== 'user') continue;
      const results = toolResultsOf(entry['content']);
      if (results.length > 0) {
        toolResults = results;
        break;
      }
    }
    return {
      name: String(match[1]).toLowerCase(),
      args: parseArgs(String(match[2])),
      step,
      userText: text.replace(match[0], '').trim(),
      toolResults,
    };
  }
  return undefined;
}
