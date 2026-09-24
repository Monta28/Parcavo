'use client';

import Link from 'next/link';
import {
  MEASUREMENT_KIND_LABELS,
  READING_CONTEXT_LABELS,
  READING_SOURCE_LABELS,
} from '@parc-auto/contracts';
import { useSession } from '@/components/layout/session-context';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime, formatKm } from '@/lib/format';
import type { ReadingView } from '@/lib/odometer-types';
import type { ReadingDecision } from './reading-dialogs';
import {
  AttachmentLink,
  channelLabel,
  ReadingDetails,
  ReadingStatusBadge,
} from './reading-display';
import { readingKmLabel, useScopeChecks } from './reading-helpers';

/**
 * Tableau de relevés (historique, file de validation, dossier véhicule). Les actions ne sont proposées
 * que si la permission est détenue sur la société du relevé ; l'API contrôle toujours.
 */
export function ReadingsTable({
  items,
  showVehicle,
  onDecide,
  onCorrect,
  caption,
}: {
  items: ReadingView[];
  showVehicle: boolean;
  onDecide?: (decision: NonNullable<ReadingDecision>) => void;
  onCorrect?: (reading: ReadingView) => void;
  caption: string;
}) {
  const session = useSession();
  const { can } = useScopeChecks();
  const withActions = Boolean(onDecide || onCorrect);

  return (
    <Table>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          <TableHead>Observé le</TableHead>
          {showVehicle ? <TableHead>Véhicule</TableHead> : null}
          <TableHead>Valeur lue</TableHead>
          <TableHead>Cumul véhicule</TableHead>
          <TableHead>Source et contexte</TableHead>
          <TableHead>Statut</TableHead>
          <TableHead>Saisie</TableHead>
          <TableHead className="min-w-56">Motifs et notes</TableHead>
          <TableHead>Photo</TableHead>
          {withActions ? <TableHead>Actions</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((r) => {
          const canApprove =
            r.status === 'EN_ATTENTE' &&
            onDecide !== undefined &&
            can(r.companyId, 'readings.approve');
          const canCorrect =
            r.status === 'ACCEPTE' &&
            !r.isEstimate &&
            onCorrect !== undefined &&
            can(r.companyId, 'readings.correct');
          const channel = channelLabel(r.channel);
          return (
            <TableRow
              key={r.id}
              className={
                r.status === 'REMPLACE' || r.status === 'REJETE'
                  ? 'text-muted-foreground'
                  : undefined
              }
            >
              <TableCell className="whitespace-nowrap">
                {formatDateTime(r.observedAt, session.timezone)}
              </TableCell>
              {showVehicle ? (
                <TableCell>
                  <Link
                    href={`/vehicules/${r.vehicleId}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {r.vehicleCode}
                  </Link>
                </TableCell>
              ) : null}
              <TableCell className="whitespace-nowrap font-medium">
                {readingKmLabel(r)}
                <span className="block text-xs font-normal text-muted-foreground">
                  Compteur n° {r.segmentSequence}
                </span>
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {r.isEstimate ? 'Estimation' : formatKm(r.cumulativeKm)}
              </TableCell>
              <TableCell>
                {READING_SOURCE_LABELS[r.source] ?? r.source}
                {channel ? ` (${channel})` : ''}
                <span className="block text-xs text-muted-foreground">
                  {READING_CONTEXT_LABELS[r.context as keyof typeof READING_CONTEXT_LABELS] ??
                    r.context}{' '}
                  · {MEASUREMENT_KIND_LABELS[r.measurementKind] ?? r.measurementKind}
                </span>
              </TableCell>
              <TableCell>
                <ReadingStatusBadge status={r.status} />
              </TableCell>
              <TableCell>
                {r.authorName ?? '—'}
                <span className="block text-xs text-muted-foreground">
                  le {formatDateTime(r.enteredAt, session.timezone)}
                </span>
              </TableCell>
              <TableCell className="text-sm whitespace-normal">
                <ReadingDetails reading={r} />
              </TableCell>
              <TableCell>
                {r.attachmentId ? (
                  <AttachmentLink id={r.attachmentId} label="Voir la photo" />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              {withActions ? (
                <TableCell>
                  <div className="flex flex-wrap gap-2">
                    {canApprove ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => onDecide?.({ reading: r, mode: 'approve' })}
                        >
                          Valider
                          <span className="sr-only">
                            {' '}
                            le relevé {r.vehicleCode} du{' '}
                            {formatDateTime(r.observedAt, session.timezone)}
                          </span>
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => onDecide?.({ reading: r, mode: 'reject' })}
                        >
                          Rejeter
                          <span className="sr-only">
                            {' '}
                            le relevé {r.vehicleCode} du{' '}
                            {formatDateTime(r.observedAt, session.timezone)}
                          </span>
                        </Button>
                      </>
                    ) : null}
                    {canCorrect ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => onCorrect?.(r)}
                      >
                        Corriger
                        <span className="sr-only">
                          {' '}
                          le relevé {r.vehicleCode} du{' '}
                          {formatDateTime(r.observedAt, session.timezone)}
                        </span>
                      </Button>
                    ) : null}
                    {!canApprove && !canCorrect ? (
                      <span className="text-muted-foreground">—</span>
                    ) : null}
                  </div>
                </TableCell>
              ) : null}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
