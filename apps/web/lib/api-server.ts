import 'server-only';
import { cookies } from 'next/headers';
import { ApiRequestError } from './api-error';
import type { SessionInfo } from './api-types';

/**
 * Appels API depuis les composants serveur : le cookie de session est relayé tel quel vers l'API
 * interne (API_INTERNAL_URL). Lecture seule : les mutations passent par le navigateur (CSRF).
 */
function apiOrigin(): string {
  return process.env.API_INTERNAL_URL ?? 'http://localhost:3001';
}

export async function apiServer<T>(path: string): Promise<T> {
  const jar = await cookies();
  const session = jar.get('pa_session')?.value;
  const response = await fetch(`${apiOrigin()}/api/v1${path}`, {
    headers: { Accept: 'application/json', ...(session ? { Cookie: `pa_session=${session}` } : {}) },
    cache: 'no-store',
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) throw new ApiRequestError(response.status, parsed as Partial<import('./api-types').ApiError> | null);
  return parsed as T;
}

/** Session courante ou null (jamais d'exception pour un simple 401). */
export async function getSession(): Promise<SessionInfo | null> {
  try {
    return await apiServer<SessionInfo>('/auth/session');
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) return null;
    if (error instanceof TypeError) return null;
    throw error;
  }
}
