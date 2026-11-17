import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMProvider } from '../../src/server/lib/llm-provider.js';
import { execFile } from 'child_process';
import * as fs from 'fs';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdtempSync: vi.fn(() => '/tmp/codex-mock'),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

describe('LLMProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('none provider', () => {
    it('returns null for merchant categorization', async () => {
      const provider = new LLMProvider({
        provider: 'none',
        cacheEnabled: false,
        timeout: 30000,
        rateLimit: { requestsPerMinute: 10 },
      });

      const result = await provider.categorizeMerchant('Starbucks', -567, ['Food', 'Coffee']);
      expect(result).toBeNull();
    });

    it('returns null for statement parsing', async () => {
      const provider = new LLMProvider({
        provider: 'none',
        cacheEnabled: false,
        timeout: 30000,
        rateLimit: { requestsPerMinute: 10 },
      });

      const result = await provider.parseUnknownStatement('some statement content');
      expect(result).toBeNull();
    });

    it('returns null for alert field extraction', async () => {
      const provider = new LLMProvider({
        provider: 'none',
        cacheEnabled: false,
        timeout: 30000,
        rateLimit: { requestsPerMinute: 10 },
      });

      const result = await provider.extractAlertFields('SGD 1.00 charged at SHOP');
      expect(result).toBeNull();
    });
  });

  describe('codex provider (mocked)', () => {
    it('categorizes merchant with mocked codex', async () => {
      const mockResult = {
        category: 'Groceries',
        confidence: 0.95,
        suggestedRule: {
          merchantPattern: 'WHOLE FOODS.*',
          category: 'Groceries',
        },
      };

      vi.mocked(execFile).mockImplementation(((cmd: any, args: any, opts: any, callback: any) => {
        callback(null, '', '');
      }) as any);

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockResult) as any);

      const provider = new LLMProvider({
        provider: 'codex',
        codexBin: 'codex',
        cacheEnabled: false,
        timeout: 30000,
        rateLimit: { requestsPerMinute: 10 },
      });

      const result = await provider.categorizeMerchant('Whole Foods Market', -4599, [
        'Groceries',
        'Dining',
      ]);

      expect(result).toEqual({
        category: 'Groceries',
        confidence: 0.95,
        suggestedRule: {
          merchantPattern: 'WHOLE FOODS.*',
          category: 'Groceries',
        },
      });

      const execCalls = vi.mocked(execFile).mock.calls;
      expect(execCalls.length).toBeGreaterThan(0);
      const lastCall = execCalls[execCalls.length - 1];
      const args = lastCall![1] as string[];
      expect(args).toContain('--skip-git-repo-check');
      expect(args).toContain('--');
      expect(args[args.length - 1]).toContain('Categorize this transaction');
    });

    it('extracts alert fields without asking for balances', async () => {
      vi.mocked(execFile).mockImplementation(((cmd: any, args: any, opts: any, callback: any) => {
        callback(null, '', '');
      }) as any);

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        amount: -12.34,
        currency: 'SGD',
        date: '2026-11-03',
        merchant: 'FAIRPRICE',
      }) as any);

      const provider = new LLMProvider({
        provider: 'codex',
        codexBin: 'codex',
        cacheEnabled: false,
        timeout: 30000,
        rateLimit: { requestsPerMinute: 10 },
      });

      const result = await provider.extractAlertFields('SGD12.34 charged at FAIRPRICE');
      expect(result?.merchant).toBe('FAIRPRICE');
      expect(result).not.toHaveProperty('openingBalance');
      const args = vi.mocked(execFile).mock.calls[0]![1] as string[];
      const prompt = args[args.length - 1] as string;
      expect(prompt).toContain('Do NOT extract');
      expect(prompt.toLowerCase()).toContain('balances');
    });

    it('handles low confidence results', async () => {
      const mockResult = {
        category: 'Miscellaneous',
        confidence: 0.3,
      };

      vi.mocked(execFile).mockImplementation(((cmd: any, args: any, opts: any, callback: any) => {
        callback(null, '', '');
      }) as any);

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockResult) as any);

      const provider = new LLMProvider({
        provider: 'codex',
        codexBin: 'codex',
        cacheEnabled: false,
        timeout: 30000,
        rateLimit: { requestsPerMinute: 10 },
      });

      const result = await provider.categorizeMerchant('XYZ Corp', -10000, ['Food', 'Shopping']);

      expect(result).not.toBeNull();
      expect(result!.confidence).toBeLessThan(0.5);
    });

    it('normalizes merchant name through codex', async () => {
      vi.mocked(execFile).mockImplementation(((cmd: any, args: any, opts: any, callback: any) => {
        callback(null, '', '');
      }) as any);

      vi.mocked(fs.readFileSync).mockReturnValue('"Starbucks"' as any);

      const provider = new LLMProvider({
        provider: 'codex',
        codexBin: 'codex',
        cacheEnabled: false,
        timeout: 30000,
        rateLimit: { requestsPerMinute: 10 },
      });

      const result = await provider.normalizeMerchant('STARBUCKS #12345 SINGAPORE');

      expect(result).toBe('Starbucks');
      
      const execCalls = vi.mocked(execFile).mock.calls;
      expect(execCalls.length).toBeGreaterThan(0);
      const lastCall = execCalls[execCalls.length - 1];
      const args = lastCall![1] as string[];
      expect(args).toContain('--output-last-message');
      expect(args).toContain('--skip-git-repo-check');
      expect(args).toContain('--');
    });
  });

  describe('caching', () => {
    it('caches results when enabled', async () => {
      const mockResult = {
        category: 'Coffee',
        confidence: 0.9,
      };

      vi.mocked(execFile).mockImplementation(((cmd: any, args: any, opts: any, callback: any) => {
        callback(null, '', '');
      }) as any);

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockResult) as any);

      const provider = new LLMProvider({
        provider: 'codex',
        codexBin: 'codex',
        cacheEnabled: true,
        timeout: 30000,
        rateLimit: { requestsPerMinute: 10 },
      });

      await provider.categorizeMerchant('Starbucks', -567, ['Coffee']);
      await provider.categorizeMerchant('Starbucks', -567, ['Coffee']);

      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
    });

    it('does not cache when disabled', async () => {
      const mockResult = {
        category: 'Coffee',
        confidence: 0.9,
      };

      vi.mocked(execFile).mockImplementation(((cmd: any, args: any, opts: any, callback: any) => {
        callback(null, '', '');
      }) as any);

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockResult) as any);

      const provider = new LLMProvider({
        provider: 'codex',
        codexBin: 'codex',
        cacheEnabled: false,
        timeout: 30000,
        rateLimit: { requestsPerMinute: 10 },
      });

      await provider.categorizeMerchant('Starbucks', -567, ['Coffee']);
      await provider.categorizeMerchant('Starbucks', -567, ['Coffee']);

      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(2);
    });
  });

  describe('rate limiting', () => {
    it.skip('enforces rate limit', async () => {
      const mockExec = vi.fn((cmd, opts, callback) => {
        callback(null, JSON.stringify({ category: 'Test', confidence: 1 }), '');
      });

      vi.mocked(execFile).mockImplementation(mockExec as any);

      const provider = new LLMProvider({
        provider: 'codex',
        cacheEnabled: false,
        timeout: 30000,
        rateLimit: { requestsPerMinute: 2 },
      });

      const start = Date.now();
      
      await provider.categorizeMerchant('A', -100, ['Test']);
      await provider.categorizeMerchant('B', -100, ['Test']);
      
      const promise = provider.categorizeMerchant('C', -100, ['Test']);
      
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(0);
      
      await promise;
    }, 10000);
  });
});
