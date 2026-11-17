import { execFile } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseCodexExtraConfig } from './codex-defaults.js';

export const CODEX_EXEC_FAILED = 'CODEX_EXEC_FAILED';
export const CODEX_PARSE_FAILED = 'CODEX_PARSE_FAILED';

export interface CodexConfig {
  codexBin: string;
  codexHome?: string;
  codexModel?: string;
  codexReasoningEffort?: string;
  extraConfig?: string[];
  timeout: number;
  retries?: number;
}

export async function executeCodex<T>(
  config: CodexConfig,
  prompt: string,
  schema?: Record<string, unknown>
): Promise<T> {
  const retries = config.retries ?? 1;
  const extra = config.extraConfig ?? parseCodexExtraConfig();
  let lastError: Error = new Error(CODEX_EXEC_FAILED);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await executeCodexOnce<T>(config, prompt, schema, extra);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code !== CODEX_EXEC_FAILED && code !== CODEX_PARSE_FAILED) {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error(CODEX_EXEC_FAILED);
    }
  }
  throw lastError;
}

async function executeCodexOnce<T>(
  config: CodexConfig,
  prompt: string,
  schema: Record<string, unknown> | undefined,
  extraConfig: string[]
): Promise<T> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'codex-'));

  try {
    const args = ['exec', '--skip-git-repo-check'];
    const outputFile = join(tmpDir, 'output.json');

    args.push('--output-last-message', outputFile);

    if (schema) {
      const schemaFile = join(tmpDir, 'schema.json');
      writeFileSync(schemaFile, JSON.stringify(schema));
      args.push('--output-schema', schemaFile);
    }

    if (config.codexModel) {
      args.push('-c', `model=${config.codexModel}`);
    }

    if (config.codexReasoningEffort) {
      args.push('-c', `model_reasoning_effort=${config.codexReasoningEffort}`);
    }

    for (const override of extraConfig) {
      args.push('-c', override);
    }

    args.push('--', prompt);

    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        config.codexBin,
        args,
        {
          timeout: config.timeout,
          env: {
            ...process.env,
            CODEX_HOME: config.codexHome || process.env.CODEX_HOME,
          },
          maxBuffer: 10 * 1024 * 1024,
        },
        (error) => {
          if (error) {
            reject(new Error(CODEX_EXEC_FAILED));
            return;
          }
          resolve();
        }
      );

      child.stdin?.end();
    });

    let output: string;
    try {
      output = readFileSync(outputFile, 'utf-8');
    } catch {
      throw new Error(CODEX_PARSE_FAILED);
    }
    try {
      return JSON.parse(output) as T;
    } catch {
      throw new Error(CODEX_PARSE_FAILED);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
