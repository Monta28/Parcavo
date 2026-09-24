import { formatIntervals, formatNotices, formatRemainingDays, formatRemainingKm, PlanStatusBadge } from '@/components/maintenance/plan-display';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate, formatKm } from '@/lib/format';
import type { PlanImpactState, TemplatePlanImpact } from '@/lib/maintenance-types';

/**
 * Impact d'une application de modèle, plan par plan (17.1) : état avant (plan existant) et après, tels que
 * calculés par l'API. Aucune échéance ni statut n'est recalculé ici.
 */
export function TemplateImpactTable({ impacts, timezone }: { impacts: TemplatePlanImpact[]; timezone: string }) {
  const updates = impacts.filter((i) => i.action === 'MISE_A_JOUR');
  const creations = impacts.filter((i) => i.action === 'CREATION');
  return (
    <div className="space-y-4">
      <section aria-labelledby="impact-updates" className="space-y-2">
        <h3 id="impact-updates" className="text-sm font-medium">
          Plans existants mis à jour ({updates.length})
        </h3>
        {updates.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun plan existant n’est modifié.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Véhicule</TableHead>
                  <TableHead>Opération</TableHead>
                  <TableHead>Avant</TableHead>
                  <TableHead>Après</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {updates.map((i) => (
                  <TableRow key={`${i.vehicleId}:${i.maintenanceTypeLabel}`}>
                    <TableCell className="font-medium">{i.vehicleCode}</TableCell>
                    <TableCell className="whitespace-normal">{i.maintenanceTypeLabel}</TableCell>
                    <TableCell className="whitespace-normal">{i.before ? <ImpactState state={i.before} timezone={timezone} /> : '—'}</TableCell>
                    <TableCell className="whitespace-normal">
                      <ImpactState state={i.after} timezone={timezone} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
      <section aria-labelledby="impact-creations" className="space-y-2">
        <h3 id="impact-creations" className="text-sm font-medium">
          Nouveaux plans ({creations.length})
        </h3>
        {creations.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun nouveau plan.</p>
        ) : (
          <ul className="divide-y rounded-md border text-sm">
            {creations.map((i) => (
              <li key={`${i.vehicleId}:${i.maintenanceTypeLabel}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span>
                  <span className="font-medium">{i.vehicleCode}</span> · {i.maintenanceTypeLabel} · {formatIntervals(i.after)}
                </span>
                <PlanStatusBadge status={i.after.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ImpactState({ state, timezone }: { state: PlanImpactState; timezone: string }) {
  return (
    <div className="space-y-1 text-sm">
      <p>{formatIntervals(state)}</p>
      <p className="text-xs text-muted-foreground">Préavis {formatNotices(state)}</p>
      {state.nextDueKm ? (
        <p>
          Échéance {formatKm(state.nextDueKm)}
          {state.remainingKm !== null ? <span className="text-muted-foreground"> · {formatRemainingKm(state.remainingKm)}</span> : null}
        </p>
      ) : null}
      {state.nextDueDate ? (
        <p>
          Échéance {formatDate(state.nextDueDate, timezone)}
          {state.remainingDays !== null ? <span className="text-muted-foreground"> · {formatRemainingDays(state.remainingDays)}</span> : null}
        </p>
      ) : null}
      <PlanStatusBadge status={state.status} />
    </div>
  );
}
