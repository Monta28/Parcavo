'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ENERGY_LABELS, FRESHNESS_LABELS, MEASUREMENT_KIND_LABELS, READING_SOURCE_LABELS, VEHICLE_LIFECYCLE_LABELS, VEHICLE_OPERATIONAL_STATUS_LABELS } from '@parc-auto/contracts';
import { DocumentStatusBadge } from '@/components/documents/document-helpers';
import { useAppScope } from '@/components/layout/session-context';
import { PlanDue, PlanStatusBadge, PlanWarnings, formatIntervals } from '@/components/maintenance/plan-display';
import { hasPermissionIn } from '@/components/maintenance/roles';
import { PrintSheetStyles } from '@/components/reports/print-styles';
import { ReportCell, ReportTable } from '@/components/reports/report-table';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import type { ComplianceRow } from '@/lib/documents-types';
import { formatDate, formatDateTime, formatKm } from '@/lib/format';
import type { MaintenancePlanView } from '@/lib/maintenance-types';
import { formatDecimalText, reportHeader } from '@/lib/report-format';
import type { ReportPage } from '@/lib/reports-types';
import { useListParams } from '@/lib/use-list-params';
import type { SiteView, VehicleSynthesis } from '@/lib/vehicles-types';

/** Libellés des modes de détention (valeurs de VehicleViewDto.ownershipMode). */
const OWNERSHIP_LABELS: Record<string, string> = { ACHAT: 'Achat', LOCATION: 'Location', LEASING: 'Leasing', AUTRE: 'Autre' };

/**
 * Fiche véhicule imprimable (CDC 11.2, 3.1) : identité, état, compteur, responsable habituel, plans
 * d'entretien, conformité documentaire, distance de la période et — seulement si l'API les renvoie
 * (costs.read) — coûts. Données lues par les routes existantes (GET /vehicles/:id/synthesis,
 * /maintenance-plans, /documents/compliance, /reports/couts-distances, /reports/depenses) : aucune valeur
 * n'est recalculée ici. Impression par le navigateur (window.print()).
 */
export function VehicleSheet({ id }: { id: string }) {
  const { session } = useAppScope();
  const tz = session.timezone;
  const staff = !session.isDriverOnly;
  const { get, set } = useListParams();
  const from = get('du');
  const to = get('au');
  const [editedAt] = useState(() => new Date().toISOString());

  const synthesis = useQuery({ queryKey: ['vehicle', id, 'synthesis'], queryFn: () => api<VehicleSynthesis>(`/vehicles/${id}/synthesis`) });
  const v = synthesis.data;
  const siteId = v?.siteId ?? null;
  const sites = useQuery({
    queryKey: ['sites', 'vehicle-sheet', v?.companyId ?? null],
    queryFn: () => api<Page<SiteView>>(`/sites${toQuery({ companyId: v?.companyId, pageSize: 100 })}`),
    enabled: staff && siteId !== null,
  });
  const plans = useQuery({
    queryKey: ['maintenance-plans', 'vehicle-sheet', id],
    queryFn: () => api<Page<MaintenancePlanView>>(`/maintenance-plans${toQuery({ vehicleId: id, pageSize: 100, sort: 'echeance' })}`),
    enabled: staff,
  });
  const compliance = useQuery({
    queryKey: ['documents', 'compliance', 'vehicle-sheet', id],
    queryFn: () => api<Page<ComplianceRow>>(`/documents/compliance${toQuery({ vehicleId: id, pageSize: 100 })}`),
    enabled: staff,
  });
  const costsVisible = staff && v !== undefined && hasPermissionIn(session, v.companyId, 'costs.read');
  const distance = useQuery({
    queryKey: ['reports', 'vehicle-sheet', 'couts-distances', id, from, to],
    // Une ligne par société détentrice sur la période (transfert au milieu de la période, CDC 11.3).
    queryFn: () => api<ReportPage>(`/reports/couts-distances${toQuery({ vehicleId: id, from, to, pageSize: 10 })}`),
    enabled: staff && v !== undefined,
  });
  const expenses = useQuery({
    queryKey: ['reports', 'vehicle-sheet', 'depenses', id, from, to],
    queryFn: () => api<ReportPage>(`/reports/depenses${toQuery({ vue: 'categorie', vehicleId: id, from, to, pageSize: 100 })}`),
    enabled: costsVisible,
  });

  if (!v) {
    return synthesis.isError ? <ErrorState error={synthesis.error} retry={() => void synthesis.refetch()} /> : <LoadingState label="Préparation de la fiche…" />;
  }
  const company = session.companies.find((c) => c.id === v.companyId);
  const site = siteId ? sites.data?.items.find((s) => s.id === siteId) : undefined;
  const odo = v.odometer;
  const period = distance.data?.meta.period ?? expenses.data?.meta.period ?? null;

  return (
    <div className="mx-auto max-w-5xl">
      <PrintSheetStyles scope="vehicle-sheet" />
      <div className="no-print mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => window.print()}>
            <Printer className="size-4" aria-hidden="true" /> Imprimer
          </Button>
          <Button variant="outline" asChild>
            <Link href={`/vehicules/${v.id}`}>
              <ArrowLeft className="size-4" aria-hidden="true" /> Retour au dossier
            </Link>
          </Button>
        </div>
        {staff ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="fiche-du">Période du</Label>
              <Input id="fiche-du" type="date" value={from || period?.from || ''} onChange={(e) => set({ du: e.target.value })} className="w-40" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="fiche-au">au</Label>
              <Input id="fiche-au" type="date" value={to || period?.to || ''} onChange={(e) => set({ au: e.target.value })} className="w-40" />
            </div>
          </div>
        ) : null}
      </div>

      <article className="vehicle-sheet space-y-6 rounded-md border bg-background p-6 text-sm print:border-0 print:p-0">
        <header className="flex flex-col gap-2 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold">
              Fiche véhicule {v.code} · {v.registration}
            </h1>
            <p className="text-muted-foreground">
              {session.organizationName}
              {company ? ` · ${company.code} ${company.name}` : ` · Société ${v.companyCode}`}
            </p>
          </div>
          <div className="text-left sm:text-right">
            <p className="text-muted-foreground">Éditée le {formatDateTime(editedAt, tz)}</p>
            <p className="text-muted-foreground">Fuseau : {tz}</p>
          </div>
        </header>

        <section aria-labelledby="fiche-identite" className="sheet-block space-y-2">
          <h2 id="fiche-identite" className="text-base font-semibold">
            Identité
          </h2>
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3 print:grid-cols-3">
            <Row label="Code" value={v.code} />
            <Row label="Immatriculation" value={`${v.registration}${v.provisionalRegistration ? ' (provisoire)' : ''}`} />
            <Row label="Marque et modèle" value={`${v.make} ${v.model}`.trim()} />
            <Row label="Catégorie" value={v.categoryLabel} />
            <Row label="Société gestionnaire" value={company ? `${company.code} — ${company.name}` : v.companyCode} />
            {siteId ? <Row label="Site" value={site?.name ?? (sites.isError ? 'Non disponible' : '…')} /> : null}
            <Row label="VIN" value={v.vin ?? '—'} />
            <Row label="Année" value={v.year?.toString() ?? '—'} />
            <Row label="Mise en service" value={v.commissioningDate ? formatDate(v.commissioningDate) : '—'} />
            <Row label="Énergie" value={v.energy ? (ENERGY_LABELS[v.energy as keyof typeof ENERGY_LABELS] ?? v.energy) : '—'} />
            <Row label="Réservoir" value={v.tankCapacityLiters ? `${formatDecimalText(v.tankCapacityLiters)} L` : '—'} />
            <Row label="Détention" value={v.ownershipMode ? (OWNERSHIP_LABELS[v.ownershipMode] ?? v.ownershipMode) : '—'} />
            <Row label="Fin de contrat" value={v.contractEndDate ? formatDate(v.contractEndDate) : '—'} />
          </dl>
          {v.notes ? <p className="whitespace-pre-wrap">Notes : {v.notes}</p> : null}
        </section>

        <section aria-labelledby="fiche-etat" className="sheet-block space-y-2">
          <h2 id="fiche-etat" className="text-base font-semibold">
            État
          </h2>
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2 print:grid-cols-2">
            <Row label="Cycle de vie" value={VEHICLE_LIFECYCLE_LABELS[v.lifecycleStatus]} />
            <Row label="État opérationnel" value={v.operationalStatus ? VEHICLE_OPERATIONAL_STATUS_LABELS[v.operationalStatus] : 'Sans objet (véhicule non actif)'} />
            <Row
              label="Utilisation en cours"
              value={v.currentUsage ? `${v.currentUsage.driverName}, remis le ${formatDateTime(v.currentUsage.checkedOutAt, tz)}, retour prévu le ${formatDateTime(v.currentUsage.expectedReturnAt, tz)}` : 'Aucune'}
            />
            <Row label="Immobilisation en cours" value={v.activeImmobilizationId ? 'Oui' : 'Non'} />
            <Row label="Incidents ouverts" value={v.openIncidents === null ? '—' : String(v.openIncidents)} />
            <Row label="Relevés en attente de validation" value={v.pendingReadings === null ? '—' : String(v.pendingReadings)} />
            <Row
              label="Dernière localisation déclarée"
              value={v.lastLocation ? `${v.lastLocation.siteName ?? v.lastLocation.placeLabel ?? '—'}, observée le ${formatDateTime(v.lastLocation.observedAt, tz)}` : 'Aucune'}
            />
          </dl>
        </section>

        <section aria-labelledby="fiche-compteur" className="sheet-block space-y-2">
          <h2 id="fiche-compteur" className="text-base font-semibold">
            Compteur
          </h2>
          {odo ? (
            <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2 print:grid-cols-2">
              <Row label="Dernier relevé accepté" value={formatKm(odo.isEstimate ? odo.cumulativeKm : odo.physicalKm, { estimate: odo.isEstimate })} />
              <Row label="Kilométrage cumulé" value={odo.cumulativeKm ? formatKm(odo.cumulativeKm) : 'Inconnu'} />
              <Row
                label="Source et nature"
                value={`${READING_SOURCE_LABELS[odo.source as keyof typeof READING_SOURCE_LABELS] ?? odo.source} · ${MEASUREMENT_KIND_LABELS[odo.measurementKind as keyof typeof MEASUREMENT_KIND_LABELS] ?? odo.measurementKind}`}
              />
              <Row label="Observé le" value={formatDateTime(odo.observedAt, tz)} />
              <Row label="Fraîcheur" value={`${FRESHNESS_LABELS[v.freshness]}${odo.ageDays !== null ? ` (${odo.ageDays} j)` : ''}`} />
              <Row label="Cumul" value={odo.cumulativeKnown ? 'Complet' : 'Incomplet : historique antérieur inconnu'} />
            </dl>
          ) : (
            <p>Kilométrage inconnu : aucun relevé accepté.</p>
          )}
        </section>

        <section aria-labelledby="fiche-responsable" className="sheet-block space-y-2">
          <h2 id="fiche-responsable" className="text-base font-semibold">
            Responsable habituel
          </h2>
          <p>{v.responsible ? `${v.responsible.driverName}, depuis le ${formatDate(v.responsible.since, tz)}` : 'Aucun responsable habituel enregistré.'}</p>
        </section>

        {staff ? (
          <section aria-labelledby="fiche-plans" className="space-y-2">
            <h2 id="fiche-plans" className="text-base font-semibold">
              Plans d’entretien
            </h2>
            {plans.isPending ? (
              <LoadingState label="Chargement des plans…" />
            ) : plans.isError ? (
              <SectionError error={plans.error} />
            ) : plans.data.items.length === 0 ? (
              <p className="text-muted-foreground">Aucun plan d’entretien actif.</p>
            ) : (
              <>
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b">
                      <th scope="col" className="py-1.5 pr-3 font-semibold">
                        Opération
                      </th>
                      <th scope="col" className="py-1.5 pr-3 font-semibold">
                        Intervalle
                      </th>
                      <th scope="col" className="py-1.5 pr-3 font-semibold">
                        Prochaine échéance
                      </th>
                      <th scope="col" className="py-1.5 pr-3 font-semibold">
                        Statut
                      </th>
                      <th scope="col" className="py-1.5 font-semibold">
                        Avertissements
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {plans.data.items.map((p) => (
                      <tr key={p.id} className="border-b align-top">
                        <td className="py-1.5 pr-3 font-medium">{p.maintenanceTypeLabel}</td>
                        <td className="py-1.5 pr-3">{formatIntervals(p)}</td>
                        <td className="py-1.5 pr-3">
                          <PlanDue plan={p} timezone={tz} />
                        </td>
                        <td className="py-1.5 pr-3">
                          <PlanStatusBadge status={p.status} />
                        </td>
                        <td className="py-1.5">
                          <PlanWarnings warnings={p.warnings} compact />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {plans.data.total > plans.data.items.length ? <p className="text-xs text-muted-foreground">{plans.data.items.length} premiers plans sur {plans.data.total}.</p> : null}
              </>
            )}
          </section>
        ) : null}

        {staff ? (
          <section aria-labelledby="fiche-documents" className="space-y-2">
            <h2 id="fiche-documents" className="text-base font-semibold">
              Documents
            </h2>
            {compliance.isPending ? (
              <LoadingState label="Chargement de la conformité…" />
            ) : compliance.isError ? (
              <SectionError error={compliance.error} />
            ) : compliance.data.items.length === 0 ? (
              <p className="text-muted-foreground">Aucun type de document applicable ni enregistré.</p>
            ) : (
              <>
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b">
                      <th scope="col" className="py-1.5 pr-3 font-semibold">
                        Document
                      </th>
                      <th scope="col" className="py-1.5 pr-3 font-semibold">
                        Statut
                      </th>
                      <th scope="col" className="py-1.5 pr-3 font-semibold">
                        Validité
                      </th>
                      <th scope="col" className="py-1.5 font-semibold">
                        Détail
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {compliance.data.items.map((d) => (
                      <tr key={`${d.documentTypeId}-${d.objectId}`} className="border-b align-top">
                        <td className="py-1.5 pr-3 font-medium">
                          {d.documentTypeLabel}
                          {d.blocksCheckout ? <span className="block text-xs font-normal text-destructive">Bloque un départ</span> : null}
                        </td>
                        <td className="py-1.5 pr-3">
                          <DocumentStatusBadge status={d.status} />
                        </td>
                        <td className="py-1.5 pr-3">{d.validFrom || d.validTo ? `${d.validFrom ? `du ${formatDate(d.validFrom)} ` : ''}${d.validTo ? `au ${formatDate(d.validTo)}` : 'sans fin'}` : '—'}</td>
                        <td className="py-1.5">{d.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {compliance.data.total > compliance.data.items.length ? (
                  <p className="text-xs text-muted-foreground">
                    {compliance.data.items.length} premières lignes sur {compliance.data.total}.
                  </p>
                ) : null}
              </>
            )}
          </section>
        ) : null}

        {staff ? (
          <section aria-labelledby="fiche-periode" className="space-y-3">
            <h2 id="fiche-periode" className="text-base font-semibold">
              Distance{costsVisible ? ' et coûts' : ''} de la période{period ? ` du ${formatDate(period.from)} au ${formatDate(period.to)}` : ''}
            </h2>
            {distance.isPending ? (
              <LoadingState label="Calcul de la distance…" />
            ) : distance.isError ? (
              <SectionError error={distance.error} />
            ) : distance.data.items.length > 0 ? (
              distance.data.items.map((item) => (
                <dl key={item.id} className="sheet-block grid gap-x-6 gap-y-1 sm:grid-cols-2 print:grid-cols-2">
                  {/* Colonnes de coût : décrites par l'API seulement avec costs.read ; absentes d'une ligne sans ce droit sur sa société (« Masqué »). */}
                  {distance.data.meta.columns.map((column) => (
                    <div key={column.key} className="flex flex-wrap gap-x-2">
                      <dt className="text-muted-foreground">{reportHeader(column)} :</dt>
                      <dd className="font-medium">
                        <ReportCell column={column} item={item} timezone={distance.data.meta.timezone} />
                      </dd>
                    </div>
                  ))}
                </dl>
              ))
            ) : (
              <p className="text-muted-foreground">Véhicule hors du rapport des distances (cycle de vie ou périmètre).</p>
            )}
            {costsVisible ? (
              expenses.isPending ? (
                <LoadingState label="Chargement des dépenses…" />
              ) : expenses.isError ? (
                <SectionError error={expenses.error} />
              ) : (
                <div className="space-y-2">
                  <h3 className="font-medium">Dépenses validées par catégorie</h3>
                  {expenses.data.total === 0 ? (
                    <p className="text-muted-foreground">Aucune dépense validée sur la période.</p>
                  ) : (
                    <div className="rounded-md border">
                      <ReportTable columns={expenses.data.meta.columns} items={expenses.data.items} timezone={expenses.data.meta.timezone} caption="Dépenses validées par catégorie" />
                    </div>
                  )}
                  {expenses.data.meta.summary.length > 0 ? (
                    <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2 print:grid-cols-2">
                      {expenses.data.meta.summary.map((s) => (
                        <Row key={s.label} label={s.label} value={s.value === null ? 'N/D' : `${formatDecimalText(s.value)}${s.unit ? ` ${s.unit}` : ''}`} />
                      ))}
                    </dl>
                  ) : null}
                </div>
              )
            ) : null}
            {distance.data ? (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                {[...distance.data.meta.notes, ...(expenses.data?.meta.notes ?? [])].map((note) => (
                  <li key={note}>{note}</li>
                ))}
                <li>
                  Données générées le {formatDateTime(distance.data.meta.generatedAt, distance.data.meta.timezone)} ({distance.data.meta.timezone}) ; {distance.data.meta.units.join(' ')}
                </li>
              </ul>
            ) : null}
          </section>
        ) : null}
      </article>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="text-muted-foreground">{label} :</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function SectionError({ error }: { error: unknown }) {
  return (
    <p role="alert" className="text-destructive">
      {isApiError(error) ? error.message : 'Données indisponibles.'}
    </p>
  );
}
