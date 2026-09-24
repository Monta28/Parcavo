import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '@parc-auto/db';
import { AppError, ErrorCodes, type ErrorBody } from './errors.js';

interface RequestWithId extends Request {
  requestId?: string;
}

/**
 * Filtre global : toute erreur devient une réponse structurée { code, message, fieldErrors?, requestId }
 * (CDC 15.1). Les erreurs internes ne révèlent ni pile ni détail technique.
 */
@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithId>();
    const requestId = request.requestId ?? 'inconnu';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: ErrorBody = { code: 'ERREUR_INTERNE', message: 'Une erreur interne est survenue.' };

    if (exception instanceof AppError) {
      status = exception.getStatus();
      body = { code: exception.code, message: exception.message };
      if (exception.fieldErrors) body.fieldErrors = exception.fieldErrors;
      if (exception.details) body.details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      body = mapNestException(exception, status);
    } else if (isVersionedUpdateMiss(exception)) {
      // Mise à jour conditionnelle where { id, version } sans ligne : modification concurrente (15.3).
      status = HttpStatus.CONFLICT;
      body = { code: ErrorCodes.VERSION_OBSOLETE, message: 'L’objet a été modifié ou supprimé entre-temps. Rechargez puis réessayez.' };
    } else {
      this.logger.error(`requestId=${requestId} ${describe(exception)}`, exception instanceof Error ? exception.stack : undefined);
    }

    if (Number(status) >= 500 && exception instanceof HttpException) {
      this.logger.error(`requestId=${requestId} ${describe(exception)}`);
    }

    response.status(status).json({ ...body, requestId });
  }
}

function describe(exception: unknown): string {
  if (exception instanceof Error) return `${exception.name}: ${exception.message}`;
  return String(exception);
}

function mapNestException(exception: HttpException, status: number): ErrorBody {
  const raw = exception.getResponse();
  const fallback: Record<number, ErrorBody> = {
    400: { code: 'REQUETE_INVALIDE', message: 'Requête invalide.' },
    401: { code: 'NON_AUTHENTIFIE', message: 'Authentification requise.' },
    403: { code: 'ACTION_INTERDITE', message: 'Action interdite.' },
    404: { code: 'INTROUVABLE', message: 'Ressource introuvable.' },
    413: { code: 'CONTENU_TROP_VOLUMINEUX', message: 'Le contenu envoyé dépasse la taille autorisée.' },
    415: { code: 'TYPE_NON_SUPPORTE', message: 'Type de contenu non supporté.' },
    429: { code: 'LIMITE_DEBIT', message: 'Trop de requêtes, veuillez réessayer plus tard.' },
  };
  const base = fallback[status] ?? { code: 'ERREUR_HTTP', message: 'Erreur de traitement de la requête.' };
  if (typeof raw === 'object' && raw !== null && 'code' in raw && typeof (raw as ErrorBody).code === 'string') {
    return raw as ErrorBody;
  }
  void status;
  return base;
}

/** Prisma P2025 : enregistrement à mettre à jour introuvable (clause de version non satisfaite). */
function isVersionedUpdateMiss(exception: unknown): boolean {
  return exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2025';
}
