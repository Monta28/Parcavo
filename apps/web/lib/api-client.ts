'use client';

import { ApiRequestError } from './api-error';

/**
 * Client HTTP navigateur : appels relatifs à /api/v1 (même origine, relayés vers l'API), cookies de
 * session envoyés automatiquement, jeton CSRF lu dans le cookie pa_csrf et renvoyé en en-tête.
 * Aucun jeton n'est stocké dans localStorage.
 */
function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  formData?: FormData;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    const csrf = readCookie('pa_csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  let body: BodyInit | undefined;
  if (options.formData) {
    body = options.formData;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, { method, headers, body, credentials: 'same-origin', signal: options.signal });
  } catch {
    throw new ApiRequestError(0, null);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      // Rechargement complet volontaire : la session est morte, l'état client doit être abandonné.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/login?expire=1&suite=${encodeURIComponent(window.location.pathname)}`);
    }
    throw new ApiRequestError(response.status, parsed as Partial<import('./api-types').ApiError> | null);
  }
  return parsed as T;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function toQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}
