import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { RequestMemo } from './request-memo.js';

/**
 * Ouvre la mémoire propre à la requête HTTP (RequestMemo) autour du traitement de la route : services,
 * transactions et actions après validation de la requête y partagent les valeurs de référence déjà lues.
 */
@Injectable()
export class RequestMemoInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return new Observable((subscriber) => RequestMemo.run(() => next.handle().subscribe(subscriber)));
  }
}
