/**
 * The host-exit hook (plan §1.6, K22, research 02 §6.3).
 *
 * @remarks
 * When the host process exits, every live session's harness input is ended
 * synchronously, so each harness sees EOF and finishes like a graceful EOF
 * (ADR-0010 residuals: on Linux host death is stdin EOF). This is the only
 * process-level hook hudhud installs: exactly one `process.once('exit')`
 * listener, present only while at least one session is live, removed when
 * the last one ends and installed again for the next. hudhud installs no
 * signal handlers (K22): a terminal Ctrl+C is the application's to handle,
 * and a harness it reaches ends as outcome `unknown` with `PROCESS_EXITED`.
 *
 * An `exit` listener runs synchronously and cannot wait: nothing here
 * schedules work, and a failing end of one session never stops the others.
 *
 * @packageDocumentation
 */

import process from 'node:process';

/**
 * The part of `process` the hook uses; injectable for tests.
 *
 * @beta
 */
export interface ExitEmitter {
  once(event: 'exit', listener: () => void): unknown;
  removeListener(event: 'exit', listener: () => void): unknown;
}

/**
 * Something whose harness input must end when the host exits.
 *
 * @beta
 */
export interface HostExitTarget {
  /** Ends the harness's input synchronously; must not schedule work. */
  endInputNow(): void;
}

/**
 * The registry behind the hook: one listener for all live sessions.
 *
 * @beta
 */
export class HostExitHook {
  readonly #emitter: ExitEmitter;
  readonly #targets = new Set<HostExitTarget>();
  #installed = false;
  readonly #listener = (): void => {
    this.#installed = false;
    for (const target of [...this.#targets]) {
      try {
        target.endInputNow();
      } catch {
        // One session's failure must not keep the others' harnesses running.
      }
    }
    this.#targets.clear();
  };

  constructor(emitter: ExitEmitter) {
    this.#emitter = emitter;
  }

  /** Live targets. */
  get size(): number {
    return this.#targets.size;
  }

  /** Whether the `exit` listener is installed. */
  get installed(): boolean {
    return this.#installed;
  }

  /** Adds a target; installs the listener for the first one. Returns the removal function. */
  register(target: HostExitTarget): () => void {
    this.#targets.add(target);
    if (!this.#installed) {
      this.#installed = true;
      this.#emitter.once('exit', this.#listener);
    }
    return () => {
      this.#unregister(target);
    };
  }

  #unregister(target: HostExitTarget): void {
    if (!this.#targets.delete(target) || this.#targets.size > 0 || !this.#installed) return;
    this.#installed = false;
    this.#emitter.removeListener('exit', this.#listener);
  }
}

/**
 * The host's hook over `node:process`.
 *
 * @beta
 */
export const hostExit: HostExitHook = new HostExitHook(process);
