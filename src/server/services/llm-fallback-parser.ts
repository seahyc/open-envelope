import type Database from 'better-sqlite3';
import type { LLMProvider } from '../lib/llm-provider.js';
import type { ParsedObservation } from '../adapters/adapter.js';
import { logger } from '../lib/logger.js';
import crypto from 'crypto';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export class LLMFallbackParser {
  constructor(
    private db: Database.Database,
    private llmProvider: LLMProvider | null
  ) {}

  async parseUnknownDocument(
    documentHash: string,
    content: Buffer,
    accountHint?: string
  ): Promise<ParsedObservation[]> {
    if (!this.llmProvider) {
      return [];
    }

    try {
      const text = content.toString('utf-8');
      const llmResult = await this.llmProvider.parseUnknownStatement(text, accountHint);

      if (!llmResult || llmResult.length === 0) {
        return [];
      }

      const validation = this.validateLLMParsedObservations(llmResult, text);
      
      if (!validation.valid) {
        logger.warn('LLM parsed observations failed validation', {
          documentHash,
          errors: validation.errors
        });
        return [];
      }

      const observations: ParsedObservation[] = llmResult.map(obs => ({
        accountHint: accountHint || 'unknown',
        amountCents: this.enforceIntegerCents(obs.amount),
        currency: 'SGD',
        timestamp: new Date(obs.date).getTime(),
        merchantText: obs.merchant,
        reference: obs.reference,
        kind: obs.amount < 0 ? 'purchase' : 'deposit',
        adapterName: 'llm-fallback',
      }));

      const openingObs = observations.find(o => o.reference === 'opening');
      const closingObs = observations.find(o => o.reference === 'closing');
      
      if (openingObs && closingObs) {
        const opening = openingObs.amountCents;
        const closing = closingObs.amountCents;
        const transactions = observations.filter(o => o.reference !== 'opening' && o.reference !== 'closing');
        const sum = transactions.reduce((acc, o) => acc + o.amountCents, 0);

        const account = accountHint ? this.db.prepare('SELECT account_group FROM accounts WHERE json_extract(aliases, "$") LIKE ?').get(`%${accountHint}%`) as { account_group: string } | undefined : undefined;
        let expectedSum = closing - opening;
        
        if (account && account.account_group === 'credit') {
          expectedSum = opening - closing;
        }

        if (sum !== expectedSum) {
          logger.warn('LLM fallback parser: exact cents check failed', {
            documentHash,
            opening,
            closing,
            sum,
            expectedSum,
            discrepancy: expectedSum - sum,
          });

          this.db.prepare(`
            INSERT INTO review_queue (id, document_hash, reason, detail, created_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            crypto.randomBytes(8).toString('hex'),
            documentHash,
            'llm_fallback_arithmetic_mismatch',
            JSON.stringify({
              opening,
              closing,
              transactionSum: sum,
              expectedSum,
              discrepancyCents: expectedSum - sum,
              observationCount: transactions.length,
            }),
            Date.now()
          );
          return [];
        }
      } else if (openingObs || closingObs) {
        logger.warn('LLM fallback parser: missing opening or closing balance', {
          documentHash,
          hasOpening: !!openingObs,
          hasClosing: !!closingObs,
        });

        this.db.prepare(`
          INSERT INTO review_queue (id, document_hash, reason, detail, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          crypto.randomBytes(8).toString('hex'),
          documentHash,
          'llm_fallback_incomplete_balances',
          JSON.stringify({
            hasOpening: !!openingObs,
            hasClosing: !!closingObs,
            observationCount: observations.length,
          }),
          Date.now()
        );
        return [];
      }

      this.db
        .prepare(`
          INSERT INTO review_queue (id, document_hash, reason, detail, created_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(
          crypto.randomBytes(8).toString('hex'),
          documentHash,
          'llm_parsed',
          JSON.stringify({
            count: observations.length,
            transactions: observations.map(o => ({
              date: new Date(o.timestamp).toISOString(),
              merchant: o.merchantText,
              amountCents: o.amountCents,
              reference: o.reference,
            })),
          }),
          Date.now()
        );

      logger.info('LLM fallback parser sent to review queue', {
        documentHash,
        count: observations.length,
        allFlaggedForReview: true
      });

      return observations;
    } catch (error) {
      logger.error('LLM fallback parser failed', {
        error: error instanceof Error ? error.message : String(error),
        documentHash
      });
      return [];
    }
  }

  private enforceIntegerCents(amount: number): number {
    const cents = Math.round(amount * 100);
    
    if (!Number.isInteger(cents)) {
      throw new Error(`Amount ${amount} cannot be represented as integer cents`);
    }
    
    if (Math.abs(cents) > Number.MAX_SAFE_INTEGER / 100) {
      throw new Error(`Amount ${amount} exceeds safe integer range`);
    }
    
    return cents;
  }

  private validateLLMParsedObservations(
    observations: Array<{ date: string; merchant: string; amount: number; reference?: string }>,
    statementText: string
  ): ValidationResult {
    const errors: string[] = [];

    for (const obs of observations) {
      if (!obs.date || !obs.merchant || obs.amount === undefined) {
        errors.push('Missing required fields (date, merchant, amount)');
        continue;
      }

      const date = new Date(obs.date);
      if (isNaN(date.getTime())) {
        errors.push(`Invalid date: ${obs.date}`);
      }

      const now = Date.now();
      const tenYearsAgo = now - (10 * 365 * 24 * 60 * 60 * 1000);
      const oneYearFuture = now + (365 * 24 * 60 * 60 * 1000);
      
      if (date.getTime() < tenYearsAgo || date.getTime() > oneYearFuture) {
        errors.push(`Date out of reasonable range: ${obs.date}`);
      }

      try {
        this.enforceIntegerCents(obs.amount);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }

      if (Math.abs(obs.amount) > 1000000) {
        errors.push(`Suspiciously large amount: ${obs.amount}`);
      }
    }

    const totalMatch = statementText.match(/total|balance|sum/i);
    if (totalMatch && observations.length > 0) {
      const numbers = statementText.match(/[\d,]+\.\d{2}/g);
      if (numbers && numbers.length > 0) {
        const possibleTotals = numbers.map(n => parseFloat(n.replace(/,/g, '')));
        const observationsSum = observations.reduce((sum, obs) => sum + Math.abs(obs.amount), 0);
        
        const matchesAnyTotal = possibleTotals.some(total => 
          Math.abs(total - observationsSum) < 1.0
        );

        if (!matchesAnyTotal) {
          errors.push('Sum of parsed transactions does not match any total in statement');
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  preventBalanceWrites(): void {
    throw new Error('LLM output cannot write balances - code-level guard');
  }

  preventAmountWrites(): void {
    throw new Error('LLM output cannot modify posted transaction amounts - code-level guard');
  }

  preventReconciliationWrites(): void {
    throw new Error('LLM output cannot modify reconciliation status - code-level guard');
  }
}
