import type { LLMProvider } from '../lib/llm-provider.js';
import { logger } from '../lib/logger.js';

export type EmailClassification = 
  | 'transaction_alert'
  | 'statement_notice'
  | 'promotional'
  | 'otp'
  | 'other';

export interface TriageResult {
  classification: EmailClassification;
  confidence: number;
  shouldParse: boolean;
}

export class LLMTriageService {
  constructor(private llmProvider: LLMProvider | null) {}

  async classifyEmail(content: string): Promise<TriageResult> {
    if (!this.llmProvider) {
      return {
        classification: 'other',
        confidence: 0,
        shouldParse: true,
      };
    }

    try {
      const result = await this.llmProvider.classifyEmail(content);
      
      const shouldParse = result.classification === 'transaction_alert' || 
                          result.classification === 'statement_notice';

      logger.info('Email classified', { 
        classification: result.classification, 
        confidence: result.confidence,
        shouldParse 
      });

      return {
        ...result,
        shouldParse,
      };
    } catch (error) {
      logger.warn('Email classification failed, defaulting to parse', {
        error: error instanceof Error ? error.message : String(error)
      });
      
      return {
        classification: 'other',
        confidence: 0,
        shouldParse: true,
      };
    }
  }

  async classifyDocument(filename: string, content: Buffer): Promise<TriageResult> {
    if (!this.llmProvider) {
      return {
        classification: 'other',
        confidence: 0,
        shouldParse: true,
      };
    }

    const text = content.toString('utf-8', 0, Math.min(2000, content.length));
    
    try {
      const result = await this.llmProvider.classifyDocument(filename, text);
      
      const shouldParse = result.classification === 'statement_notice';

      return {
        ...result,
        shouldParse,
      };
    } catch (error) {
      logger.warn('Document classification failed, defaulting to parse', {
        error: error instanceof Error ? error.message : String(error)
      });
      
      return {
        classification: 'other',
        confidence: 0,
        shouldParse: true,
      };
    }
  }
}
