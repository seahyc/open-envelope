import type Database from 'better-sqlite3';
import type { LLMProvider } from '../lib/llm-provider.js';
import { logger } from '../lib/logger.js';
import crypto from 'crypto';
import { hh } from '../lib/tenancy.js';

export class MerchantNormalizationService {
  constructor(
    private db: Database.Database,
    private llmProvider: LLMProvider | null
  ) {}

  async normalizeMerchant(rawMerchant: string): Promise<string | null> {
    if (!this.llmProvider) {
      return null;
    }

    const existing = this.db
      .prepare('SELECT normalized_name FROM merchant_normalizations WHERE household_id = ? AND raw_merchant = ?')
      .get(hh(), rawMerchant) as { normalized_name: string } | undefined;

    if (existing) {
      return existing.normalized_name;
    }

    try {
      const normalized = await this.llmProvider.normalizeMerchant(rawMerchant);
      
      if (normalized && normalized !== rawMerchant) {
        this.db
          .prepare(`
            INSERT INTO merchant_normalizations (id, household_id, raw_merchant, normalized_name, source, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `)
          .run(
            crypto.randomBytes(8).toString('hex'),
            hh(),
            rawMerchant,
            normalized,
            'llm',
            Date.now()
          );

        logger.info('Merchant normalized', { raw: rawMerchant, normalized });
        return normalized;
      }
    } catch (error) {
      logger.warn('Merchant normalization failed', { 
        error: error instanceof Error ? error.message : String(error) 
      });
    }

    return null;
  }

  applyUserOverride(rawMerchant: string, normalizedName: string): void {
    this.db
      .prepare(`
        INSERT INTO merchant_normalizations (id, household_id, raw_merchant, normalized_name, source, created_at)
        VALUES (?, ?, ?, ?, 'user', ?)
        ON CONFLICT(household_id, raw_merchant) DO UPDATE SET
          normalized_name = excluded.normalized_name,
          source = 'user'
      `)
      .run(crypto.randomBytes(8).toString('hex'), hh(), rawMerchant, normalizedName, Date.now());

    logger.info('User override applied', { raw: rawMerchant, normalized: normalizedName });
  }
}
