import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as errors from '../src/binding/errors.js';
import {
  AbortError,
  HudhudError,
  ProcessExitedError,
  ProjectCredentialEnvError,
  ProtocolError,
  isHudhudError,
} from '../src/binding/errors.js';
import {
  ERROR_RETRYABLE,
  HUDHUD_ERROR_CODES,
  type HudhudErrorCode,
  parseErrorData,
} from '../src/protocol/errors.js';

type Ctor = new (message: string, options?: errors.HudhudErrorOptions) => HudhudError;

/** Class name per code, spelled out from plan 3.1 (independent of the implementation). */
const EXPECTED: readonly (readonly [string, HudhudErrorCode, boolean])[] = [
  ['InvalidOptionsError', 'INVALID_OPTIONS', false],
  ['CapabilityUnsupportedError', 'CAPABILITY_UNSUPPORTED', false],
  ['AdapterApiVersionError', 'ADAPTER_API_VERSION_MISMATCH', false],
  ['BinaryNotFoundError', 'BINARY_NOT_FOUND', false],
  ['BinaryRefusedError', 'BINARY_REFUSED', false],
  ['BinaryVerificationError', 'BINARY_VERIFICATION_FAILED', false],
  ['BinaryProbeError', 'BINARY_PROBE_FAILED', true],
  ['CwdInvalidError', 'CWD_INVALID', false],
  ['CwdTooLongError', 'CWD_TOO_LONG', false],
  ['ProjectCredentialEnvError', 'PROJECT_CREDENTIAL_ENV', false],
  ['SessionIdInUseError', 'SESSION_ID_IN_USE', true],
  ['SpawnError', 'SPAWN_FAILED', false],
  ['HandshakeTimeoutError', 'HANDSHAKE_TIMEOUT', true],
  ['HandshakeError', 'HANDSHAKE_FAILED', true],
  ['SessionNotFoundError', 'SESSION_NOT_FOUND', false],
  ['AuthenticationFailedError', 'AUTHENTICATION_FAILED', false],
  ['SessionPoisonedError', 'SESSION_POISONED', false],
  ['ProtocolError', 'PROTOCOL_ERROR', false],
  ['OversizedFrameError', 'OVERSIZED_FRAME', false],
  ['OutboundFrameTooLargeError', 'OUTBOUND_FRAME_TOO_LARGE', false],
  ['ControlRequestError', 'CONTROL_REQUEST_FAILED', true],
  ['ProcessExitedError', 'PROCESS_EXITED', true],
  ['SessionClosedError', 'SESSION_CLOSED', false],
  ['HarnessDisposedError', 'HARNESS_DISPOSED', false],
  ['AbortError', 'ABORTED', false],
  ['SubscriberOverflowError', 'SUBSCRIBER_OVERFLOW', false],
];

function ctorOf(name: string): Ctor {
  const found = (errors as Record<string, unknown>)[name];
  expect(typeof found).toBe('function');
  return found as Ctor;
}

const SECRET = 'FAKE-SECRET-VALUE-0123456789';

describe('taxonomy coverage', () => {
  it('has exactly one class for every code, in the order of the code table', () => {
    expect(EXPECTED.map(([, code]) => code)).toEqual([...HUDHUD_ERROR_CODES]);
    for (const [name, code, retryable] of EXPECTED) {
      expect(ctorOf(name).name).toBe(name);
      expect(ERROR_RETRYABLE[code]).toBe(retryable);
    }
  });

  it('matches the table in the implementation plan 3.1 (names, codes, retryability)', () => {
    const plan = readFileSync(
      fileURLToPath(new URL('../../../docs/plan/v1-implementation.md', import.meta.url)),
      'utf8',
    );
    const rows = [
      ...plan.matchAll(
        /^\| `(\w+Error)`(?: \(extends `\w+`\))? \| `([A-Z_]+)` \|.*\| (yes|no) \|$/gmu,
      ),
    ].map(([, name, code, retry]) => [name, code, retry === 'yes']);
    expect(rows).toEqual(EXPECTED.map((row) => [...row]));
  });
});

describe.each(EXPECTED)('%s', (name, code, retryable) => {
  const Class = ctorOf(name);
  const details = { path: 'a.b', list: ['x', 1, null], nested: { ok: true } };

  it('constructs with code, retryability, name and the Error prototype chain', () => {
    const error = new Class('boom');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(HudhudError);
    expect(isHudhudError(error)).toBe(true);
    expect(error).toBeInstanceOf(Class);
    expect(error.code).toBe(code);
    expect(Class).toHaveProperty('code', code);
    expect(error.retryable).toBe(retryable);
    expect(error.name).toBe(name);
    expect(error.message).toBe('boom');
    expect(error.details).toBeUndefined();
    expect(error.cause).toBeUndefined();
    expect(Object.hasOwn(error, 'cause')).toBe(false);
  });

  it('copies details on the way in and on the way out', () => {
    const source = { ...details };
    const error = new Class('boom', { details: source });
    expect(error.details).toEqual(details);
    expect(error.details).not.toBe(source);
    expect(error.toData().details).not.toBe(error.details);
  });

  it('round-trips as JSON data: serialize, parse, reconstruct equal', () => {
    for (const withDetails of [false, true]) {
      const error = new Class('boom', withDetails ? { details } : {});
      const text = JSON.stringify(error);
      expect(JSON.parse(text)).toEqual(error.toData());
      const parsed = parseErrorData(JSON.parse(text));
      if (!parsed.ok) throw new Error(`parse failed: ${parsed.reason}`);
      expect(parsed.value).toEqual({
        code,
        message: 'boom',
        retryable,
        ...(withDetails ? { details } : {}),
      });
      const rebuilt = HudhudError.fromData(parsed.value);
      expect(rebuilt).toBeInstanceOf(Class);
      expect(rebuilt.constructor).toBe(Class);
      expect(rebuilt.name).toBe(name);
      expect(rebuilt.code).toBe(code);
      expect(rebuilt.retryable).toBe(retryable);
      expect(rebuilt.message).toBe('boom');
      expect(rebuilt.details).toEqual(error.details);
      expect(rebuilt.toData()).toEqual(error.toData());
      expect(JSON.stringify(rebuilt)).toBe(text);
    }
  });

  it('keeps cause in memory only: never in data, JSON or message', () => {
    const cause = new Error(`failed with ${SECRET}`);
    const error = new Class('boom', { cause });
    expect(error.cause).toBe(cause);
    expect(Object.keys(error.toData()).sort()).toEqual(['code', 'message', 'retryable']);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(error.message).not.toContain(SECRET);
    expect(HudhudError.fromData(error.toData()).cause).toBeUndefined();
  });

  it('keeps a cause that is undefined or a non-error as given', () => {
    expect(new Class('x', { cause: undefined }).cause).toBeUndefined();
    expect(Object.hasOwn(new Class('x', { cause: undefined }), 'cause')).toBe(true);
    expect(new Class('x', { cause: 'plain' }).cause).toBe('plain');
  });
});

describe('class relationships', () => {
  it('OversizedFrameError extends ProtocolError with its own code', () => {
    const error = new errors.OversizedFrameError('too big', {
      details: { bytes: 5, maxFrameBytes: 4 },
    });
    expect(error).toBeInstanceOf(ProtocolError);
    expect(error.code).toBe('OVERSIZED_FRAME');
    expect(new ProtocolError('x').code).toBe('PROTOCOL_ERROR');
  });
});

describe('AbortError', () => {
  it('has a default message and keeps name AbortError', () => {
    const error = new AbortError();
    expect(error.name).toBe('AbortError');
    expect(error.message).toBe('The operation was aborted.');
    expect(new AbortError('custom').message).toBe('custom');
  });

  it('fromSignal keeps signal.reason as cause', () => {
    const controller = new AbortController();
    const reason = new Error('user cancelled');
    controller.abort(reason);
    const error = AbortError.fromSignal(controller.signal);
    expect(error.cause).toBe(reason);
    expect(error.code).toBe('ABORTED');
    expect(error.retryable).toBe(false);
    expect(JSON.stringify(error)).not.toContain('user cancelled');
    const plain = new AbortController();
    plain.abort();
    expect(AbortError.fromSignal(plain.signal).cause).toBe(plain.signal.reason);
  });
});

describe('ProcessExitedError details', () => {
  it('carries exit facts and the (already redacted) stderr tail as plain data', () => {
    const error = new ProcessExitedError('The process exited.', {
      details: {
        exitCode: null,
        signal: 'SIGTERM',
        outcome: 'killed-externally',
        stderrTail: '<redacted>',
      },
    });
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: 'PROCESS_EXITED',
      message: 'The process exited.',
      retryable: true,
      details: {
        exitCode: null,
        signal: 'SIGTERM',
        outcome: 'killed-externally',
        stderrTail: '<redacted>',
      },
    });
  });
});

describe('ProjectCredentialEnvError.fromFindings', () => {
  it('names variables and files but never values', () => {
    const env: Record<string, string> = {
      ANTHROPIC_API_KEY: SECRET,
      MY_PROJECT_TOKEN: 'tok-FAKE-9999',
    };
    const error = ProjectCredentialEnvError.fromFindings({
      files: ['.claude/settings.json', '.claude/settings.local.json'],
      variables: Object.keys(env),
      apiKeyHelper: true,
      unparseable: ['..\\settings.json'],
    });
    expect(error.code).toBe('PROJECT_CREDENTIAL_ENV');
    expect(error.retryable).toBe(false);
    const text = `${error.message}\n${JSON.stringify(error)}`;
    for (const value of Object.values(env)) expect(text).not.toContain(value);
    for (const key of Object.keys(env)) expect(error.message).toContain(key);
    expect(error.message).toContain('apiKeyHelper');
    expect(error.message).toContain('settings.local.json');
    expect(error.message).toContain('unparseable');
    expect(error.details).toEqual({
      files: ['.claude/settings.json', '.claude/settings.local.json'],
      variables: ['ANTHROPIC_API_KEY', 'MY_PROJECT_TOKEN'],
      apiKeyHelper: true,
      unparseable: ['..\\settings.json'],
    });
    const rebuilt = HudhudError.fromData(error.toData());
    expect(rebuilt).toBeInstanceOf(ProjectCredentialEnvError);
    expect(rebuilt.toData()).toEqual(error.toData());
  });

  it('copies the findings and describes a bare finding without a variable list', () => {
    const files = ['a.json'];
    const error = ProjectCredentialEnvError.fromFindings({
      files,
      variables: [],
      apiKeyHelper: false,
      unparseable: [],
    });
    files.push('b.json');
    expect(error.details).toEqual({
      files: ['a.json'],
      variables: [],
      apiKeyHelper: false,
      unparseable: [],
    });
    expect(error.message).toBe('Project settings define credential settings. Files: a.json.');
  });
});

describe('isHudhudError', () => {
  it('is false for other values', () => {
    expect(isHudhudError(new Error('x'))).toBe(false);
    expect(isHudhudError({ code: 'ABORTED' })).toBe(false);
    expect(isHudhudError(null)).toBe(false);
  });
});

describe('neutrality', () => {
  it('has no Claude-specific names in the error sources', () => {
    for (const file of ['../src/protocol/errors.ts', '../src/binding/errors.ts']) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(source).not.toMatch(/claude/i);
    }
  });
});
