import type { Observation, DocumentHash } from '../../shared/types.js';

export interface ParsedObservation extends Omit<Observation, 'id' | 'documentHash' | 'createdAt'> {
  lineOrdinal?: number;
}

export interface StatementPeriod {
  startDate: number;
  endDate: number;
  openingBalanceCents: number;
  closingBalanceCents: number;
  accountHint?: string;
}

export interface ParseResult {
  observations: ParsedObservation[];
  statementPeriod?: StatementPeriod;
  statementPeriods?: StatementPeriod[];
}

export interface Adapter {
  readonly name: string;
  readonly supportedMimeTypes: string[];
  parse(content: Buffer, documentHash: DocumentHash): Promise<ParsedObservation[] | ParseResult>;
}

export async function createObservationId(
  documentHash: DocumentHash,
  accountHint: string,
  timestamp: number,
  amountCents: number,
  merchantText: string,
  lineOrdinal?: number
): Promise<string> {
  const ordinal = lineOrdinal !== undefined ? `${lineOrdinal}:` : '';
  const data = `${documentHash}:${ordinal}${accountHint}:${timestamp}:${amountCents}:${merchantText}`;
  const crypto = await import('crypto');
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
}
