export function redactErrorCode(error: unknown): string {
  if (error instanceof Error) {
    const token = error.message.trim().split(/\s+/)[0] ?? '';
    if (/^[A-Z][A-Z0-9_]{2,}$/.test(token)) return token;
  }
  return 'CATEGORISE_FAILED';
}
