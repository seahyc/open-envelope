import { describe, it, expect } from 'vitest';
import { AdapterRegistry } from '../../src/server/adapters/registry.js';
import { adapterNodeId, buildPipelineGraph, PIPELINE_STAGE_ORDER } from '../../src/server/pipeline/definition.js';
import type { Adapter } from '../../src/server/adapters/adapter.js';

describe('declarative pipeline graph', () => {
  it('fans adapter branches out of the registry, including a newly registered bank', () => {
    const registry = new AdapterRegistry();
    const before = buildPipelineGraph(registry);
    expect(before.nodes.some((node) => node.id === adapterNodeId('ocbc-360'))).toBe(true);
    expect(before.nodes.some((node) => node.id === adapterNodeId('llm-fallback'))).toBe(true);
    expect(before.edges.some((edge) => edge.source === 'detect-format' && edge.target === adapterNodeId('ocbc-card'))).toBe(true);

    const uob: Adapter = {
      name: 'uob-card',
      supportedMimeTypes: ['application/pdf'],
      async parse() {
        return { observations: [] };
      },
      async canParse() {
        return 0.9;
      },
    };
    registry.register(uob);

    const after = buildPipelineGraph(registry);
    expect(after.nodes.some((node) => node.id === adapterNodeId('uob-card'))).toBe(true);
    expect(after.edges.some((edge) => edge.source === 'detect-format' && edge.target === adapterNodeId('uob-card'))).toBe(true);
    expect(after.edges.some((edge) => edge.source === adapterNodeId('uob-card') && edge.target === 'parse')).toBe(true);
  });

  it('keeps the linear stages independent of bank names', () => {
    const graph = buildPipelineGraph(new AdapterRegistry());
    const linear = graph.nodes.filter((node) => node.kind === 'linear').map((node) => node.id);
    expect(linear).toEqual([
      'ingest',
      'detect-format',
      'parse',
      'resolve-account',
      'upsert',
      'match',
      'reconcile',
      'detect-transfers',
      'enrich-merchant',
      'triangulate',
      'categorize',
      'flag-rules',
      'review-queue',
    ]);
    expect(linear.join(' ')).not.toMatch(/uob|ocbc|dbs|posb|cpf/i);
    const sources = graph.nodes.filter((node) => node.kind === 'signal-source').map((node) => node.id);
    expect(sources).toEqual(['source:location', 'source:calendar', 'source:orders', 'source:webhook']);
    expect(sources.every((id) => graph.nodes.find((node) => node.id === id)?.enabled === false)).toBe(true);
    expect(graph.nodes.find((node) => node.id === 'triangulate')?.enabled).toBe(false);
    expect(graph.edges.some((edge) => edge.source === 'source:location' && edge.target === 'triangulate')).toBe(true);
    expect(graph.edges.some((edge) => edge.source === 'enrich-merchant' && edge.target === 'triangulate')).toBe(true);
    expect(graph.edges.some((edge) => edge.source === 'triangulate' && edge.target === 'categorize')).toBe(true);
    expect(graph.edges.some((edge) => edge.source === 'categorize' && edge.target === 'triangulate')).toBe(false);
    expect(graph.edges.some((edge) => edge.source === 'categorize' && edge.target === 'enrich-merchant')).toBe(false);
  });

  it('runs enrich-merchant and that-day research before categorize', () => {
    const enrich = PIPELINE_STAGE_ORDER.indexOf('enrich-merchant');
    const thatDay = PIPELINE_STAGE_ORDER.indexOf('triangulate');
    const categorize = PIPELINE_STAGE_ORDER.indexOf('categorize');
    expect(enrich).toBeGreaterThanOrEqual(0);
    expect(thatDay).toBeGreaterThan(enrich);
    expect(categorize).toBeGreaterThan(thatDay);
    const graph = buildPipelineGraph(new AdapterRegistry());
    const linear = graph.nodes.filter((node) => node.kind === 'linear').map((node) => node.id);
    expect(linear.indexOf('enrich-merchant')).toBeLessThan(linear.indexOf('triangulate'));
    expect(linear.indexOf('triangulate')).toBeLessThan(linear.indexOf('categorize'));
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'enrich-merchant', target: 'triangulate' }),
        expect.objectContaining({ source: 'triangulate', target: 'categorize' }),
      ])
    );
  });

  it('nests categoriser sub-steps under categorize', () => {
    const graph = buildPipelineGraph(new AdapterRegistry());
    expect(graph.nodes.filter((node) => node.parentId === 'categorize').map((node) => node.id)).toEqual([
      'categorize:memory',
      'categorize:rules',
      'categorize:provider',
      'categorize:threshold',
    ]);
    expect(graph.edges.some((edge) => edge.source === 'categorize:memory' && edge.target === 'categorize:rules')).toBe(true);
  });
});
