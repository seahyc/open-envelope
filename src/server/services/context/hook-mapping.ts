import { jsonPathGet } from './json-path.js';

export type MappingSpec = Record<string, unknown>;

export interface ItemMapping {
  from: string;
  [field: string]: unknown;
}

export function applyMapping(payload: unknown, mapping: MappingSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(mapping)) {
    out[key] = resolveSpec(payload, spec);
  }
  return out;
}

export function previewMapping(
  sample: unknown,
  mapping: MappingSpec | null,
): { preview: unknown; error: string | null } {
  if (!mapping || Object.keys(mapping).length === 0) {
    return { preview: sample, error: null };
  }
  try {
    return { preview: applyMapping(sample, mapping), error: null };
  } catch (error) {
    return { preview: null, error: error instanceof Error ? error.message : 'Mapping failed' };
  }
}

function resolveSpec(root: unknown, spec: unknown): unknown {
  if (spec && typeof spec === 'object' && !Array.isArray(spec) && 'from' in spec) {
    const itemMap = spec as ItemMapping;
    const arr = jsonPathGet(root, String(itemMap.from));
    const list = Array.isArray(arr) ? arr : [];
    const fields = Object.entries(itemMap).filter(([k]) => k !== 'from');
    return list.map((item) => {
      const row: Record<string, unknown> = {};
      for (const [field, value] of fields) {
        row[field] = resolveValue(item, value);
      }
      return row;
    });
  }
  return resolveValue(root, spec);
}

function resolveValue(root: unknown, spec: unknown): unknown {
  if (typeof spec === 'string' && spec.startsWith('$.')) {
    try {
      return jsonPathGet(root, spec);
    } catch {
      return undefined;
    }
  }
  if (typeof spec === 'string' && spec === '$') return root;
  return spec;
}
