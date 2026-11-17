import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CpfAdapter } from '../../src/server/adapters/singapore/cpf-adapter.js';
import { Ocbc360Adapter } from '../../src/server/adapters/singapore/ocbc-360-adapter.js';
import { DbsAccountAdapter } from '../../src/server/adapters/singapore/dbs-account-adapter.js';
import { defaultRegistry } from '../../src/server/adapters/registry.js';

const layouts = join(process.cwd(), 'fixtures/layouts');
const singapore = join(process.cwd(), 'fixtures/singapore');

describe('CpfAdapter detection', () => {
  const adapter = new CpfAdapter();

  it('does not win on OCBC/DBS deposit-insurance footers that mention CPF Investment Scheme', async () => {
    const ocbc = readFileSync(join(layouts, 'ocbc-360-bank-account.txt'));
    const savings = readFileSync(join(layouts, 'ocbc-statement-savings.txt'));
    const dbs = readFileSync(join(layouts, 'dbs-posb-esavings.txt'));

    expect(await adapter.canParse(ocbc, 'ocbc-360.pdf', 'application/pdf')).toBe(0);
    expect(await adapter.canParse(savings, 'ocbc-savings.pdf', 'application/pdf')).toBe(0);
    expect(await adapter.canParse(dbs, 'dbs-posb.pdf', 'application/pdf')).toBe(0);

    expect(await new Ocbc360Adapter().canParse(ocbc, 'stmt.pdf', 'application/pdf')).toBeGreaterThan(0.5);
    expect(await new DbsAccountAdapter().canParse(dbs, 'stmt.pdf', 'application/pdf')).toBeGreaterThan(0.5);

    const bestOcbc = await defaultRegistry.findBestAdapter(ocbc, 'random.pdf', 'application/pdf');
    expect(bestOcbc?.adapter.name).toBe('ocbc-360');
    expect(bestOcbc?.adapter.name).not.toBe('cpf');
  });

  it('still recognises a real CPF statement header and the existing CSV fixture', async () => {
    const header = readFileSync(join(layouts, 'cpf-statement-header.txt'));
    expect(await adapter.canParse(header, 'statement.txt', 'text/plain')).toBeGreaterThan(0.5);

    const csv = readFileSync(join(singapore, 'cpf-statement.csv'));
    expect(await adapter.canParse(csv, 'cpf-statement.csv', 'text/csv')).toBeGreaterThan(0.5);
    const parsed = await adapter.parse(csv);
    expect(parsed.observations).toHaveLength(5);
  });
});
