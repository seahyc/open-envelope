import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { defaultRegistry } from '../../src/server/adapters/registry.js';

describe('Singapore Fixtures Recognition', () => {
  it('recognizes all 5 statement fixtures in fixtures/singapore', async () => {
    const fixturesDir = join(process.cwd(), 'fixtures/singapore');
    const statementFixtures = [
      'cpf-statement.csv',
      'dbs-account-statement.txt',
      'dbs-card-statement.txt',
      'ocbc-360-statement.txt',
      'ocbc-card-statement.txt',
    ];

    const results: Record<string, { recognized: boolean; observations: number }> = {};

    for (const filename of statementFixtures) {
      const filePath = join(fixturesDir, filename);
      if (!existsSync(filePath)) {
        results[filename] = { recognized: false, observations: 0 };
        continue;
      }

      const content = readFileSync(filePath);
      const bestMatch = await defaultRegistry.findBestAdapter(content, filename, 'text/plain');

      if (!bestMatch || !bestMatch.adapter) {
        results[filename] = { recognized: false, observations: 0 };
        continue;
      }

      try {
        const parseResult = await bestMatch.adapter.parse(content, `hash-${filename}`);
        const observations = Array.isArray(parseResult) ? parseResult : parseResult.observations;
        results[filename] = {
          recognized: true,
          observations: observations.length,
        };
      } catch (error) {
        results[filename] = { recognized: false, observations: 0 };
      }
    }

    expect(results['cpf-statement.csv'].recognized).toBe(true);
    expect(results['cpf-statement.csv'].observations).toBeGreaterThan(0);

    expect(results['dbs-account-statement.txt'].recognized).toBe(true);
    expect(results['dbs-account-statement.txt'].observations).toBeGreaterThan(0);

    expect(results['dbs-card-statement.txt'].recognized).toBe(true);
    expect(results['dbs-card-statement.txt'].observations).toBeGreaterThan(0);

    expect(results['ocbc-360-statement.txt'].recognized).toBe(true);
    expect(results['ocbc-360-statement.txt'].observations).toBeGreaterThan(0);

    expect(results['ocbc-card-statement.txt'].recognized).toBe(true);
    expect(results['ocbc-card-statement.txt'].observations).toBeGreaterThan(0);
  });
});
