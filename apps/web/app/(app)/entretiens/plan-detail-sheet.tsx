'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useSession } from '@/components/layout/session-context';
import { PlanCurrentKm, PlanDue, PlanStatusBadge, PlanWarnings, formatBase, formatIntervals, formatNotices } from '@/components/maintenance/plan-display';
import { isManagerOf, isOperationalIn } from '@/components/maintenance/roles';
import { ErrorState, LoadingState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { api } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { ACCEPTED_SOURCES_LABELS, type MaintenancePlanView, type MaintenanceTemplateView } from '@/lib/maintenance-types';
import { PlanDeactivateDialog } from './plan-deactivate-dialog';
import { PlanEditDialog } from './plan-edit-dialog';
import { ResponsibleName } from './plan-form-parts';
import { PlanReactivateDialog } from './plan-reactivate-dialog';

/** Détail d'un plan ouvert par ?plan=<id> (lien direct depuis les alertes et la fiche véhicule). */
export function PlanDetailSheet({ planId, onClose }: { planId: string; onClose: () => void }) {
  const session = useSession();
  const [dialog, setDialog] = useState<'edit' | 'deactivate' | 'reactivate' | null>(null);
  const plan = useQuery({ queryKey: ['maintenance-plan', planId], queryFn: () => api<MaintenancePlanView>(`/maintenance-plans/${planId}`) });
  const templateId = plan.data?.templateId ?? null;
  const template = useQuery({ queryKey: ['maintenance-template', templateId], queryFn: () => api<MaintenanceTemplateView>(`/maintenance-templates/${templateId}`), enabled: Boolean(templateId) });
  const p = plan.data;
  const canManage = p ? isManagerOf(session, p.companyId) && p.active : false;
  const canReactivate = p ? isManagerOf(session, p.companyId) && !p.active : false;
  const canPlanWork = p ? isOperationalIn(session, p.companyId) && p.active : false;
  const companyCode = p ? session.companies.find((c) => c.id === p.companyId)?.code : undefined;

  return (
    <>
      <Sheet open onOpenChange={(open) => !open && dialog === null && onClose()}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{p ? `${p.maintenanceTypeLabel} · ${p.vehicleCode}` : 'Plan d’entretien'}</SheetTitle>
            <SheetDescription>Échéances et statuts calculés par le serveur depuis les opérations validées et le kilométrage admissible.</SheetDescription>
          </SheetHeader>
          <div className="space-y-4 px-4 pb-6 text-sm">
            {plan.isPending ? (
              <LoadingState label="Chargement du plan…" />
            ) : plan.isError ? (
              <ErrorState error={plan.error} retry={() => void plan.refetch()} />
            ) : p ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <PlanStatusBadge status={p.status} />
                  {!p.active ? <StatusBadge label="Plan désactivé" tone="neutral" /> : null}
                  {p.kmStatus ? <PlanStatusBadge status={p.kmStatus} prefix="Km" /> : null}
                  {p.dateStatus ? <PlanStatusBadge status={p.dateStatus} prefix="Date" /> : null}
                </div>
                {p.kmStatus && p.dateStatus ? <p className="text-xs text-muted-foreground">Le statut retenu est le plus urgent des seuils kilométrique et calendaire.</p> : null}
                {p.warnings.length > 0 ? (
                  <section aria-labelledby="plan-warnings-title" className="rounded-md border border-warning/40 bg-warning/10 p-3">
                    <h3 id="plan-warnings-title" className="mb-2 text-sm font-medium">
                      Données manquantes ou anciennes
                    </h3>
                    <PlanWarnings warnings={p.warnings} />
                  </section>
                ) : null}
                <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                  <Item label="Véhicule">
                    <Link href={`/vehicules/${p.vehicleId}`} className="font-medium underline-offset-4 hover:underline">
                      {p.vehicleCode}
                    </Link>
                    {companyCode ? <span className="text-muted-foreground"> · {companyCode}</span> : null}
                  </Item>
                  <Item label="Opération">{p.maintenanceTypeLabel}</Item>
                  <Item label="Intervalles">{formatIntervals(p)}</Item>
                  <Item label="Préavis">{formatNotices(p)}</Item>
                  <Item label="Base de calcul">{formatBase(p, session.timezone)}</Item>
                  <Item label="Prochaine échéance">
                    <PlanDue plan={p} timezone={session.timezone} />
                  </Item>
                  <Item label="Kilométrage retenu">
                    <PlanCurrentKm plan={p} />
                    {p.currentKmObservedAt ? <span className="block text-xs text-muted-foreground">observé le {formatDateTime(p.currentKmObservedAt, session.timezone)}</span> : null}
                  </Item>
                  <Item label="Relevés admis">{ACCEPTED_SOURCES_LABELS[p.acceptedSources] ?? p.acceptedSources}</Item>
                  <Item label="Responsable">
                    <ResponsibleName userId={p.responsibleUserId} name={p.responsibleUserName} />
                  </Item>
                  <Item label="Origine">{p.templateId ? (template.data ? `Copié du modèle « ${template.data.name} »` : 'Copié d’un modèle') : 'Plan saisi pour ce véhicule'}</Item>
                  {!p.active && p.deactivationReason ? <Item label="Motif de désactivation">{p.deactivationReason}</Item> : null}
                </dl>
                <div className="flex flex-wrap gap-2 border-t pt-4">
                  {canManage ? (
                    <>
                      <Button onClick={() => setDialog('edit')}>Modifier</Button>
                      <Button variant="outline" onClick={() => setDialog('deactivate')}>
                        Désactiver
                      </Button>
                    </>
                  ) : null}
                  {canReactivate ? <Button onClick={() => setDialog('reactivate')}>Réactiver</Button> : null}
                  {canPlanWork ? (
                    <Button variant="outline" asChild>
                      <Link href={`/interventions/nouvelle?vehicleId=${p.vehicleId}`}>Nouvelle intervention</Link>
                    </Button>
                  ) : null}
                  <Button variant="ghost" asChild>
                    <Link href={`/vehicules/${p.vehicleId}`}>Fiche véhicule</Link>
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
      {p && dialog === 'edit' ? <PlanEditDialog plan={p} onOpenChange={(open) => !open && setDialog(null)} onSaved={() => setDialog(null)} /> : null}
      {p && dialog === 'deactivate' ? <PlanDeactivateDialog plan={p} onOpenChange={(open) => !open && setDialog(null)} onDone={() => setDialog(null)} /> : null}
      {p && dialog === 'reactivate' ? <PlanReactivateDialog plan={p} onOpenChange={(open) => !open && setDialog(null)} onDone={() => setDialog(null)} /> : null}
    </>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
