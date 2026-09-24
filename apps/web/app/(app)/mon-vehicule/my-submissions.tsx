'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { READING_CONTEXT_LABELS } from '@parc-auto/contracts';
import { useSession } from '@/components/layout/session-context';
import { AttachmentLink, ReadingStatusBadge } from '@/components/odometer/reading-display';
import { readingKmLabel } from '@/components/odometer/reading-helpers';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import type { ReadingView } from '@/lib/odometer-types';

/**
 * « Mes soumissions » (CDC 10.3, D-153) : relevés dont l'utilisateur est l'auteur, avec leur statut et le
 * motif de rejet. Pour un compte conducteur, l'API ne renvoie que les siens ; pour un membre du personnel
 * qui dispose aussi d'une fiche conducteur, le filtre mine=true restreint la liste à ses propres saisies.
 */
export function MySubmissions() {
  const session = useSession();
  const ownOnly = session.isDriverOnly;
  const [page, setPage] = useState(1);
  const query = toQuery({ mine: ownOnly ? undefined : 'true', order: 'desc', page, pageSize: 10 });
  const readings = useQuery({ queryKey: ['readings', 'mon-vehicule', query], queryFn: () => api<Page<ReadingView>>(`/readings${query}`) });
  const title = 'Mes soumissions';

  return (
    <section aria-labelledby="submissions-title" className="space-y-3">
      <div>
        <h2 id="submissions-title" className="text-lg font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">Statut de chaque relevé : en attente de validation, accepté ou rejeté avec son motif.</p>
      </div>
      {readings.isPending ? (
        <LoadingState label="Chargement des relevés…" />
      ) : readings.isError ? (
        <ErrorState error={readings.error} retry={() => void readings.refetch()} />
      ) : readings.data.total === 0 ? (
        <EmptyState title="Aucune soumission" description="Les kilométrages que vous envoyez apparaîtront ici avec leur statut." />
      ) : (
        <div>
          <ul className="space-y-2">
            {readings.data.items.map((r) => (
              <li key={r.id} className="rounded-lg border p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-base font-semibold">{readingKmLabel(r)}</p>
                    <p className="text-muted-foreground">
                      {r.vehicleCode} · relevé du {formatDateTime(r.observedAt, session.timezone)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {READING_CONTEXT_LABELS[r.context as keyof typeof READING_CONTEXT_LABELS] ?? r.context} · saisi le {formatDateTime(r.enteredAt, session.timezone)}
                      {!ownOnly && r.authorName ? ` par ${r.authorName}` : ''}
                    </p>
                  </div>
                  <ReadingStatusBadge status={r.status} />
                </div>
                <SubmissionOutcome reading={r} timezone={session.timezone} />
                {r.attachmentId ? (
                  <p className="mt-2">
                    <AttachmentLink id={r.attachmentId} label="Voir la photo du compteur" />
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <PaginationControls page={readings.data.page} pageSize={readings.data.pageSize} total={readings.data.total} onPageChange={setPage} />
        </div>
      )}
    </section>
  );
}

/** Explication du statut fourni par l'API, avec le motif de décision éventuel. */
function SubmissionOutcome({ reading: r, timezone }: { reading: ReadingView; timezone: string }) {
  switch (r.status) {
    case 'EN_ATTENTE':
      return (
        <div className="mt-2 space-y-0.5">
          <p>En attente de validation par le gestionnaire du parc.</p>
          {r.statusReason ? <p className="text-muted-foreground">Motif d’attente : {r.statusReason}</p> : null}
        </div>
      );
    case 'ACCEPTE':
      return (
        <div className="mt-2 space-y-0.5">
          <p>Accepté{r.decidedAt ? ` le ${formatDateTime(r.decidedAt, timezone)}` : ''}.</p>
          {r.decisionReason ? <p className="text-muted-foreground">Commentaire : {r.decisionReason}</p> : null}
        </div>
      );
    case 'REJETE':
      return (
        <div className="mt-2 space-y-0.5">
          <p className="text-destructive">Refusé{r.decidedAt ? ` le ${formatDateTime(r.decidedAt, timezone)}` : ''}.</p>
          <p>
            <span className="text-muted-foreground">Motif du rejet : </span>
            {r.decisionReason ?? r.statusReason ?? 'non communiqué'}
          </p>
        </div>
      );
    case 'REMPLACE':
      return (
        <div className="mt-2 space-y-0.5">
          <p>Corrigé par le gestionnaire du parc : une nouvelle valeur remplace ce relevé.</p>
          {r.decisionReason ? <p className="text-muted-foreground">Motif : {r.decisionReason}</p> : null}
        </div>
      );
    default:
      return null;
  }
}
