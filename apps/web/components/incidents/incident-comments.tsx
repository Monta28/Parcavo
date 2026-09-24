'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { FieldError } from '@/components/forms/field-error';
import { ApiErrorAlert } from '@/components/incidents/ops-display';
import { type FieldErrors, describedBy, errorsOf, invalid } from '@/components/incidents/ops-helpers';
import { useAppScope } from '@/components/layout/session-context';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import { formatDateTime } from '@/lib/format';
import { COMMENT_VISIBILITY_LABELS, type CommentVisibility, type IncidentCommentView, type IncidentView } from '@/lib/incidents-types';

/**
 * Commentaires chronologiques d'un incident (GET/POST /incidents/:id/comments), jamais modifiés.
 * Le personnel choisit la visibilité (interne par défaut) ; un conducteur ne voit et n'écrit que des
 * commentaires partagés.
 */
export function IncidentComments({ incident, canComment, idPrefix = 'comment' }: { incident: Pick<IncidentView, 'id' | 'status'>; canComment: boolean; idPrefix?: string }) {
  const { session } = useAppScope();
  const queryClient = useQueryClient();
  const driver = session.isDriverOnly;
  const comments = useQuery({ queryKey: ['incident', incident.id, 'comments'], queryFn: () => api<IncidentCommentView[]>(`/incidents/${incident.id}/comments`) });
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<CommentVisibility>('INTERNE');
  const [local, setLocal] = useState<FieldErrors>({});
  const add = useMutation({
    mutationFn: () => api<IncidentCommentView>(`/incidents/${incident.id}/comments`, { method: 'POST', body: { body: body.trim(), visibility: driver ? undefined : visibility } }),
    onSuccess: (created) => {
      toast.success(created.visibility === 'PARTAGE_CONDUCTEUR' ? 'Commentaire ajouté (partagé avec le conducteur).' : 'Commentaire interne ajouté.');
      setBody('');
      queryClient.setQueryData<IncidentCommentView[]>(['incident', incident.id, 'comments'], (list) => [...(list ?? []), created]);
      void queryClient.invalidateQueries({ queryKey: ['incident', incident.id, 'comments'] });
    },
    onError: (error) => toast.error(isApiError(error) ? error.message : 'Commentaire non enregistré.'),
  });
  const errors = { ...errorsOf(add.error), ...local };
  const closed = incident.status === 'CLOTURE';

  return (
    <div className="space-y-4">
      {comments.isPending ? (
        <LoadingState label="Chargement des commentaires…" />
      ) : comments.isError ? (
        <ErrorState error={comments.error} retry={() => void comments.refetch()} />
      ) : comments.data.length === 0 ? (
        <EmptyState title="Aucun commentaire" description={driver ? 'Les réponses du gestionnaire du parc partagées avec vous apparaîtront ici.' : 'Les commentaires et notes de transition apparaîtront ici, dans l’ordre chronologique.'} />
      ) : (
        <ol className="space-y-3">
          {comments.data.map((c) => (
            <li key={c.id} className="rounded-md border p-3 text-sm">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{c.authorName ?? 'Auteur inconnu'}</span>
                <span>·</span>
                <time dateTime={c.createdAt}>{formatDateTime(c.createdAt, session.timezone)}</time>
                {driver ? null : <StatusBadge label={COMMENT_VISIBILITY_LABELS[c.visibility] ?? c.visibility} tone={c.visibility === 'PARTAGE_CONDUCTEUR' ? 'info' : 'neutral'} />}
              </div>
              <p className="whitespace-pre-wrap break-words">{c.body}</p>
            </li>
          ))}
        </ol>
      )}

      {closed ? (
        <p className="text-sm text-muted-foreground">Incident clôturé : les commentaires sont fermés.</p>
      ) : canComment ? (
        <form
          className="space-y-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const next: FieldErrors = {};
            if (!body.trim()) next.body = ['Saisissez un commentaire.'];
            setLocal(next);
            if (Object.keys(next).length === 0) add.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-body`}>{driver ? 'Ajouter un commentaire' : 'Nouveau commentaire'}</Label>
            <Textarea id={`${idPrefix}-body`} rows={3} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} aria-invalid={invalid(errors, 'body')} aria-describedby={describedBy(errors, 'body', `${idPrefix}-hint`)} />
            <p id={`${idPrefix}-hint`} className="text-xs text-muted-foreground">
              {driver ? 'Votre commentaire est visible par le gestionnaire du parc. Il ne pourra pas être modifié.' : 'Un commentaire enregistré ne peut plus être modifié.'}
            </p>
            <FieldError errors={errors} name="body" />
          </div>
          {driver ? null : (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Visibilité</legend>
              <RadioGroup value={visibility} onValueChange={(v) => setVisibility(v as CommentVisibility)} className="flex flex-wrap gap-4">
                {(Object.keys(COMMENT_VISIBILITY_LABELS) as CommentVisibility[]).map((v) => (
                  <div key={v} className="flex items-center gap-2">
                    <RadioGroupItem id={`${idPrefix}-visibility-${v}`} value={v} />
                    <Label htmlFor={`${idPrefix}-visibility-${v}`} className="font-normal">
                      {COMMENT_VISIBILITY_LABELS[v]}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
              <FieldError errors={errors} name="visibility" />
            </fieldset>
          )}
          {add.error && !errors.body ? <ApiErrorAlert error={add.error} /> : null}
          <Button type="submit" disabled={add.isPending}>
            {add.isPending ? 'Envoi…' : 'Publier le commentaire'}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
