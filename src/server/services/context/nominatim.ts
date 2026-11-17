import { logger } from '../../lib/logger.js';
import type Database from 'better-sqlite3';

export interface NominatimLookup {
  reverse(lat: number, lng: number): Promise<string | null>;
}

export function geocodeCacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

export function createNominatimLookup(options: {
  db: Database.Database;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  userAgent?: string;
  minIntervalMs?: number;
  now?: () => number;
} ): NominatimLookup {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint || process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/reverse';
  const userAgent = options.userAgent || process.env.NOMINATIM_USER_AGENT || 'OpenEnvelope/0.1';
  const minIntervalMs = options.minIntervalMs ?? 1000;
  const now = options.now ?? (() => Date.now());
  let lastCallAt = 0;
  const skipNetwork = Boolean(process.env.VITEST) && !options.fetchImpl;

  return {
    async reverse(lat: number, lng: number) {
      const key = geocodeCacheKey(lat, lng);
      const cached = options.db.prepare(
        'SELECT place_name FROM geocode_cache WHERE cache_key = ?'
      ).get(key) as { place_name: string } | undefined;
      if (cached?.place_name) return cached.place_name;
      if (skipNetwork) return null;
      const wait = minIntervalMs - (now() - lastCallAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastCallAt = now();
      try {
        const url = new URL(endpoint);
        url.searchParams.set('lat', String(lat));
        url.searchParams.set('lon', String(lng));
        url.searchParams.set('format', 'json');
        url.searchParams.set('zoom', '18');
        const response = await fetchImpl(url.toString(), {
          headers: { 'User-Agent': userAgent, Accept: 'application/json' },
          signal: AbortSignal.timeout(4000),
        });
        if (!response.ok) return null;
        const body = await response.json() as { display_name?: string; name?: string };
        const name = (body.name || body.display_name || '').split(',')[0]?.trim();
        if (!name) return null;
        options.db.prepare(
          'INSERT OR REPLACE INTO geocode_cache (cache_key, place_name, fetched_at) VALUES (?, ?, ?)'
        ).run(key, name, now());
        return name;
      } catch (error) {
        logger.warn('Nominatim reverse failed', { error: error instanceof Error ? error.message : String(error) });
        return null;
      }
    },
  };
}
