interface Env {
  OPENENVELOPE_INGEST_URL: string;
  EMAIL_INGEST_HMAC_SECRET: string;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret: string, body: ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, body);
  return toHex(sig);
}

export function extractEmailAddress(value: string): string {
  const trimmed = (value || '').trim();
  if (!trimmed) return '';
  const angled = trimmed.match(/<([^>]+)>/);
  if (angled?.[1]) return angled[1].replace(/[>;]$/, '').trim();
  const bare = trimmed.match(/(\S+@\S+)/);
  if (bare?.[1]) return bare[1].replace(/[>;]$/, '').trim();
  return trimmed.includes('@') ? trimmed : '';
}

export function firstRecipient(message: { to?: string; headers?: { get: (name: string) => string | null } }): string {
  const envelope = extractEmailAddress(message.to || '');
  if (envelope) return envelope;
  const headerTo = message.headers?.get('delivered-to')
    || message.headers?.get('x-original-to')
    || message.headers?.get('to')
    || '';
  return extractEmailAddress(headerTo);
}

export default {
  async email(message: { raw: ReadableStream; to?: string; headers: Headers }, env: Env): Promise<void> {
    const ingestUrl = (env.OPENENVELOPE_INGEST_URL || '').replace(/\/$/, '');
    const secret = env.EMAIL_INGEST_HMAC_SECRET;
    if (!ingestUrl || !secret) {
      console.error('OPENENVELOPE_INGEST_URL or EMAIL_INGEST_HMAC_SECRET missing');
      return;
    }
    const raw = await new Response(message.raw).arrayBuffer();
    const recipient = firstRecipient(message);
    const signature = await hmacHex(secret, raw);
    const response = await fetch(`${ingestUrl}/api/ingest/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'message/rfc822',
        'X-OE-Signature': signature,
        'X-OE-Recipient': recipient,
      },
      body: raw,
    });
    if (!response.ok) {
      console.error('Failed to ingest email', response.status);
    }
  },
};
