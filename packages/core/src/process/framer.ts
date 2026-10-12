/**
 * Bounded, UTF-8-safe NDJSON framer for a child's stdout (plan §1.7, ADR-0011 §7).
 *
 * @packageDocumentation
 */

/**
 * Default inbound line cap: 64 MiB (ADR-0011 §7, 05 §11).
 *
 * @public
 */
export const DEFAULT_MAX_INBOUND_FRAME_BYTES: number = 64 * 1024 * 1024;

/**
 * Options of {@link createFramer}.
 *
 * @public
 */
export interface FramerOptions {
  /**
   * Largest accepted line in bytes, terminator excluded: a positive safe
   * integer no larger than {@link maxFramerLineBytes}. Usually
   * {@link DEFAULT_MAX_INBOUND_FRAME_BYTES}.
   */
  readonly maxLineBytes: number;
}

/**
 * One framing result, in stream order.
 *
 * @remarks
 * - `line`: a complete line of valid UTF-8 within the cap. `bytes` is its
 *   length without the terminator (`\n` or `\r\n`), including a leading byte
 *   order mark on the first line; `text` has neither.
 * - `oversized`: a line above the cap, reported once, as soon as the cap is
 *   crossed (fail fast: an endless line is reported without waiting for its
 *   end). The rest of the line is discarded up to its LF, then framing
 *   resumes. The report never depends on chunking: `bytes` and
 *   `details.atLeastBytes` are always `maxBytes + 1`, a lower bound.
 * - `invalid-utf8`: a line within the cap that is not valid UTF-8; `bytes` as
 *   for `line`. Its content is not reported.
 *
 * Lines that are empty or hold only spaces, tabs and carriage returns produce
 * no output.
 *
 * @public
 */
export type FramerOutput =
  | { readonly kind: 'line'; readonly text: string; readonly bytes: number }
  | {
      readonly kind: 'oversized';
      readonly bytes: number;
      readonly details: { readonly maxBytes: number; readonly atLeastBytes: number };
    }
  | { readonly kind: 'invalid-utf8'; readonly bytes: number };

/**
 * A push-based NDJSON framer.
 *
 * @public
 */
export interface Framer {
  /**
   * Feeds the next chunk of the stream and returns what it completes, in
   * stream order. The chunk is not retained: bytes kept for an unfinished
   * line are copied.
   *
   * @throws Error after {@link Framer.end}.
   */
  push(chunk: Uint8Array): FramerOutput[];
  /**
   * Ends the stream; an unterminated last line is framed as if terminated.
   *
   * @throws Error when called twice.
   */
  end(): FramerOutput[];
}

/**
 * Largest accepted `maxLineBytes`: V8's maximum string length on 64-bit hosts
 * (2^29 - 24 UTF-16 code units). A line within it always decodes to a string.
 *
 * @public
 */
export const maxFramerLineBytes = 0x1fff_ffe8;

const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const TAB = 0x09;
const INITIAL_CAPACITY = 4096;
/** A buffer that grew above this is released after its line completes. */
const RETAINED_CAPACITY = 64 * 1024;
/** The UTF-8 byte order mark. */
const BOM = [0xef, 0xbb, 0xbf] as const;

function isBlank(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte !== SPACE && byte !== TAB && byte !== CR) return false;
  }
  return true;
}

class NdjsonFramer implements Framer {
  readonly #max: number;
  readonly #decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  /** Bytes of the unfinished line; at most `#max + 1` (a line of `#max` plus its CR). */
  #buffer: Uint8Array;
  #length = 0;
  /** The unfinished line crossed the cap: it was reported and is being discarded. */
  #discarding = false;
  #firstLine = true;
  #ended = false;

  constructor(max: number) {
    this.#max = max;
    this.#buffer = new Uint8Array(Math.min(INITIAL_CAPACITY, max + 1));
  }

  /** Bytes currently held for an unfinished line, and the buffer capacity. */
  get retained(): { readonly bufferedBytes: number; readonly capacityBytes: number } {
    return { bufferedBytes: this.#length, capacityBytes: this.#buffer.byteLength };
  }

  push(chunk: Uint8Array): FramerOutput[] {
    this.#assertOpen();
    const out: FramerOutput[] = [];
    let start = 0;
    while (start < chunk.length) {
      const lf = chunk.indexOf(LF, start);
      const stop = lf === -1 ? chunk.length : lf;
      this.#take(chunk, start, stop, out);
      if (lf === -1) break;
      this.#finishLine(out);
      start = lf + 1;
    }
    return out;
  }

  end(): FramerOutput[] {
    this.#assertOpen();
    this.#ended = true;
    const out: FramerOutput[] = [];
    this.#finishLine(out);
    this.#buffer = new Uint8Array(0);
    return out;
  }

  #assertOpen(): void {
    if (this.#ended) throw new Error('The framer has ended.');
  }

  /** Adds `chunk[start, stop)` (no LF inside) to the unfinished line. */
  #take(chunk: Uint8Array, start: number, stop: number, out: FramerOutput[]): void {
    if (this.#discarding || start === stop) return;
    const needed = this.#length + stop - start;
    // `max + 1` bytes are still within the cap when the last one is the CR of
    // a CRLF; one more byte, or a last byte other than CR, crosses it.
    const crossed = needed > this.#max + 1 || (needed === this.#max + 1 && chunk[stop - 1] !== CR);
    if (crossed) {
      const atLeastBytes = this.#max + 1;
      out.push({
        kind: 'oversized',
        bytes: atLeastBytes,
        details: { maxBytes: this.#max, atLeastBytes },
      });
      this.#discarding = true;
      this.#length = 0;
      this.#release();
      return;
    }
    if (needed > this.#buffer.byteLength) {
      let capacity = this.#buffer.byteLength * 2;
      while (capacity < needed) capacity *= 2;
      const grown = new Uint8Array(Math.min(capacity, this.#max + 1));
      grown.set(this.#buffer.subarray(0, this.#length));
      this.#buffer = grown;
    }
    this.#buffer.set(chunk.subarray(start, stop), this.#length);
    this.#length = needed;
  }

  /** Frames the unfinished line, if any, and resets for the next one. */
  #finishLine(out: FramerOutput[]): void {
    const output = this.#discarding ? undefined : this.#frame();
    this.#firstLine = false;
    this.#length = 0;
    this.#discarding = false;
    if (this.#buffer.byteLength > RETAINED_CAPACITY) this.#release();
    if (output !== undefined) out.push(output);
  }

  /** Frames a line within the cap (`#take` reported every line above it). */
  #frame(): FramerOutput | undefined {
    let bytes = this.#length;
    if (this.#buffer[bytes - 1] === CR) bytes -= 1;
    const skip = this.#firstLine && startsWithBom(this.#buffer, bytes) ? BOM.length : 0;
    const body = this.#buffer.subarray(skip, bytes);
    if (isBlank(body)) return undefined;
    try {
      return { kind: 'line', text: this.#decoder.decode(body), bytes };
    } catch {
      return { kind: 'invalid-utf8', bytes };
    }
  }

  #release(): void {
    this.#buffer = new Uint8Array(Math.min(INITIAL_CAPACITY, this.#max + 1));
  }
}

function startsWithBom(buffer: Uint8Array, length: number): boolean {
  return length >= 3 && buffer[0] === BOM[0] && buffer[1] === BOM[1] && buffer[2] === BOM[2];
}

/**
 * Creates a framer that splits a byte stream into NDJSON lines.
 *
 * @remarks
 * Lines end at LF; a CR before the LF is dropped, so CRLF and LF streams frame
 * alike. A UTF-8 byte order mark at the start of the stream is dropped.
 * Multibyte characters split across chunks are reassembled, because only
 * complete lines are decoded. Memory is bounded: the framer holds at most
 * `maxLineBytes + 1` bytes between calls, independent of the input. A line
 * above the cap is reported as `oversized` the moment it crosses the cap and
 * discarded up to its LF. Nothing is truncated silently: every non-blank line
 * yields exactly one output. Output does not depend on how the stream is
 * chunked.
 *
 * @throws RangeError when `maxLineBytes` is not an integer in
 * `[1, maxFramerLineBytes]`.
 * @public
 */
export function createFramer(options: FramerOptions): Framer {
  const max = options.maxLineBytes;
  if (!Number.isSafeInteger(max) || max < 1 || max > maxFramerLineBytes) {
    throw new RangeError(
      `maxLineBytes must be an integer in [1, ${String(maxFramerLineBytes)}], got ${String(max)}`,
    );
  }
  return new NdjsonFramer(max);
}

/**
 * Test and diagnostics hook: bytes a framer holds for its unfinished line and
 * the capacity of its buffer.
 *
 * @throws TypeError for an object not made by {@link createFramer}.
 * @internal
 */
export function framerRetention(framer: Framer): {
  readonly bufferedBytes: number;
  readonly capacityBytes: number;
} {
  if (!(framer instanceof NdjsonFramer)) throw new TypeError('Not a framer made by createFramer.');
  return framer.retained;
}
