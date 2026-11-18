import { createHmac } from 'node:crypto';
import { logger } from '../../lib/logger.js';
import type { Shop } from './order-match.js';

/**
 * Event-driven order sync: when a fresh card/bank charge for a marketplace lands and no
 * order explains it yet, ask the order-sync sidecar to fetch that shop's latest orders.
 *
 * Fire-and-forget, signed with the ingest secret, debounced per shop, and a no-op unless
 * ORDER_SYNC_TRIGGER_URL is configured. It never blocks or fails the ingest pipeline.
 */
export interface OrderSyncTriggerOptions {
  url?: string;
  secret?: string;
  /** Minimum gap between two requests for the same shop. */
  debounceMs?: number;
  /** Only charges newer than this trigger a fetch (statement back-fills do not). */
  freshnessMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export interface ShopChargeEvent {
  shop: Shop;
  transactionId: string;
  timestamp: number;
  amountCents: number;
}

export class OrderSyncTrigger {
  private readonly lastSent = new Map<Shop, number>();
  private readonly debounceMs: number;
  private readonly freshnessMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OrderSyncTriggerOptions = {}) {
    this.debounceMs = options.debounceMs ?? 10 * 60 * 1000;
    this.freshnessMs = options.freshnessMs ?? 3 * 24 * 60 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get enabled(): boolean {
    return Boolean(this.options.url && this.options.secret);
  }

  /** Returns true when a request was sent (or queued to send). */
  request(event: ShopChargeEvent): boolean {
    if (!this.enabled) return false;
    const now = this.now();
    if (now - event.timestamp > this.freshnessMs) return false;
    const last = this.lastSent.get(event.shop);
    if (last != null && now - last < this.debounceMs) return false;
    this.lastSent.set(event.shop, now);
    const body = JSON.stringify({ shop: event.shop, reason: 'charge', at: event.timestamp });
    const signature = createHmac('sha256', this.options.secret!).update(body).digest('hex');
    void this.fetchImpl(this.options.url!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OE-Signature': signature },
      body,
      signal: AbortSignal.timeout(5000),
    }).then((response) => {
      if (!response.ok) logger.warn('Order sync trigger rejected', { shop: event.shop, status: response.status });
    }).catch((error: unknown) => {
      logger.warn('Order sync trigger failed', { shop: event.shop, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }
}
