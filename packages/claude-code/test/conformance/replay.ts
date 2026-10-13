// Replay of one recorded variant through the Claude session machine
// (plan §4.3, W4-T2): the recorded host writes become the hudhud commands
// that make them, the recorded CLI output becomes transport input, and a
// fake clock follows the recorded times. Every step goes through the
// machine-kit driver, so the contract invariants (no throw, no mutation,
// determinism, JSON stability, every turn and permission ending exactly
// once, seq +1, timers cleared, nothing after session.end) are checked on
// every replay.
//
// Translation (one rule per record direction, no per-suite switch):
//
// - `config`: the session config (`sessionConfigOf`): plan §1.5 defaults;
//   `mode` and the ids from the argv (`--resume`, `--fork-session`,
//   `--session-id`), else the first `system/init.session_id` (the recorder
//   let the CLI choose; hudhud always names one); `platform` from the
//   recording; a permission handler registered.
// - `in` (a host write):
//   - `control_request` `initialize`: `process.started` (pid 1001: the
//     normalizer numbers the spawned pid first); the machine writes its own
//     `initialize`.
//   - `user`: `cmd.send` with the frame's `uuid` as the turn id (a fresh
//     deterministic UUID when the recording sent none) and its content.
//   - `control_request` `interrupt`: `cmd.interrupt` of the oldest live
//     application turn (session-wide when none), `cancelQueued` from the
//     frame, the recorded request id as the correlation.
//   - `control_response` to `can_use_tool`: `success` becomes
//     `cmd.permission` with the recorded decision; `error` becomes
//     `cmd.permission-abort` (hudhud never answers a permission request with
//     a control error: it fails closed with a non-interrupting deny).
//   - a blank line (crlf-bom): no command; a BOM and a final CR are
//     stripped before parsing.
// - `cmd` `{stdin: "eof"}`: `cmd.close` (the recorder's EOF ends a script
//   the way `session.close()` ends a session).
// - `out`: a `line` (`line.oversized` above the 64 MiB default cap), after
//   mapping the recorded control request ids to the machine's.
// - `err`: one `stderr.line` per line.
// - `timer`: fires that armed timer.
// - `exit`: `stdout.end`, then `process.exit`, then `ladder.done` when a
//   ladder started.
// - Clock: before each record, every armed timer whose deadline is at or
//   before the record's time fires, earliest first, at its deadline.
//
// Placeholders: every `<uuid-N>` of the recording (in any string) becomes
// the UUID `00000000-0000-4000-8000-<N as 12 digits>`, since the machine
// takes UUIDs only.
//
// Writes: each write of the machine is paired with the host write of the
// recording it stands for (by subtype in order for control requests, by
// uuid for user frames, by request id for permission answers, in order for
// EOF), and the pair must be equal up to the request id (and the uuid when
// the recording sent none). Unpaired writes on either side are reported as
// labels; each suite declares them (`catalogue.ts`).

import type { JsonObject, JsonValue, MachineEffect, MachineInput } from '@hudhud/core/protocol';
import { isDeepStrictEqual } from 'node:util';

import {
  KitDriver,
  type KitInputBody,
  type KitMachine,
} from '../../../../tooling/test-support/src/machine-kit.js';
import {
  claudeSessionMachine,
  DEFAULT_AUTH_FAIL_FAST_SOURCES,
  type ClaudeSessionConfig,
  type ClaudeSessionState,
} from '../../src/protocol/machine/index.js';
import { utf8Bytes, type ConformanceVariant, type RecordLine } from './loader.js';

/** The clock origin of every replay: the recorded `t` is added to it. */
export const REPLAY_START_MS = Date.UTC(2026, 0, 1);

/** The spawned pid: the normalizer numbers it first. */
export const SPAWNED_PID = 1001;

/** The inbound frame cap default (plan §2.3 `maxFrameBytes`). */
export const DEFAULT_MAX_FRAME_BYTES = 67_108_864;

/** The session id when neither the argv nor a `system/init` names one. */
export const DEFAULT_SESSION_ID = '00000000-0000-4000-8000-000000000000';

const PLACEHOLDER = /<uuid-(\d+)>/gu;

/** The UUID a `<uuid-N>` placeholder stands for. */
export function placeholderUuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** The turn id of the n-th send whose recorded user frame had no uuid. */
export function sendUuid(n: number): string {
  return `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
}

/** Replaces every `<uuid-N>` placeholder (in strings and keys) with its UUID. */
export function denormalize(value: JsonValue): JsonValue {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER, (_, n: string) => placeholderUuid(Number(n)));
  }
  if (Array.isArray(value)) return (value as readonly JsonValue[]).map(denormalize);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [denormalize(key) as string, denormalize(item)]),
    );
  }
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

function ownText(value: JsonValue | undefined, key: string): string | undefined {
  const found = own(value, key);
  return typeof found === 'string' ? found : undefined;
}

/** A field as text: a string as is, anything else as JSON (`undefined` when absent). */
function show(value: JsonValue | undefined): string {
  if (value === undefined) return 'undefined';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The value of `--name=value` in `argv`. */
function flag(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

/** The session config a variant replays under (see the translation rules above). */
export function sessionConfigOf(variant: ConformanceVariant): ClaudeSessionConfig {
  const argv = variant.launch.argv.map((arg) => denormalize(arg) as string);
  const resume = flag(argv, 'resume');
  const named = flag(argv, 'session-id');
  const fork = argv.includes('--fork-session');
  const init = variant.records.find(
    (record) =>
      record.dir === 'out' &&
      own(record.v, 'type') === 'system' &&
      own(record.v, 'subtype') === 'init',
  );
  const observed = init === undefined ? undefined : ownText(denormalize(init.v), 'session_id');
  const mode = resume === undefined ? 'create' : fork ? 'fork' : 'resume';
  const sessionId =
    resume !== undefined && !fork ? resume : (named ?? observed ?? DEFAULT_SESSION_ID);
  return {
    mode,
    sessionId,
    ...(resume !== undefined && fork ? { forkedFrom: resume } : {}),
    firstFrameTimeoutMs: 60_000,
    idleStallMs: 300_000,
    closeTimeoutMs: 30_000,
    interruptWaitMs: 1000,
    maxOutboundBytes: 33_554_432,
    onOversizedFrame: 'fail',
    onAuthFailure: 'fail-fast',
    authFailFastSources: DEFAULT_AUTH_FAIL_FAST_SOURCES,
    permissionHandler: true,
    allowConfigWrites: false,
    allowBypassPermissions: false,
    platform: variant.platform === 'win32' ? 'win32' : 'posix',
    initialize: {},
  };
}

/** One step of a replay. */
export interface ReplayStep {
  /** Index of the record line the step belongs to. */
  readonly record: number;
  readonly input: MachineInput;
  readonly effects: readonly MachineEffect[];
  /** The state after the step. */
  readonly state: ClaudeSessionState;
}

/** The outcome of {@link replayVariant}. */
export interface ReplayResult {
  readonly config: ClaudeSessionConfig;
  readonly steps: readonly ReplayStep[];
  /** The effects of each record line (index = record index). */
  readonly effects: readonly (readonly MachineEffect[])[];
  /** The frame fed for each `out` record (after id mapping); `undefined` for other records. */
  readonly frames: readonly (JsonValue | undefined)[];
  /** Contract violations found by the machine kit. */
  readonly violations: readonly string[];
  /** Replay problems: a record without a hudhud command, a paired write that differs, no end. */
  readonly problems: readonly string[];
  /** Host writes of the recording the machine did not make (labels, in record order). */
  readonly unpairedRecorded: readonly string[];
  /** Writes of the machine the recording does not have (labels, in write order). */
  readonly unpairedMachine: readonly string[];
  readonly ended: boolean;
  readonly state: ClaudeSessionState | undefined;
}

/** Options of {@link replayVariant}. */
export interface ReplayOptions {
  /**
   * The machine to drive. Default: the Claude session machine's own `step`.
   * The loopback replay (W4-Z) passes the machine behind its
   * serialize/deserialize boundary.
   */
  readonly machine?: KitMachine<ClaudeSessionState, ClaudeSessionConfig>;
  /** The inbound frame cap the transport applies. Default {@link DEFAULT_MAX_FRAME_BYTES}. */
  readonly maxFrameBytes?: number;
}

/** A write: of the recording's host, or of the machine. */
export interface ReplayWrite {
  readonly record: number;
  /** What pairs it: `request:<subtype>` (in order), `turn:<id>`, `answer:<request id>`, `eof`, `blank`. */
  readonly key: string;
  readonly label: string;
  /** The frame (placeholders mapped); `undefined` for EOF and a blank line. */
  readonly frame: JsonObject | undefined;
  paired: boolean;
}

/** The leading byte-order mark the recorder wrote before a line (crlf-bom). */
const BOM = String.fromCharCode(0xfeff);

/** `' <JSON>'` of an object without the `omit` keys, or `''` when nothing is left. */
function rest(value: JsonValue | undefined, ...omit: string[]): string {
  if (!isObject(value)) return '';
  const others = Object.fromEntries(Object.entries(value).filter(([key]) => !omit.includes(key)));
  return Object.keys(others).length === 0 ? '' : ` ${JSON.stringify(others)}`;
}

/**
 * The label of a write (`catalogue.ts` declarations use it): `stdin.end`,
 * `user`, a control request's subtype and its other fields
 * (`interrupt {"cancel_queued":false}`), a permission answer's behavior and
 * its other fields (`deny {"message":"..."}`), `error {"error":"..."}`.
 */
export function writeLabel(frame: JsonObject | undefined): string {
  if (frame === undefined) return 'stdin.end';
  const type = own(frame, 'type');
  if (type === 'user') return 'user';
  if (type === 'control_request') {
    const request = own(frame, 'request');
    return `${show(own(request, 'subtype'))}${rest(request, 'subtype')}`;
  }
  if (type === 'control_response') {
    const response = own(frame, 'response');
    if (own(response, 'subtype') !== 'success') {
      return `error${rest(response, 'subtype', 'request_id')}`;
    }
    const body = own(response, 'response');
    return `${show(own(body, 'behavior'))}${rest(body, 'behavior')}`;
  }
  return `frame ${show(type)}`;
}

/** The pairing key of a frame. */
function keyOf(frame: JsonObject, turnId: string | undefined): string {
  const type = own(frame, 'type');
  if (type === 'control_request') return `request:${show(own(own(frame, 'request'), 'subtype'))}`;
  if (type === 'user') return `turn:${turnId ?? show(own(frame, 'uuid'))}`;
  return `answer:${show(own(own(frame, 'response'), 'request_id'))}`;
}

/** A frame without its `uuid`. */
function withoutUuid(frame: JsonObject | undefined): JsonObject {
  return Object.fromEntries(Object.entries(frame ?? {}).filter(([key]) => key !== 'uuid'));
}

/**
 * Whether two writes with the same key are equal up to the request id: the
 * same label, and for user frames the same frame but for the `uuid` (the
 * key already holds the recorded uuid; a recording without one gets the
 * player's).
 */
function sameWrite(host: ReplayWrite, machine: ReplayWrite): boolean {
  if (host.label !== machine.label) return false;
  return (
    own(host.frame, 'type') !== 'user' ||
    isDeepStrictEqual(withoutUuid(host.frame), withoutUuid(machine.frame))
  );
}

/** Parses a host `in` value: a frame, or a raw line (BOM and final CR stripped; blank allowed). */
function hostFrame(value: JsonValue): JsonObject | 'blank' | 'invalid' {
  if (isObject(value)) return denormalize(value) as JsonObject;
  let line = value as string;
  if (line.startsWith(BOM)) line = line.slice(BOM.length);
  if (line.endsWith('\r')) line = line.slice(0, -1);
  if (line.trim() === '') return 'blank';
  try {
    const parsed = JSON.parse(line) as JsonValue;
    return isObject(parsed) ? (denormalize(parsed) as JsonObject) : 'invalid';
  } catch {
    return 'invalid';
  }
}

/**
 * Pairs machine writes with host writes: each machine write takes the first
 * unpaired host write with its key; a pair counts when the two are equal.
 * Returns the unpaired labels of both sides.
 */
export function pairWrites(
  hosts: readonly ReplayWrite[],
  machines: readonly ReplayWrite[],
): { readonly recorded: string[]; readonly machine: string[] } {
  const machine: string[] = [];
  for (const write of machines) {
    const host = hosts.find((item) => !item.paired && item.key === write.key);
    if (host !== undefined && sameWrite(host, write)) {
      host.paired = true;
      write.paired = true;
    } else {
      machine.push(write.label);
    }
  }
  return { recorded: hosts.filter((host) => !host.paired).map((host) => host.label), machine };
}

/**
 * Replays one variant (see the translation rules at the top of this file).
 * Pure: the same variant always gives the same result.
 */
export function replayVariant(
  variant: ConformanceVariant,
  options: ReplayOptions = {},
): ReplayResult {
  return new Player(
    variant,
    options.machine ?? claudeSessionMachine,
    options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
  ).run();
}

class Player {
  private readonly variant: ConformanceVariant;
  private readonly config: ClaudeSessionConfig;
  private readonly driver: KitDriver<ClaudeSessionState, ClaudeSessionConfig>;
  private readonly steps: ReplayStep[] = [];
  private readonly effects: MachineEffect[][];
  private readonly frames: (JsonValue | undefined)[];
  private readonly problems: string[] = [];
  private readonly hostWrites: ReplayWrite[] = [];
  private readonly machineWrites: ReplayWrite[] = [];
  /** Recorded control request id to the machine's, learned as the machine writes. */
  private readonly requestIds = new Map<string, string>();
  /** Recorded control requests already given a machine id. */
  private readonly mapped = new Set<ReplayWrite>();
  /** Application turns sent and not yet ended, oldest first. */
  private readonly liveTurns: string[] = [];
  private sends = 0;
  private ladder = false;
  private record = 0;
  private readonly maxFrameBytes: number;

  constructor(
    variant: ConformanceVariant,
    machine: KitMachine<ClaudeSessionState, ClaudeSessionConfig>,
    maxFrameBytes: number,
  ) {
    this.variant = variant;
    this.maxFrameBytes = maxFrameBytes;
    this.config = sessionConfigOf(variant);
    this.driver = new KitDriver(machine, this.config, { firstSeq: 1, startMs: REPLAY_START_MS });
    this.effects = variant.records.map(() => []);
    this.frames = variant.records.map(() => undefined);
  }

  run(): ReplayResult {
    for (const [index, record] of this.variant.records.entries()) {
      this.record = index;
      this.fireDue(REPLAY_START_MS + record.t);
      this.driver.advanceTo(REPLAY_START_MS + record.t);
      this.play(record);
    }
    if (!this.driver.ended) this.problem('the session did not end at the recorded exit');
    const unpaired = pairWrites(this.hostWrites, this.machineWrites);
    return {
      config: this.config,
      steps: this.steps,
      effects: this.effects,
      frames: this.frames,
      violations: this.driver.violations,
      problems: this.problems,
      unpairedRecorded: unpaired.recorded,
      unpairedMachine: unpaired.machine,
      ended: this.driver.ended,
      state: this.driver.state,
    };
  }

  private problem(message: string): void {
    this.problems.push(`${this.variant.id}:${String(this.record + 1)}: ${message}`);
  }

  /** Fires every armed timer due by `limit`, earliest first (arming order on a tie). */
  private fireDue(limit: number): void {
    for (;;) {
      let first: readonly [string, number] | undefined;
      for (const timer of this.driver.timers) {
        if (timer[1] <= limit && (first === undefined || timer[1] < first[1])) first = timer;
      }
      if (first === undefined || this.driver.stopped) return;
      const name = first[0];
      this.track(() => this.driver.fireTimer(name));
    }
  }

  /** Runs one driver call and processes the steps it added. */
  private track(call: () => boolean): void {
    const before = this.driver.steps.length;
    call();
    for (const step of this.driver.steps.slice(before)) {
      const effects = step.effects as readonly MachineEffect[];
      this.steps.push({ record: this.record, input: step.input, effects, state: step.state });
      this.effects[this.record]?.push(...effects);
      for (const effect of effects) this.observe(effect);
    }
  }

  private feed(body: KitInputBody): void {
    this.track(() => this.driver.feed(body));
  }

  private play(record: RecordLine): void {
    switch (record.dir) {
      case 'config':
        return;
      case 'in':
        this.hostWrite(record.v);
        return;
      case 'out':
        this.output(record.v as JsonObject);
        return;
      case 'err':
        for (const text of (record.v as string).split('\n').slice(0, -1)) {
          this.feed({ type: 'stderr.line', text });
        }
        return;
      case 'cmd':
        this.addHost('eof', 'stdin.end', undefined);
        this.feed({ type: 'cmd.close' });
        return;
      case 'timer': {
        const name = own(record.v, 'name') as string;
        if (!this.driver.timers.some(([armed]) => armed === name)) {
          this.problem(`timer ${name} is not armed`);
          return;
        }
        this.track(() => this.driver.fireTimer(name));
        return;
      }
      case 'exit': {
        const exit = record.v as { code: number | null; signal: string | null };
        this.feed({ type: 'stdout.end' });
        this.feed({ type: 'process.exit', code: exit.code, signal: exit.signal });
        if (this.ladder) this.feed({ type: 'ladder.done' });
        return;
      }
    }
  }

  private output(value: JsonObject): void {
    const frame = denormalize(value) as JsonObject;
    const response = own(frame, 'response');
    const id = ownText(response, 'request_id');
    const machineId = id === undefined ? undefined : this.requestIds.get(id);
    const mapped =
      own(frame, 'type') === 'control_response' && machineId !== undefined
        ? { ...frame, response: { ...(response as JsonObject), request_id: machineId } }
        : frame;
    this.frames[this.record] = mapped;
    const text = JSON.stringify(mapped);
    const bytes = utf8Bytes(text);
    this.feed(
      bytes > this.maxFrameBytes
        ? { type: 'line.oversized', bytes }
        : { type: 'line', text, bytes },
    );
  }

  private addHost(key: string, label: string, frame: JsonObject | undefined): void {
    this.hostWrites.push({ record: this.record, key, label, frame, paired: false });
  }

  private hostWrite(value: JsonValue): void {
    const parsed = hostFrame(value);
    if (parsed === 'invalid') {
      this.problem('a host write that is not a JSON object');
      return;
    }
    if (parsed === 'blank') {
      this.addHost('blank', 'blank line', undefined);
      return;
    }
    const type = own(parsed, 'type');
    const request = own(parsed, 'request');
    const subtype = own(request, 'subtype');
    if (type === 'control_request' && subtype === 'initialize') {
      this.addHost(keyOf(parsed, undefined), writeLabel(parsed), parsed);
      this.feed({ type: 'process.started', pid: SPAWNED_PID });
    } else if (type === 'control_request' && subtype === 'interrupt') {
      this.addHost(keyOf(parsed, undefined), writeLabel(parsed), parsed);
      const turnId = this.liveTurns[0];
      const correlation = show(own(parsed, 'request_id'));
      const cancelQueued = own(request, 'cancel_queued') === true;
      this.feed(
        turnId === undefined
          ? { type: 'cmd.interrupt', cancelQueued, correlation }
          : { type: 'cmd.interrupt', turnId, cancelQueued, correlation },
      );
    } else if (type === 'user') {
      const content = own(own(parsed, 'message'), 'content');
      if (content === undefined) {
        this.problem('a user frame without message.content');
        return;
      }
      this.sends += 1;
      const turnId = ownText(parsed, 'uuid') ?? sendUuid(this.sends);
      this.addHost(keyOf(parsed, turnId), 'user', parsed);
      this.liveTurns.push(turnId);
      this.track(() => this.driver.send(turnId, content));
    } else if (type === 'control_response') {
      this.addHost(keyOf(parsed, undefined), writeLabel(parsed), parsed);
      const response = own(parsed, 'response');
      const requestId = String(ownText(response, 'request_id'));
      if (!this.driver.pendingAsks.includes(requestId)) {
        this.problem(`the machine did not ask permission request ${requestId}`);
      } else if (own(response, 'subtype') === 'success') {
        this.track(() => this.driver.answer(requestId, own(response, 'response') as JsonObject));
      } else {
        this.track(() => this.driver.abortAsk(requestId));
      }
    } else {
      this.problem(`no hudhud command writes ${writeLabel(parsed)}`);
    }
  }

  /** Collects writes, maps request ids, tracks live turns and the ladder. */
  private observe(effect: MachineEffect): void {
    if (effect.type === 'write') {
      const frame = JSON.parse(effect.line) as JsonObject;
      const write: ReplayWrite = {
        record: this.record,
        key: keyOf(frame, undefined),
        label: writeLabel(frame),
        frame,
        paired: false,
      };
      this.machineWrites.push(write);
      if (own(frame, 'type') === 'control_request') this.mapRequestId(write);
    } else if (effect.type === 'stdin.end') {
      this.machineWrites.push({
        record: this.record,
        key: 'eof',
        label: 'stdin.end',
        frame: undefined,
        paired: false,
      });
    } else if (
      effect.type === 'turn.settle' ||
      effect.type === 'turn.fail' ||
      effect.type === 'send.rejected'
    ) {
      const at = this.liveTurns.indexOf(effect.turnId);
      if (at >= 0) this.liveTurns.splice(at, 1);
    } else if (effect.type === 'ladder.start') {
      this.ladder = true;
    }
  }

  /** Gives the first recorded control request of the same subtype the machine's request id. */
  private mapRequestId(write: ReplayWrite): void {
    const host = this.hostWrites.find((item) => item.key === write.key && !this.mapped.has(item));
    if (host === undefined) return;
    this.mapped.add(host);
    this.requestIds.set(show(own(host.frame, 'request_id')), show(own(write.frame, 'request_id')));
  }
}
