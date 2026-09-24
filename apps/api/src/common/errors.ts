import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Erreurs métier structurées (CDC 15.1) : code stable, message français, erreurs de champ
 * facultatives. Le requestId est ajouté par le filtre d'exception global.
 */
export type FieldErrors = Record<string, string[]>;

export interface ErrorBody {
  code: string;
  message: string;
  fieldErrors?: FieldErrors;
  details?: Record<string, unknown>;
}

export class AppError extends HttpException {
  readonly code: string;
  readonly fieldErrors: FieldErrors | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: HttpStatus, code: string, message: string, options?: { fieldErrors?: FieldErrors; details?: Record<string, unknown> }) {
    super({ code, message, fieldErrors: options?.fieldErrors, details: options?.details } satisfies ErrorBody, status);
    this.code = code;
    this.fieldErrors = options?.fieldErrors;
    this.details = options?.details;
  }
}

/** 401 : aucune session valide. */
export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentification requise.') {
    super(HttpStatus.UNAUTHORIZED, 'NON_AUTHENTIFIE', message);
  }
}

/** 403 : action interdite pour un objet pourtant visible. */
export class ForbiddenActionError extends AppError {
  constructor(message = 'Action interdite.', details?: Record<string, unknown>) {
    super(HttpStatus.FORBIDDEN, 'ACTION_INTERDITE', message, { details });
  }
}

/** 404 : objet introuvable ou hors périmètre (jamais révéler l'existence, CDC 15.1). */
export class NotFoundOrOutOfScopeError extends AppError {
  constructor(objectLabel = 'Objet') {
    super(HttpStatus.NOT_FOUND, 'INTROUVABLE', `${objectLabel} introuvable.`);
  }
}

/** 409 : conflit d'état ou de concurrence (verrou optimiste, contrainte en base, idempotence). */
export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(HttpStatus.CONFLICT, code, message, { details });
  }
}

/** 422 : règle métier non respectée. */
export class BusinessRuleError extends AppError {
  constructor(code: string, message: string, options?: { fieldErrors?: FieldErrors; details?: Record<string, unknown> }) {
    super(HttpStatus.UNPROCESSABLE_ENTITY, code, message, options);
  }
}

/** 429 : limitation de débit. */
export class RateLimitedError extends AppError {
  constructor(message = 'Trop de tentatives, veuillez réessayer plus tard.') {
    super(HttpStatus.TOO_MANY_REQUESTS, 'LIMITE_DEBIT', message);
  }
}

export class ValidationFailedError extends AppError {
  constructor(fieldErrors: FieldErrors) {
    super(HttpStatus.UNPROCESSABLE_ENTITY, 'VALIDATION', 'Certains champs sont invalides.', { fieldErrors });
  }
}

export const ErrorCodes = {
  VERSION_OBSOLETE: 'VERSION_OBSOLETE',
  IDEMPOTENCE_CORPS_DIFFERENT: 'IDEMPOTENCE_CORPS_DIFFERENT',
  IDEMPOTENCE_EN_COURS: 'IDEMPOTENCE_EN_COURS',
  CONCURRENCE: 'CONCURRENCE',
  VEHICULE_DEJA_EN_UTILISATION: 'VEHICULE_DEJA_EN_UTILISATION',
  CONDUCTEUR_DEJA_EN_UTILISATION: 'CONDUCTEUR_DEJA_EN_UTILISATION',
  RESERVATION_CHEVAUCHEMENT: 'RESERVATION_CHEVAUCHEMENT',
  /** Départ ou prolongation chevauchant la réservation CONFIRMEE d'un autre conducteur ou véhicule (D-140). */
  RESERVATION_CONFLIT: 'RESERVATION_CONFLIT',
} as const;
