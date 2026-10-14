/**
 * The raw channel of one session: the transport tap behind the unstable
 * `/raw` tier (plan §2.6; ADR-0003, ADR-0004 §5, ADR-0012 §8).
 *
 * @remarks
 * Every session's transport is wrapped by a {@link RawChannel} (cheap when
 * nothing reads it: a line is parsed only while a raw subscriber or a raw
 * control request waits). It offers:
 *
 * - `frames()`: every JSON frame in both directions, in order, as
 *   {@link RawFrame}s, through the core's bounded fanout with the usual
 *   subscriber limits and overflow policies (`'block'` holds the stdout
 *   reader, as for events, ADR-0007). Frames are read-only copies.
 * - `controlRequest()` and `writeFrame()`: written to the CLI's stdin outside
 *   the session machine, so they carry the agent's full authority (ADR-0012
 *   §8). Both are refused (`INVALID_OPTIONS`) unless the Harness was
 *   connected with `claudeCode.dangerouslyAllowRawControl: true`, and both
 *   keep the protocol policies of the outbound layer
 *   (`rawControlRefusal`, `rawFrameRefusal`): never `initialize` (the only
 *   carrier of `workspaceTrust`, J3), no `update_settings` and no non-session
 *   permission destinations without `dangerouslyAllowConfigWrites` (R6). The
 *   outbound cap applies (`OUTBOUND_FRAME_TOO_LARGE`, nothing written).
 *
 * A raw control request is correlated by its own request id
 * (`hudhud-raw-<n>`, never one the machine uses); the machine sees the answer
 * as an unknown response (diagnostic `control.unknown-response`). It settles
 * with the CLI's answer, `CONTROL_REQUEST_FAILED` (an error answer, or its
 * `timeoutMs`), `ABORTED`, or `SESSION_CLOSED` when the session ends first.
 *
 * @packageDocumentation
 */

import {
  AbortError,
  ControlRequestError,
  HudhudError,
  InvalidOptionsError,
  SessionClosedError,
  SubscriberOverflowError,
  type JsonObject,
  type JsonValue,
  type SubscriberOptions,
} from '@hudhud/core';
import {
  Fanout,
  TransportWriteError,
  type Clock,
  type HarnessTransport,
  type TransportOutput,
} from '@hudhud/core/binding';
import { encodeJsonLine, ownObject, ownString, parseJsonLine } from '@hudhud/core/protocol';

import {
  rawControlRefusal,
  rawControlRequest,
  rawFrameRefusal,
  type RawControlPolicy,
} from './protocol/wire/outbound.js';

/**
 * One frame on the wire (plan §2.6).
 *
 * @public
 */
export interface RawFrame {
  readonly direction: 'in' | 'out';
  /** Gapless from 1 per session, across both directions. */
  readonly seq: number;
  readonly ts: string;
  /** The line's byte length. */
  readonly bytes: number;
  readonly frame: JsonValue;
}

const encoder = new TextEncoder();

/** Longest CLI error text copied into an error. */
const MAX_ECHO = 256;

function cap(text: string): string {
  return text.length > MAX_ECHO ? `${text.slice(0, MAX_ECHO)}…` : text;
}

/** What travels through the fanout: frames, and the gap marker of a drop. */
type RawItem = { readonly kind: 'frame'; readonly frame: RawFrame } | { readonly kind: 'gap' };

async function* framesOf(items: AsyncIterator<RawItem>): AsyncGenerator<RawFrame, void> {
  for await (const item of { [Symbol.asyncIterator]: () => items }) {
    // A dropped stretch shows as a jump of `seq`; RawFrame has no gap form.
    if (item.kind === 'frame') yield item.frame;
  }
}

interface PendingControl {
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: HudhudError) => void;
}

/**
 * The raw channel of one session (see the module remarks).
 *
 * @internal
 */
export class RawChannel {
  readonly #clock: Clock;
  readonly #maxOutboundBytes: number;
  readonly #policy: RawControlPolicy;
  readonly #defaults: Omit<SubscriberOptions, 'signal'>;
  readonly #fanout: Fanout<RawItem>;
  readonly #pending = new Map<string, PendingControl>();
  #transport: HarnessTransport | undefined;
  #seq = 1;
  #nextId = 1;
  #closed = false;

  constructor(options: {
    readonly clock: Clock;
    readonly maxOutboundBytes: number;
    readonly policy: RawControlPolicy;
    /** The session's subscriber defaults (`SessionOptions.events`, without its signal). */
    readonly defaults: Omit<SubscriberOptions, 'signal'>;
  }) {
    this.#clock = options.clock;
    this.#maxOutboundBytes = options.maxOutboundBytes;
    this.#policy = options.policy;
    this.#defaults = options.defaults;
    this.#fanout = new Fanout<RawItem>({
      gapMarker: () => ({ kind: 'gap' }),
      overflowError: (info) =>
        new SubscriberOverflowError('The raw frame subscriber queue overflowed.', {
          details: { ...info },
        }),
      abortError: (reason) => new AbortError(undefined, { cause: reason }),
    });
  }

  /** The transport the driver uses: this channel's tap over `transport`. */
  wrap(transport: HarnessTransport): HarnessTransport {
    this.#transport = transport;
    const tapOutput = (): AsyncIterable<TransportOutput> => this.#tapOutput(transport.output);
    return {
      pid: transport.pid,
      get output() {
        return tapOutput();
      },
      write: async (line) => {
        await transport.write(line);
        await this.#observe('out', line);
      },
      endInput: (options) => {
        transport.endInput(options);
      },
      exited: transport.exited,
      terminate: (request) => transport.terminate(request),
      afterExit: () => transport.afterExit(),
      stderrTail: () => transport.stderrTail(),
    };
  }

  async *#tapOutput(output: AsyncIterable<TransportOutput>): AsyncGenerator<TransportOutput> {
    for await (const item of output) {
      if (item.type === 'line') await this.#observe('in', `${item.text}\n`);
      yield item;
    }
  }

  /** Publishes a frame and settles the raw control request it answers. */
  async #observe(direction: 'in' | 'out', line: string): Promise<void> {
    if (this.#closed || (this.#fanout.subscriberCount === 0 && this.#pending.size === 0)) return;
    const parsed = parseJsonLine(line.slice(0, -1));
    if (!parsed.ok) return;
    const frame = parsed.value;
    if (direction === 'in') this.#settle(frame);
    if (this.#fanout.subscriberCount === 0) return;
    const bytes = encoder.encode(line).byteLength - 1;
    const raw: RawFrame = {
      direction,
      seq: this.#seq,
      ts: this.#clock.nowIso(),
      bytes,
      frame,
    };
    this.#seq += 1;
    await this.#fanout.publish({ kind: 'frame', frame: raw }, bytes);
  }

  #settle(frame: JsonObject): void {
    if (ownString(frame, 'type') !== 'control_response') return;
    const response = ownObject(frame, 'response');
    const id = response === undefined ? undefined : ownString(response, 'request_id');
    const pending = id === undefined ? undefined : this.#pending.get(id);
    if (response === undefined || id === undefined || pending === undefined) return;
    this.#pending.delete(id);
    if (ownString(response, 'subtype') === 'success') {
      // An own `response` member only (a `__proto__` key stays inert, ADR-0012 §8).
      pending.resolve(Object.entries(response).find(([key]) => key === 'response')?.[1] ?? null);
      return;
    }
    const cliError = ownString(response, 'error') ?? 'error';
    pending.reject(
      new ControlRequestError('The CLI answered the raw control request with an error.', {
        details: { requestId: id, cliError: cap(cliError) },
      }),
    );
  }

  /** Raw frames in both directions (see the module remarks). */
  frames(options: SubscriberOptions = {}): AsyncIterable<RawFrame> {
    let items: AsyncIterator<RawItem>;
    try {
      items = this.#fanout.subscribe({}, { ...this.#defaults, ...options });
    } catch (error) {
      // The fanout checks the limits and the policy before it subscribes.
      throw new InvalidOptionsError('Invalid subscriber options.', {
        details: { path: 'frames', rule: 'subscriber-options' },
        cause: error,
      });
    }
    const frames = framesOf(items);
    return { [Symbol.asyncIterator]: () => frames };
  }

  /**
   * Sends one control request and resolves with the CLI's answer.
   *
   * @throws `InvalidOptionsError` (raw control not enabled, a refused
   *   subtype or body, a bad `timeoutMs`), `OutboundFrameTooLargeError`,
   *   `ControlRequestError`, `AbortError`, `SessionClosedError`
   */
  async controlRequest(
    subtype: string,
    body: JsonObject | undefined,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<JsonValue> {
    const refusal =
      typeof subtype === 'string'
        ? rawControlRefusal(subtype, body, this.#policy)
        : rawControlRefusal('', undefined, this.#policy);
    if (refusal !== undefined) throw HudhudError.fromData(refusal);
    const { signal, timeoutMs } = options;
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) {
      throw new InvalidOptionsError('timeoutMs must be a positive safe integer.', {
        details: { path: 'timeoutMs', rule: 'timeout' },
      });
    }
    if (signal?.aborted === true) throw AbortError.fromSignal(signal);
    const id = `hudhud-raw-${String(this.#nextId)}`;
    this.#nextId += 1;
    const line = this.#encode(rawControlRequest(id, subtype, body));
    const { promise, resolve, reject } = Promise.withResolvers<JsonValue>();
    let cancelTimer = (): void => undefined;
    let detach = (): void => undefined;
    const finish = (): void => {
      this.#pending.delete(id);
      cancelTimer();
      detach();
    };
    const settleWith = (error: HudhudError): void => {
      finish();
      reject(error);
    };
    this.#pending.set(id, {
      resolve: (value) => {
        finish();
        resolve(value);
      },
      reject: settleWith,
    });
    if (signal !== undefined) {
      const onAbort = (): void => {
        settleWith(AbortError.fromSignal(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      detach = () => {
        signal.removeEventListener('abort', onAbort);
      };
    }
    if (timeoutMs !== undefined) {
      cancelTimer = this.#clock.schedule(timeoutMs, () => {
        settleWith(
          new ControlRequestError(`The raw ${cap(subtype)} control request timed out.`, {
            details: { cause: 'timeout', requestId: id, timeoutMs },
          }),
        );
      });
    }
    const failed = await this.#write(line);
    if (failed !== null) settleWith(failed);
    return promise;
  }

  /**
   * Writes one caller-built frame.
   *
   * @throws `InvalidOptionsError` (raw control not enabled, a refused frame),
   *   `OutboundFrameTooLargeError`, `SessionClosedError`
   */
  async writeFrame(frame: JsonObject): Promise<void> {
    const refusal = rawFrameRefusal(frame, this.#policy);
    if (refusal !== undefined) throw HudhudError.fromData(refusal);
    const failed = await this.#write(this.#encode(frame));
    if (failed !== null) throw failed;
  }

  #encode(frame: JsonObject): string {
    const encoded = encodeJsonLine(frame, this.#maxOutboundBytes);
    if (!encoded.ok) throw HudhudError.fromData(encoded.error);
    return encoded.line;
  }

  /** Writes a line; the error is returned when the session's input is gone. */
  async #write(line: string): Promise<SessionClosedError | null> {
    const transport = this.#transport;
    if (this.#closed || transport === undefined) {
      return new SessionClosedError('The session has ended.');
    }
    try {
      await transport.write(line);
    } catch (error) {
      // The transport rejects only with TransportWriteError (its contract).
      const code = error instanceof TransportWriteError ? error.code : 'EIO';
      return new SessionClosedError(`The session's input is closed (${code}).`, { cause: error });
    }
    await this.#observe('out', line);
    return null;
  }

  /** The session ended: pending requests fail, subscriptions end after their queued frames. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new SessionClosedError('The session has ended.');
    for (const pending of [...this.#pending.values()]) pending.reject(error);
    this.#fanout.close();
  }
}
