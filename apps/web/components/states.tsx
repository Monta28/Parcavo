import { AlertCircle, Inbox, Loader2, Lock } from 'lucide-react';
import { isApiError } from '@/lib/api-error';

/** États obligatoires des listes (CDC 10.1) : chargement, vide, erreur, accès refusé. */
export function LoadingState({ label = 'Chargement…' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" /> {label}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center">
      <Inbox className="size-6 text-muted-foreground" aria-hidden="true" />
      <p className="font-medium">{title}</p>
      {description ? <p className="max-w-md text-sm text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const forbidden = isApiError(error) && (error.status === 403 || error.status === 404);
  const message = isApiError(error) ? error.message : 'Une erreur est survenue.';
  return (
    <div role="alert" className="flex flex-col items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 py-10 text-center">
      {forbidden ? <Lock className="size-6 text-muted-foreground" aria-hidden="true" /> : <AlertCircle className="size-6 text-destructive" aria-hidden="true" />}
      <p className="font-medium">{forbidden ? 'Accès refusé ou élément hors de votre périmètre' : 'Erreur'}</p>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      {isApiError(error) && error.requestId ? <p className="text-xs text-muted-foreground">Référence : {error.requestId}</p> : null}
      {retry ? (
        <button type="button" onClick={retry} className="text-sm underline underline-offset-4">
          Réessayer
        </button>
      ) : null}
    </div>
  );
}
