import crypto from 'crypto';
import { logger } from './logger.js';
import { executeCodex } from './llm-provider-codex.js';
import { parseCodexExtraConfig } from './codex-defaults.js';

export interface LLMConfig {
  provider: 'none' | 'codex' | 'openai';
  codexBin?: string;
  codexHome?: string;
  codexModel?: string;
  codexReasoningEffort?: string;
  cacheEnabled: boolean;
  timeout: number;
  rateLimit: {
    requestsPerMinute: number;
  };
}

export interface MerchantCategorization {
  category: string;
  confidence: number;
  suggestedRule?: {
    merchantPattern: string;
    category: string;
  };
}

export interface ParsedObservationFromLLM {
  date: string;
  merchant: string;
  amount: number;
  reference?: string;
}

export interface ExtractedAlertFields {
  amount: number;
  currency: string;
  date: string;
  time?: string;
  merchant: string;
  last4?: string;
  direction?: 'debit' | 'credit';
  kind?: 'purchase' | 'refund' | 'transfer' | 'deposit';
}

export interface EmailClassificationResult {
  classification: 'transaction_alert' | 'statement_notice' | 'promotional' | 'otp' | 'other';
  confidence: number;
}

interface CacheEntry<T> {
  result: T;
  timestamp: number;
}

export class LLMProvider {
  private cache = new Map<string, CacheEntry<unknown>>();
  private requestTimes: number[] = [];

  constructor(private config: LLMConfig) {}

  async normalizeMerchant(rawMerchant: string): Promise<string | null> {
    if (this.config.provider === 'none') {
      return null;
    }

    const cacheKey = this.getCacheKey('normalize', { merchant: rawMerchant });
    const cached = this.getFromCache<string>(cacheKey);
    if (cached) {
      return cached;
    }

    await this.checkRateLimit();

    try {
      const prompt = `Normalize this merchant name to a clean, consistent format. Return only the normalized name, nothing else.

Raw merchant: ${rawMerchant}

Examples:
- "GRAB* A-8XYZ SINGAPORE SG" -> "Grab"
- "AMZN Mktp SG*AB1CD2EF3" -> "Amazon"
- "SP * STARBUCKS #12345" -> "Starbucks"

Normalized name:`;

      const result = await this.executeCodexCall<string>(prompt);
      const normalized = result.trim().replace(/["']/g, '');
      
      if (normalized && normalized !== rawMerchant) {
        this.setCache(cacheKey, normalized);
        logger.info('Merchant normalized via LLM', { raw: rawMerchant, normalized, cacheKey });
        return normalized;
      }
    } catch (error) {
      logger.error('LLM normalization failed', { 
        error: error instanceof Error ? error.message : String(error) 
      });
    }

    return null;
  }

  async categorizeMerchant(
    merchant: string,
    amount: number,
    existingCategories: string[]
  ): Promise<MerchantCategorization | null> {
    if (this.config.provider === 'none') {
      return null;
    }

    const cacheKey = this.getCacheKey('categorize', { merchant, amount });
    const cached = this.getFromCache<MerchantCategorization>(cacheKey);
    if (cached) {
      return cached;
    }

    await this.checkRateLimit();

    try {
      const prompt = `Categorize this transaction:
Merchant: ${merchant}
Amount: $${(amount / 100).toFixed(2)}

Available categories: ${existingCategories.join(', ')}

Return JSON with:
- category (pick from available or suggest new)
- confidence (0-1)
- suggestedRule (optional): { merchantPattern: regex, category: string }

Examples:
{"category":"Groceries","confidence":0.95,"suggestedRule":{"merchantPattern":"WHOLE FOODS.*","category":"Groceries"}}
{"category":"Transportation","confidence":0.8}`;

      const result = await this.executeCodexCall<MerchantCategorization>(prompt, {
        type: 'object',
        properties: {
          category: { type: 'string' },
          confidence: { type: 'number' },
          suggestedRule: {
            type: 'object',
            properties: {
              merchantPattern: { type: 'string' },
              category: { type: 'string' },
            },
          },
        },
        required: ['category', 'confidence'],
      });

      if (result.confidence < 0.5) {
        logger.warn('Low confidence merchant categorization', { merchant, confidence: result.confidence });
      }

      this.setCache(cacheKey, result);
      return result;
    } catch (error) {
      logger.error('Merchant categorization failed', {
        error: error instanceof Error ? error.message : String(error),
        merchant,
      });
      return null;
    }
  }

  async classifyEmail(content: string): Promise<EmailClassificationResult> {
    if (this.config.provider === 'none') {
      return { classification: 'other', confidence: 0 };
    }

    const cacheKey = this.getCacheKey('classify_email', { content: content.substring(0, 500) });
    const cached = this.getFromCache<EmailClassificationResult>(cacheKey);
    if (cached) {
      return cached;
    }

    await this.checkRateLimit();

    try {
      const prompt = `Classify this email as one of: transaction_alert, statement_notice, promotional, otp, other

Email content:
${content.substring(0, 1000)}

Return JSON with:
- classification: one of the types above
- confidence: 0-1

Examples:
{"classification":"transaction_alert","confidence":0.95}
{"classification":"promotional","confidence":0.8}
{"classification":"otp","confidence":0.99}`;

      const result = await this.executeCodexCall<EmailClassificationResult>(prompt, {
        type: 'object',
        properties: {
          classification: { 
            type: 'string',
            enum: ['transaction_alert', 'statement_notice', 'promotional', 'otp', 'other']
          },
          confidence: { type: 'number' }
        },
        required: ['classification', 'confidence']
      });

      this.setCache(cacheKey, result);
      return result;
    } catch (error) {
      logger.error('Email classification failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      return { classification: 'other', confidence: 0 };
    }
  }

  async classifyDocument(filename: string, text: string): Promise<EmailClassificationResult> {
    if (this.config.provider === 'none') {
      return { classification: 'other', confidence: 0 };
    }

    const cacheKey = this.getCacheKey('classify_doc', { filename, text: text.substring(0, 500) });
    const cached = this.getFromCache<EmailClassificationResult>(cacheKey);
    if (cached) {
      return cached;
    }

    await this.checkRateLimit();

    try {
      const prompt = `Classify this document: ${filename}

Content preview:
${text.substring(0, 1000)}

Is this: transaction_alert, statement_notice, promotional, otp, or other?

Return JSON with:
- classification: the type
- confidence: 0-1`;

      const result = await this.executeCodexCall<EmailClassificationResult>(prompt, {
        type: 'object',
        properties: {
          classification: { 
            type: 'string',
            enum: ['transaction_alert', 'statement_notice', 'promotional', 'otp', 'other']
          },
          confidence: { type: 'number' }
        },
        required: ['classification', 'confidence']
      });

      this.setCache(cacheKey, result);
      return result;
    } catch (error) {
      logger.error('Document classification failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      return { classification: 'other', confidence: 0 };
    }
  }

  async parseUnknownStatement(
    content: string,
    accountHint?: string
  ): Promise<ParsedObservationFromLLM[] | null> {
    if (this.config.provider === 'none') {
      return null;
    }

    const cacheKey = this.getCacheKey('parse', { content: content.substring(0, 1000) });
    const cached = this.getFromCache<ParsedObservationFromLLM[]>(cacheKey);
    if (cached) {
      return cached;
    }

    await this.checkRateLimit();

    try {
      const prompt = `Parse transactions from this statement${accountHint ? ` (account: ${accountHint})` : ''}:

${content.substring(0, 2000)}

Extract transactions as JSON array. Each transaction:
- date: ISO date string (YYYY-MM-DD)
- merchant: string
- amount: number (positive for credits, negative for debits)
- reference: optional transaction ID/reference

IMPORTANT: Only extract transaction data. Do NOT include balances or totals.
Return empty array if no transactions found.`;

      const result = await this.executeCodexCall<ParsedObservationFromLLM[]>(prompt, {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string' },
            merchant: { type: 'string' },
            amount: { type: 'number' },
            reference: { type: 'string' },
          },
          required: ['date', 'merchant', 'amount'],
        },
      });

      this.setCache(cacheKey, result);
      return result;
    } catch (error) {
      logger.error('Statement parsing failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async extractAlertFields(content: string): Promise<ExtractedAlertFields | null> {
    if (this.config.provider === 'none') {
      return null;
    }

    const cacheKey = this.getCacheKey('extract_alert', { content: content.substring(0, 1000) });
    const cached = this.getFromCache<ExtractedAlertFields>(cacheKey);
    if (cached) {
      return cached;
    }

    await this.checkRateLimit();

    try {
      const prompt = `Extract one bank transaction alert from this email. Return JSON only.
Do NOT extract, invent, or return balances, opening balances, closing balances, or totals.

Email:
${content.substring(0, 2000)}

Fields:
- amount: number in major units, negative for charged/debited/sent, positive for refunded/credited/received
- currency: ISO code (SGD if unclear)
- date: YYYY-MM-DD (Asia/Singapore calendar date)
- time: optional HH:MM 24h Singapore time
- merchant: payee or shop name
- last4: optional card/account last four
- direction: debit or credit
- kind: purchase, refund, transfer, or deposit

Return null-equivalent empty merchant if this is not a transaction alert.`;

      const result = await this.executeCodexCall<ExtractedAlertFields>(prompt, {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          currency: { type: 'string' },
          date: { type: 'string' },
          time: { type: 'string' },
          merchant: { type: 'string' },
          last4: { type: 'string' },
          direction: { type: 'string', enum: ['debit', 'credit'] },
          kind: { type: 'string', enum: ['purchase', 'refund', 'transfer', 'deposit'] },
        },
        required: ['amount', 'currency', 'date', 'merchant'],
      });

      if (!result.merchant || result.amount === undefined) {
        return null;
      }
      this.setCache(cacheKey, result);
      return result;
    } catch (error) {
      logger.error('Alert field extraction failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async executeCodexCall<T>(prompt: string, schema?: Record<string, unknown>): Promise<T> {
    if (this.config.provider === 'codex') {
      if (!this.config.codexBin) {
        throw new Error('Codex binary path not configured');
      }
      
      return executeCodex<T>({
        codexBin: this.config.codexBin,
        codexHome: this.config.codexHome,
        codexModel: this.config.codexModel,
        codexReasoningEffort: this.config.codexReasoningEffort,
        extraConfig: parseCodexExtraConfig(),
        timeout: this.config.timeout,
      }, prompt, schema);
    } else if (this.config.provider === 'openai') {
      throw new Error('OpenAI provider not implemented yet');
    }
    throw new Error(`Unknown provider: ${this.config.provider}`);
  }

  private getCacheKey(operation: string, params: Record<string, unknown>): string {
    const hash = crypto
      .createHash('sha256')
      .update(operation + JSON.stringify(params))
      .digest('hex');
    return hash;
  }

  private getFromCache<T>(key: string): T | null {
    if (!this.config.cacheEnabled) {
      return null;
    }

    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) {
      return null;
    }

    const age = Date.now() - entry.timestamp;
    if (age > 24 * 60 * 60 * 1000) {
      this.cache.delete(key);
      return null;
    }

    return entry.result;
  }

  private setCache(key: string, result: unknown): void {
    if (!this.config.cacheEnabled) {
      return;
    }

    this.cache.set(key, {
      result,
      timestamp: Date.now(),
    });

    if (this.cache.size > 10000) {
      const oldestKeys = Array.from(this.cache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp)
        .slice(0, 1000)
        .map(([k]) => k);
      oldestKeys.forEach(k => this.cache.delete(k));
    }
  }

  private async checkRateLimit(): Promise<void> {
    const now = Date.now();
    this.requestTimes = this.requestTimes.filter(t => now - t < 60000);

    if (this.requestTimes.length >= this.config.rateLimit.requestsPerMinute) {
      const oldestRequest = this.requestTimes[0]!;
      const waitTime = 60000 - (now - oldestRequest);
      logger.warn('Rate limit hit, waiting', { waitMs: waitTime });
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return this.checkRateLimit();
    }

    this.requestTimes.push(now);
  }
}
