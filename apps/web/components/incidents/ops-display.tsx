'use client';

import { isApiError } from '@/lib/api-error';

/** Erreur globale d'une action : message métier de l'API affiché tel quel, détails et référence de la requête. */
export function ApiErrorAlert({ error, children }: { error: unknown; children?: React.ReactNode }) {
  if (!error) return null;
  const apiError = isApiError(error) ? error : null;
  return (
    <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
      <p className="text-destructive">{apiError ? apiError.message : error instanceof Error ? error.message : 'Une erreur est survenue.'}</p>
      {apiError?.status === 0 ? <p className="mt-1 text-muted-foreground">Vérifiez votre connexion puis relancez l’envoi.</p> : null}
      {children}
      {apiError?.requestId ? <p className="mt-1 text-xs text-muted-foreground">Référence : {apiError.requestId}</p> : null}
    </div>
  );
}

/** Ligne d'une liste de définitions (fiches). */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}
