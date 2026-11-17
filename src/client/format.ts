const SGD = new Intl.NumberFormat('en-SG', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatSgd(cents: number): string {
  const body = `S$${SGD.format(Math.abs(cents) / 100)}`;
  if (cents < 0) return `−${body}`;
  return body;
}

export function formatSignedSgd(cents: number): string {
  if (cents > 0) return `+${formatSgd(cents)}`;
  return formatSgd(cents);
}

export function formatListDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-SG', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

export function formatMonth(month: string): string {
  const [year, mm] = month.split('-');
  if (!year || !mm) return month;
  return new Date(Date.UTC(Number(year), Number(mm) - 1, 1)).toLocaleDateString('en-SG', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function percentInt(value: number): string {
  return `${Math.round(value * 100)}%`;
}
