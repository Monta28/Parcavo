import type { NextFunction, Request, Response } from 'express';

/** Requête dont le corps brut a été conservé tel que reçu (octets signés par le fournisseur). */
export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
  requestId?: string;
}

/**
 * Lecture bornée du corps brut des lots webhook (D-298, R-14.4-X01), montée avant les analyseurs JSON
 * globaux : la signature porte sur les octets exacts reçus, jamais sur un JSON re-sérialisé. Au-delà de
 * la limite (Content-Length annoncé ou octets effectivement reçus), la lecture s'arrête et la réponse est
 * 413 structurée, sans rien conserver ni journaliser du contenu.
 */
export function webhookRawBodyMiddleware(limitBytes: number) {
  return (req: RawBodyRequest, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST') {
      next();
      return;
    }
    const tooLarge = (): void => {
      if (res.headersSent) return;
      res.setHeader('Connection', 'close');
      res.status(413).json({ code: 'CONTENU_TROP_VOLUMINEUX', message: `Lot trop volumineux : ${limitBytes} octets au plus par requête ; découpez l’envoi.`, requestId: req.requestId ?? 'inconnu' });
    };
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limitBytes) {
      // Le reste du corps est lu et jeté (jamais conservé) ; la connexion est fermée après la réponse.
      req.resume();
      tooLarge();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limitBytes) {
        done = true;
        chunks.length = 0;
        tooLarge();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      req.rawBody = Buffer.concat(chunks);
      next();
    });
    req.on('error', (error) => {
      if (done) return;
      done = true;
      next(error);
    });
  };
}
