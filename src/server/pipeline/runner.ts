import type { PipelineRecorder } from './recorder.js';
import { timedStage } from './recorder.js';
import type { Stage, StageContext, StageResult } from './stage.js';

export function defineStage<TInput, TOutput = TInput>(
  meta: { name: string; version: string; enabled?: boolean; description: string },
  run: (input: TInput, ctx: StageContext) => Promise<StageResult<TOutput>> | StageResult<TOutput>
): Stage<TInput, TOutput> {
  return {
    name: meta.name,
    version: meta.version,
    enabled: meta.enabled ?? true,
    description: meta.description,
    async run(input, ctx) {
      return run(input, ctx);
    },
  };
}

export async function runStages<TState>(
  recorder: PipelineRecorder,
  runId: string,
  stages: Stage<TState, TState>[],
  initial: TState,
  ctx: StageContext
): Promise<TState> {
  let state = initial;
  for (const stage of stages) {
    if (!stage.enabled) continue;
    const result = await timedStage(recorder, runId, stage.name, stage.version, () => stage.run(state, ctx));
    state = result.output;
  }
  return state;
}
