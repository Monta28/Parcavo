import type { ApiError } from './api-types';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors: Record<string, string[]>;
  readonly details: Record<string, unknown> | undefined;
  readonly requestId: string | undefined;

  constructor(status: number, body: Partial<ApiError> | null) {
    super(body?.message ?? messageForStatus(status));
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body?.code ?? `HTTP_${status}`;
    this.fieldErrors = body?.fieldErrors ?? {};
    this.details = body?.details;
    this.requestId = body?.requestId;
  }
}

export function messageForStatus(status: number): string {
  switch (status) {
    case 401:
      return 'Votre session a expiré. Reconnectez-vous.';
    case 403:
      return 'Action non autorisée.';
    case 404:
      return 'Élément introuvable ou hors de votre périmètre.';
    case 409:
      return 'Conflit : les données ont changé entre-temps.';
    case 422:
      return 'Certaines valeurs sont invalides.';
    case 429:
      return 'Trop de requêtes, réessayez dans un instant.';
    case 0:
      return 'Impossible de joindre le serveur. Vérifiez votre connexion : rien n’a été enregistré.';
    default:
      return 'Une erreur est survenue.';
  }
}

export function isApiError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError;
}
