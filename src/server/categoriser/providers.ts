import { executeCodex } from '../lib/llm-provider-codex.js';
import {
  DEFAULT_CODEX_BIN,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  parseCodexExtraConfig,
} from '../lib/codex-defaults.js';
import { logger } from '../lib/logger.js';
import type { PromptOption } from './prompt.js';

export interface ProviderDecision {
  optionId: string;
  confidence: number;
  probabilities: Record<string, number>;
  rationale: string;
  inputTokens: number;
  outputTokens: number;
}

export interface CategoriserProvider {
  readonly name: 'none' | 'codex' | 'jev' | 'memory-only';
  choose(question: string, state: string, options: PromptOption[]): Promise<ProviderDecision | null>;
}

export class MemoryOnlyProvider implements CategoriserProvider {
  readonly name = 'memory-only' as const;
  async choose(): Promise<ProviderDecision | null> {
    return null;
  }
}

export class CodexCategoriserProvider implements CategoriserProvider {
  readonly name = 'codex' as const;

  constructor(
    private config: {
      codexBin: string;
      codexHome?: string;
      codexModel?: string;
      codexReasoningEffort?: string;
      extraConfig?: string[];
      timeout: number;
    }
  ) {}

  async choose(question: string, state: string, options: PromptOption[]): Promise<ProviderDecision | null> {
    const ids = options.map((option) => option.id);
    const result = await executeCodex<{ category: string; confidence: number; rationale?: string }>({
      codexBin: this.config.codexBin,
      codexHome: this.config.codexHome,
      codexModel: this.config.codexModel,
      codexReasoningEffort: this.config.codexReasoningEffort,
      extraConfig: this.config.extraConfig,
      timeout: this.config.timeout,
    }, `${question}\n\n${state}\n\nReturn JSON only.`, codexChoiceSchema(ids));
    if (!ids.includes(result.category)) return null;
    const probabilities = Object.fromEntries(ids.map((id) => [id, id === result.category ? result.confidence : 0]));
    return {
      optionId: result.category,
      confidence: result.confidence,
      probabilities,
      rationale: result.rationale ?? 'codex enum choice',
      inputTokens: Math.ceil(state.length / 4),
      outputTokens: 16,
    };
  }
}

export class JevCategoriserProvider implements CategoriserProvider {
  readonly name = 'jev' as const;

  constructor(private apiKey = process.env.TYPESAFE_API_KEY) {}

  async choose(question: string, state: string, options: PromptOption[]): Promise<ProviderDecision | null> {
    if (!this.apiKey) {
      throw new Error('TYPESAFE_API_KEY is required for the jev provider');
    }
    try {
      const sdk = await import('@typesafe-ai/sdk');
      const client = new sdk.TypeSafeClient({ apiKey: this.apiKey });
      const criteria = Object.fromEntries(options.map((option) => [option.id, option.description || option.label]));
      const response = await client.systemOne({
        state,
        questions: {
          category: sdk.choice(question, criteria),
        },
      });
      const answer = response.answers.category;
      const usage = (response as { usage?: { input_tokens?: number; output_tokens?: number; inputTokens?: number; outputTokens?: number } }).usage;
      return {
        optionId: answer.choice,
        confidence: answer.confidence ?? 0,
        probabilities: answer.probabilities ?? { [answer.choice]: answer.confidence ?? 0 },
        rationale: `jev selected ${answer.choice}`,
        inputTokens: usage?.input_tokens ?? usage?.inputTokens ?? 0,
        outputTokens: usage?.output_tokens ?? usage?.outputTokens ?? 0,
      };
    } catch (error) {
      if (error instanceof Error && /Cannot find module|Failed to resolve/.test(error.message)) {
        return this.chooseViaHttp(question, state, options);
      }
      throw error;
    }
  }

  private async chooseViaHttp(question: string, state: string, options: PromptOption[]): Promise<ProviderDecision | null> {
    const criteria = Object.fromEntries(options.map((option) => [option.id, option.description || option.label]));
    const response = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state,
        questions: {
          category: {
            type: 'choice',
            instructions: question,
            criteria,
          },
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`jev HTTP ${response.status}`);
    }
    const payload = await response.json() as {
      answers: { category: { choice: string; confidence?: number; probabilities?: Record<string, number> } };
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const answer = payload.answers.category;
    return {
      optionId: answer.choice,
      confidence: answer.confidence ?? 0,
      probabilities: answer.probabilities ?? {},
      rationale: `jev http selected ${answer.choice}`,
      inputTokens: payload.usage?.input_tokens ?? 0,
      outputTokens: payload.usage?.output_tokens ?? 0,
    };
  }
}

export function codexChoiceSchema(ids: string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      category: { type: 'string', enum: ids },
      confidence: { type: 'number' },
      rationale: { type: 'string' },
    },
    required: ['category', 'confidence', 'rationale'],
  };
}

export function providerConfigFromEnv(): {
  codexBin?: string;
  codexHome?: string;
  codexModel?: string;
  codexReasoningEffort?: string;
  extraConfig: string[];
  timeout: number;
} {
  return {
    codexBin: process.env.CODEX_BIN || DEFAULT_CODEX_BIN,
    codexHome: process.env.CODEX_HOME,
    codexModel: process.env.CODEX_MODEL || DEFAULT_CODEX_MODEL,
    codexReasoningEffort: process.env.CODEX_REASONING_EFFORT || DEFAULT_CODEX_REASONING_EFFORT,
    extraConfig: parseCodexExtraConfig(),
    timeout: parseInt(process.env.LLM_TIMEOUT || '30000', 10),
  };
}

export function createCategoriserProvider(
  name: string,
  config: {
    codexBin?: string;
    codexHome?: string;
    codexModel?: string;
    codexReasoningEffort?: string;
    extraConfig?: string[];
    timeout?: number;
  } = {}
): CategoriserProvider {
  if (name === 'codex') {
    const codexBin = config.codexBin || DEFAULT_CODEX_BIN;
    if (!codexBin) {
      logger.warn('CATEGORISER_PROVIDER=codex without CODEX_BIN; using memory-only');
      return new MemoryOnlyProvider();
    }
    return new CodexCategoriserProvider({
      codexBin,
      codexHome: config.codexHome,
      codexModel: config.codexModel || DEFAULT_CODEX_MODEL,
      codexReasoningEffort: config.codexReasoningEffort || DEFAULT_CODEX_REASONING_EFFORT,
      extraConfig: config.extraConfig ?? parseCodexExtraConfig(),
      timeout: config.timeout ?? 30000,
    });
  }
  if (name === 'jev') {
    return new JevCategoriserProvider();
  }
  return new MemoryOnlyProvider();
}
