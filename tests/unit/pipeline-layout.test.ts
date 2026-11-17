import { describe, it, expect } from 'vitest';
import { AdapterRegistry } from '../../src/server/adapters/registry.js';
import { buildPipelineGraph } from '../../src/server/pipeline/definition.js';
import { layoutPipelineGraph } from '../../src/client/pipeline-layout.js';

describe('pipeline dagre layout', () => {
  it('keeps adapter branches in one column and nests categoriser sub-steps', () => {
    const definition = buildPipelineGraph(new AdapterRegistry());
    const { nodes } = layoutPipelineGraph(
      definition.nodes.map((node) => ({
        id: node.id,
        name: node.name,
        label: node.name,
        description: node.description,
        kind: node.kind,
        enabled: node.enabled,
        version: node.version,
        parentId: node.parentId,
        adapterName: node.adapterName,
        inputCount: 0,
        outputCount: 0,
        errorCount: 0,
        flaggedCount: 0,
        durationMs: 0,
      })),
      definition.edges
    );
    const adapters = nodes.filter((node) => (node.data as { kind: string }).kind === 'adapter-branch');
    const xs = adapters.map((node) => Math.round(node.position.x / 20));
    expect(new Set(xs).size).toBe(1);
    expect(nodes.some((node) => node.id === 'categorize' && node.type === 'pipelineGroup')).toBe(true);
    expect(nodes.filter((node) => node.parentId === 'categorize')).toHaveLength(4);
  });
});
