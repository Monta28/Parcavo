import { SetMetadata, applyDecorators } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'parc-auto:public';
export const SKIP_CSRF_KEY = 'parc-auto:skip-csrf';
export const SIGNED_WEBHOOK_KEY = 'parc-auto:signed-webhook';

/** Route accessible sans session (connexion, santé, réinitialisation). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Route de mutation exemptée du jeton CSRF (avant l'existence d'une session) ; le contrôle d'origine reste appliqué. */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF_KEY, true);

/**
 * Point de réception serveur à serveur authentifié par signature HMAC du corps (webhook fournisseur,
 * D-298) : aucune session ni cookie n'y est lu, donc ni contrôle d'origine ni jeton CSRF (la requête
 * n'est jamais authentifiée par un cookie du navigateur). La signature est vérifiée par le service.
 */
export const SignedWebhook = () => applyDecorators(SetMetadata(IS_PUBLIC_KEY, true), SetMetadata(SIGNED_WEBHOOK_KEY, true));
