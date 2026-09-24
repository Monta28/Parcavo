'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { INTERVENTION_STATUS_LABELS } from '@parc-auto/contracts';
import { useSession } from '@/components/layout/session-context';
import { PlanCurrentKm, PlanDue, PlanStatusBadge, PlanWarnings, formatIntervals } from '@/components/maintenance/plan-display';
import { hasPermissionIn, isManagerOf, isOperationalIn } from '@/components/maintenance/roles';
import { PaginationControls } from '@/components/pagination-controls';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, toQuery } from '@/lib/api-client';
import type { Page } from '@/lib/api-types';
import { formatDate, formatDateTime, formatKm, formatMoney } from '@/lib/format';
import { INTERVENTION_COST_STATUS_LABELS, INTERVENTION_KIND_LABELS, type InterventionView } from '@/lib/interventions-types';
import type { MaintenancePlanView } from '@/lib/maintenance-types';
import { toneForInterventionStatus } from '../../interventions/intervention-helpers';

/**
 * Onglet « Entretien » de la fiche véhicule : plans actifs du véhicule (GET /maintenance-plans?vehicleId=)
 * et interventions (GET /interventions?vehicleId=). Composant autonome, à intégrer dans vehicle-detail.
 */
export function MaintenancePanel({ vehicleId, companyId }: { vehicleId: string; companyId: string }) {
  const session = useSession();
  const [interventionsPage, setInterventionsPage] = useState(1);
  const plansQuery = toQuery({ vehicleId, pageSize: 100 });
  const plans = useQuery({ queryKey: ['maintenance-plans', plansQuery], queryFn: () => api<Page<MaintenancePlanView>>(`/maintenance-plans${plansQuery}`) });
  const interventionsQuery = toQuery({ vehicleId, page: interventionsPage, pageSize: 10 });
  const interventions = useQuery({ queryKey: ['interventions', interventionsQuery], queryFn: () => api<Page<InterventionView>>(`/interventions${interventionsQuery}`) });
  const canManagePlans = isManagerOf(session, companyId);
  const canCreateIntervention = isOperationalIn(session, companyId);
  const canSeeCosts = hasPermissionIn(session, companyId, 'costs.read');

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base">Plans d’entretien</CardTitle>
          <Button variant="outline" size="sm" asChild>
            <Link href={`/entretiens?vehicule=${vehicleId}`}>{canManagePlans ? 'Gérer les plans' : 'Voir dans Entretiens'}</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {plans.isPending ? (
            <LoadingState label="Chargement des plans…" />
          ) : plans.isError ? (
            <ErrorState error={plans.error} retry={() => void plans.refetch()} />
          ) : plans.data.total === 0 ? (
            <EmptyState title="Aucun plan d’entretien actif" description="Créez un plan ou appliquez un modèle depuis la page Entretiens." />
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Opération</TableHead>
                    <TableHead>Prochaine échéance</TableHead>
                    <TableHead>Km retenu</TableHead>
                    <TableHead>Statut</TableHead>
                    <TableHead>Avertissements</TableHead>
                    <TableHead className="text-right">Détail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plans.data.items.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="whitespace-normal">
                        <span className="font-medium">{p.maintenanceTypeLabel}</span>
                        <span className="block text-xs text-muted-foreground">{formatIntervals(p)}</span>
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        <PlanDue plan={p} timezone={session.timezone} />
                      </TableCell>
                      <TableCell>
                        <PlanCurrentKm plan={p} />
                      </TableCell>
                      <TableCell>
                        <PlanStatusBadge status={p.status} />
                      </TableCell>
                      <TableCell className="min-w-48 whitespace-normal">
                        <PlanWarnings warnings={p.warnings} compact />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`/entretiens?plan=${p.id}`} aria-label={`Détail du plan ${p.maintenanceTypeLabel}`}>
                            Ouvrir
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {plans.data.total > plans.data.items.length ? (
                <p className="px-3 py-3 text-sm text-muted-foreground">
                  {plans.data.items.length} plans affichés sur {plans.data.total} :{' '}
                  <Link href={`/entretiens?vehicule=${vehicleId}`} className="underline underline-offset-4">
                    voir la liste complète
                  </Link>
                  .
                </p>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base">Interventions</CardTitle>
          {canCreateIntervention ? (
            <Button size="sm" asChild>
              <Link href={`/interventions/nouvelle?vehicleId=${vehicleId}`}>
                <Plus className="size-4" aria-hidden="true" /> Nouvelle intervention
              </Link>
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-2">
          {!canSeeCosts ? <p className="text-sm text-muted-foreground">Coûts non visibles avec vos habilitations.</p> : null}
          {interventions.isPending ? (
            <LoadingState label="Chargement des interventions…" />
          ) : interventions.isError ? (
            <ErrorState error={interventions.error} retry={() => void interventions.refetch()} />
          ) : interventions.data.total === 0 ? (
            <EmptyState title="Aucune intervention" description="Les interventions préventives et correctives de ce véhicule apparaîtront ici." />
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Référence</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Statut</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Km d’exécution</TableHead>
                    <TableHead>Travaux</TableHead>
                    <TableHead>Garage</TableHead>
                    {canSeeCosts ? <TableHead className="text-right">Total</TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {interventions.data.items.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell>
                        <Link href={`/interventions/${i.id}`} className="font-medium underline-offset-4 hover:underline">
                          {i.reference}
                        </Link>
                        {i.isHistorical ? <span className="block text-xs text-muted-foreground">saisie historique</span> : null}
                      </TableCell>
                      <TableCell>{INTERVENTION_KIND_LABELS[i.kind] ?? i.kind}</TableCell>
                      <TableCell>
                        <StatusBadge label={INTERVENTION_STATUS_LABELS[i.status] ?? i.status} tone={toneForInterventionStatus(i.status)} />
                      </TableCell>
                      <TableCell>
                        {i.performedOn ? (
                          <span>réalisée le {formatDate(i.performedOn, session.timezone)}</span>
                        ) : i.plannedStartAt ? (
                          <span className="text-muted-foreground">prévue le {formatDateTime(i.plannedStartAt, session.timezone)}</span>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>{formatKm(i.performedKm)}</TableCell>
                      <TableCell className="min-w-48 whitespace-normal text-xs">{i.tasks.length > 0 ? i.tasks.map((t) => t.maintenanceTypeLabel ?? t.label).join(', ') : '—'}</TableCell>
                      <TableCell className="whitespace-normal">{i.supplierName ?? '—'}</TableCell>
                      {canSeeCosts ? (
                        <TableCell className="text-right">
                          {i.totalAmount !== null ? formatMoney(i.totalAmount, session.currency, session.currencyDecimals) : <span className="text-muted-foreground">{INTERVENTION_COST_STATUS_LABELS[i.costStatus] ?? '—'}</span>}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <PaginationControls page={interventions.data.page} pageSize={interventions.data.pageSize} total={interventions.data.total} onPageChange={setInterventionsPage} />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
