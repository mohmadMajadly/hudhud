// An in-memory filesystem for the settings guard tests: directories, files,
// links (followed like the OS follows them) and injected failures. Any
// access to a path naming another host is recorded and fails, so a test can
// prove that the guard never touched it.

import path from 'node:path';

import type { ProcessPlatform } from '@hudhudjs/core/process';

import type {
  SettingsEntryKind,
  SettingsFileRead,
  SettingsGuardFs,
} from '../../src/settings-guard.js';

type FakeNode =
  | { readonly kind: 'dir' }
  | { readonly kind: 'file'; readonly bytes: Uint8Array }
  | { readonly kind: 'link'; readonly target: string }
  | { readonly kind: 'other' };

export type FakeOp = 'lstat' | 'readlink' | 'readFile';

function fsError(code: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: fake`), { code });
}

const MAX_HOPS = 40;

export class FakeFs implements SettingsGuardFs {
  readonly platform: ProcessPlatform;
  /** Every call, as `op path`. */
  readonly calls: string[] = [];
  /** Paths naming another host that something tried to touch. */
  readonly remoteTouches: string[] = [];
  readonly #nodes = new Map<string, FakeNode>();
  readonly #failures = new Map<string, string>();

  constructor(platform: ProcessPlatform) {
    this.platform = platform;
  }

  get p(): typeof path.posix {
    return this.platform === 'win32' ? path.win32 : path.posix;
  }

  #key(file: string): string {
    const normal = this.p.normalize(file);
    const { root } = this.p.parse(normal);
    const trimmed =
      normal.length > root.length
        ? normal.replace(this.platform === 'win32' ? /[\\/]+$/ : /\/+$/, '')
        : normal;
    return this.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  }

  #parents(file: string): void {
    for (let dir = this.p.dirname(file); ; dir = this.p.dirname(dir)) {
      if (!this.#nodes.has(this.#key(dir))) this.#nodes.set(this.#key(dir), { kind: 'dir' });
      if (this.p.dirname(dir) === dir) return;
    }
  }

  dir(file: string): this {
    this.#parents(file);
    this.#nodes.set(this.#key(file), { kind: 'dir' });
    return this;
  }

  file(file: string, content: string | Uint8Array): this {
    this.#parents(file);
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    this.#nodes.set(this.#key(file), { kind: 'file', bytes });
    return this;
  }

  json(file: string, value: unknown): this {
    return this.file(file, JSON.stringify(value));
  }

  link(file: string, target: string): this {
    this.#parents(file);
    this.#nodes.set(this.#key(file), { kind: 'link', target });
    return this;
  }

  other(file: string): this {
    this.#parents(file);
    this.#nodes.set(this.#key(file), { kind: 'other' });
    return this;
  }

  fail(op: FakeOp, file: string, code = 'EACCES'): this {
    this.#failures.set(`${op} ${this.#key(file)}`, code);
    return this;
  }

  /** Whether any call named `file` (any operation). */
  touched(file: string): boolean {
    const key = this.#key(file);
    return this.calls.some((call) => this.#key(call.slice(call.indexOf(' ') + 1)) === key);
  }

  #enter(op: FakeOp, file: string): void {
    this.calls.push(`${op} ${file}`);
    if (/^[\\/]{2}/.test(file) && !/^[\\/]{2}[?.][\\/][A-Za-z]:/.test(file)) {
      this.remoteTouches.push(file);
      throw fsError('EHOSTUNREACH');
    }
    const code = this.#failures.get(`${op} ${this.#key(file)}`);
    if (code !== undefined) throw fsError(code);
  }

  /** The node at `file`; links are followed except a final one unless `followLast`. */
  #locate(file: string, followLast: boolean, hops = 0): FakeNode | null {
    const normal = this.p.normalize(file);
    const { root } = this.p.parse(normal);
    const segments = normal
      .slice(root.length)
      .split(this.platform === 'win32' ? /[\\/]+/ : /\/+/)
      .filter((s) => s !== '');
    let current = root;
    let node: FakeNode = { kind: 'dir' };
    for (const [index, segment] of segments.entries()) {
      if (node.kind !== 'dir') return null;
      const next = this.p.join(current, segment);
      const found = this.#nodes.get(this.#key(next));
      if (found === undefined) return null;
      const last = index === segments.length - 1;
      if (found.kind === 'link' && (!last || followLast)) {
        if (hops >= MAX_HOPS) throw fsError('ELOOP');
        if (/^[\\/]{2}/.test(found.target)) {
          this.remoteTouches.push(found.target);
          throw fsError('EHOSTUNREACH');
        }
        const base = this.p.isAbsolute(found.target)
          ? found.target
          : this.p.join(current, found.target);
        return this.#locate(this.p.join(base, ...segments.slice(index + 1)), followLast, hops + 1);
      }
      node = found;
      current = next;
    }
    return node;
  }

  /** Runs a synchronous operation as a promise; a throw becomes a rejection. */
  #settle<T>(operation: () => T): Promise<T> {
    return new Promise((resolve) => {
      resolve(operation());
    });
  }

  lstat(file: string): Promise<SettingsEntryKind | null> {
    return this.#settle(() => {
      this.#enter('lstat', file);
      const node = this.#locate(file, false);
      if (node === null) return null;
      const kinds = { dir: 'directory', file: 'file', link: 'symlink', other: 'other' } as const;
      return kinds[node.kind];
    });
  }

  readlink(file: string): Promise<string> {
    return this.#settle(() => {
      this.#enter('readlink', file);
      const node = this.#locate(file, false);
      if (node?.kind !== 'link') throw fsError('EINVAL');
      return node.target;
    });
  }

  readFile(file: string, maxBytes: number): Promise<SettingsFileRead> {
    return this.#settle((): SettingsFileRead => {
      this.#enter('readFile', file);
      const node = this.#locate(file, true);
      if (node === null) return { kind: 'absent' };
      if (node.kind !== 'file') return { kind: 'not-a-file' };
      if (node.bytes.length > maxBytes) return { kind: 'oversized' };
      return { kind: 'ok', bytes: node.bytes };
    });
  }
}
