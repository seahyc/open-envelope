#!/usr/bin/env node
import Database from 'better-sqlite3';
import { readFileSync, readdirSync, statSync } from 'fs';
import { parse } from 'yaml';
import { join } from 'path';
import crypto from 'crypto';
import { PipelineService, type AccountMapping } from '../src/server/services/pipeline-service.js';
import { ImportService } from '../src/server/services/import-service.js';
import { LLMProvider } from '../src/server/lib/llm-provider.js';
import { LocalDocumentStore } from '../src/server/storage/document-store.js';
import { defaultRegistry } from '../src/server/adapters/registry.js';
import { runMigrations } from '../src/server/db/migrations.js';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: npm run import -- <directory>');
  console.error('');
  console.error('Example: npm run import -- ./statements');
  console.error('');
  console.error('Requires accounts.yaml config file (see accounts.yaml.example)');
  process.exit(1);
}

const dirPath = args[0]!;

const configPath = process.env.ACCOUNTS_CONFIG || 'accounts.yaml';
let accountMappings: AccountMapping[] = [];
interface AccountConfig {
  folderPattern?: string;
  accountAlias: string;
  accountName?: string;
  accountType?: string;
  institution?: string;
  aliases?: string[];
}
let accountConfigs: AccountConfig[] = [];

try {
  const configContent = readFileSync(configPath, 'utf-8');
  const config = parse(configContent) as { accounts: AccountConfig[] };
  accountConfigs = config.accounts;
  accountMappings = config.accounts.map(acc => ({
    folderPattern: acc.folderPattern,
    accountAlias: acc.accountAlias,
    accountId: undefined,
    accountHint: acc.accountAlias
  }));
  console.log(`Loaded ${accountMappings.length} account mappings from ${configPath}`);
} catch (error) {
  console.warn(`Warning: ${configPath} not found, using empty mappings`);
  accountMappings = [];
  accountConfigs = [];
}

const databasePath = process.env.DATABASE_PATH || './data/openenvelope.db';
const db = Database(databasePath);

runMigrations(db);

for (const accConfig of accountConfigs) {
  const accountName = accConfig.accountName || accConfig.accountAlias;
  const accountType = accConfig.accountType || 'budget';
  const aliases = accConfig.aliases || [accConfig.accountAlias];
  
  const existing = db.prepare('SELECT id FROM accounts WHERE aliases LIKE ?').get(`%"${accConfig.accountAlias}"%`) as { id: string } | undefined;
  
  if (!existing) {
    const accountId = `${accountName.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;
    db.prepare(`
      INSERT INTO accounts (id, name, aliases, account_group, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(accountId, accountName, JSON.stringify(aliases), accountType, Date.now());
    console.log(`Created account: ${accountName} (${accountId})`);
    
    const mapping = accountMappings.find(m => m.accountAlias === accConfig.accountAlias);
    if (mapping) {
      mapping.accountId = accountId;
    }
  } else {
    const mapping = accountMappings.find(m => m.accountAlias === accConfig.accountAlias);
    if (mapping) {
      mapping.accountId = existing.id;
    }
  }
}

const documentStore = new LocalDocumentStore(process.env.OBJECT_STORAGE_LOCAL_PATH || './data/documents');

const llmProvider = new LLMProvider({
  provider: 'none',
  cacheEnabled: false,
  timeout: 30000,
  rateLimit: { requestsPerMinute: 10 },
});
const pipelineService = new PipelineService(db, llmProvider, accountMappings, documentStore);
const importService = new ImportService(db, documentStore, defaultRegistry, pipelineService);

console.log(`\nImporting from: ${dirPath}\n`);

// Item D: Walk directory and process each document through pipeline
const files: string[] = [];
function walkDir(dir: string) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walkDir(fullPath);
    } else if (stat.isFile() && !/\.ya?ml$/i.test(entry)) {
      files.push(fullPath);
    }
  }
}

walkDir(dirPath);

interface ImportResult {
  file: string;
  status: 'success' | 'error' | 'skipped';
  adapter?: string;
  observations?: number;
  transactions?: number;
  merged?: number;
  error?: string;
  documentHash?: string;
}

const results: ImportResult[] = [];

for (const file of files) {
  try {
    const buffer = readFileSync(file);
    const documentHash = crypto.createHash('sha256').update(buffer).digest('hex');
    const filename = file.split('/').pop() || file;
    
    const existing = db
      .prepare('SELECT hash FROM raw_documents WHERE hash = ?')
      .get(documentHash) as { hash: string } | undefined;
    
    if (existing) {
      results.push({ file, status: 'skipped', error: 'Already imported' });
      continue;
    }
    
    const relativePath = file.startsWith(dirPath)
      ? file.slice(dirPath.length).replace(/^[/\\]/, '')
      : filename;
    const importResult = await importService.import(relativePath, buffer);
    
    if (importResult.observationsCreated === 0) {
      const mismatch = importResult.errors.find((error) =>
        /adapter matched but parsed 0 lines while balances differ/i.test(error)
      );
      if (mismatch) {
        results.push({
          file,
          status: 'error',
          adapter: importResult.adapterName,
          error: mismatch,
          documentHash,
        });
        continue;
      }

      const period = db
        .prepare('SELECT COUNT(*) as count FROM statement_periods WHERE document_hash = ?')
        .get(documentHash) as { count: number };
      if (importResult.hasStatementPeriod || period.count > 0) {
        results.push({
          file,
          status: 'success',
          adapter: importResult.adapterName || 'unknown',
          observations: 0,
          transactions: importResult.transactionsCreated,
          merged: importResult.transactionsMerged,
          documentHash: importResult.documentHash,
        });
        continue;
      }

      results.push({
        file,
        status: 'error',
        error: 'Unrecognised format - no observations created',
        documentHash,
      });
      continue;
    }
    
    const adapterName = db.prepare('SELECT adapter_name FROM observations WHERE document_hash = ? LIMIT 1').get(documentHash) as { adapter_name: string } | undefined;

    results.push({
      file,
      status: importResult.errors.length > 0 ? 'error' : 'success',
      adapter: adapterName?.adapter_name || importResult.adapterName || 'unknown',
      observations: importResult.observationsCreated,
      transactions: importResult.transactionsCreated,
      merged: importResult.transactionsMerged,
      error: importResult.errors.join('; ') || undefined,
      documentHash: importResult.documentHash,
    });
  } catch (error) {
    results.push({
      file,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log('\n=== Import Summary ===\n');

const stats = {
  total: results.length,
  success: 0,
  skipped: 0,
  error: 0,
  unrecognised: 0,
  observations: 0,
  newTransactions: 0,
  mergedTransactions: 0,
};

for (const result of results) {
  if (result.status === 'success') {
    stats.success++;
    stats.observations += result.observations || 0;
    stats.newTransactions += result.transactions || 0;
    stats.mergedTransactions += result.merged || 0;
    console.log(`✓ ${result.file}`);
    console.log(`  Adapter: ${result.adapter}`);
    console.log(`  Observations: ${result.observations}`);
    console.log(`  New transactions: ${result.transactions}`);
    console.log(`  Merged: ${result.merged || 0}`);
    console.log(`  Hash: ${result.documentHash?.substring(0, 12)}...`);
  } else if (result.status === 'skipped') {
    stats.skipped++;
    console.log(`○ ${result.file} (${result.error})`);
  } else {
    if (result.error?.includes('Unrecognised format')) {
      stats.unrecognised++;
      console.log(`? ${result.file}`);
      console.log(`  ${result.error}`);
    } else {
      stats.error++;
      console.log(`✗ ${result.file}`);
      console.log(`  Error: ${result.error}`);
    }
  }
  console.log('');
}

console.log('=== Statistics ===\n');
console.log(`Total files: ${stats.total}`);
console.log(`Success: ${stats.success}`);
console.log(`Skipped: ${stats.skipped}`);
console.log(`Unrecognised: ${stats.unrecognised}`);
console.log(`Errors: ${stats.error}`);
console.log(`Total observations: ${stats.observations}`);
console.log(`New transactions: ${stats.newTransactions}`);
console.log(`Merged: ${stats.mergedTransactions}`);

db.close();
