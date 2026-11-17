export type Route =
  | 'home'
  | 'review'
  | 'budget'
  | 'ledger'
  | 'accounts'
  | 'import'
  | 'reconcile'
  | 'pipeline'
  | 'connections'
  | 'household';

export function routeFromPath(pathname: string): Route {
  const path = pathname.replace(/\/$/, '') || '/';
  switch (path) {
    case '/review':
      return 'review';
    case '/budget':
      return 'budget';
    case '/ledger':
    case '/transactions':
      return 'ledger';
    case '/accounts':
      return 'accounts';
    case '/import':
      return 'import';
    case '/reconcile':
      return 'reconcile';
    case '/pipeline':
      return 'pipeline';
    case '/settings':
    case '/settings/connections':
    case '/connections':
      return 'connections';
    case '/household':
    case '/settings/household':
      return 'household';
    default:
      return 'home';
  }
}

export function pathFromRoute(route: Route): string {
  if (route === 'home') return '/';
  if (route === 'ledger') return '/ledger';
  if (route === 'connections') return '/settings/connections';
  if (route === 'household') return '/household';
  return `/${route}`;
}
