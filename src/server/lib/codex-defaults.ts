export const DEFAULT_CODEX_MODEL = 'gpt-6-luna';
export const DEFAULT_CODEX_REASONING_EFFORT = 'low';
export const DEFAULT_CATEGORISER_AUTO_THRESHOLD = 0.9;
export const DEFAULT_CODEX_BIN = 'codex';

export function parseCodexExtraConfig(raw = process.env.CODEX_EXTRA_CONFIG): string[] {
  if (!raw || !raw.trim()) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.map((value) => String(value).trim()).filter(Boolean);
    } catch {
      return [];
    }
  }
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (const char of trimmed) {
    if (char === '{' || char === '[') depth += 1;
    if (char === '}' || char === ']') depth = Math.max(0, depth - 1);
    if ((char === ',' || char === '\n') && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}
