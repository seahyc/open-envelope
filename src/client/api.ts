export type ApiErrorKind = 'session' | 'offline' | 'server';

export class ApiClientError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;

  constructor(kind: ApiErrorKind, message: string, status = 0) {
    super(message);
    this.name = 'ApiClientError';
    this.kind = kind;
    this.status = status;
  }
}

type Handlers = {
  onSession?: () => void;
  onOffline?: (offline: boolean) => void;
};

let handlers: Handlers = {};

export function setApiHandlers(next: Handlers): void {
  handlers = next;
}

function isHtml(contentType: string): boolean {
  return contentType.includes('text/html');
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    handlers.onOffline?.(true);
    throw new ApiClientError('offline', 'Offline. Showing what we had.', 0);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    handlers.onOffline?.(true);
    throw new ApiClientError('offline', 'Offline. Showing what we had.', 0);
  }

  handlers.onOffline?.(false);
  const contentType = response.headers.get('content-type') || '';

  if (response.status === 401 || response.status === 403 || isHtml(contentType)) {
    handlers.onSession?.();
    throw new ApiClientError('session', 'Your session napped. Sign in again — your edit is saved.', response.status);
  }

  if (!response.ok) {
    let message = `Couldn't load (${response.status}). Nothing was saved.`;
    if (contentType.includes('application/json')) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (body.error) message = `${body.error} (${response.status}). Nothing was saved.`;
    }
    const error = new ApiClientError('server', message, response.status);
    if (response.status === 409) {
      error.message = 'Already resolved.';
    }
    throw error;
  }

  if (!contentType.includes('application/json')) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export function apiPost<T>(url: string, body: unknown): Promise<T> {
  return api<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
