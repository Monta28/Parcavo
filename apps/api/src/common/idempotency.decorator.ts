import { ApiHeader } from '@nestjs/swagger';
import { applyDecorators, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { BusinessRuleError } from './errors.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Nom documenté de l'en-tête. Les routes qui le lisent avec @Headers() passent ce nom (Nest le met en
 * minuscules pour la lecture) : le paramètre déduit par OpenAPI fusionne alors avec celui d'ApiIdempotent
 * au lieu d'apparaître en double comme obligatoire.
 */
export const IDEMPOTENCY_HEADER_NAME = 'Idempotency-Key';

/**
 * Documente l'en-tête Idempotency-Key dans OpenAPI : obligatoire par défaut (routes qui lisent la clé avec
 * @IdempotencyKey(), 422 sans clé), facultatif pour les routes qui l'acceptent sans l'exiger.
 */
export function ApiIdempotent(options: { required?: boolean } = {}): MethodDecorator & ClassDecorator {
  const required = options.required ?? true;
  return applyDecorators(
    ApiHeader({
      name: IDEMPOTENCY_HEADER_NAME,
      required,
      description: required
        ? 'Clé d’idempotence obligatoire (8 à 128 caractères, UUID recommandé) ; peut aussi être fournie dans le corps (idempotencyKey).'
        : 'Clé d’idempotence facultative (8 à 128 caractères, UUID recommandé) : un nouvel envoi avec la même clé rejoue la réponse initiale.',
    }),
  );
}

/** Lit la clé d'idempotence : en-tête Idempotency-Key ou champ idempotencyKey du corps. */
export const IdempotencyKey = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<Request>();
  const header = req.header(IDEMPOTENCY_HEADER);
  const body = req.body as { idempotencyKey?: unknown } | undefined;
  const fromBody = body && typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined;
  const key = header ?? fromBody;
  if (!key || key.length < 8 || key.length > 128) {
    throw new BusinessRuleError('IDEMPOTENCE_CLE_REQUISE', 'Une clé d’idempotence (8 à 128 caractères) est requise pour cette opération.', {
      fieldErrors: { idempotencyKey: ['Clé requise (8 à 128 caractères).'] },
    });
  }
  return key;
});
