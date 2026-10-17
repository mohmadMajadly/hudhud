// Shared helpers of the permission and interrupt suites (W6-T2, plan §5.8).
//
// What hudhud wrote to the CLI is read from the session's own wire tap, the
// unstable raw tier (`raw(session).frames()`, plan §2.6): every frame in both
// directions, in order, `out` being a line hudhud wrote to the CLI's stdin
// and `in` a line the CLI printed. Reading frames needs no raw control; the
// tests never write through it. What reached the model is read from the
// mock's captured requests.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { HudhudEvent, JsonObject, JsonValue, Session } from '@hudhudjs/core';
import { isJsonObject } from '@hudhudjs/core/protocol';

import type { SessionOptions } from '../../../src/options-types.js';
import { raw, type RawWireFrame } from '../../../src/raw/index.js';
import type { MockServer } from '../../../../../tooling/test-support/src/mock/server.js';
import {
  isRecord,
  toolResultsOf,
  type ToolResultView,
} from '../../../../../tooling/test-support/src/mock/scenario.js';
import type { ClaudeIntegrationSuite } from '../support/harness.js';

/**
 * Opens a session in the test's sandbox, tapped from the start. Several
 * scenarios end the session within a second of the spawn (an abort right
 * after the first permission request lives about 650 ms on Windows, W6-T2);
 * the harness hands the CLI to the product only once its identity was read
 * (identity first), so even such a session keeps a tracked tree.
 */
export async function tappedSession(
  suite: ClaudeIntegrationSuite,
  session: SessionOptions,
): Promise<{ session: Session; tap: SessionTap }> {
  const opened = await suite.testSession({ session });
  return { session: opened, tap: new SessionTap(opened) };
}

/** Base64 of UTF-8 text, for mock marker arguments. */
export function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * The mutating command of the permission runs of 05 §6 (run 19): the CLI
 * asks before it runs in `default` mode, and the marker file proves whether
 * the tool ran.
 */
export const PERMISSION_CMD = 'echo hi && touch marker.txt';

/** A turn whose model reply calls Bash with {@link PERMISSION_CMD} (05 §6). */
export const PERMISSION_MARKER = `[[mock:bash cmd=${b64(PERMISSION_CMD)}]] run it`;

/** The file {@link PERMISSION_CMD} creates in the session's working directory. */
export const MARKER_FILE = 'marker.txt';

/** Narrows an event to one type. */
export type EventOf<T extends string> = Extract<HudhudEvent, { type: T }>;

/** Whether `event` has type `type`. */
export function isEvent<T extends HudhudEvent['type']>(
  event: HudhudEvent,
  type: T,
): event is EventOf<T> {
  return event.type === type;
}

/** An own object member of a JSON value. */
export function member(value: JsonValue | undefined, key: string): JsonValue | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.entries(value).find(([name]) => name === key)?.[1];
}

/** The `type` of a frame, and the `subtype` of its `request`/`response` or itself. */
export function frameKind(frame: JsonValue): { type?: string; subtype?: string } {
  const type = member(frame, 'type');
  const inner = member(frame, 'request') ?? member(frame, 'response');
  const subtype = member(inner, 'subtype') ?? member(frame, 'subtype');
  return {
    ...(typeof type === 'string' ? { type } : {}),
    ...(typeof subtype === 'string' ? { subtype } : {}),
  };
}

interface Waiter<T> {
  readonly match: (item: T) => boolean;
  readonly resolve: (item: T) => void;
  readonly reject: (error: Error) => void;
  readonly what: string;
}

/** A list that grows while a stream is read, with waits for a matching item. */
class Collected<T> {
  readonly items: T[] = [];
  #waiters: Waiter<T>[] = [];
  #ended = false;
  readonly #name: string;

  constructor(name: string) {
    this.#name = name;
  }

  push(item: T): void {
    this.items.push(item);
    const ready = this.#waiters.filter((waiter) => waiter.match(item));
    this.#waiters = this.#waiters.filter((waiter) => !waiter.match(item));
    for (const waiter of ready) waiter.resolve(item);
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters) {
      waiter.reject(new Error(`the ${this.#name} stream ended before ${waiter.what}`));
    }
    this.#waiters = [];
  }

  /** The first item (already seen or later) that matches; rejects when the stream ends first. */
  wait(match: (item: T) => boolean, what: string): Promise<T> {
    const seen = this.items.find(match);
    if (seen !== undefined) return Promise.resolve(seen);
    if (this.#ended) {
      return Promise.reject(new Error(`the ${this.#name} stream ended before ${what}`));
    }
    return new Promise<T>((resolve, reject) => {
      this.#waiters.push({ match, resolve, reject, what });
    });
  }
}

/**
 * Records a session's events and wire frames from the moment it is
 * attached until the session ends. Attach it right after `create()`.
 */
export class SessionTap {
  readonly #events = new Collected<HudhudEvent>('event');
  readonly #frames = new Collected<RawWireFrame>('frame');
  /** Settles once both streams ended (the session ended); rejects on a stream error. */
  readonly ended: Promise<void>;

  constructor(session: Session) {
    const frames = raw(session).frames();
    const events = session.events();
    this.ended = Promise.all([
      this.#read(
        events,
        (event) => {
          this.#events.push(event);
        },
        this.#events,
      ),
      this.#read(
        frames,
        (frame) => {
          // The default overflow policy is 'error', so no gap marker is ever yielded.
          if (frame.kind === 'frame') this.#frames.push(frame);
        },
        this.#frames,
      ),
    ]).then(() => undefined);
  }

  async #read<T, U>(
    stream: AsyncIterable<T>,
    onItem: (item: T) => void,
    sink: Collected<U>,
  ): Promise<void> {
    try {
      for await (const item of stream) onItem(item);
    } finally {
      sink.end();
    }
  }

  /** Every event so far (from the replayed `compat` on). */
  get events(): readonly HudhudEvent[] {
    return this.#events.items;
  }

  /** Every wire frame so far, both directions, in wire order. */
  get frames(): readonly RawWireFrame[] {
    return this.#frames.items;
  }

  /** Every frame hudhud wrote to the CLI so far. */
  get written(): readonly JsonValue[] {
    return this.frames.filter((frame) => frame.direction === 'out').map((frame) => frame.frame);
  }

  /** Events of one type so far. */
  eventsOf<T extends HudhudEvent['type']>(type: T): EventOf<T>[] {
    return this.events.filter((event): event is EventOf<T> => isEvent(event, type));
  }

  /** The first event of `type` that matches `match`. */
  async event<T extends HudhudEvent['type']>(
    type: T,
    match: (event: EventOf<T>) => boolean = () => true,
  ): Promise<EventOf<T>> {
    const found = await this.#events.wait(
      (event) => isEvent(event, type) && match(event),
      `a ${type} event`,
    );
    return found as EventOf<T>;
  }

  /** The first frame that matches. */
  frame(match: (frame: RawWireFrame) => boolean, what: string): Promise<RawWireFrame> {
    return this.#frames.wait(match, what);
  }

  /** The `control_response` frames hudhud wrote for an inbound request id. */
  answersTo(requestId: string): JsonValue[] {
    return this.written.filter(
      (frame) =>
        member(frame, 'type') === 'control_response' &&
        member(member(frame, 'response'), 'request_id') === requestId,
    );
  }

  /** The control requests of `subtype` hudhud wrote. */
  controlRequestsOut(subtype: string): RawWireFrame[] {
    return this.frames.filter(
      (frame) =>
        frame.direction === 'out' &&
        member(frame.frame, 'type') === 'control_request' &&
        member(member(frame.frame, 'request'), 'subtype') === subtype,
    );
  }
}

/** The one `can_use_tool` request id the CLI asked so far, from the wire. */
export function canUseToolIds(tap: SessionTap): string[] {
  return tap.frames
    .filter(
      (frame) =>
        frame.direction === 'in' &&
        frameKind(frame.frame).type === 'control_request' &&
        frameKind(frame.frame).subtype === 'can_use_tool',
    )
    .flatMap((frame) => {
      const id = member(frame.frame, 'request_id');
      return typeof id === 'string' ? [id] : [];
    });
}

/** The `response` of the one answer hudhud wrote for `requestId`. */
export function onlyAnswer(tap: SessionTap, requestId: string): JsonValue | undefined {
  const answers = tap.answersTo(requestId);
  if (answers.length !== 1) {
    throw new Error(`expected one answer to ${requestId}, found ${String(answers.length)}`);
  }
  return member(answers[0], 'response');
}

/** Every tool result the model was sent, over all captured requests of the mock. */
export function toolResultsSent(mock: MockServer): ToolResultView[] {
  const results: ToolResultView[] = [];
  for (const request of mock.requests) {
    const messages = member(request.body as JsonValue, 'messages');
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      if (isRecord(message) && message['role'] === 'user') {
        results.push(...toolResultsOf(message['content']));
      }
    }
  }
  return results;
}

/** Whether `text` occurs anywhere in what the mock received or hudhud wrote. */
export function leaked(text: string, mock: MockServer, tap: SessionTap): string[] {
  const where: string[] = [];
  for (const request of mock.requests) {
    if (JSON.stringify(request.body).includes(text))
      where.push(`mock request ${String(request.seq)}`);
  }
  for (const frame of tap.written) {
    if (JSON.stringify(frame).includes(text)) where.push(`written frame ${JSON.stringify(frame)}`);
  }
  return where;
}

/** Whether the marker file of {@link PERMISSION_CMD} exists in `workDir`. */
export function markerExists(workDir: string): boolean {
  return existsSync(path.join(workDir, MARKER_FILE));
}

const SETTINGS_FILE = /^settings(?:\.local)?\.json$/iu;

/**
 * Every settings file under `root` (any depth) with the sha256 of its
 * content: the files a permission update with a `localSettings`,
 * `userSettings` or `projectSettings` destination would write. Call it only
 * while no CLI runs in the sandbox: a live CLI creates and removes
 * `cfg/.claude.json.lock` and temporary files, and a walk would race them.
 */
export async function settingsFiles(root: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && SETTINGS_FILE.test(entry.name)) {
        found[path.relative(root, full)] = createHash('sha256')
          .update(await readFile(full))
          .digest('hex');
      }
    }
  };
  await walk(root);
  return found;
}

/** The tool input of a permission request as a JSON object (Bash input always is one). */
export function inputObject(input: JsonValue): JsonObject {
  if (!isJsonObject(input)) {
    throw new Error(`the tool input is not an object: ${JSON.stringify(input)}`);
  }
  return input;
}
