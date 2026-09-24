import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Identifiant de requête (CDC 15.1) : généré côté serveur, renvoyé dans l'en-tête X-Request-Id. */
export function requestIdMiddleware(req: Request & { requestId?: string }, res: Response, next: NextFunction): void {
  const id = randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
