import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 } as const;

export function contextSecretKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.CONTEXT_SECRET_KEY?.trim();
  if (!raw) {
    if (env.AUTH_MODE === 'none' || env.VITEST) {
      return createHash('sha256').update('openenvelope-test-context-key').digest();
    }
    return null;
  }
  if (/^[0-9a-f]+$/i.test(raw) && raw.length === 64) return Buffer.from(raw, 'hex');
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === 32) return b64;
  return createHash('sha256').update(raw).digest();
}

export function sealString(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function unsealString(sealed: string, key: Buffer): string {
  const buf = Buffer.from(sealed, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function hashSecret(secret: string, salt = randomBytes(16)): { salt: string; hash: string } {
  const hash = scryptSync(secret, salt, 32, SCRYPT_OPTS);
  return { salt: salt.toString('base64'), hash: hash.toString('base64') };
}

export function verifySecret(secret: string, saltB64: string, hashB64: string): boolean {
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(secret, salt, 32, SCRYPT_OPTS);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
