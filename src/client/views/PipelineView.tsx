import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { layoutPipelineGraph, type LayoutGraphNode } from '../pipeline-layout';
import { api } from '../api';

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  count: number;
}

interface PipelineRun {
  id: string;
  filename: string | null;
  adapter_name: string | null;
  started_at: number;
  status: string;
  observations_created: number;
  transactions_created: number;
}

interface GraphPayload {
  nodes: LayoutGraphNode[];
  edges: GraphEdge[];
  runs: PipelineRun[];
  selectedRun: PipelineRun | null;
  reviewItems: Array<{ id: string; reason: string; detail: string | null; createdAt: number }>;
  samples: Array<{ merchantText: string; amountCents: number; accountMasked: string; kind: string }>;
}

let selectHandler: ((node: LayoutGraphNode) => void) | null = null;

function PipelineStageNode({ id, data }: NodeProps) {
  const node = data as unknown as LayoutGraphNode;
  const active = node.outputCount > 0 || node.inputCount > 0;
  return (
    <div
      className={`pipeline-node ${node.kind} ${active ? 'active' : ''} ${node.enabled ? '' : 'disabled'}`}
      data-testid={`pipeline-node-${id}`}
      onClick={() => selectHandler?.(node)}
    >
      <Handle type="target" position={Position.Left} />
      <div className="pipeline-node-title">{node.label}</div>
      <div className="pipeline-node-meta">
        {node.kind === 'adapter-branch' ? 'adapter' : node.kind === 'signal-source' ? 'source' : node.name}
        {typeof node.outputCount === 'number' ? ` · ${node.outputCount}` : ''}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function PipelineGroupNode({ data }: NodeProps) {
  const node = data as unknown as LayoutGraphNode;
  return (
    <div className="pipeline-group" data-testid={`pipeline-node-${node.id}`} onClick={() => selectHandler?.(node)}>
      <Handle type="target" position={Position.Left} />
      <div className="pipeline-group-title">{node.label}</div>
      <div className="pipeline-group-meta">memory → rules/exemplars → provider → threshold</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { pipelineStage: PipelineStageNode, pipelineGroup: PipelineGroupNode };

export function PipelineView() {
  const [payload, setPayload] = useState<GraphPayload | null>(null);
  const [runId, setRunId] = useState<string>('');
  const [selected, setSelected] = useState<LayoutGraphNode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id?: string) => {
    const query = id ? `?runId=${encodeURIComponent(id)}` : '';
    const data = await api<GraphPayload>(`/api/pipeline/graph${query}`);
    setPayload(data);
    setRunId(data.selectedRun?.id ?? '');
  }, []);

  useEffect(() => {
    load().catch(() => setError('Could not load pipeline graph'));
  }, [load]);

  selectHandler = setSelected;

  const laidOut = useMemo(
    () => (payload ? layoutPipelineGraph(payload.nodes, payload.edges) : { nodes: [], edges: [] }),
    [payload]
  );

  const edges = useMemo(
    () =>
      laidOut.edges.map((edge) => {
        const count = payload?.edges.find((item) => item.id === edge.id)?.count ?? 0;
        return {
          ...edge,
          label: String(count),
          animated: count > 0,
          style: { stroke: count > 0 ? '#111111' : '#9A9A9A', strokeWidth: count > 0 ? 2 : 1 },
          labelStyle: { fill: '#111111', fontSize: 11, fontWeight: 600 },
          labelBgStyle: { fill: '#ffffff' },
        };
      }),
    [laidOut.edges, payload]
  );

  const selectedDetails = selected
    ? payload?.nodes.find((node) => node.id === selected.id) ?? selected
    : null;

  return (
    <div className="pipeline-page">
      <div className="pipeline-toolbar">
        <div>
          <h2>Import pipeline</h2>
          <p>n8n-style view of the declarative stages. Adapter branches come from the registry.</p>
        </div>
        <label className="pipeline-run-picker">
          Run
          <select
            value={runId}
            onChange={(event) => {
              const next = event.target.value;
              setRunId(next);
              load(next || undefined).catch(() => undefined);
            }}
            disabled={!payload || payload.runs.length === 0}
          >
            {payload?.runs.length ? (
              payload.runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {new Date(run.started_at).toLocaleString()} · {run.adapter_name || 'unknown'} · {run.filename || 'document'}
                </option>
              ))
            ) : (
              <option value="">No runs yet</option>
            )}
          </select>
        </label>
      </div>

      {error && <div className="pipeline-banner error">{error}</div>}
      {payload && payload.runs.length === 0 && (
        <div className="pipeline-banner empty" data-testid="pipeline-empty">
          No pipeline runs yet. Import a statement to see counts on the graph.
        </div>
      )}

      <div className="pipeline-body">
        <div className="pipeline-canvas" data-testid="pipeline-graph">
          <ReactFlow
            nodes={laidOut.nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.16 }}
            minZoom={0.35}
            maxZoom={1.6}
            nodesDraggable={false}
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_event, node) => setSelected(node.data as unknown as LayoutGraphNode)}
          >
            <Background color="#E6E6E6" gap={18} />
            <Controls />
            <MiniMap
              pannable
              zoomable
              style={{ background: '#ffffff', width: 120, height: 80 }}
              nodeColor={(node) => {
                const kind = (node.data as unknown as LayoutGraphNode).kind;
                if (kind === 'adapter-branch') return '#111111';
                if (kind === 'substep') return '#5C5C5C';
                return '#111111';
              }}
            />
          </ReactFlow>
        </div>

        <aside className={`pipeline-panel ${selectedDetails ? 'open' : ''}`} data-testid="pipeline-panel">
          {selectedDetails ? (
            <>
              <div className="pipeline-panel-header">
                <h3>{selectedDetails.label}</h3>
                <button type="button" className="btn btn-secondary" onClick={() => setSelected(null)}>
                  Close
                </button>
              </div>
              <p>{selectedDetails.description}</p>
              <dl>
                <div><dt>Enabled</dt><dd>{selectedDetails.enabled ? 'yes' : 'no'}</dd></div>
                <div><dt>Version</dt><dd>{selectedDetails.version}</dd></div>
                <div><dt>Last-run in</dt><dd>{selectedDetails.inputCount}</dd></div>
                <div><dt>Last-run out</dt><dd>{selectedDetails.outputCount}</dd></div>
                <div><dt>Errors</dt><dd>{selectedDetails.errorCount}</dd></div>
                <div><dt>Flagged</dt><dd>{selectedDetails.flaggedCount}</dd></div>
                <div><dt>Duration</dt><dd>{selectedDetails.durationMs} ms</dd></div>
              </dl>
              {selectedDetails.errorMessage && <p className="pipeline-error">{selectedDetails.errorMessage}</p>}
              <h4>Recent review items</h4>
              {payload?.reviewItems.length ? (
                <ul>
                  {payload.reviewItems.map((item) => (
                    <li key={item.id}>{item.reason}</li>
                  ))}
                </ul>
              ) : (
                <p className="pipeline-muted">None for this run.</p>
              )}
              <h4>Sample items</h4>
              {payload?.samples.length ? (
                <ul>
                  {payload.samples.map((sample, index) => (
                    <li key={`${sample.merchantText}-${index}`}>
                      {sample.merchantText} · {sample.accountMasked} · {(sample.amountCents / 100).toFixed(2)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="pipeline-muted">No observation samples.</p>
              )}
            </>
          ) : (
            <p className="pipeline-muted">Click a node for stage details. Accounts are masked to the last 4 digits.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
