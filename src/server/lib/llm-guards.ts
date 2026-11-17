/**
 * LLM Safety Guards
 * 
 * These functions enforce code-level rules preventing LLM output
 * from writing to protected fields (balances, posted amounts, reconciliation status).
 */

export interface LLMSourcedData {
  source?: 'llm' | 'llm-fallback' | 'user' | 'adapter' | 'rule';
  adapterName?: string;
}

/**
 * Assert that data is NOT from an LLM source.
 * Throws an error if the data comes from LLM or LLM-fallback.
 * 
 * Call this on EVERY write path that could receive LLM-derived data.
 */
export function assertNotLLMSourced(data: LLMSourcedData, operation: string): void {
  const isLLMSourced = 
    data.source === 'llm' || 
    data.source === 'llm-fallback' ||
    data.adapterName === 'llm-fallback' ||
    data.adapterName === 'llm';

  if (isLLMSourced) {
    throw new Error(`GUARD: LLM-sourced data cannot perform operation: ${operation}`);
  }
}
