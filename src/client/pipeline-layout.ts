import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';

export interface LayoutGraphNode {
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
}

const NODE_WIDTH = 188;
const NODE_HEIGHT = 58;
const SUB_WIDTH = 168;
const SUB_HEIGHT = 52;

export function layoutPipelineGraph(graphNodes: LayoutGraphNode[], graphEdges: Array<{ id: string; source: string; target: string }>): {
  nodes: Node[];
  edges: Edge[];
} {
  const children = graphNodes.filter((node) => node.parentId);
  const topLevel = graphNodes.filter((node) => !node.parentId);
  const childIds = new Set(children.map((node) => node.id));

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 16, ranksep: 52, edgesep: 10, marginx: 12, marginy: 12 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of topLevel) {
    const wide = node.id === 'categorize' && children.some((child) => child.parentId === node.id);
    g.setNode(node.id, {
      width: wide ? 560 : NODE_WIDTH,
      height: wide ? 150 : NODE_HEIGHT,
    });
  }
  for (const edge of graphEdges) {
    if (childIds.has(edge.source) || childIds.has(edge.target)) continue;
    if (!g.hasNode(edge.source) || !g.hasNode(edge.target)) continue;
    g.setEdge(edge.source, edge.target);
  }
  dagre.layout(g);

  const nodes: Node[] = topLevel.map((node) => {
    const placed = g.node(node.id);
    const isGroup = node.id === 'categorize' && children.some((child) => child.parentId === node.id);
    return {
      id: node.id,
      type: isGroup ? 'pipelineGroup' : 'pipelineStage',
      position: { x: placed.x - (isGroup ? 560 : NODE_WIDTH) / 2, y: placed.y - (isGroup ? 150 : NODE_HEIGHT) / 2 },
      style: isGroup ? { width: 560, height: 150 } : undefined,
      data: node as unknown as Record<string, unknown>,
    };
  });

  const grouped = new Map<string, LayoutGraphNode[]>();
  for (const child of children) {
    const list = grouped.get(child.parentId!) ?? [];
    list.push(child);
    grouped.set(child.parentId!, list);
  }

  for (const [parentId, group] of grouped) {
    const inner = new dagre.graphlib.Graph();
    inner.setGraph({ rankdir: 'LR', nodesep: 16, ranksep: 36, marginx: 16, marginy: 36 });
    inner.setDefaultEdgeLabel(() => ({}));
    for (const child of group) {
      inner.setNode(child.id, { width: SUB_WIDTH, height: SUB_HEIGHT });
    }
    for (let i = 0; i < group.length - 1; i++) {
      inner.setEdge(group[i]!.id, group[i + 1]!.id);
    }
    dagre.layout(inner);
    for (const child of group) {
      const placed = inner.node(child.id);
      nodes.push({
        id: child.id,
        type: 'pipelineStage',
        parentId,
        extent: 'parent',
        position: { x: placed.x - SUB_WIDTH / 2, y: placed.y - SUB_HEIGHT / 2 },
        data: child as unknown as Record<string, unknown>,
      });
    }
  }

  const edges: Edge[] = graphEdges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: undefined,
  }));

  return { nodes, edges };
}
