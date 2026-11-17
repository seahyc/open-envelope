import { createHmac, timingSafeEqual } from 'node:crypto';

export function emailHmacHex(secret: string, body: Buffer): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function verifyEmailHmac(secret: string, body: Buffer, header: string | null | undefined): boolean {
  if (!header) return false;
  const got = header.trim().replace(/^sha256=/i, '');
  if (!/^[0-9a-f]+$/i.test(got) || got.length !== 64) return false;
  const expected = emailHmacHex(secret, body);
  try {
    return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export function authorizeEmailIngest(options: {
  hmacSecret?: string;
  apiKey?: string;
  authMode: string;
  providedHmac?: string | null;
  providedApiKey?: string | null;
  body: Buffer;
}): boolean {
  if (options.hmacSecret) {
    return verifyEmailHmac(options.hmacSecret, options.body, options.providedHmac);
  }
  if (options.apiKey) {
    return options.providedApiKey === options.apiKey;
  }
  return options.authMode === 'none';
}
