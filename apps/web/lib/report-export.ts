'use client';

import { ApiRequestError } from './api-error';
import type { ApiError } from './api-types';
import { fileNameFromDisposition } from './report-format';
import type { ExportAccepted } from './reports-types';

/** Issue d'une demande d'export : fichier téléchargé (synchrone) ou export différé à suivre (202). */
export type ExportOutcome = { kind: 'file'; fileName: string } | ({ kind: 'job' } & ExportAccepted);

const API_PREFIX = '/api/v1/';

/**
 * Appel GET d'un fichier de l'API (même origine, cookies de session) : une réponse 200 est enregistrée
 * sous le nom annoncé par l'API ; une réponse 202 (export différé) est renvoyée telle quelle ; une erreur
 * est levée avec le message français de l'API (403 droits, 404 hors périmètre, 409 pas prêt, 410 expiré…).
 */
export async function fetchFile(path: string, fallbackName: string): Promise<ExportOutcome> {
  if (!path.startsWith(API_PREFIX)) throw new ApiRequestError(400, { code: 'CHEMIN_INVALIDE', message: 'Chemin de téléchargement invalide.' });
  let response: Response;
  try {
    response = await fetch(path, { method: 'GET', credentials: 'same-origin', headers: { Accept: 'text/csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/json' } });
  } catch {
    throw new ApiRequestError(0, null);
  }
  if (response.status === 202) {
    const body = (await response.json()) as ExportAccepted;
    return { kind: 'job', ...body };
  }
  if (!response.ok) {
    if (response.status === 401 && !window.location.pathname.startsWith('/login')) {
      // Session morte (compte désactivé, session expirée — T32) : même conduite que le client api().
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/login?expire=1&suite=${encodeURIComponent(window.location.pathname)}`);
    }
    let parsed: Partial<ApiError> | null = null;
    try {
      parsed = (await response.json()) as Partial<ApiError>;
    } catch {
      parsed = null;
    }
    throw new ApiRequestError(response.status, parsed);
  }
  const blob = await response.blob();
  const fileName = fileNameFromDisposition(response.headers.get('Content-Disposition'), fallbackName);
  saveBlob(blob, fileName);
  return { kind: 'file', fileName };
}

/** Enregistrement local d'un fichier reçu (lien temporaire libéré après le clic). */
function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
