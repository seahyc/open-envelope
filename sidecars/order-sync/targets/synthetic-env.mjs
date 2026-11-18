// Loader shim so the daemon can run the synthetic target: ORDER_SYNC_SHOPS=synthetic-env.
import { syntheticTarget } from './synthetic.mjs';

export function createTarget(env) {
  if (!env.ORDER_SYNC_SYNTHETIC_ORIGIN) throw new Error('ORDER_SYNC_SYNTHETIC_ORIGIN is required');
  return syntheticTarget(env.ORDER_SYNC_SYNTHETIC_ORIGIN);
}
