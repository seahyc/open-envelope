import { createHmac, timingSafeEqual } from 'node:crypto';

export const HOOK_REPLAY_WINDOW_SEC = 300;

export function hookHmacHex(secret: string, timestamp: string, body: Buffer): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}

export function parseHookSignature(header: string | null | undefined): string | null {
  if (!header) return null;
  const got = header.trim().replace(/^sha256=/i, '');
  if (!/^[0-9a-f]+$/i.test(got) || got.length !== 64) return null;
  return got.toLowerCase();
}

export function verifyHookHmac(
  secret: string,
  timestamp: string,
  body: Buffer,
  header: string | null | undefined,
): boolean {
  const got = parseHookSignature(header);
  if (!got) return false;
  const expected = hookHmacHex(secret, timestamp, body);
  try {
    return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export function hookTimestampFresh(
  timestampHeader: string | null | undefined,
  nowMs = Date.now(),
  windowSec = HOOK_REPLAY_WINDOW_SEC,
): boolean {
  if (!timestampHeader) return false;
  if (!/^\d{10,12}$/.test(timestampHeader.trim())) return false;
  const ts = Number(timestampHeader.trim());
  if (!Number.isFinite(ts)) return false;
  const tsMs = ts < 1e12 ? ts * 1000 : ts;
  return Math.abs(nowMs - tsMs) <= windowSec * 1000;
}

export function parseBearerSecret(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}
