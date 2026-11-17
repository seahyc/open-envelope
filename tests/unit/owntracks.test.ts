import { describe, it, expect } from 'vitest';
import {
  encryptOwnTracksPayload,
  decryptOwnTracksPayload,
  parseEncryptKey,
  parseOwnTracksBody,
  unwrapOwnTracksPayload,
} from '../../src/server/services/context/owntracks.js';

describe('OwnTracks payload helpers', () => {
  it('parses a 64-char hex key', () => {
    const hex = 'ab'.repeat(32);
    const key = parseEncryptKey(hex);
    expect(key).not.toBeNull();
    expect(key).toHaveLength(32);
    expect(Buffer.from(key!).toString('hex')).toBe(hex);
  });

  it('parses standard base64 of 32 bytes', () => {
    const raw = Buffer.alloc(32, 9);
    const key = parseEncryptKey(raw.toString('base64'));
    expect(key).toEqual(new Uint8Array(raw));
  });

  it('NUL-pads an OwnTracks passphrase to 32 bytes', () => {
    const key = parseEncryptKey('mysecreTpass01');
    expect(key).not.toBeNull();
    expect(key).toHaveLength(32);
    expect(Buffer.from(key!.subarray(0, 14)).toString('utf8')).toBe('mysecreTpass01');
    expect(key!.subarray(14).every((b) => b === 0)).toBe(true);
  });

  it('rejects an empty or over-long passphrase', () => {
    expect(parseEncryptKey('')).toBeNull();
    expect(parseEncryptKey('x'.repeat(33))).toBeNull();
  });

  it('round-trips secretbox with a passphrase key', () => {
    const key = parseEncryptKey('device-passphrase-1')!;
    const payload = { _type: 'location', lat: 1.36, lon: 103.99, tst: 1_771_000_000 };
    const data = encryptOwnTracksPayload(payload, key);
    expect(decryptOwnTracksPayload(data, key)).toEqual(payload);
  });

  it('unwraps a single encrypted object and an offline-queue array', () => {
    const key = parseEncryptKey('queue-secret')!;
    const loc = { _type: 'location', lat: 1.36, lon: 103.99, tst: 1_771_000_000 };
    const data = encryptOwnTracksPayload(loc, key);
    expect(unwrapOwnTracksPayload({ _type: 'encrypted', data }, key)).toEqual(loc);
    const batch = unwrapOwnTracksPayload(
      [{ _type: 'encrypted', data }, { _type: 'lwt', tst: 1 }],
      key,
    ) as unknown[];
    expect(batch[0]).toEqual(loc);
    expect(batch[1]).toEqual({ _type: 'lwt', tst: 1 });
  });

  it('throws when encrypted payload has no key or garbage data', () => {
    expect(() => unwrapOwnTracksPayload({ _type: 'encrypted', data: 'xxxx' }, undefined)).toThrow();
    const key = parseEncryptKey('queue-secret')!;
    expect(() => unwrapOwnTracksPayload({ _type: 'encrypted', data: 'not-a-box' }, key)).toThrow();
  });

  it('keeps location points from a mixed array and drops other types', () => {
    const points = parseOwnTracksBody([
      { _type: 'location', lat: 1.36, lon: 103.99, tst: 10 },
      { _type: 'cmd', action: 'dump' },
      { _type: 'lwt', tst: 11 },
    ]);
    expect(points).toEqual([{ lat: 1.36, lon: 103.99, tst: 10, acc: undefined, tid: undefined, _type: 'location' }]);
  });
});
