/**
 * Bounded, redacted tail of a child's stderr (ADR-0016 §6, 02 §2.6).
 *
 * @remarks
 * Memory is bounded regardless of input: at most `maxLines` complete lines
 * of at most `maxChars` code units each are retained, older lines are dropped
 * once the retained text exceeds `maxChars`, the incomplete current line is
 * kept up to `maxLineChars` code units, and the UTF-8 decoder holds at most
 * three bytes. {@link StderrTail.retainedCodeUnits} reports the current size.
 *
 * Redaction (see `redact.ts`): every line is redacted as soon as it is
 * complete, so raw text is held only for the current incomplete line, and
 * {@link StderrTail.read} redacts that line too. Secrets split across
 * chunks, including multi-byte characters split across chunks, are therefore
 * redacted as a whole. Where text is cut before its end (an overlong line,
 * or a read while a line is incomplete) the possibly partial trailing token
 * and any trailing prefix of a known secret are masked as well (fail
 * closed). Text cut at the front is always already redacted, so a cut there
 * cannot expose part of a secret.
 *
 * Line breaks are LF, CRLF and lone CR (progress output); the tail renders
 * them as LF. Deterministic: no clock, timers or randomness.
 *
 * @packageDocumentation
 */

import { maskCutEnd, prepareSecrets, redactNormalized } from './redact.js';
import { Utf8StreamDecoder } from './utf8.js';

/**
 * Marker appended to a line whose remainder was dropped (over `maxLineChars`).
 *
 * @beta
 */
export const TRUNCATED = '<truncated>';

/**
 * Options of {@link StderrTail}.
 *
 * @beta
 */
export interface StderrTailOptions {
  /** Known secret values, typically `secretsFromEnv(childEnv)`. */
  readonly secrets?: readonly string[];
  /** Length of the tail in UTF-16 code units. Default 2048 (02 §2.6). */
  readonly maxChars?: number;
  /** Most lines in the tail. Default 100. */
  readonly maxLines?: number;
  /**
   * Longest retained line in UTF-16 code units; the rest of a longer line is
   * dropped and the line ends with {@link TRUNCATED}. Default `maxChars`.
   */
  readonly maxLineChars?: number;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`StderrTail: ${name} must be a positive safe integer`);
  }
  return value;
}

/** The last `max` code units of `text`, never starting inside a surrogate pair. */
function tailOf(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = text.slice(text.length - max);
  return isLowSurrogate(tail.charCodeAt(0)) ? tail.slice(1) : tail;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

const BREAK = /[\r\n]/g;

/**
 * A bounded, redacted tail of a byte or text stream.
 *
 * @example
 * ```ts
 * const tail = new StderrTail({ secrets: secretsFromEnv(childEnv) });
 * child.stderr.on('data', (chunk: Uint8Array) => tail.push(chunk));
 * child.on('close', () => tail.end());
 * const text = tail.read(); // safe to attach to an error
 * ```
 *
 * @beta
 */
export class StderrTail {
  readonly #secrets: readonly string[];
  readonly #maxChars: number;
  readonly #maxLines: number;
  readonly #maxLineChars: number;
  readonly #decoder = new Utf8StreamDecoder();
  /** Complete, redacted lines without their break. */
  readonly #lines: string[] = [];
  /** Sum of the lengths of `#lines` plus one break each. */
  #linesChars = 0;
  /** Raw text of the incomplete current line. */
  #partial = '';
  /** Dropping the rest of an overlong line until the next break. */
  #discarding = false;
  /** The last character seen was a CR (a following LF belongs to it). */
  #pendingCr = false;
  #ended = false;
  #receivedBytes = 0;
  #truncated = false;

  constructor(options: StderrTailOptions = {}) {
    this.#secrets = prepareSecrets(options.secrets ?? []);
    this.#maxChars = positiveInteger('maxChars', options.maxChars ?? 2048);
    this.#maxLines = positiveInteger('maxLines', options.maxLines ?? 100);
    this.#maxLineChars = positiveInteger('maxLineChars', options.maxLineChars ?? this.#maxChars);
  }

  /** Bytes received through {@link StderrTail.push} as `Uint8Array`. */
  get receivedBytes(): number {
    return this.#receivedBytes;
  }

  /** Whether any text was dropped (old lines, overlong lines, the front of the tail). */
  get truncated(): boolean {
    return this.#truncated || this.#render().length > this.#maxChars;
  }

  /** UTF-16 code units currently retained, plus pending decoder bytes. */
  get retainedCodeUnits(): number {
    return this.#linesChars + this.#partial.length + this.#decoder.pendingBytes;
  }

  /**
   * Upper bound of {@link StderrTail.retainedCodeUnits} for these options:
   * complete lines are dropped from the front while the rest still covers
   * `maxChars`, so they hold less than `maxChars` plus one line (itself capped
   * at `maxChars`) plus its break; then the current line and three bytes.
   */
  get retainedBound(): number {
    return 2 * this.#maxChars + 1 + this.#maxLineChars + 3;
  }

  /** Appends a chunk (bytes are decoded as UTF-8; strings are taken as is). Ignored after {@link StderrTail.end}. */
  push(chunk: Uint8Array | string): void {
    if (this.#ended) return;
    if (typeof chunk === 'string') {
      this.#append(chunk);
      return;
    }
    this.#receivedBytes += chunk.length;
    this.#append(this.#decoder.decode(chunk, true));
  }

  /** Ends the stream: an incomplete UTF-8 sequence becomes U+FFFD and the last line is complete. */
  end(): void {
    if (this.#ended) return;
    this.#append(this.#decoder.decode(new Uint8Array(0), false));
    this.#ended = true;
  }

  /** The redacted tail: at most `maxChars` code units and `maxLines` lines. */
  read(): string {
    return tailOf(this.#render(), this.#maxChars);
  }

  #render(): string {
    const last = this.#renderPartial();
    const keep = last === '' ? this.#maxLines : this.#maxLines - 1;
    const lines = this.#lines.slice(Math.max(0, this.#lines.length - keep));
    const text = lines.map((line) => `${line}\n`).join('') + last;
    // An overlong last line that never got its break is rendered without one.
    return this.#ended && this.#discarding ? text.slice(0, -1) : text;
  }

  #renderPartial(): string {
    if (this.#partial === '') return '';
    const redacted = redactNormalized(this.#partial, this.#secrets);
    return this.#ended ? redacted : maskCutEnd(redacted, this.#secrets);
  }

  #append(text: string): void {
    let index = 0;
    while (index < text.length) {
      if (this.#pendingCr) {
        this.#pendingCr = false;
        if (text.charAt(index) === '\n') {
          index += 1;
          continue;
        }
      }
      BREAK.lastIndex = index;
      const found = BREAK.exec(text);
      if (found === null) {
        this.#extend(text.slice(index));
        return;
      }
      this.#extend(text.slice(index, found.index));
      this.#completeLine();
      this.#pendingCr = found[0] === '\r';
      index = found.index + 1;
    }
  }

  #extend(segment: string): void {
    if (this.#discarding || segment === '') return;
    const room = this.#maxLineChars - this.#partial.length;
    if (segment.length <= room) {
      this.#partial += segment;
      return;
    }
    let head = this.#partial + segment.slice(0, room);
    if (isHighSurrogate(head.charCodeAt(head.length - 1))) head = head.slice(0, -1);
    const redacted = maskCutEnd(redactNormalized(head, this.#secrets), this.#secrets);
    this.#store(redacted + TRUNCATED);
    this.#partial = '';
    this.#discarding = true;
    this.#truncated = true;
  }

  #completeLine(): void {
    if (this.#discarding) {
      this.#discarding = false;
      return;
    }
    this.#store(redactNormalized(this.#partial, this.#secrets));
    this.#partial = '';
  }

  #store(line: string): void {
    const kept = tailOf(line, this.#maxChars);
    if (kept.length < line.length) this.#truncated = true;
    this.#lines.push(kept);
    this.#linesChars += kept.length + 1;
    while (this.#lines.length > 1) {
      const [oldest] = this.#lines as [string, ...string[]];
      const first = oldest.length + 1;
      if (this.#lines.length <= this.#maxLines && this.#linesChars - first < this.#maxChars) break;
      this.#lines.shift();
      this.#linesChars -= first;
      this.#truncated = true;
    }
  }
}
