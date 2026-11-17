import fs from 'fs/promises';
import path from 'path';
import type Database from 'better-sqlite3';
import { logger } from '../lib/logger.js';
import type { Adapter } from '../adapters/adapter.js';

export interface AccountMapping {
  folderPattern: string;
  accountAlias: string;
  accountName: string;
}

export interface ImportSummary {
  file: string;
  status: 'success' | 'skipped' | 'error';
  adapter?: string;
  observations: number;
  newTransactions: number;
  matched: number;
  error?: string;
}

export class BulkImportService {
  constructor(
    private db: Database.Database,
    private adapters: Adapter[],
    private accountMappings: AccountMapping[]
  ) {}

  async importDirectory(dirPath: string): Promise<ImportSummary[]> {
    const results: ImportSummary[] = [];
    
    try {
      await this.walkDirectory(dirPath, async (filePath, relativePath) => {
        const summary = await this.importFile(filePath, relativePath);
        results.push(summary);
      });
    } catch (error) {
      logger.error('Directory import failed', {
        error: error instanceof Error ? error.message : String(error),
        dirPath,
      });
    }

    return results;
  }

  private async walkDirectory(
    dirPath: string,
    callback: (filePath: string, relativePath: string) => Promise<void>
  ): Promise<void> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      
      if (entry.isDirectory()) {
        await this.walkDirectory(fullPath, callback);
      } else if (entry.isFile()) {
        const relativePath = path.relative(process.cwd(), fullPath);
        await callback(fullPath, relativePath);
      }
    }
  }

  private async importFile(filePath: string, relativePath: string): Promise<ImportSummary> {
    try {
      const content = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      
      const mimeType = this.getMimeType(ext);
      if (!mimeType) {
        return {
          file: relativePath,
          status: 'skipped',
          observations: 0,
          newTransactions: 0,
          matched: 0,
          error: 'Unknown file type',
        };
      }

      const adapter = this.adapters.find(a => a.supportedMimeTypes.includes(mimeType));
      if (!adapter) {
        return {
          file: relativePath,
          status: 'skipped',
          observations: 0,
          newTransactions: 0,
          matched: 0,
          error: 'No adapter found',
        };
      }

      const accountHint = this.getAccountHint(relativePath);
      
      const documentHash = this.calculateHash(content);
      
      const existingDoc = this.db
        .prepare('SELECT hash FROM raw_documents WHERE hash = ?')
        .get(documentHash) as { hash: string } | undefined;

      if (existingDoc) {
        return {
          file: relativePath,
          status: 'skipped',
          adapter: adapter.name,
          observations: 0,
          newTransactions: 0,
          matched: 0,
          error: 'Already imported',
        };
      }

      const parseResult = await adapter.parse(content, documentHash);
      const observations = Array.isArray(parseResult) ? parseResult : parseResult.observations;

      this.db
        .prepare(
          `INSERT INTO raw_documents (hash, filename, mime_type, size_bytes, uploaded_at, content_key)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(documentHash, path.basename(filePath), mimeType, content.length, Date.now(), documentHash);

      const now = Date.now();
      let newTxns = 0;
      let matched = 0;

      for (const obs of observations) {
        const obsId = `obs_${documentHash}_${obs.reference || obs.timestamp}`;
        
        const existing = this.db
          .prepare('SELECT id FROM observations WHERE id = ?')
          .get(obsId) as { id: string } | undefined;

        if (!existing) {
          this.db
            .prepare(
              `INSERT INTO observations (
                id, document_hash, account_hint, timestamp, amount_cents, 
                currency, merchant_text, reference, kind, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              obsId,
              documentHash,
              accountHint || obs.accountHint,
              obs.timestamp,
              obs.amountCents,
              obs.currency,
              obs.merchantText,
              obs.reference,
              obs.kind,
              now
            );
          
          newTxns++;
        }
      }

      return {
        file: relativePath,
        status: 'success',
        adapter: adapter.name,
        observations: observations.length,
        newTransactions: newTxns,
        matched,
      };
    } catch (error) {
      logger.error('File import failed', {
        error: error instanceof Error ? error.message : String(error),
        file: relativePath,
      });

      return {
        file: relativePath,
        status: 'error',
        observations: 0,
        newTransactions: 0,
        matched: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private getMimeType(ext: string): string | null {
    const mimeTypes: Record<string, string> = {
      '.csv': 'text/csv',
      '.ofx': 'application/x-ofx',
      '.qfx': 'application/x-ofx',
      '.pdf': 'application/pdf',
      '.eml': 'message/rfc822',
    };
    return mimeTypes[ext] || null;
  }

  private getAccountHint(relativePath: string): string | null {
    for (const mapping of this.accountMappings) {
      const regex = new RegExp(mapping.folderPattern, 'i');
      if (regex.test(relativePath)) {
        return mapping.accountAlias;
      }
    }
    return null;
  }

  private calculateHash(content: Buffer): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}
