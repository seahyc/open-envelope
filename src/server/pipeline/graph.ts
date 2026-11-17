import type Database from 'better-sqlite3';
import type { AdapterRegistry } from '../adapters/registry.js';
import { adapterDisplayName, adapterNodeId, buildPipelineGraph } from './definition.js';
import type { PipelineRecorder, PipelineRunRow, StageRunRow } from './recorder.js';

export interface PipelineGraphPayload {
  nodes: Array<{
    id: string;
    name: string;
    label: string;
    description: string;
    kind: string;
    enabled: boolean;
    version: string;
    parentId?: string;
    adapterName?: string;
    inputCount: number;
    outputCount: number;
    errorCount: number;
    flaggedCount: number;
    durationMs: number;
    status?: string;
    errorMessage?: string | null;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    count: number;
  }>;
  runs: PipelineRunRow[];
  selectedRun: PipelineRunRow | null;
  reviewItems: Array<{
    id: string;
    reason: string;
    detail: string | null;
    createdAt: number;
  }>;
  samples: Array<{
    merchantText: string;
    amountCents: number;
    accountMasked: string;
    kind: string;
  }>;
}

function maskAccount(hint: string): string {
  const digits = hint.replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return `••••${digits.slice(-4)}`;
}

function stageCounts(stageRuns: StageRunRow[], stageName: string): StageRunRow | undefined {
  return stageRuns.find((row) => row.stage_name === stageName);
}

export function buildPipelineGraphPayload(
  db: Database.Database,
  registry: AdapterRegistry,
  recorder: PipelineRecorder,
  runId?: string
): PipelineGraphPayload {
  const definition = buildPipelineGraph(registry);
  const runs = recorder.listRuns();
  const selected = runId
    ? recorder.getRun(runId) ?? null
    : runs[0] ?? null;
  const stageRuns = selected ? recorder.getStageRuns(selected.id) : [];

  const chosenAdapter = selected?.adapter_name ?? stageRuns.find((row) => row.adapter_name)?.adapter_name ?? null;

  const nodes = definition.nodes.map((node) => {
    const recorded = node.kind === 'adapter-branch'
      ? stageRuns.find((row) => row.stage_name === 'detect-format' && (
        node.adapterName === chosenAdapter && node.id === adapterNodeId(chosenAdapter)
        || node.adapterName === 'llm-fallback' && chosenAdapter === 'llm-fallback'
      ))
      : stageCounts(stageRuns, node.name);

    const selectedBranch = node.kind === 'adapter-branch' && chosenAdapter
      && (node.adapterName === chosenAdapter || (chosenAdapter === 'llm-fallback' && node.adapterName === 'llm-fallback'));

    const detect = stageCounts(stageRuns, 'detect-format');
    const parse = stageCounts(stageRuns, 'parse');

    let inputCount = recorded?.input_count ?? 0;
    let outputCount = recorded?.output_count ?? 0;
    if (node.kind === 'adapter-branch') {
      inputCount = selectedBranch ? (detect?.output_count ?? (chosenAdapter ? 1 : 0)) : 0;
      outputCount = selectedBranch ? (parse?.input_count || parse?.output_count || inputCount) : 0;
    }

    return {
      id: node.id,
      name: node.name,
      label: node.kind === 'adapter-branch' ? adapterDisplayName(node.adapterName ?? node.name) : node.name,
      parentId: node.parentId,
      description: node.description,
      kind: node.kind,
      enabled: node.enabled,
      version: node.version,
      adapterName: node.adapterName,
      inputCount,
      outputCount,
      errorCount: recorded?.error_count ?? 0,
      flaggedCount: recorded?.flagged_count ?? 0,
      durationMs: recorded?.duration_ms ?? 0,
      status: recorded?.status,
      errorMessage: recorded?.error_message,
    };
  });

  const edges = definition.edges.map((edge) => {
    const source = nodes.find((node) => node.id === edge.source);
    const target = nodes.find((node) => node.id === edge.target);
    let count = 0;
    if (source?.kind === 'adapter-branch') {
      count = source.outputCount;
    } else if (target?.kind === 'adapter-branch') {
      count = target.inputCount;
    } else if (target) {
      count = target.inputCount || target.outputCount;
    } else if (source) {
      count = source.outputCount;
    }
    return { id: edge.id, source: edge.source, target: edge.target, count };
  });

  let reviewItems: PipelineGraphPayload['reviewItems'] = [];
  let samples: PipelineGraphPayload['samples'] = [];
  if (selected?.document_hash) {
    reviewItems = (db.prepare(`
      SELECT id, reason, detail, created_at as createdAt
      FROM review_queue
      WHERE document_hash = ?
      ORDER BY created_at DESC
      LIMIT 8
    `).all(selected.document_hash) as PipelineGraphPayload['reviewItems']);

    samples = (db.prepare(`
      SELECT merchant_text as merchantText, amount_cents as amountCents,
             account_hint as accountHint, kind
      FROM observations
      WHERE document_hash = ?
      ORDER BY created_at DESC
      LIMIT 6
    `).all(selected.document_hash) as Array<{
      merchantText: string;
      amountCents: number;
      accountHint: string;
      kind: string;
    }>).map((row) => ({
      merchantText: row.merchantText,
      amountCents: row.amountCents,
      accountMasked: maskAccount(row.accountHint),
      kind: row.kind,
    }));
  }

  return { nodes, edges, runs, selectedRun: selected, reviewItems, samples };
}
