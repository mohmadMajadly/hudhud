import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CliFetchError } from '../../src/cli/errors.js';
import { MAX_PAX_BYTES, checkEntryPath, extractTarEntry, parsePax } from '../../src/cli/tar.js';
import type { TarExtractOptions } from '../../src/cli/tar.js';
import {
  END,
  archive,
  bytes,
  chunked,
  concat,
  entry,
  header,
  pax,
  paxRecord,
  source,
} from './tar-builder.js';

const WANTED = 'package/claude';
const NUL = String.fromCharCode(0);
const BINARY = bytes('#!fake binary, never executed\n'.repeat(40));

interface Run {
  readonly size: number;
  readonly data: Uint8Array;
}

async function run(
  chunks: readonly Uint8Array[],
  overrides: Partial<TarExtractOptions> = {},
): Promise<Run> {
  const received: Uint8Array[] = [];
  const result = await extractTarEntry(source(chunks), {
    wanted: WANTED,
    maxWantedSize: 1024 * 1024,
    maxOtherSize: 64 * 1024,
    maxEntries: 16,
    maxTrailingBytes: 16 * 1024,
    onData: (chunk) => {
      received.push(chunk.slice());
    },
    ...overrides,
  });
  return { size: result.size, data: concat(received) };
}

async function refusal(
  data: Uint8Array,
  overrides: Partial<TarExtractOptions> = {},
): Promise<string> {
  try {
    await run([data], overrides);
  } catch (error) {
    expect(error).toBeInstanceOf(CliFetchError);
    expect((error as CliFetchError).code).toBe('archive-refused');
    return (error as CliFetchError).message;
  }
  throw new Error('expected the archive to be refused');
}

const npmLike = (): Uint8Array =>
  archive(
    entry({ name: 'package/LICENSE.md', body: bytes('license text') }),
    entry({ name: 'package/README.md', body: bytes('readme') }),
    entry({ name: WANTED, body: BINARY }),
    entry({ name: 'package/package.json', body: bytes('{"name":"x"}') }),
  );

describe('extractTarEntry: accepted shapes', () => {
  it('extracts only the wanted entry of an npm-like archive', async () => {
    const result = await run([npmLike()], { expectedSize: BINARY.byteLength });
    expect(result.size).toBe(BINARY.byteLength);
    expect(result.data).toEqual(BINARY);
  });

  it('accepts directories, the ustar prefix, pax paths and zero padding after the marker', async () => {
    const data = concat([
      entry({ name: 'package/', type: '5' }),
      entry({ name: 'claude', prefix: 'package', type: '\0', body: BINARY }),
      pax(paxRecord('path', 'package/renamed-by-pax') + paxRecord('mtime', '1.5')),
      entry({ name: 'package/ignored-ustar-name', body: bytes('x') }),
      END,
      new Uint8Array(4096),
    ]);
    expect((await run([data])).data).toEqual(BINARY);
  });

  it('reads a name that fills its whole 100-byte field', async () => {
    const long = `package/${'n'.repeat(92)}`;
    expect(Buffer.byteLength(long)).toBe(100);
    const data = archive(entry({ name: long, body: BINARY }));
    expect((await run([data], { wanted: long })).data).toEqual(BINARY);
  });

  it('uses the pax path to identify the wanted entry', async () => {
    const data = archive(
      pax(paxRecord('path', WANTED)),
      entry({ name: 'package/short-name', body: BINARY }),
    );
    expect((await run([data])).data).toEqual(BINARY);
  });

  it('accepts a pax header without a path and keeps the ustar name', async () => {
    const data = archive(pax(paxRecord('comment', 'hi')), entry({ name: WANTED, body: BINARY }));
    expect((await run([data])).data).toEqual(BINARY);
  });

  it('accepts an empty wanted entry and empty source chunks', async () => {
    const data = archive(entry({ name: WANTED }));
    const result = await run([new Uint8Array(0), data, new Uint8Array(0)]);
    expect(result).toEqual({ size: 0, data: new Uint8Array(0) });
  });

  it('accepts numeric fields with leading spaces and space terminators', async () => {
    const data = archive(
      entry({ name: WANTED, body: BINARY, sizeField: ` ${BINARY.byteLength.toString(8)} ` }),
    );
    expect((await run([data])).data).toEqual(BINARY);
  });

  it('awaits an asynchronous sink', async () => {
    const order: string[] = [];
    await extractTarEntry(source([npmLike()]), {
      wanted: WANTED,
      maxWantedSize: 1 << 20,
      maxOtherSize: 1 << 16,
      maxEntries: 16,
      maxTrailingBytes: 0,
      onData: async () => {
        await Promise.resolve();
        order.push('chunk');
      },
    });
    expect(order.length).toBeGreaterThan(0);
  });
});

describe('extractTarEntry: refused archives', () => {
  it.each([
    ['../package/claude', 'traversal'],
    ['package/../claude', 'traversal'],
    ['package/./claude', 'traversal'],
    ['package//claude', 'traversal'],
    ['/package/claude', 'absolute'],
    ['C:/package/claude', 'absolute'],
    ['c:package', 'absolute'],
    ['package\\claude', 'backslash'],
    ['package/cl\u0001aude', 'control character'],
    ['other/claude', 'outside package/'],
  ])('refuses the name %j (%s), wanted or not', async (name, reason) => {
    expect(
      await refusal(archive(entry({ name, body: bytes('x') }), entry({ name: WANTED }))),
    ).toContain(reason);
  });

  it('refuses a dangerous name smuggled through a pax path', async () => {
    const data = archive(pax(paxRecord('path', '../../etc/passwd')), entry({ name: WANTED }));
    expect(await refusal(data)).toContain('traversal');
  });

  it('refuses a directory with a dangerous name or a size', async () => {
    expect(await refusal(archive(entry({ name: '../', type: '5' })))).toContain('traversal');
    expect(await refusal(archive(entry({ name: 'package/', type: '5', size: 1 })))).toContain(
      'has a size',
    );
  });

  it.each([
    ['1', 'link'],
    ['2', 'link'],
    ['3', 'device'],
    ['4', 'device'],
    ['6', 'FIFO'],
    ['7', 'unsupported'],
    ['g', 'unsupported'],
    ['L', 'unsupported'],
    ['K', 'unsupported'],
    ['S', 'unsupported'],
  ])('refuses entry type %j', async (type, reason) => {
    const data = archive(entry({ name: WANTED, type, linkname: '/etc/passwd' }));
    expect(await refusal(data)).toContain(reason);
  });

  it('refuses a header checksum mismatch, a foreign magic and non-octal fields', async () => {
    expect(await refusal(archive(entry({ name: WANTED, badChecksum: true })))).toContain(
      'checksum',
    );
    expect(await refusal(archive(entry({ name: WANTED, magic: 'ustar  \0' })))).toContain('ustar');
    expect(await refusal(archive(entry({ name: WANTED, sizeField: '0000000009\0' })))).toContain(
      'octal',
    );
    // GNU base-256 size encoding (high bit set) is refused.
    const base256 = header({ name: WANTED });
    base256[124] = 0x80;
    expect(await refusal(concat([base256, END]))).toContain('checksum');
  });

  it('refuses invalid UTF-8 in names and pax records', async () => {
    expect(
      await refusal(archive(entry({ name: '', nameBytes: Uint8Array.of(0x70, 0xff) }))),
    ).toContain('UTF-8');
    expect(await refusal(archive(entry({ name: '' })))).toContain('empty entry name');
    const badPax = concat([bytes('9 path='), Uint8Array.of(0xff), bytes('\n')]);
    const data = archive(
      entry({ name: 'PaxHeader/x', type: 'x', body: badPax }),
      entry({ name: WANTED }),
    );
    expect(await refusal(data)).toContain('UTF-8');
  });

  it.each(['linkpath', 'size', 'GNU.sparse.map'])('refuses the pax key %j', async (key) => {
    const data = archive(pax(paxRecord(key, '1')), entry({ name: WANTED }));
    expect(await refusal(data)).toContain('not supported');
  });

  it('refuses pax misuse: consecutive, trailing, oversized', async () => {
    expect(
      await refusal(
        archive(pax(paxRecord('a', 'b')), pax(paxRecord('a', 'b')), entry({ name: WANTED })),
      ),
    ).toContain('consecutive');
    expect(await refusal(archive(entry({ name: WANTED }), pax(paxRecord('a', 'b'))))).toContain(
      'without a following entry',
    );
    const big = archive(entry({ name: 'PaxHeader/x', type: 'x', size: MAX_PAX_BYTES + 1 }));
    expect(await refusal(big)).toContain('oversized pax');
  });

  it('refuses oversized entries before reading their bodies', async () => {
    const huge = archive(entry({ name: 'package/README.md', size: 2 ** 33 - 1 }));
    expect(await refusal(huge)).toContain('oversized entry');
    const wanted = archive(entry({ name: WANTED, size: 2 ** 33 - 1 }));
    expect(await refusal(wanted)).toContain('oversized entry');
  });

  it('refuses a wanted entry of an unexpected size without writing a byte', async () => {
    let written = 0;
    await expect(
      run([npmLike()], {
        expectedSize: BINARY.byteLength + 1,
        onData: () => {
          written += 1;
        },
      }),
    ).rejects.toThrow(/expected/);
    expect(written).toBe(0);
  });

  it('refuses duplicates, a missing entry and too many entries', async () => {
    expect(await refusal(archive(entry({ name: WANTED }), entry({ name: WANTED })))).toContain(
      'duplicate',
    );
    expect(await refusal(archive(entry({ name: 'package/README.md' })))).toContain('not found');
    expect(await refusal(npmLike(), { maxEntries: 3 })).toContain('too many entries');
  });

  it('refuses a malformed end marker and data or excess padding after it', async () => {
    const one = concat([
      entry({ name: WANTED }),
      new Uint8Array(512),
      entry({ name: 'package/x' }),
    ]);
    expect(await refusal(one)).toContain('end-of-archive');
    const garbage = concat([archive(entry({ name: WANTED })), Uint8Array.of(1)]);
    expect(await refusal(garbage)).toContain('data after the end-of-archive marker');
    const padded = concat([archive(entry({ name: WANTED })), new Uint8Array(4096)]);
    expect(await refusal(padded, { maxTrailingBytes: 1024 })).toContain('too much data');
    const lateGarbage = [
      archive(entry({ name: WANTED })),
      new Uint8Array(512),
      Uint8Array.of(0, 7),
    ];
    await expect(run(lateGarbage)).rejects.toThrow(/data after/);
  });

  it('refuses truncation in a header, a body, padding and the end marker', async () => {
    const full = npmLike();
    for (const cut of [0, 100, 512, 700, full.byteLength - 1024, full.byteLength - 1]) {
      expect(await refusal(full.subarray(0, cut))).toContain('truncated');
    }
    const pending = concat([header({ name: WANTED, size: 600 }), new Uint8Array(600)]);
    expect(await refusal(pending)).toContain('truncated');
  });
});

describe('checkEntryPath and parsePax', () => {
  it('accepts plain package paths and a directory slash', () => {
    expect(() => {
      checkEntryPath('package/a/b.txt', false);
    }).not.toThrow();
    expect(() => {
      checkEntryPath('package/a/', true);
    }).not.toThrow();
    expect(() => {
      checkEntryPath('package/a/', false);
    }).toThrow(CliFetchError);
  });

  it.each([
    [''],
    ['x'],
    ['12 path=x'],
    ['0 path=x\n'],
    ['9 path=xyz\n'],
    ['5 a=b\n'],
    ['6 =ab\n'],
    ['5 ab\n\n'],
    ['3 \n'],
    ['01 x'],
  ])('refuses the malformed pax body %j unless empty', (raw) => {
    if (raw === '') {
      expect(parsePax(bytes(raw))).toBeUndefined();
      return;
    }
    expect(() => parsePax(bytes(raw))).toThrow(CliFetchError);
  });

  it('keeps the last path record', () => {
    expect(parsePax(bytes(paxRecord('path', 'package/a') + paxRecord('path', 'package/b')))).toBe(
      'package/b',
    );
  });
});

// ---------------------------------------------------------------------------
// Fuzzing (fast-check). Seeds are printed on failure; FC_SEED reproduces.

const SAFE_NAMES = [
  'package/README.md',
  'package/LICENSE.md',
  'package/package.json',
  'package/sub/file',
  WANTED,
];
const DANGEROUS_NAMES = [
  '../claude',
  'package/../claude',
  'package/../../etc/passwd',
  '/etc/passwd',
  '/package/claude',
  'C:\\Windows\\x',
  'C:/x',
  'package\\..\\claude',
  'package/./claude',
  'package//claude',
  './package/claude',
  'package/\u0000hidden',
  'package/\u001b[31m',
  'other/claude',
  '',
];
const TYPES = [
  '0',
  '\0',
  '5',
  '1',
  '2',
  '3',
  '4',
  '6',
  '7',
  'g',
  'L',
  'K',
  'S',
  'V',
  'M',
  'N',
  'D',
];

/** Independent reference: what the reader may accept for a non-pax entry. */
function referenceSafe(name: string, type: string): boolean {
  const path = type === '5' && name.endsWith('/') ? name.slice(0, -1) : name;
  return (
    ['0', '\0', '5'].includes(type) &&
    (path === 'package' || path.startsWith('package/')) &&
    !path.includes('\\') &&
    // eslint-disable-next-line no-control-regex -- the reference rejects control characters
    !/[\u0000-\u001f\u007f]/.test(path) &&
    !path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  );
}

const entryArb = fc
  .record({
    name: fc.oneof(
      fc.constantFrom(...SAFE_NAMES),
      fc.constantFrom(...DANGEROUS_NAMES),
      fc.string({ unit: 'binary-ascii', maxLength: 40 }).map((s) => `package/${s}`),
      fc.string({ unit: 'grapheme', maxLength: 30 }),
    ),
    type: fc.oneof(
      { weight: 4, arbitrary: fc.constant('0') },
      { weight: 3, arbitrary: fc.constantFrom(...TYPES) },
    ),
    body: fc.uint8Array({ maxLength: 1500 }),
    viaPax: fc.boolean(),
  })
  // A ustar name field ends at its first NUL (String.fromCharCode(0)) and holds 100 bytes; pax paths have neither limit.
  .filter(
    (spec) => spec.viaPax || (!spec.name.includes(NUL) && Buffer.byteLength(spec.name) <= 100),
  );

describe('extractTarEntry: fuzzing', () => {
  it('accepts exactly the safe archives and only ever emits the wanted entry', async () => {
    let accepted = 0;
    let refusedCount = 0;
    const wantedEntry = fc.record({
      name: fc.constant(WANTED),
      type: fc.constantFrom('0', '\0'),
      body: fc.uint8Array({ maxLength: 1500 }),
      viaPax: fc.boolean(),
    });
    const safeEntry = fc.record({
      name: fc.constantFrom(...SAFE_NAMES.filter((name) => name !== WANTED)),
      type: fc.constantFrom('0', '5'),
      body: fc.uint8Array({ maxLength: 600 }),
      viaPax: fc.boolean(),
    });
    // Mostly-safe archives with the wanted entry somewhere, mixed with arbitrary ones.
    const archiveArb = fc.oneof(
      fc.array(entryArb, { maxLength: 8 }),
      fc
        .tuple(
          fc.array(
            fc.oneof({ weight: 5, arbitrary: safeEntry }, { weight: 1, arbitrary: entryArb }),
            { maxLength: 6 },
          ),
          wantedEntry,
          fc.nat(),
        )
        .map(([others, wanted, at]) => [
          ...others.slice(0, at % (others.length + 1)),
          wanted,
          ...others.slice(at % (others.length + 1)),
        ]),
    );
    await fc.assert(
      fc.asyncProperty(archiveArb, async (specs) => {
        const parts = specs.flatMap((spec) => [
          ...(spec.viaPax ? [pax(paxRecord('path', spec.name))] : []),
          entry({
            name: spec.viaPax ? 'package/placeholder' : spec.name,
            type: spec.type,
            body: spec.type === '5' ? new Uint8Array(0) : spec.body,
          }),
        ]);
        const allSafe = specs.every((spec) => referenceSafe(spec.name, spec.type));
        const wanted = specs.filter((spec) => spec.name === WANTED && spec.type !== '5');
        let outcome: Run | CliFetchError;
        try {
          outcome = await run([archive(...parts)], { maxEntries: 64 });
        } catch (error) {
          if (!(error instanceof CliFetchError) || error.code !== 'archive-refused') throw error;
          outcome = error;
        }
        if (allSafe && wanted.length === 1) {
          accepted += 1;
          expect(outcome).not.toBeInstanceOf(CliFetchError);
          expect((outcome as Run).data).toEqual(wanted[0]?.body);
        } else {
          refusedCount += 1;
          expect(outcome).toBeInstanceOf(CliFetchError);
        }
      }),
      { numRuns: 2000 },
    );
    // The property must exercise both outcomes substantially.
    expect(accepted).toBeGreaterThan(200);
    expect(refusedCount).toBeGreaterThan(200);
  });

  it('never fails other than closed on mutated or truncated archives', async () => {
    const base = npmLike();
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.nat({ max: base.byteLength - 1 }), fc.integer({ min: 1, max: 255 })), {
          maxLength: 6,
        }),
        fc.option(fc.nat({ max: base.byteLength - 1 }), { nil: undefined }),
        async (flips, cut) => {
          const data = base.slice();
          for (const [index, xor] of flips) data[index] = (data[index] ?? 0) ^ xor;
          const input = cut === undefined ? data : data.subarray(0, cut);
          try {
            const result = await run([input]);
            expect(cut).toBeUndefined();
            expect(result.data.byteLength).toBe(result.size);
            expect(result.size).toBeLessThanOrEqual(1024 * 1024);
          } catch (error) {
            if (!(error instanceof CliFetchError)) throw error;
            expect(error.code).toBe('archive-refused');
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('every strict prefix of a valid archive is refused as truncated', async () => {
    const base = npmLike();
    await fc.assert(
      fc.asyncProperty(fc.nat({ max: base.byteLength - 1 }), async (cut) => {
        expect(await refusal(base.subarray(0, cut))).toContain('truncated');
      }),
      { numRuns: 300 },
    );
  });

  it('the output does not depend on how the stream is chunked', async () => {
    const base = npmLike();
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.nat({ max: base.byteLength }), { maxLength: 30 }),
        async (cuts) => {
          expect((await run(chunked(base, cuts))).data).toEqual(BINARY);
        },
      ),
      { numRuns: 300 },
    );
    // 300 full extractions of a 1 MiB-bounded archive, up to 31 chunks each
    // (about 4 s on Windows with coverage). The timeout is a hang guard, not a
    // performance budget (W3-Z ruling 4).
  }, 60_000);
});
