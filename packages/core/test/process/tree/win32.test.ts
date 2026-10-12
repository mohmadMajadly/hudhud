import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseWin32ProcessJson } from '../../../src/process/tree/win32.js';
import { bytes, fcParams, fixture } from './support.js';

describe('parseWin32ProcessJson on recorded Windows CIM output', () => {
  it('parses the array form, converting FILETIME start times to microseconds exactly', () => {
    const { records, rejected } = parseWin32ProcessJson(fixture('win32/cim-array.out'));
    expect(rejected).toBe(0);
    expect(records).toHaveLength(8);
    expect(records[0]).toEqual({
      pid: 0,
      ppid: 0,
      startTime: '13435773053817224',
      name: 'System Idle Process',
    });
    expect(records.find((record) => record.name === 'explorer.exe')).toEqual({
      pid: 44668,
      ppid: 44788,
      startTime: '13435782422555023',
      name: 'explorer.exe',
    });
    for (const record of records) expect(record).not.toHaveProperty('pgid');
  });

  it('parses the single-object form of Windows PowerShell 5.1', () => {
    expect(parseWin32ProcessJson(fixture('win32/cim-single.out'))).toEqual({
      records: [{ pid: 56860, ppid: 7352, startTime: '13436298173431726', name: 'powershell.exe' }],
      rejected: 0,
    });
  });
});

describe('parseWin32ProcessJson validation', () => {
  it('rejects a document that is not JSON, without records', () => {
    expect(parseWin32ProcessJson(bytes('not json'))).toEqual({ records: [], rejected: 1 });
    expect(parseWin32ProcessJson(new Uint8Array())).toEqual({ records: [], rejected: 1 });
  });

  it('strips a UTF-8 byte order mark', () => {
    expect(parseWin32ProcessJson(bytes('﻿[{"p":8,"pp":4,"t":"5","n":"a"}]')).records).toHaveLength(
      1,
    );
  });

  it('maps a null name to the empty string and keeps hostile names verbatim', () => {
    const json = JSON.stringify([
      { p: 8, pp: 4, t: '50', n: null },
      { p: 9, pp: 8, t: '69', n: 'x\n10 9 6 forged\u0000' },
    ]);
    expect(parseWin32ProcessJson(bytes(json)).records).toEqual([
      { pid: 8, ppid: 4, startTime: '5', name: '' },
      { pid: 9, ppid: 8, startTime: '6', name: 'x\n10 9 6 forged\u0000' },
    ]);
  });

  it('rejects entries with missing or invalid fields', () => {
    const entries: unknown[] = [
      null,
      7,
      'x',
      [1, 2],
      { pp: 4, t: '5', n: 'a' },
      { p: -1, pp: 4, t: '5', n: 'a' },
      { p: 4294967296, pp: 4, t: '5', n: 'a' },
      { p: 1.5, pp: 4, t: '5', n: 'a' },
      { p: '8', pp: 4, t: '5', n: 'a' },
      { p: 8, pp: -4, t: '5', n: 'a' },
      { p: 8, pp: 4, t: 5, n: 'a' },
      { p: 8, pp: 4, t: '', n: 'a' },
      { p: 8, pp: 4, t: '05', n: 'a' },
      { p: 8, pp: 4, t: '5', n: 3 },
      { p: 8, pp: 4, t: '5' },
    ];
    expect(parseWin32ProcessJson(bytes(JSON.stringify(entries)))).toEqual({
      records: [],
      rejected: entries.length,
    });
  });

  it('ignores __proto__ keys', () => {
    const json = '[{"__proto__":{"p":1},"p":8,"pp":4,"t":"5","n":"a"}]';
    expect(parseWin32ProcessJson(bytes(json)).records).toEqual([
      { pid: 8, ppid: 4, startTime: '0', name: 'a' },
    ]);
  });

  it('never throws, and round-trips arbitrary names', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), fc.uint8Array({ maxLength: 64 }), (name, junk) => {
        const encoded = bytes(JSON.stringify([{ p: 8, pp: 4, t: '5', n: name }]));
        // JSON.stringify escapes lone surrogates, so even those survive.
        expect(parseWin32ProcessJson(encoded).records[0]?.name).toBe(name);
        parseWin32ProcessJson(junk);
      }),
      fcParams(),
    );
  });
});
