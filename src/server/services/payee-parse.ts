const UEN_RE = /\b(\d{8,10}[A-Z]|[STR]\d{2}[A-Z]{2}\d{4}[A-Z])\b/i;
const TRAILING_NOISE = /\s+(?:OTHR(?:-OTHR)?|OTHER(?:-OTHER)?|MISC)\s*$/i;
const RAIL = /(FAST\s+PAYMENT|PAYNOW|PAY[\s-]*NOW|\bGIRO\b|\bIBG\b|\bATM\b|CASHIER'?S?\s*ORDER)/i;

export interface ParsedPayee {
  payeeName: string;
  uen: string | null;
  opaque: boolean;
}

export function parsePayeeAndUen(raw: string): ParsedPayee {
  const text = raw.trim();
  const uenMatch = text.match(UEN_RE);
  const uen = uenMatch ? uenMatch[1]!.toUpperCase() : null;
  const opaque = RAIL.test(text);
  let name = text;
  const toMatch = text.match(/\bTO\b\s+(.+)$/i);
  const fromMatch = text.match(/\bFROM\b\s+(.+)$/i);
  if (toMatch?.[1]) name = toMatch[1];
  else if (fromMatch?.[1]) name = fromMatch[1];
  if (uen) name = name.replace(UEN_RE, ' ');
  name = name.replace(TRAILING_NOISE, '').replace(/[^A-Za-z0-9&/.\-\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) name = uen ?? text;
  return { payeeName: name, uen, opaque };
}
