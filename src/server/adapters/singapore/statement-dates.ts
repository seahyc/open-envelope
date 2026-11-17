export const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

export function monthIndex(token: string): number | undefined {
  return MONTHS[token.slice(0, 3).toUpperCase()];
}

export function parseFlexibleDate(raw: string): Date | null {
  const text = raw.trim();
  const dmyName = text.match(/^(\d{1,2})\s+([A-Z]{3})(?:\s+(\d{2,4}))?/i);
  if (dmyName) {
    const month = monthIndex(dmyName[2]!);
    if (month === undefined) return null;
    const day = parseInt(dmyName[1]!, 10);
    if (!dmyName[3]) return null;
    let year = parseInt(dmyName[3]!, 10);
    if (year < 100) year += 2000;
    return new Date(year, month, day);
  }

  const numeric = text.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})/);
  if (numeric) {
    const day = parseInt(numeric[1]!, 10);
    const month = parseInt(numeric[2]!, 10) - 1;
    let year = parseInt(numeric[3]!, 10);
    if (year < 100) year += 2000;
    if (month < 0 || month > 11) return null;
    return new Date(year, month, day);
  }

  const compact = text.match(/^(\d{2})([A-Z]{3})(?:(\d{2,4}))?$/i);
  if (compact) {
    const month = monthIndex(compact[2]!);
    if (month === undefined || !compact[3]) return null;
    let year = parseInt(compact[3]!, 10);
    if (year < 100) year += 2000;
    return new Date(year, month, parseInt(compact[1]!, 10));
  }

  return parseFullDate(text);
}

export function parseFullDate(dateStr: string): Date | null {
  const parts = dateStr.trim().split(/\s+/);
  if (parts.length !== 3) return null;

  const day = parseInt(parts[0]!, 10);
  const month = MONTHS[parts[1]!.toUpperCase()];
  let year = parseInt(parts[2]!, 10);

  if (Number.isNaN(day) || month === undefined || Number.isNaN(year)) {
    return null;
  }

  if (year < 100) {
    year = 2000 + year;
  }

  return new Date(year, month, day);
}

export function extractHeaderYear(text: string): number | undefined {
  const match = text.slice(0, 2500).match(/\b(20\d{2})\b/);
  return match ? parseInt(match[1]!, 10) : undefined;
}

export function extractStatementPeriod(text: string): { start: Date; end: Date } | null {
  const rangeWithYears = text.match(
    /Statement Period[:\s]+(\d{1,2}\s+[A-Z]{3}\s+\d{2,4})\s+to\s+(\d{1,2}\s+[A-Z]{3}\s+\d{2,4})/i
  );
  if (rangeWithYears) {
    const start = parseFullDate(rangeWithYears[1]!);
    const end = parseFullDate(rangeWithYears[2]!);
    if (start && end) return { start, end };
  }

  const dateRangeWithYears = text.match(
    /Statement Date[:\s]+(\d{1,2}\s+[A-Z]{3}\s+\d{2,4})\s+to\s+(\d{1,2}\s+[A-Z]{3}\s+\d{2,4})/i
  );
  if (dateRangeWithYears) {
    const start = parseFullDate(dateRangeWithYears[1]!);
    const end = parseFullDate(dateRangeWithYears[2]!);
    if (start && end) return { start, end };
  }

  const dateRangeYearAtEnd = text.match(
    /Statement Date[:\s]+(\d{1,2}\s+[A-Z]{3})\s+to\s+(\d{1,2}\s+[A-Z]{3})\s+(\d{2,4})/i
  );
  if (dateRangeYearAtEnd) {
    const year = dateRangeYearAtEnd[3]!;
    const start = parseFullDate(`${dateRangeYearAtEnd[1]} ${year}`);
    const end = parseFullDate(`${dateRangeYearAtEnd[2]} ${year}`);
    if (start && end) return { start, end };
  }

  const singleStatementDate = text.match(
    /Statement Date[:\s]+(\d{1,2}\s+[A-Z]{3}\s+\d{2,4})/i
  );
  if (singleStatementDate) {
    const end = parseFullDate(singleStatementDate[1]!);
    if (end) {
      return { start: new Date(end.getFullYear(), end.getMonth(), 1), end };
    }
  }

  const fromRange = text.match(
    /STATEMENT OF ACCOUNT FROM:\s+(\d{1,2}\s+[A-Z]{3}\s+\d{2,4})\s+to\s+(\d{1,2}\s+[A-Z]{3}\s+\d{2,4})/i
  );
  if (fromRange) {
    const start = parseFullDate(fromRange[1]!);
    const end = parseFullDate(fromRange[2]!);
    if (start && end) return { start, end };
  }

  const numericRange = text.match(
    /Statement Period[:\s]+(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})\s+to\s+(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/i
  );
  if (numericRange) {
    const start = parseFlexibleDate(numericRange[1]!);
    const end = parseFlexibleDate(numericRange[2]!);
    if (start && end) return { start, end };
  }

  return null;
}

export function extractStatementDate(text: string): Date | null {
  const numericInline = text.match(
    /(?:Statement Date|STATEMENT DATE)\s*[:\s]+(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})/i
  );
  if (numericInline) {
    return parseFlexibleDate(`${numericInline[1]}-${numericInline[2]}-${numericInline[3]}`);
  }

  const namedInline = text.match(
    /(?:Statement Date|STATEMENT DATE)\s*[:\s]+(\d{1,2}\s+[A-Z]{3}\s+\d{2,4})/i
  );
  if (namedInline) {
    return parseFullDate(namedInline[1]!);
  }

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/STATEMENT DATE/i.test(lines[i]!)) continue;
    if (/CREDIT LIMIT|MINIMUM PAYMENT|TOTAL CREDIT LIMIT|AVAILABLE CREDIT/i.test(lines[i]!)) {
      continue;
    }
    const sameLine = parseFlexibleDate(lines[i]!.replace(/.*STATEMENT DATE[:\s]*/i, ''));
    if (sameLine) return sameLine;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      if (/(?:S\$|\$)\s*[\d,]/.test(lines[j]!)) continue;
      const parsed = parseFlexibleDate(lines[j]!);
      if (parsed) return parsed;
    }
  }

  return null;
}

export function cardCycleFromStatementDate(statementDate: Date): { start: Date; end: Date } {
  const end = statementDate;
  const start = new Date(end.getFullYear(), end.getMonth() - 1, end.getDate() + 1);
  return { start, end };
}

export function yearForMonthAgainstAnchor(month: number, anchor: Date): number {
  if (month > anchor.getMonth()) {
    return anchor.getFullYear() - 1;
  }
  return anchor.getFullYear();
}

export function compactDayMonthToTimestamp(
  day: number,
  monthToken: string,
  periodStart: Date | null,
  periodEnd: Date | null,
  headerYear?: number,
  anchor?: Date | null
): number {
  const month = monthIndex(monthToken);
  if (month === undefined || Number.isNaN(day)) {
    return headerYear !== undefined ? new Date(headerYear, 0, 1).getTime() : 0;
  }
  if (periodStart && periodEnd) {
    return new Date(yearFromPeriod(month, periodStart, periodEnd), month, day).getTime();
  }
  if (anchor) {
    return new Date(yearForMonthAgainstAnchor(month, anchor), month, day).getTime();
  }
  if (headerYear !== undefined) {
    return new Date(headerYear, month, day).getTime();
  }
  return new Date(1970, month, day).getTime();
}

export function yearFromPeriod(month: number, periodStart: Date, periodEnd: Date): number {
  if (periodStart.getFullYear() === periodEnd.getFullYear()) {
    return periodStart.getFullYear();
  }
  return month >= periodStart.getMonth() ? periodStart.getFullYear() : periodEnd.getFullYear();
}

export function lineDateToTimestamp(
  dateStr: string,
  periodStart: Date | null,
  periodEnd: Date | null,
  headerYear?: number
): number {
  const parts = dateStr.trim().split(/\s+/);
  if (parts.length < 2) {
    return headerYear !== undefined ? new Date(headerYear, 0, 1).getTime() : 0;
  }

  const day = parseInt(parts[0]!, 10);
  const month = MONTHS[parts[1]!.toUpperCase()];
  if (month === undefined || Number.isNaN(day)) {
    return headerYear !== undefined ? new Date(headerYear, 0, 1).getTime() : 0;
  }

  if (parts.length >= 3 && /^\d{2,4}$/.test(parts[2]!)) {
    let year = parseInt(parts[2]!, 10);
    if (year < 100) year = 2000 + year;
    return new Date(year, month, day).getTime();
  }

  if (periodStart && periodEnd) {
    return new Date(yearFromPeriod(month, periodStart, periodEnd), month, day).getTime();
  }

  if (headerYear !== undefined) {
    return new Date(headerYear, month, day).getTime();
  }

  return new Date(1970, month, day).getTime();
}
