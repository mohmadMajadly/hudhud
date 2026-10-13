// The host-exit hook (plan §1.6, K22): one `exit` listener for every live
// session, synchronous, installed only while needed.

import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { HostExitHook, hostExit, type ExitEmitter } from '../../../src/binding/host-exit.js';

function emitter(): ExitEmitter & { readonly listeners: (() => void)[] } {
  const listeners: (() => void)[] = [];
  return {
    listeners,
    once: (_event, listener) => {
      listeners.push(listener);
    },
    removeListener: (_event, listener) => {
      listeners.splice(listeners.indexOf(listener), 1);
    },
  };
}

describe('HostExitHook', () => {
  it('installs one listener for many targets and removes it with the last', () => {
    const e = emitter();
    const hook = new HostExitHook(e);
    const ended: string[] = [];
    const offA = hook.register({ endInputNow: () => ended.push('a') });
    const offB = hook.register({ endInputNow: () => ended.push('b') });
    expect(e.listeners).toHaveLength(1);
    expect(hook.size).toBe(2);
    offA();
    offA();
    expect(e.listeners).toHaveLength(1);
    offB();
    expect(e.listeners).toHaveLength(0);
    expect(hook.installed).toBe(false);
    hook.register({ endInputNow: () => ended.push('c') });
    expect(e.listeners).toHaveLength(1);
    e.listeners[0]?.();
    expect(ended).toEqual(['c']);
  });

  it('ends every target synchronously on exit, even when one throws', () => {
    const e = emitter();
    const hook = new HostExitHook(e);
    const ended: string[] = [];
    hook.register({
      endInputNow: () => {
        throw new Error('broken');
      },
    });
    const off = hook.register({ endInputNow: () => ended.push('b') });
    e.listeners[0]?.();
    expect(ended).toEqual(['b']);
    expect(hook.installed).toBe(false);
    expect(hook.size).toBe(0);
    // A removal after the exit fired is harmless.
    off();
    expect(e.listeners).toHaveLength(1);
  });

  it('the host hook uses node:process and is not installed at import', () => {
    expect(hostExit.installed).toBe(false);
    const before = process.listenerCount('exit');
    const off = hostExit.register({ endInputNow: () => undefined });
    expect(process.listenerCount('exit')).toBe(before + 1);
    off();
    expect(process.listenerCount('exit')).toBe(before);
  });
});
