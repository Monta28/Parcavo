import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'parc-auto:public';
export const SKIP_CSRF_KEY = 'parc-auto:skip-csrf';

/** Route accessible sans session (connexion, santé, réinitialisation). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Route de mutation exemptée du jeton CSRF (avant l'existence d'une session) ; le contrôle d'origine reste appliqué. */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF_KEY, true);
