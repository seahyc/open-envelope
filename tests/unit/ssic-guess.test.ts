import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { loadCategorySchema } from '../../src/server/categoriser/schema.js';
import { CategoriserService } from '../../src/server/categoriser/service.js';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/server/db/migrations.js';
import {
  NO_RESEARCH_MATCH,
  citeResearchReason,
  guardCategoryDirection,
  guessFromSsic,
  probablyWasSentence,
} from '../../src/server/services/ssic-guess.js';

const schema = loadCategorySchema(join(process.cwd(), 'config/categories.default.json'));
const PAYNOW = 'FAST PAYMENT via PayNow-UEN to ABOVE ALL ENTERP OTHR-OTHR';

describe('SSIC family and direction guard', () => {
  it('maps cafe SSIC family plus a small outflow to hawker dining', () => {
    const guess = guessFromSsic({
      ssicCode: '56122',
      ssicDescription: 'na',
      amountCents: -1850,
      merchantText: PAYNOW,
    });
    expect(guess?.categoryId).toBe('exp.food.dining.hawker');
    expect(guess?.rationale).toBe('S$18.50 PayNow to a cafe operator');
    expect(probablyWasSentence({
      ssicCode: '56122',
      amountCents: -1850,
      merchantText: PAYNOW,
    })).toBe('A meal or kopi at a coffee shop');
    expect(citeResearchReason({
      ssicCode: '56122',
      ssicDescription: 'na',
      amountCents: -1850,
      merchantText: PAYNOW,
    })).toMatch(/coffee shop/i);
    expect(citeResearchReason({
      ssicCode: null,
      amountCents: -350000,
      merchantText: 'FAST PAYMENT via PayNow to LIM AH HOCK OTHR-OTHR',
    })).toBe(NO_RESEARCH_MATCH);
  });

  it('never assigns an income category to an outflow, or the reverse', () => {
    expect(guardCategoryDirection(schema, 'inc.salary', -1850)).toEqual({
      categoryId: null,
      blocked: true,
      reason: 'direction guard: outflow cannot be income',
    });
    expect(guardCategoryDirection(schema, 'exp.food.dining.hawker', 520000)).toEqual({
      categoryId: null,
      blocked: true,
      reason: 'direction guard: inflow cannot be expense',
    });
    expect(guardCategoryDirection(schema, 'exp.food.dining.hawker', -1850).blocked).toBe(false);
    expect(guardCategoryDirection(schema, 'inc.salary', 520000).blocked).toBe(false);
  });

  it('direction-guard: provider income on an outflow is rejected', async () => {
    const db = new Database(':memory:');
    runMigrations(db, { quiet: true });
    const categoriser = new CategoriserService(db, {
      schema,
      seedMemoryCsv: null,
      provider: {
        name: 'codex',
        async choose(_question, _state, options) {
          const optionId = options.some((option) => option.id === 'inc.salary')
            ? 'inc.salary'
            : options.some((option) => option.id === 'Income')
              ? 'Income'
              : options[0]!.id;
          return {
            optionId,
            confidence: 0.91,
            probabilities: { [optionId]: 0.91 },
            rationale: 'fake income',
            inputTokens: 4,
            outputTokens: 2,
          };
        },
      },
    });
    const outcome = await categoriser.categorizeFacts({
      merchant: PAYNOW,
      accountId: 'acc-joint',
      amountCents: -1850,
      ssicCode: '56122',
      ssicDescription: 'Food courts, coffee shops and eating houses',
    });
    expect(outcome.categoryId).not.toMatch(/^inc\./);
    expect(outcome.categoryId).toBe('exp.food.dining.hawker');
    expect(outcome.applied).toBe(false);
    expect(outcome.review).toBe(true);
    expect(outcome.rationale).toMatch(/direction guard/);
    db.close();
  });
});
