import type { ParsedObservation } from '../adapters/adapter.js';
import { defaultRegistry } from '../adapters/registry.js';
import {
  expandYear,
  extractBankAlert,
  extractionToObservation,
  parseSingaporeDateTime,
  singaporeWallTimeToUtcMs,
} from '../adapters/singapore/bank-alert-extract.js';
import type { ExtractedAlertFields, LLMProvider } from '../lib/llm-provider.js';
import type { ObservationKind } from '../../shared/types.js';

export const ALERT_CONFIDENCE_THRESHOLD = 0.6;

export type EmailAlertMethod = 'patterns' | 'patterns+hint' | 'llm' | 'adapter' | 'unparsed';

export interface EmailAlertResolution {
  observations: ParsedObservation[];
  method: EmailAlertMethod;
  confidence: number;
  reviewText: string | null;
}

const ALERT_ADAPTERS = new Set(['bank-alert', 'ocbc-alert', 'dbs-alert']);

function excerpt(text: string): string {
  return text.replace(/\r\n/g, '\n').slice(0, 2000);
}

function llmFieldsToObservation(fields: ExtractedAlertFields): ParsedObservation | null {
  if (!fields.merchant || fields.amount === undefined) return null;
  let timestamp = parseSingaporeDateTime(`${fields.date} ${fields.time || ''}`.trim());
  if (timestamp == null) {
    const iso = fields.date.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) {
      const clock = (fields.time || '00:00').match(/^(\d{1,2}):(\d{2})/);
      timestamp = singaporeWallTimeToUtcMs(
        expandYear(Number(iso[1])),
        Number(iso[2]) - 1,
        Number(iso[3]),
        clock ? Number(clock[1]) : 0,
        clock ? Number(clock[2]) : 0,
      );
    }
  }
  if (timestamp == null || Number.isNaN(timestamp)) return null;
  const cents = Math.round(fields.amount * 100);
  if (!Number.isFinite(cents) || cents === 0) return null;
  const credit = fields.direction === 'credit' || cents > 0;
  const amountCents = credit ? Math.abs(cents) : -Math.abs(cents);
  const kind = (fields.kind || (credit ? 'deposit' : 'purchase')) as ObservationKind;
  const last4 = fields.last4?.replace(/\D/g, '').slice(-4);
  return {
    accountHint: last4 ? `card-${last4}` : 'unknown',
    amountCents,
    currency: (fields.currency || 'SGD').toUpperCase(),
    timestamp,
    merchantText: fields.merchant.trim(),
    kind,
    adapterName: 'bank-alert',
    parseConfidence: 0.7,
    parseMethod: 'llm',
  };
}

export async function resolveEmailAlert(
  raw: Buffer,
  filename: string,
  mimeType: string,
  emailText: string,
  llm: LLMProvider | null,
): Promise<EmailAlertResolution> {
  const extracted = extractBankAlert(emailText);
  const patterned = extractionToObservation(extracted, extracted.hintId ? `${extracted.hintId}-alert` : 'bank-alert');

  if (extracted.complete && extracted.confidence >= ALERT_CONFIDENCE_THRESHOLD && patterned) {
    return {
      observations: [patterned],
      method: extracted.method,
      confidence: extracted.confidence,
      reviewText: null,
    };
  }

  if (extracted.looksLikeAlert || extracted.confidence >= 0.4) {
    const llmFields = llm ? await llm.extractAlertFields(emailText) : null;
    const fromLlm = llmFields ? llmFieldsToObservation(llmFields) : null;
    if (fromLlm) {
      return {
        observations: [fromLlm],
        method: 'llm',
        confidence: fromLlm.parseConfidence || 0.7,
        reviewText: null,
      };
    }
    return {
      observations: [],
      method: 'unparsed',
      confidence: extracted.confidence,
      reviewText: excerpt(emailText),
    };
  }

  const bestMatch = await defaultRegistry.findBestAdapter(raw, filename, mimeType);
  if (bestMatch && !ALERT_ADAPTERS.has(bestMatch.adapter.name)) {
    const parsed = await bestMatch.adapter.parse(raw, filename);
    const observations = Array.isArray(parsed) ? parsed : parsed.observations;
    if (observations.length > 0) {
      return {
        observations,
        method: 'adapter',
        confidence: bestMatch.confidence,
        reviewText: null,
      };
    }
  }

  return {
    observations: [],
    method: 'unparsed',
    confidence: extracted.confidence,
    reviewText: excerpt(emailText),
  };
}
