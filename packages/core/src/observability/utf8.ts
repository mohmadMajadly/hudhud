/**
 * Streaming UTF-8 decoder for diagnostic byte streams (stderr).
 *
 * @remarks
 * Self-contained rather than a `TextDecoder` because the stderr tail needs the
 * number of bytes held for an incomplete sequence ({@link Utf8StreamDecoder.pendingBytes})
 * to account for its memory bound, which `TextDecoder` does not expose.
 * The output equals `new TextDecoder('utf-8')` with `{ stream: true }` on
 * every chunk and a final flush: ill-formed sequences become U+FFFD per the
 * WHATWG Encoding Standard ("maximal subpart" replacement), and a sequence
 * split across chunks is completed by the next chunk instead of being
 * replaced. At most three bytes of an incomplete sequence are retained.
 *
 * @internal
 */

const REPLACEMENT = 0xfffd;

/** @internal */
export class Utf8StreamDecoder {
  #needed = 0;
  #seen = 0;
  #codePoint = 0;
  #lower = 0x80;
  #upper = 0xbf;

  /** Bytes of an incomplete sequence held for the next chunk (0 to 3). */
  get pendingBytes(): number {
    return this.#seen + (this.#needed > 0 ? 1 : 0);
  }

  /**
   * Decodes `bytes`. With `stream` false, an incomplete trailing sequence is
   * flushed as U+FFFD and the decoder is reset.
   */
  decode(bytes: Uint8Array, stream: boolean): string {
    const units: number[] = [];
    for (const byte of bytes) {
      if (this.#needed > 0 && (byte < this.#lower || byte > this.#upper)) {
        // Ill-formed: replace the maximal subpart, then this byte starts anew.
        this.#reset();
        units.push(REPLACEMENT);
      }
      if (this.#needed === 0) {
        this.#lead(byte, units);
        continue;
      }
      this.#lower = 0x80;
      this.#upper = 0xbf;
      this.#codePoint = (this.#codePoint << 6) | (byte & 0x3f);
      this.#seen += 1;
      if (this.#seen === this.#needed) {
        pushCodePoint(units, this.#codePoint);
        this.#reset();
      }
    }
    if (!stream && this.#needed > 0) {
      this.#reset();
      units.push(REPLACEMENT);
    }
    return fromUnits(units);
  }

  #lead(byte: number, units: number[]): void {
    if (byte <= 0x7f) {
      units.push(byte);
    } else if (byte >= 0xc2 && byte <= 0xdf) {
      this.#needed = 1;
      this.#codePoint = byte & 0x1f;
    } else if (byte >= 0xe0 && byte <= 0xef) {
      if (byte === 0xe0) this.#lower = 0xa0;
      if (byte === 0xed) this.#upper = 0x9f;
      this.#needed = 2;
      this.#codePoint = byte & 0x0f;
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      if (byte === 0xf0) this.#lower = 0x90;
      if (byte === 0xf4) this.#upper = 0x8f;
      this.#needed = 3;
      this.#codePoint = byte & 0x07;
    } else {
      units.push(REPLACEMENT);
    }
  }

  #reset(): void {
    this.#needed = 0;
    this.#seen = 0;
    this.#codePoint = 0;
    this.#lower = 0x80;
    this.#upper = 0xbf;
  }
}

function pushCodePoint(units: number[], codePoint: number): void {
  if (codePoint < 0x10000) {
    units.push(codePoint);
    return;
  }
  const offset = codePoint - 0x10000;
  units.push(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
}

/** Converts UTF-16 code units to a string in bounded slices (argument limits). */
function fromUnits(units: readonly number[]): string {
  const SLICE = 8192;
  let out = '';
  for (let start = 0; start < units.length; start += SLICE) {
    out += String.fromCharCode(...units.slice(start, start + SLICE));
  }
  return out;
}
