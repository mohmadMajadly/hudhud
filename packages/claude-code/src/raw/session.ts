/**
 * The unstable raw tier of the Claude Code adapter (plan §2.6; ADR-0003,
 * ADR-0004 §5, ADR-0012 §8, L4).
 *
 * @remarks
 * - {@link raw}: the {@link RawSession} of a session this adapter opened:
 *   every frame on the wire, and (only with
 *   `claudeCode.dangerouslyAllowRawControl: true`) raw control requests and
 *   frames written past the session machine (`raw-channel.ts`).
 * - {@link createSessionRaw}: `sessions.create` with spawn extras.
 *   `extraArgs` may not contain the flags hudhud passes itself (plan §2.5,
 *   both spellings), `--dangerously-skip-permissions`, `--settings` or
 *   `--project-config-root` (L4), each refused with `INVALID_OPTIONS`
 *   (`details.rule`, `details.flag`); every element is passed as one argv
 *   element. `extraEnv` may not name a hudhud-pinned variable. Both are
 *   listed in the session's `securityPosture` by name (`raw.extraArgs`: flag
 *   names; `raw.extraEnv`: variable names, never values).
 *
 * Exempt from the compatibility promises of the stable tier (ADR-0004 §5).
 *
 * @packageDocumentation
 */

import {
  InvalidOptionsError,
  type JsonObject,
  type JsonValue,
  type Session,
  type SubscriberOptions,
} from '@hudhud/core';

import { checkExtraArgs } from '../argv.js';
import { claudeHarnessOf, type ClaudeCodeHarness } from '../connect.js';
import { checkExtraEnv } from '../env.js';
import { resolveSessionOptions, type SessionOptions } from '../options.js';
import type { RawFrame } from '../raw-channel.js';
import { rawChannelOf } from '../session-factory.js';

export type { RawFrame } from '../raw-channel.js';

/**
 * Spawn extras of {@link createSessionRaw} (plan §2.6).
 *
 * @public
 */
export interface RawSpawnOptions {
  readonly extraArgs?: readonly string[];
  readonly extraEnv?: Readonly<Record<string, string>>;
}

/**
 * The raw view of one session (plan §2.6).
 *
 * @public
 */
export interface RawSession {
  /** Every frame in both directions from now on, bounded like `events()`. */
  frames(opts?: SubscriberOptions): AsyncIterable<RawFrame>;
  /**
   * Sends a control request (`{ subtype, ...body }`) and resolves with the
   * CLI's answer. Needs `claudeCode.dangerouslyAllowRawControl: true`.
   */
  controlRequest(
    subtype: string,
    body?: JsonObject,
    opts?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<JsonValue>;
  /** Writes one frame. Needs `claudeCode.dangerouslyAllowRawControl: true`. */
  writeFrame(frame: JsonObject): Promise<void>;
}

function invalid(path: string, rule: string, message: string): InvalidOptionsError {
  return new InvalidOptionsError(message, { details: { path, rule } });
}

/**
 * The raw view of a session this adapter opened.
 *
 * @throws `InvalidOptionsError` for any other value
 * @public
 */
export function raw(session: Session): RawSession {
  const channel = rawChannelOf(session);
  if (channel === undefined) {
    throw invalid('session', 'raw-session', 'raw() takes a session opened by @hudhud/claude-code.');
  }
  return Object.freeze({
    frames: (opts?: SubscriberOptions) => channel.frames(opts),
    controlRequest: (
      subtype: string,
      body?: JsonObject,
      opts: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
    ) => channel.controlRequest(subtype, body, opts),
    writeFrame: (frame: JsonObject) => channel.writeFrame(frame),
  });
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Checks the spawn extras: shapes, reserved flags, pinned variables. */
function checkRaw(value: unknown): {
  readonly extraArgs: readonly string[];
  readonly extraEnv: Readonly<Record<string, string>>;
} {
  if (!isPlainObject(value)) throw invalid('raw', 'raw-options', 'options.raw must be an object.');
  const { extraArgs = [], extraEnv = {}, ...rest } = value;
  if (Object.keys(rest).length > 0) {
    throw invalid('raw', 'raw-options', 'options.raw takes extraArgs and extraEnv only.');
  }
  if (!Array.isArray(extraArgs) || !extraArgs.every((arg) => typeof arg === 'string')) {
    throw invalid('raw.extraArgs', 'raw-options', 'raw.extraArgs must be an array of strings.');
  }
  if (!isPlainObject(extraEnv) || !Object.values(extraEnv).every((v) => typeof v === 'string')) {
    throw invalid('raw.extraEnv', 'raw-options', 'raw.extraEnv must map names to strings.');
  }
  const args = [...(extraArgs as readonly string[])];
  const env = { ...(extraEnv as Readonly<Record<string, string>>) };
  checkExtraArgs(args);
  checkExtraEnv(env);
  return { extraArgs: args, extraEnv: env };
}

/**
 * `sessions.create` with spawn extras (see the module remarks).
 *
 * @throws every error of `sessions.create`; `InvalidOptionsError` for refused
 *   extras or a Harness that is not this adapter's
 * @public
 */
export async function createSessionRaw(
  harness: ClaudeCodeHarness,
  opts: SessionOptions & { readonly raw: RawSpawnOptions },
): Promise<Session> {
  const claude = claudeHarnessOf(harness);
  if (claude === undefined) {
    throw invalid('harness', 'raw-harness', 'createSessionRaw takes a Harness from connect().');
  }
  if (!isPlainObject(opts)) throw invalid('', 'not-an-object', 'options must be a plain object');
  const { raw: extras, ...options } = opts;
  const checked = checkRaw(extras);
  const { effective, host: values } = resolveSessionOptions(options);
  return claude.open(
    { mode: 'create', sessionId: claude.host.ids.uuid() },
    effective,
    values,
    checked,
  );
}
