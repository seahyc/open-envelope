import nacl from 'tweetnacl';

export interface OwnTracksLocation {
  lat: number;
  lon: number;
  tst: number;
  acc?: number;
  tid?: string;
  _type?: string;
}

export function parseOwnTracksBody(body: unknown): OwnTracksLocation[] {
  const items = Array.isArray(body) ? body : [body];
  const out: OwnTracksLocation[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const type = typeof row._type === 'string' ? row._type : 'location';
    if (type !== 'location') continue;
    const lat = Number(row.lat);
    const lon = Number(row.lon ?? row.lng);
    const tst = Number(row.tst);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(tst)) continue;
    out.push({
      lat,
      lon,
      tst,
      acc: Number.isFinite(Number(row.acc)) ? Number(row.acc) : undefined,
      tid: typeof row.tid === 'string' ? row.tid : undefined,
      _type: 'location',
    });
  }
  return out;
}

export function decryptOwnTracksPayload(data: string, key: Uint8Array): unknown {
  const buf = Buffer.from(data, 'base64');
  if (buf.length <= 24) throw new Error('short');
  const nonce = buf.subarray(0, 24);
  const cipher = buf.subarray(24);
  const opened = nacl.secretbox.open(new Uint8Array(cipher), new Uint8Array(nonce), key);
  if (!opened) throw new Error('open');
  return JSON.parse(Buffer.from(opened).toString('utf8'));
}

export function encryptOwnTracksPayload(payload: unknown, key: Uint8Array): string {
  const nonce = nacl.randomBytes(24);
  const message = Buffer.from(JSON.stringify(payload), 'utf8');
  const boxed = nacl.secretbox(new Uint8Array(message), nonce, key);
  return Buffer.concat([Buffer.from(nonce), Buffer.from(boxed)]).toString('base64');
}

/**
 * OwnTracks secretbox key material.
 *
 * Accepted forms (same string as `LOCATION_ENCRYPT_KEYS` and the app's Encryption Key):
 * 1. 64-char hex of a 32-byte key
 * 2. standard base64 of a 32-byte key
 * 3. OwnTracks passphrase: UTF-8, at most 32 bytes, padded with NULs to 32
 *    (libsodium secretbox / XSalsa20-Poly1305, as the iOS and Android apps do)
 */
export function parseEncryptKey(raw: string): Uint8Array | null {
  const hex = raw.trim();
  if (!hex) return null;
  if (/^[0-9a-f]+$/i.test(hex) && hex.length === 64) return new Uint8Array(Buffer.from(hex, 'hex'));
  const b64 = Buffer.from(hex, 'base64');
  if (b64.length === 32) return new Uint8Array(b64);
  const utf8 = Buffer.from(hex, 'utf8');
  if (utf8.length === 0 || utf8.length > 32) return null;
  const key = new Uint8Array(32);
  key.set(utf8);
  return key;
}

export function unwrapOwnTracksPayload(body: unknown, key: Uint8Array | undefined): unknown {
  const unwrapOne = (item: unknown): unknown => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const row = item as Record<string, unknown>;
    if (row._type !== 'encrypted') return item;
    if (typeof row.data !== 'string' || !key) throw new Error('encrypted');
    return decryptOwnTracksPayload(row.data, key);
  };
  if (Array.isArray(body)) return body.map(unwrapOne);
  return unwrapOne(body);
}
