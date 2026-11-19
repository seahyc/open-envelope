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
  const shorter = Math.min(na.length, nb.length);
  if (shorter < 5) return false;
  let common = 0;
  while (common < shorter && na[common] === nb[common]) common++;
  // Statements truncate and rewrite text, so a long shared prefix is enough.
  return common >= Math.min(8, shorter) || na.includes(nb.slice(0, 12)) || nb.includes(na.slice(0, 12));
}
