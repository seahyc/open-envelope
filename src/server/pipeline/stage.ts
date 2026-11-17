export interface StageCounts {
  inputCount: number;
  outputCount: number;
  errorCount: number;
  flaggedCount: number;
}

export interface StageResult<TOutput = unknown> extends StageCounts {
  output: TOutput;
  adapterName?: string;
  errors: string[];
}

export interface StageContext {
  runId: string;
  documentHash?: string;
  filename?: string;
  skipLlmFallback?: boolean;
}

export interface Stage<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly description: string;
  run(input: TInput, ctx: StageContext): Promise<StageResult<TOutput>>;
}

export type StageKind = 'linear' | 'adapter-branch' | 'group' | 'substep' | 'signal-source';

export interface StageNode {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  description: string;
  kind: StageKind;
  adapterName?: string;
  parentId?: string;
}

export interface StageEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export function emptyCounts(): StageCounts {
  return { inputCount: 0, outputCount: 0, errorCount: 0, flaggedCount: 0 };
}

export function stageResult<T>(output: T, counts: Partial<StageCounts> & { adapterName?: string; errors?: string[] } = {}): StageResult<T> {
  return {
    output,
    inputCount: counts.inputCount ?? 0,
    outputCount: counts.outputCount ?? 0,
    errorCount: counts.errorCount ?? 0,
    flaggedCount: counts.flaggedCount ?? 0,
    adapterName: counts.adapterName,
    errors: counts.errors ?? [],
  };
}
