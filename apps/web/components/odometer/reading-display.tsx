'use client';

import Link from 'next/link';
import {
  FRESHNESS_LABELS,
  READING_STATUS_LABELS,
  TELEMETRY_CHANNEL_LABELS,
} from '@parc-auto/contracts';
import { StatusBadge, toneForFreshness } from '@/components/status-badge';
import { isApiError } from '@/lib/api-error';
import { formatKm } from '@/lib/format';
import type { FreshnessStatus, ReadingView } from '@/lib/odometer-types';
import { dependentsFromDetails, toneForReading } from './reading-helpers';

export function ReadingStatusBadge({ status }: { status: string }) {
  return (
    <StatusBadge
      label={READING_STATUS_LABELS[status as keyof typeof READING_STATUS_LABELS] ?? status}
      tone={toneForReading(status)}
    />
  );
}

/** Fraîcheur calculée par l'API (INCONNU, A_ACTUALISER, A_JOUR), toujours accompagnée de son libellé. */
export function FreshnessBadge({
  freshness,
  ageDays,
  prefix = 'Kilométrage',
}: {
  freshness: FreshnessStatus;
  ageDays: number | null;
  prefix?: string;
}) {
  return (
    <StatusBadge
      label={`${prefix} : ${FRESHNESS_LABELS[freshness]}${ageDays !== null ? ` (${ageDays} j)` : ''}`}
      tone={toneForFreshness(freshness)}
    />
  );
}

/** Lien de téléchargement privé d'une pièce jointe (contrôle d'accès par l'API). */
export function AttachmentLink({ id, label }: { id: string; label: string }) {
  return (
    <a
      href={`/api/v1/attachments/${id}/download`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-4"
    >
      {label}
      <span className="sr-only"> (ouvre un nouvel onglet)</span>
    </a>
  );
}

/** Canal télématique éventuel, affiché après la source. */
export function channelLabel(channel: string | null): string | null {
  if (!channel) return null;
  return TELEMETRY_CHANNEL_LABELS[channel as keyof typeof TELEMETRY_CHANNEL_LABELS] ?? channel;
}

/** Motifs et commentaires portés par le relevé (attente, rejet, correction, validation, note). */
export function ReadingDetails({ reading }: { reading: ReadingView }) {
  const lines: Array<{ key: string; label: string; value: string }> = [];
  if (reading.status === 'EN_ATTENTE' && reading.statusReason)
    lines.push({ key: 'attente', label: 'Motif d’attente', value: reading.statusReason });
  if (reading.status === 'REJETE' && reading.decisionReason)
    lines.push({ key: 'rejet', label: 'Motif du rejet', value: reading.decisionReason });
  if (reading.status === 'REMPLACE')
    lines.push({
      key: 'remplace',
      label: 'Remplacé',
      value: reading.decisionReason
        ? `corrigé (motif : ${reading.decisionReason})`
        : 'corrigé par un nouveau relevé',
    });
  if (reading.replacesReadingId && reading.correctionReason)
    lines.push({ key: 'correction', label: 'Relevé corrigé', value: reading.correctionReason });
  if (reading.status === 'ACCEPTE' && reading.decisionReason)
    lines.push({
      key: 'validation',
      label: 'Commentaire de validation',
      value: reading.decisionReason,
    });
  if (reading.status !== 'EN_ATTENTE' && reading.statusReason)
    lines.push({ key: 'anomalie', label: 'Anomalie signalée', value: reading.statusReason });
  if (reading.isEstimate && reading.gpsDistanceKm)
    lines.push({ key: 'gps', label: 'Distance GPS brute', value: formatKm(reading.gpsDistanceKm) });
  if (reading.note) lines.push({ key: 'note', label: 'Note', value: reading.note });
  if (lines.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <ul className="space-y-0.5">
      {lines.map((l) => (
        <li key={l.key}>
          <span className="text-muted-foreground">{l.label} : </span>
          {l.value}
        </li>
      ))}
      {reading.status === 'EN_ATTENTE' && reading.anomalyCode ? (
        <li className="text-xs text-muted-foreground">Code : {reading.anomalyCode}</li>
      ) : null}
    </ul>
  );
}

/** Erreur d'envoi affichée dans le formulaire : message métier de l'API, dépendances bloquantes et référence. */
export function FormErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const apiError = isApiError(error) ? error : null;
  const dependents = dependentsFromDetails(apiError?.details);
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
    >
      <p className="text-destructive">
        {apiError
          ? apiError.message
          : error instanceof Error
            ? error.message
            : 'Une erreur est survenue.'}
      </p>
      {apiError?.status === 0 ? (
        <p className="mt-1 text-muted-foreground">
          Relancez l’envoi une fois la connexion rétablie.
        </p>
      ) : null}
      {dependents.length > 0 ? (
        <div className="mt-2">
          <p className="font-medium">Éléments rattachés à ce relevé :</p>
          <ul className="list-disc space-y-1 pl-5">
            {dependents.map((d) => (
              <li key={`${d.type}-${d.id}`}>
                {d.type === 'utilisation' ? (
                  <Link href={`/utilisations/${d.id}`} className="underline underline-offset-4">
                    Utilisation {d.id.slice(0, 8)}
                  </Link>
                ) : d.type === 'intervention' ? (
                  <Link href={`/interventions/${d.id}`} className="underline underline-offset-4">
                    Intervention {d.id.slice(0, 8)}
                  </Link>
                ) : (
                  <span>
                    {d.type === 'plein' ? 'Plein' : d.type} {d.id.slice(0, 8)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {apiError?.requestId ? (
        <p className="mt-1 text-xs text-muted-foreground">Référence : {apiError.requestId}</p>
      ) : null}
    </div>
  );
}
