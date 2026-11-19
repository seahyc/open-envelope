/**
 * Decide whether two merchant strings from different sources (a bank alert and a
 * statement line) plausibly name the same merchant.
 *
 * Statement lines often carry a leading card-number fragment ("-9839 COLD STORAGE - N")
 * and are truncated, while alerts are not ("COLD STORAGE - NOVENA SQUARE"). Comparing
 * raw prefixes therefore fails, so both sides are normalised first.
 */
export function normalizeMerchantForMatch(text: string): string {
  return text
    .toUpperCase()
    .replace(/^\s*-?\d{3,5}\s+/, '')
    .replace(/[^A-Z0-9]/g, '');
}

export function merchantsCompatible(a: string, b: string): boolean {
  const na = normalizeMerchantForMatch(a);
  const nb = normalizeMerchantForMatch(b);
  if (!na || !nb) return false;
  const k = Math.min(na.length, nb.length, 20);
  if (k < 5) return false;
  const pa = na.slice(0, k);
  const pb = nb.slice(0, k);
  return pa === pb || na.includes(pb) || nb.includes(pa);
}
