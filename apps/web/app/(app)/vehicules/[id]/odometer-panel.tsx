'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import {
  MEASUREMENT_KIND_LABELS,
  READING_SOURCE_LABELS,
  READING_STATUS_LABELS,
} from '@parc-auto/contracts';
import { useRoleIn, useSession } from '@/components/layout/session-context';
import { AddReadingDialog } from '@/components/odometer/add-reading-dialog';
import {
  CorrectReadingDialog,
  ReadingDecisionDialog,
  type ReadingDecision,
} from '@/components/odometer/reading-dialogs';
import { AttachmentLink, FreshnessBadge } from '@/components/odometer/reading-display';
import { readingKmLabel, useScopeChecks } from '@/components/odometer/reading-helpers';
import { ReadingsTable } from '@/components/odometer/readings-table';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { formatDateTime, formatKm } from '@/lib/format';
import type { OdometerCurrentView, ReadingView, SegmentView } from '@/lib/odometer-types';
import { OdometerSegmentDialog, type SegmentMode } from './odometer-segment-dialog';

const ALL = '__all__';

/**
 * Onglet Kilométrage du dossier véhicule (CDC 5.3 à 5.5) : compteur courant et fraîcheur calculés par
 * l'API, segments de compteur, historique de tous les relevés et actions autorisées.
 */
export function OdometerPanel({
  vehicleId,
  companyId,
  canEnter,
}: {
  vehicleId: string;
  companyId: string;
  canEnter: boolean;
}) {
  const session = useSession();
  const { can } = useScopeChecks();
  const canCorrect = can(companyId, 'readings.correct');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [page, setPage] = useState(1);
  const [addOpen, setAddOpen] = useState(false);
  const [segmentMode, setSegmentMode] = useState<SegmentMode | null>(null);
  const [decision, setDecision] = useState<ReadingDecision>(null);
  const [correcting, setCorrecting] = useState<ReadingView | null>(null);

  const current = useQuery({
    queryKey: ['vehicle', vehicleId, 'odometer'],
    queryFn: () => api<OdometerCurrentView>(`/vehicles/${vehicleId}/odometer`),
  });
  const segments = useQuery({
    queryKey: ['vehicle', vehicleId, 'odometer-segments'],
    queryFn: () => api<SegmentView[]>(`/vehicles/${vehicleId}/odometer-segments`),
  });
  const readingsQuery = toQuery({ status, source, page, pageSize: 25 });
  const readings = useQuery({
    queryKey: ['vehicle', vehicleId, 'readings', readingsQuery],
    queryFn: () => api<Page<ReadingView>>(`/vehicles/${vehicleId}/readings${readingsQuery}`),
  });

  const openSegment = segments.data?.find((s) => s.endedAt === null) ?? null;
  const o = current.data;
  // Initialisation explicite (base cumulée, cumul incomplet) : chef de parc et administrateur (D-167).
  const role = useRoleIn(companyId);
  const canInitialize = (role === 'ADMIN' || role === 'CHEF_PARC') && o !== undefined && o.reading === null;
  const canReplace = canCorrect && o !== undefined && o.openSegmentId !== null;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">
              <h2>Compteur courant</h2>
            </CardTitle>
            <CardDescription>
              Dernier relevé accepté selon la date d’observation ; un relevé historique ne fait pas
              reculer le compteur.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {current.isPending ? (
              <LoadingState label="Chargement du compteur…" />
            ) : current.isError ? (
              <ErrorState error={current.error} retry={() => void current.refetch()} />
            ) : (
              <CurrentOdometer
                data={current.data}
                vehicleId={vehicleId}
                timezone={session.timezone}
              />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              <h2>Actions</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {canEnter ? (
              <Button
                type="button"
                onClick={() => setAddOpen(true)}
                disabled={current.isPending || segments.isPending}
              >
                Ajouter un relevé
              </Button>
            ) : null}
            {canInitialize ? (
              <Button type="button" variant="outline" onClick={() => setSegmentMode('INITIAL')}>
                Initialiser le compteur
              </Button>
            ) : null}
            {canReplace ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setSegmentMode('REPLACEMENT')}
                disabled={segments.isPending}
              >
                Remplacement de compteur
              </Button>
            ) : null}
            {!canEnter && !canReplace ? (
              <p className="text-sm text-muted-foreground">
                Consultation seule : votre rôle ne permet pas de saisir de relevé sur ce véhicule.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <h2>Compteurs successifs</h2>
          </CardTitle>
          <CardDescription>
            Le cumul du véhicule est séparé de la valeur physique : chaque remplacement ouvre un
            nouveau compteur à partir du dernier cumul validé.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {segments.isPending ? (
            <LoadingState label="Chargement des compteurs…" />
          ) : segments.isError ? (
            <ErrorState error={segments.error} retry={() => void segments.refetch()} />
          ) : segments.data.length === 0 ? (
            <EmptyState
              title="Compteur non initialisé"
              description="Aucun compteur enregistré : le premier relevé accepté ou une initialisation explicite le crée."
            />
          ) : (
            <div className="rounded-md border">
              <Table>
                <caption className="sr-only">Compteurs successifs du véhicule</caption>
                <TableHeader>
                  <TableRow>
                    <TableHead>N°</TableHead>
                    <TableHead>Période</TableHead>
                    <TableHead>Valeur de départ</TableHead>
                    <TableHead>Cumul de départ</TableHead>
                    <TableHead>Dernière valeur validée</TableHead>
                    <TableHead>Cumul</TableHead>
                    <TableHead className="min-w-48">Motif</TableHead>
                    <TableHead>Justificatif</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {segments.data.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">
                        {s.sequence}
                        {s.endedAt === null ? (
                          <span className="block text-xs text-muted-foreground">en service</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        du {formatDateTime(s.startedAt, session.timezone)}
                        <span className="block">
                          {s.endedAt
                            ? `au ${formatDateTime(s.endedAt, session.timezone)}`
                            : 'à aujourd’hui'}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatKm(s.startPhysicalKm)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatKm(s.startCumulativeKm)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatKm(s.lastPhysicalKm)}
                      </TableCell>
                      <TableCell>
                        {s.cumulativeKnown ? (
                          <StatusBadge label="Connu" tone="success" />
                        ) : (
                          <StatusBadge label="Cumul incomplet" tone="warning" />
                        )}
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        {s.replacementReason ?? '—'}
                      </TableCell>
                      <TableCell>
                        {s.justificationAttachmentId ? (
                          <AttachmentLink
                            id={s.justificationAttachmentId}
                            label="Voir le justificatif"
                          />
                        ) : s.sequence > 1 ? (
                          <span className="text-muted-foreground">Sans justificatif</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <section aria-labelledby="vehicle-readings-title" className="space-y-3">
        <h2 id="vehicle-readings-title" className="text-base font-semibold">
          Historique des relevés
        </h2>
        <div
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          role="search"
          aria-label="Filtres de l’historique des relevés du véhicule"
        >
          <div className="space-y-1">
            <Label htmlFor="vehicle-readings-status">Statut</Label>
            <Select
              value={status || ALL}
              onValueChange={(v) => {
                setStatus(v === ALL ? '' : v);
                setPage(1);
              }}
            >
              <SelectTrigger id="vehicle-readings-status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Tous les statuts</SelectItem>
                {Object.entries(READING_STATUS_LABELS).map(([k, label]) => (
                  <SelectItem key={k} value={k}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="vehicle-readings-source">Source</Label>
            <Select
              value={source || ALL}
              onValueChange={(v) => {
                setSource(v === ALL ? '' : v);
                setPage(1);
              }}
            >
              <SelectTrigger id="vehicle-readings-source" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Toutes les sources</SelectItem>
                {Object.entries(READING_SOURCE_LABELS).map(([k, label]) => (
                  <SelectItem key={k} value={k}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {readings.isPending ? (
          <LoadingState label="Chargement des relevés…" />
        ) : readings.isError ? (
          <ErrorState error={readings.error} retry={() => void readings.refetch()} />
        ) : readings.data.total === 0 ? (
          <EmptyState
            title="Aucun relevé"
            description={
              status || source
                ? 'Aucun relevé ne correspond aux filtres.'
                : 'Aucun relevé enregistré pour ce véhicule.'
            }
          />
        ) : (
          <div className="rounded-md border">
            <ReadingsTable
              caption="Relevés du véhicule"
              items={readings.data.items}
              showVehicle={false}
              onDecide={setDecision}
              onCorrect={setCorrecting}
            />
            <PaginationControls
              page={readings.data.page}
              pageSize={readings.data.pageSize}
              total={readings.data.total}
              onPageChange={setPage}
            />
          </div>
        )}
      </section>

      <AddReadingDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        vehicleId={vehicleId}
        companyId={companyId}
        current={o}
        segments={segments.data ?? []}
      />
      <OdometerSegmentDialog
        mode={segmentMode}
        onClose={() => setSegmentMode(null)}
        vehicleId={vehicleId}
        companyId={companyId}
        current={o}
        openSegment={openSegment}
      />
      <ReadingDecisionDialog decision={decision} onClose={() => setDecision(null)} />
      <CorrectReadingDialog reading={correcting} onClose={() => setCorrecting(null)} />
    </div>
  );
}

function CurrentOdometer({
  data,
  vehicleId,
  timezone,
}: {
  data: OdometerCurrentView;
  vehicleId: string;
  timezone: string;
}) {
  const r = data.reading;
  const hint = data.lastTelematicsHint;
  return (
    <>
      {r ? (
        <div className="space-y-1">
          <p className="text-2xl font-semibold">{readingKmLabel(r)}</p>
          {!r.isEstimate && r.cumulativeKm ? (
            <p>Cumul véhicule : {formatKm(r.cumulativeKm)}</p>
          ) : null}
          <p className="text-muted-foreground">
            {READING_SOURCE_LABELS[r.source] ?? r.source} ·{' '}
            {MEASUREMENT_KIND_LABELS[r.measurementKind] ?? r.measurementKind} · compteur n°{' '}
            {r.segmentSequence} · observé le {formatDateTime(r.observedAt, timezone)}
            {r.authorName ? ` · ${r.authorName}` : ''}
          </p>
        </div>
      ) : (
        <p>Kilométrage inconnu : aucun relevé accepté.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <FreshnessBadge freshness={data.freshness} ageDays={data.ageDays} prefix="Fraîcheur" />
        {!data.cumulativeKnown ? (
          <StatusBadge label="Cumul incomplet : historique antérieur inconnu" tone="warning" />
        ) : null}
        {data.pendingCount > 0 ? (
          <StatusBadge
            label={`${data.pendingCount} relevé(s) en attente de validation`}
            tone="warning"
          />
        ) : null}
      </div>
      {data.pendingCount > 0 ? (
        <p>
          <Link
            href={`/kilometrage?onglet=a-valider&vehicule=${vehicleId}`}
            className="underline underline-offset-4"
          >
            Ouvrir la file de validation de ce véhicule
          </Link>
        </p>
      ) : null}
      {hint ? (
        <p className="text-muted-foreground">
          Dernière valeur télématique reçue : {formatKm(hint.valueKm)} (
          {MEASUREMENT_KIND_LABELS[hint.kind as keyof typeof MEASUREMENT_KIND_LABELS] ?? hint.kind})
          le {formatDateTime(hint.observedAt, timezone)}. Indication seulement : elle ne remplace
          pas un relevé lu au tableau de bord.
        </p>
      ) : null}
    </>
  );
}
