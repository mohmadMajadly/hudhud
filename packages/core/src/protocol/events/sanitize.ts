/**
 * Display sanitizer for untrusted harness text (ADR-0012 §8, plan §1.4).
 *
 * @remarks
 * Text from a harness (model output, tool results, permission reasons,
 * plugin metadata) may carry terminal control sequences that recolour,
 * move the cursor, retitle the window, write the clipboard (OSC 52), forge
 * hyperlinks (OSC 8) or reorder what the reader sees (bidirectional
 * overrides, "Trojan Source"). This is a display helper only: hudhud passes
 * harness data to the application unchanged, and the application (or a
 * hudhud renderer) applies this before showing the text in a terminal.
 *
 * Removed:
 *
 * - escape sequences introduced by ESC (U+001B) per ECMA-48: CSI with its
 *   parameter, intermediate and final bytes; OSC, DCS, SOS, PM and APC
 *   strings up to their terminator (ST, BEL, CAN, SUB or the next ESC) or the
 *   end of the text; every other ESC sequence with its intermediate and final
 *   bytes;
 * - the same sequences introduced by their 8-bit C1 forms (U+009B CSI,
 *   U+009D OSC, U+0090 DCS, U+0098 SOS, U+009E PM, U+009F APC);
 * - every other C0 control (U+0000 to U+001F) except tab and line feed, DEL
 *   (U+007F) and every other C1 control (U+0080 to U+009F); carriage return
 *   is removed, so CRLF becomes LF and a lone CR cannot overwrite a line;
 * - the bidirectional embedding, override and isolate controls U+202A to
 *   U+202E and U+2066 to U+2069. Directional marks (U+200E, U+200F, U+061C)
 *   stay: they only affect neutral characters next to them, and
 *   right-to-left text needs them.
 *
 * Everything else, including lone surrogates and other format characters,
 * passes through unchanged. The function is total, linear in the input
 * length and idempotent.
 *
 * @packageDocumentation
 */

/**
 * Options of {@link sanitizeForDisplay}.
 *
 * @public
 */
export interface SanitizeForDisplayOptions {
  /**
   * Replace each line feed and tab with a space, for a single-line context
   * such as a prompt or a status line. Default `false`.
   */
  readonly singleLine?: boolean;
}

const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const TAB = 0x09;
const LF = 0x0a;
const DEL = 0x7f;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;

/** Characters that introduce a control string after ESC: P (DCS), X (SOS), ] (OSC), ^ (PM), _ (APC). */
const ESC_STRING_INTRODUCERS: ReadonlySet<number> = new Set([0x50, 0x58, 0x5d, 0x5e, 0x5f]);
/** The 8-bit forms of the control-string introducers: DCS, SOS, OSC, PM, APC. */
const C1_STRING_INTRODUCERS: ReadonlySet<number> = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);

/** Whether a code unit is a bidirectional embedding, override or isolate control. */
function isBidiControl(unit: number): boolean {
  return (unit >= 0x202a && unit <= 0x202e) || (unit >= 0x2066 && unit <= 0x2069);
}

/** Whether a code unit is removed when it stands alone. */
function isStrippedControl(unit: number): boolean {
  return (
    (unit < 0x20 && unit !== TAB && unit !== LF) ||
    (unit >= DEL && unit <= 0x9f) ||
    isBidiControl(unit)
  );
}

/**
 * Index after a control string that starts at `from` (the first payload
 * unit): past ST, BEL, CAN or SUB; at a following ESC that is not part of
 * ST (that ESC starts the next sequence); or the end of the text.
 */
function skipControlString(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const unit = text.charCodeAt(i);
    if (unit === BEL || unit === C1_ST || unit === CAN || unit === SUB) return i + 1;
    if (unit === ESC) return text.charCodeAt(i + 1) === 0x5c ? i + 2 : i;
    i += 1;
  }
  return i;
}

/**
 * Index after a CSI whose parameters start at `from`: parameter bytes
 * (0x30-0x3F), intermediate bytes (0x20-0x2F), then one final byte
 * (0x40-0x7E). A malformed sequence ends at the first unit that does not fit;
 * that unit is kept and examined on its own.
 */
function skipCsi(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const unit = text.charCodeAt(i);
    if (unit >= 0x30 && unit <= 0x3f) i += 1;
    else break;
  }
  return skipIntermediatesAndFinal(text, i, 0x40);
}

/**
 * Index after intermediate bytes (0x20-0x2F) and a final byte in
 * `minFinal`-0x7E starting at `from`. Without a final byte the sequence ends
 * after the intermediates.
 */
function skipIntermediatesAndFinal(text: string, from: number, minFinal: number): number {
  let i = from;
  while (i < text.length) {
    const unit = text.charCodeAt(i);
    if (unit >= 0x20 && unit <= 0x2f) i += 1;
    else break;
  }
  const final = text.charCodeAt(i);
  return final >= minFinal && final <= 0x7e ? i + 1 : i;
}

/**
 * Index after the escape sequence whose introducer is at `at` (ESC or an
 * 8-bit C1 introducer).
 */
function skipSequence(text: string, at: number): number {
  const unit = text.charCodeAt(at);
  if (unit === C1_CSI) return skipCsi(text, at + 1);
  if (C1_STRING_INTRODUCERS.has(unit)) return skipControlString(text, at + 1);
  // ESC: what follows decides the kind.
  const next = text.charCodeAt(at + 1);
  if (next === 0x5b) return skipCsi(text, at + 2);
  if (ESC_STRING_INTRODUCERS.has(next)) return skipControlString(text, at + 2);
  // nF (intermediates then a final 0x30-0x7E), Fp, Fe and Fs (a single final).
  return skipIntermediatesAndFinal(text, at + 1, 0x30);
}

/**
 * Removes terminal control sequences and controls from untrusted text before
 * it is displayed (ADR-0012 §8). Never throws; returns the input unchanged
 * when it contains nothing to remove.
 *
 * @param text - untrusted text, for example a permission request's
 *   `decisionReason` or model output.
 * @returns the text without escape sequences, C0 controls other than tab and
 *   line feed, DEL, C1 controls and bidirectional overrides.
 *
 * @public
 */
export function sanitizeForDisplay(text: string, options: SanitizeForDisplayOptions = {}): string {
  const singleLine = options.singleLine === true;
  let out = '';
  // Start of the pending run of kept units, copied in one slice.
  let runStart = 0;
  let i = 0;
  while (i < text.length) {
    const unit = text.charCodeAt(i);
    const introducer = unit === ESC || unit === C1_CSI || C1_STRING_INTRODUCERS.has(unit);
    const replace = singleLine && (unit === LF || unit === TAB);
    if (!introducer && !replace && !isStrippedControl(unit)) {
      i += 1;
      continue;
    }
    out += text.slice(runStart, i);
    if (replace) out += ' ';
    i = introducer ? skipSequence(text, i) : i + 1;
    runStart = i;
  }
  return runStart === 0 ? text : out + text.slice(runStart);
}
