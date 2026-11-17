import { AsyncLocalStorage } from 'node:async_hooks';

export const DEFAULT_HOUSEHOLD_ID = 'hh-1';

const householdAls = new AsyncLocalStorage<string>();

export function runWithHousehold<T>(householdId: string, fn: () => T): T {
  return householdAls.run(householdId, fn);
}

export async function runWithHouseholdAsync<T>(householdId: string, fn: () => Promise<T>): Promise<T> {
  return householdAls.run(householdId, fn);
}

export function currentHouseholdId(): string {
  return householdAls.getStore() ?? DEFAULT_HOUSEHOLD_ID;
}

/** Bind this as `household_id` on every tenant query. */
export function hh(): string {
  return currentHouseholdId();
}

export const TENANT_TABLES = [
  'raw_documents',
  'observations',
  'accounts',
  'transactions',
  'statement_periods',
  'merchant_rules',
  'envelopes',
  'budget_allocations',
  'adapter_configs',
  'review_queue',
  'merchant_normalizations',
  'pipeline_runs',
  'stage_runs',
  'merchant_memory',
  'category_exemplars',
  'household_members',
  'review_undos',
  'location_devices',
  'location_points',
  'place_visits',
  'member_calendar_feeds',
  'calendar_events',
  'orders',
  'order_items',
  'context_links',
  'spent_attributions',
  'push_subscriptions',
  'ingest_mailboxes',
  'inbound_mail',
  'extension_tokens',
  'payee_notes',
  'ingest_hooks',
  'ingest_hook_events',
] as const;

export type TenantTable = (typeof TENANT_TABLES)[number];
