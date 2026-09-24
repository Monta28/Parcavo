import { ApiHeader } from '@nestjs/swagger';
import { applyDecorators, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { BusinessRuleError } from './errors.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Documente l'en-tête Idempotency-Key dans OpenAPI. */
export function ApiIdempotent(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiHeader({
      name: 'Idempotency-Key',
      required: false,
      description: 'Clé d’idempotence (UUID recommandé) ; peut aussi être fournie dans le corps (idempotencyKey).',
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
