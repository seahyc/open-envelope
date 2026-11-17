import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'child_process';
import * as fs from 'fs';
import { CODEX_EXEC_FAILED, CODEX_PARSE_FAILED, executeCodex } from '../../src/server/lib/llm-provider-codex.js';

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

describe('executeCodex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes --skip-git-repo-check and redacts exec failures', async () => {
    vi.mocked(execFile).mockImplementation(((cmd: unknown, args: unknown, opts: unknown, callback: (error: Error | null) => void) => {
      callback(new Error(`Command failed: codex exec -- Merchant: SECRETCAFE Amount: 12.34 Account: acc-joint`));
      return {} as never;
    }) as typeof execFile);

    await expect(executeCodex({
      codexBin: 'codex',
      timeout: 1000,
    }, 'Merchant: SECRETCAFE Amount: 12.34 Account: acc-joint')).rejects.toThrow(CODEX_EXEC_FAILED);

    try {
      await executeCodex({
        codexBin: 'codex',
        timeout: 1000,
      }, 'Merchant: SECRETCAFE Amount: 12.34 Account: acc-joint');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe(CODEX_EXEC_FAILED);
      expect(message).not.toContain('SECRETCAFE');
      expect(message).not.toContain('12.34');
      expect(message).not.toContain('acc-joint');
    }

    const args = vi.mocked(execFile).mock.calls[0]![1] as string[];
    expect(args).toContain('--skip-git-repo-check');
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('--skip-git-repo-check');
    expect(vi.mocked(execFile).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('redacts parse failures to an error code', async () => {
    vi.mocked(execFile).mockImplementation(((cmd: unknown, args: unknown, opts: unknown, callback: (error: Error | null) => void) => {
      callback(null);
      return {} as never;
    }) as typeof execFile);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT output.json Merchant: SECRETCAFE');
    });

    await expect(executeCodex({
      codexBin: 'codex',
      timeout: 1000,
    }, 'Merchant: SECRETCAFE')).rejects.toThrow(CODEX_PARSE_FAILED);
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(2);
  });

  it('retries once on parse failure then succeeds', async () => {
    let calls = 0;
    vi.mocked(execFile).mockImplementation(((cmd: unknown, args: unknown, opts: unknown, callback: (error: Error | null) => void) => {
      callback(null);
      return {} as never;
    }) as typeof execFile);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      calls += 1;
      if (calls === 1) throw new Error('not json');
      return JSON.stringify({ category: 'Transport', confidence: 0.95, rationale: 'ok' });
    });

    const result = await executeCodex<{ category: string }>({
      codexBin: 'codex',
      timeout: 1000,
    }, 'prompt');
    expect(result.category).toBe('Transport');
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(2);
  });

  it('passes CODEX_EXTRA_CONFIG as extra -c flags', async () => {
    vi.mocked(execFile).mockImplementation(((cmd: unknown, args: unknown, opts: unknown, callback: (error: Error | null) => void) => {
      callback(null);
      return {} as never;
    }) as typeof execFile);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ok: true }) as never);

    await executeCodex({
      codexBin: 'codex',
      timeout: 1000,
      extraConfig: ['mcp_servers={}', 'features.mcp=false'],
      retries: 0,
    }, 'prompt');

    const args = vi.mocked(execFile).mock.calls[0]![1] as string[];
    expect(args).toContain('mcp_servers={}');
    expect(args).toContain('features.mcp=false');
    const cFlags = args.filter((arg, index) => args[index - 1] === '-c');
    expect(cFlags).toContain('mcp_servers={}');
  });
});
