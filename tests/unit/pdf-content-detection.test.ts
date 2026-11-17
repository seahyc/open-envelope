import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DbsAccountAdapter } from '../../src/server/adapters/singapore/dbs-account-adapter.js';
import { DbsCardAdapter } from '../../src/server/adapters/singapore/dbs-card-adapter.js';
import { Ocbc360Adapter } from '../../src/server/adapters/singapore/ocbc-360-adapter.js';
import { OcbcCardAdapter } from '../../src/server/adapters/singapore/ocbc-card-adapter.js';

describe('PDF/statement type detection from content', () => {
  const fixtures = join(process.cwd(), 'fixtures/singapore');

  it('picks the adapter from header text even when the filename is wrong', async () => {
    const adapters = [
      new DbsAccountAdapter(),
      new DbsCardAdapter(),
      new Ocbc360Adapter(),
      new OcbcCardAdapter(),
    ];

    const cases = [
      { file: 'ocbc-360-statement.txt', expected: 'ocbc-360' },
      { file: 'ocbc-card-statement.txt', expected: 'ocbc-card' },
      { file: 'dbs-account-statement.txt', expected: 'dbs-account' },
      { file: 'dbs-card-statement.txt', expected: 'dbs-card' },
      { file: '../layouts/ocbc-360-bank-account.txt', expected: 'ocbc-360' },
      { file: '../layouts/ocbc-card-90n.txt', expected: 'ocbc-card' },
      { file: '../layouts/dbs-posb-esavings.txt', expected: 'dbs-account' },
      { file: '../layouts/dbs-card-altitude.txt', expected: 'dbs-card' },
    ];

    for (const fixture of cases) {
      const content = readFileSync(join(fixtures, fixture.file));
      const scored = [];
      for (const adapter of adapters) {
        scored.push({
          name: adapter.name,
          score: await adapter.canParse(content, 'random-bank-statement.pdf', 'application/pdf'),
        });
      }
      scored.sort((a, b) => b.score - a.score);
      expect(scored[0]!.name, fixture.file).toBe(fixture.expected);
      expect(scored[0]!.score).toBeGreaterThan(0.5);
    }
  });
});
