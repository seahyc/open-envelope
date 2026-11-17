/**
 * Tiny JSONPath getter: `$.a.b[0].c`, `$['a']`, `$["a"]`.
 * No recursive descent, no filters — enough for webhook field mapping.
 */
export function jsonPathGet(root: unknown, expr: string): unknown {
  if (typeof expr !== 'string') return undefined;
  if (expr === '$') return root;
  if (!expr.startsWith('$')) return undefined;
  let cur: unknown = root;
  const tokens = tokenize(expr.slice(1));
  for (const token of tokens) {
    if (cur == null) return undefined;
    if (token.type === 'index') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[token.index];
      continue;
    }
    if (typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[token.key];
  }
  return cur;
}

type Token = { type: 'key'; key: string } | { type: 'index'; index: number };

function tokenize(rest: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i]!;
    if (ch === '.') {
      i += 1;
      const start = i;
      while (i < rest.length && /[A-Za-z0-9_$-]/.test(rest[i]!)) i += 1;
      if (i === start) throw new Error('Invalid JSONPath');
      tokens.push({ type: 'key', key: rest.slice(start, i) });
      continue;
    }
    if (ch === '[') {
      i += 1;
      if (rest[i] === "'" || rest[i] === '"') {
        const quote = rest[i]!;
        i += 1;
        const start = i;
        while (i < rest.length && rest[i] !== quote) i += 1;
        tokens.push({ type: 'key', key: rest.slice(start, i) });
        i += 1;
        if (rest[i] !== ']') throw new Error('Invalid JSONPath');
        i += 1;
        continue;
      }
      const start = i;
      while (i < rest.length && rest[i] !== ']') i += 1;
      const raw = rest.slice(start, i);
      if (!/^\d+$/.test(raw)) throw new Error('Invalid JSONPath');
      tokens.push({ type: 'index', index: Number(raw) });
      i += 1;
      continue;
    }
    throw new Error('Invalid JSONPath');
  }
  return tokens;
}
