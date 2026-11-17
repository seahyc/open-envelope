import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { ImportService } from '../../src/server/services/import-service.js';
import { PipelineService } from '../../src/server/services/pipeline-service.js';
import { LLMProvider } from '../../src/server/lib/llm-provider.js';
import { LocalDocumentStore } from '../../src/server/storage/document-store.js';
import { AdapterRegistry } from '../../src/server/adapters/registry.js';
import { LLMTriageService } from '../../src/server/services/llm-triage-service.js';

describe('Email Ingest Integration', () => {
  let db: Database.Database;
  let tmpDir: string;
  let importService: ImportService;
  let triageService: LLMTriageService;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openenvelope-test-'));
    
    const { initDatabase } = await import('../../src/server/db/database.js');
    db = initDatabase(join(tmpDir, 'test.db'));
    
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES ('test-account', 'Test Account', '["1234", "test"]', 'budget', ?)
    `).run(Date.now());
    
    const llmProvider = new LLMProvider({
      provider: 'none',
      cacheEnabled: false,
      timeout: 30000,
      rateLimit: { requestsPerMinute: 10 },
    });
    
    const documentStore = new LocalDocumentStore(join(tmpDir, 'documents'));
    const adapterRegistry = new AdapterRegistry();
    const pipelineService = new PipelineService(db, llmProvider, [
      { accountHint: 'test', accountAlias: 'test', accountId: 'test-account' }
    ], documentStore);
    
    importService = new ImportService(db, documentStore, adapterRegistry, pipelineService);
    triageService = new LLMTriageService(llmProvider);
  });

  afterEach(() => {
    if (db) db.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores email document through import service', async () => {
    const alertEmail = Buffer.from(`From: alerts@bank.com
To: user@example.com
Subject: Transaction Alert
Message-ID: <alert-123@bank.com>
Date: Mon, 26 Oct 2026 10:00:00 +0000

Transaction Alert:
Your DBS account ending in 1234 was debited SGD 45.67 at STARBUCKS #12345 on 26 Oct 2026.
`);

    const result = await importService.import('alert-email.eml', alertEmail);
    
    expect(result.documentHash).toBeDefined();
    expect(result.errors).toBeDefined();
    
    const rawDocs = db.prepare('SELECT COUNT(*) as count FROM raw_documents').get() as { count: number };
    expect(rawDocs.count).toBeGreaterThan(0);
  });

  it('with LLM_PROVIDER=none classification returns other', async () => {
    const classification = await triageService.classifyEmail('Some email content');
    
    expect(classification.classification).toBe('other');
    expect(classification.confidence).toBe(0);
  });
});
