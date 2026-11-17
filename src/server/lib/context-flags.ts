export type ContextFlag = 'location' | 'calendar' | 'orders' | 'triangulate' | 'webhook';

const ENV_NAMES: Record<ContextFlag, string> = {
  location: 'CONTEXT_LOCATION',
  calendar: 'CONTEXT_CALENDAR',
  orders: 'CONTEXT_ORDERS',
  triangulate: 'CONTEXT_TRIANGULATE',
  webhook: 'CONTEXT_WEBHOOK',
};

export function flagOn(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env[name] || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'on' || value === 'yes';
}

export function contextFlag(flag: ContextFlag, env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(ENV_NAMES[flag], env);
}

export function contextFlags(env: NodeJS.ProcessEnv = process.env): Record<ContextFlag, boolean> {
  return {
    location: contextFlag('location', env),
    calendar: contextFlag('calendar', env),
    orders: contextFlag('orders', env),
    triangulate: contextFlag('triangulate', env),
    webhook: contextFlag('webhook', env),
  };
}
