import type { AdapterRegistry } from '../adapters/registry.js';
import { contextFlag } from '../lib/context-flags.js';
import type { StageEdge, StageNode } from './stage.js';

export const LINEAR_STAGES: StageNode[] = [
  {
    id: 'ingest',
    name: 'ingest',
    version: '1.0.0',
    enabled: true,
    description: 'Store the raw document and skip work when the content hash is already known.',
    kind: 'linear',
  },
  {
    id: 'detect-format',
    name: 'detect-format',
    version: '1.0.0',
    enabled: true,
    description: 'Score every registered adapter and pick the best match. New banks register here automatically.',
    kind: 'linear',
  },
  {
    id: 'parse',
    name: 'parse',
    version: '1.0.0',
    enabled: true,
    description: 'Parse observations and statement periods from the chosen adapter.',
    kind: 'linear',
  },
  {
    id: 'resolve-account',
    name: 'resolve-account',
    version: '1.0.0',
    enabled: true,
    description: 'Resolve each line and period through aliases, dash-normalised hints, and folderPattern.',
    kind: 'linear',
  },
  {
    id: 'upsert',
    name: 'upsert',
    version: '1.0.0',
    enabled: true,
    description: 'Idempotent insert of observations and statement periods.',
    kind: 'linear',
  },
  {
    id: 'match',
    name: 'match',
    version: '1.0.0',
    enabled: true,
    description: 'Match alert lines to statement lines, or create a new transaction.',
    kind: 'linear',
  },
  {
    id: 'reconcile',
    name: 'reconcile',
    version: '1.0.0',
    enabled: true,
    description: 'Balance statement periods against posted lines and flag discrepancies.',
    kind: 'linear',
  },
  {
    id: 'detect-transfers',
    name: 'detect-transfers',
    version: '1.0.0',
    enabled: true,
    description: 'Auto-link unambiguous card-bill and own-account FAST/PayNow pairs; flag the rest for review.',
    kind: 'linear',
  },
  {
    id: 'enrich-merchant',
    name: 'enrich-merchant',
    version: '1.0.0',
    enabled: true,
    description: 'Look up opaque PayNow/FAST/GIRO payees in ACRA, then optional web search. Sends only the payee name or UEN.',
    kind: 'linear',
  },
  {
    id: 'triangulate',
    name: 'triangulate',
    version: '1.0.0',
    enabled: true,
    description: 'Propose order, place-visit, and calendar evidence for That day. Runs before categorize so the guess can cite research.',
    kind: 'linear',
  },
  {
    id: 'categorize',
    name: 'categorize',
    version: '1.0.0',
    enabled: true,
    description: 'After research: merchant memory, SSIC/that-day guess, condensed rules/exemplars, provider, then threshold. Never writes balances.',
    kind: 'linear',
  },
  {
    id: 'flag-rules',
    name: 'flag-rules',
    version: '1.0.0',
    enabled: true,
    description: 'Apply deterministic flags (zero-line balance mismatch, unmatched accounts).',
    kind: 'linear',
  },
  {
    id: 'review-queue',
    name: 'review-queue',
    version: '1.0.0',
    enabled: true,
    description: 'Collect review items produced by earlier stages for this document.',
    kind: 'linear',
  },
];

export const CATEGORISE_SUBSTEPS: StageNode[] = [
  {
    id: 'categorize:memory',
    name: 'categorize:memory',
    version: '1.0.0',
    enabled: true,
    description: 'Exact or high-agreement merchant memory. flag/ask always reviews.',
    kind: 'substep',
    parentId: 'categorize',
  },
  {
    id: 'categorize:rules',
    name: 'categorize:rules',
    version: '1.0.0',
    enabled: true,
    description: 'Condensed rules and similar exemplars for the two-step prompt.',
    kind: 'substep',
    parentId: 'categorize',
  },
  {
    id: 'categorize:provider',
    name: 'categorize:provider',
    version: '1.0.0',
    enabled: true,
    description: 'codex or jev choose L1/kind then a leaf. Skipped on memory hits.',
    kind: 'substep',
    parentId: 'categorize',
  },
  {
    id: 'categorize:threshold',
    name: 'categorize:threshold',
    version: '1.0.0',
    enabled: true,
    description: 'Auto-apply above confidence; otherwise review. Corrections write back to memory.',
    kind: 'substep',
    parentId: 'categorize',
  },
];

export function signalSources(env: NodeJS.ProcessEnv = process.env): StageNode[] {
  return [
    {
      id: 'source:location',
      name: 'location',
      version: '1.0.0',
      enabled: contextFlag('location', env),
      description: 'OwnTracks HTTP location ingest. Derives place visits; raw points expire after 90 days.',
      kind: 'signal-source',
    },
    {
      id: 'source:calendar',
      name: 'calendar',
      version: '1.0.0',
      enabled: contextFlag('calendar', env),
      description: 'Poll each member’s secret iCal URL every 15 minutes. Stores title, start/end, location.',
      kind: 'signal-source',
    },
    {
      id: 'source:orders',
      name: 'orders',
      version: '1.0.0',
      enabled: contextFlag('orders', env),
      description: 'Parse itemised receipt emails (Lazada, Shopee, Amazon SG, FairPrice) into orders + items.',
      kind: 'signal-source',
    },
    {
      id: 'source:webhook',
      name: 'webhook',
      version: '1.0.0',
      enabled: contextFlag('webhook', env),
      description: 'Generic webhook ingest. Typed events or JSONPath-mapped JSON join the same triangulate step. Never writes balances.',
      kind: 'signal-source',
    },
  ];
}

export const SIGNAL_SOURCES: StageNode[] = signalSources();

export const LLM_FALLBACK_NODE: StageNode = {
  id: 'adapter:llm-fallback',
  name: 'llm-fallback',
  version: '1.0.0',
  enabled: true,
  description: 'Last-resort parser when no adapter matches. Never writes balances.',
  kind: 'adapter-branch',
  adapterName: 'llm-fallback',
};

export function adapterNodeId(adapterName: string): string {
  return `adapter:${adapterName}`;
}

export function adapterDisplayName(adapterName: string): string {
  return adapterName.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

export function buildPipelineGraph(registry: AdapterRegistry): { nodes: StageNode[]; edges: StageEdge[] } {
  const adapterNodes: StageNode[] = registry.getAll().map((adapter) => ({
    id: adapterNodeId(adapter.name),
    name: adapter.name,
    version: '1.0.0',
    enabled: true,
    description: `Adapter branch for ${adapterDisplayName(adapter.name)}. Register a new adapter to add a bank — do not edit the pipeline.`,
    kind: 'adapter-branch',
    adapterName: adapter.name,
  }));
  adapterNodes.push(LLM_FALLBACK_NODE);

  const sources = signalSources();
  const linear = LINEAR_STAGES.map((stage) => (
    stage.id === 'triangulate' ? { ...stage, enabled: contextFlag('triangulate') } : stage
  ));
  const nodes: StageNode[] = [
    linear[0]!,
    linear[1]!,
    ...adapterNodes,
    ...linear.slice(2),
    ...CATEGORISE_SUBSTEPS,
    ...sources,
  ];

  const edges: StageEdge[] = [
    { id: 'e-ingest-detect', source: 'ingest', target: 'detect-format' },
  ];

  for (const adapter of adapterNodes) {
    edges.push({ id: `e-detect-${adapter.id}`, source: 'detect-format', target: adapter.id });
    edges.push({ id: `e-${adapter.id}-parse`, source: adapter.id, target: 'parse' });
  }

  const afterParse = linear.slice(2);
  for (let i = 0; i < afterParse.length - 1; i++) {
    const from = afterParse[i]!;
    const to = afterParse[i + 1]!;
    edges.push({ id: `e-${from.id}-${to.id}`, source: from.id, target: to.id });
  }

  for (let i = 0; i < CATEGORISE_SUBSTEPS.length - 1; i++) {
    const from = CATEGORISE_SUBSTEPS[i]!;
    const to = CATEGORISE_SUBSTEPS[i + 1]!;
    edges.push({ id: `e-${from.id}-${to.id}`, source: from.id, target: to.id });
  }

  for (const source of sources) {
    edges.push({ id: `e-${source.id}-triangulate`, source: source.id, target: 'triangulate' });
  }

  return { nodes, edges };
}

export const PIPELINE_STAGE_ORDER = LINEAR_STAGES.map((stage) => stage.id);
