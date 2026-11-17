export interface GmailForwardingVerify {
  code: string;
  link: string | null;
}

const GOOGLE_FROM = /forwarding-noreply@google\.com|noreply@google\.com/i;
const CODE_PATTERNS = [
  /confirmation code[:\s]+([A-Z0-9]{6,12})/i,
  /\bcode[:\s]+([0-9]{6,12})\b/i,
  /\b([0-9]{8,12})\b/,
];
const LINK_PATTERN = /https:\/\/mail\.google\.com\/[^\s"'<>]+/i;

export function parseGmailForwardingVerify(raw: string): GmailForwardingVerify | null {
  const from = raw.match(/^From:\s*(.+)$/im)?.[1] ?? '';
  const subject = raw.match(/^Subject:\s*(.+)$/im)?.[1] ?? '';
  const looksLike = GOOGLE_FROM.test(from)
    || /gmail forwarding confirmation/i.test(subject)
    || /forwarding confirmation/i.test(subject);
  if (!looksLike) return null;
  let code: string | null = null;
  for (const pattern of CODE_PATTERNS) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      code = match[1];
      break;
    }
  }
  if (!code) return null;
  const link = raw.match(LINK_PATTERN)?.[0] ?? null;
  return { code, link };
}
