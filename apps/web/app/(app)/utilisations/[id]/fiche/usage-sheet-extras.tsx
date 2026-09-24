'use client';

import { useQuery } from '@tanstack/react-query';
import { INCIDENT_SEVERITY_LABELS, INCIDENT_STATUS_LABELS, INCIDENT_TYPE_LABELS } from '@parc-auto/contracts';
import { api, toQuery } from '@/lib/api-client';
import { isApiError } from '@/lib/api-error';
import type { Page } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import type { IncidentView } from '@/lib/incidents-types';

/**
 * Anomalies de la fiche de remise et de restitution : incidents rattachés à l'utilisation
 * (GET /incidents?usageId=, recoupé avec le périmètre de l'appelant par l'API).
 */
export function UsageSheetAnomalies({ usageId, timezone }: { usageId: string; timezone: string }) {
  const incidents = useQuery({ queryKey: ['incidents', 'usage-sheet', usageId], queryFn: () => api<Page<IncidentView>>(`/incidents${toQuery({ usageId, pageSize: 100 })}`) });
  return (
    <section aria-labelledby="sheet-anomalies" className="space-y-2">
      <h2 id="sheet-anomalies" className="text-base font-semibold">
        Anomalies et incidents signalés
      </h2>
      {incidents.isPending ? (
        <p role="status" className="text-muted-foreground">
          Chargement des incidents…
        </p>
      ) : incidents.isError ? (
        <p role="alert" className="text-destructive">
          {isApiError(incidents.error) ? incidents.error.message : 'Incidents indisponibles.'}
        </p>
      ) : incidents.data.items.length === 0 ? (
        <p className="text-muted-foreground">Aucun incident rattaché à cette utilisation.</p>
      ) : (
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b">
              <th scope="col" className="py-2 pr-3 font-semibold">
                Référence
              </th>
              <th scope="col" className="py-2 pr-3 font-semibold">
                Survenu le
              </th>
              <th scope="col" className="py-2 pr-3 font-semibold">
                Type et gravité
              </th>
              <th scope="col" className="py-2 pr-3 font-semibold">
                Statut
              </th>
              <th scope="col" className="py-2 font-semibold">
                Description
              </th>
            </tr>
          </thead>
          <tbody>
            {incidents.data.items.map((i) => (
              <tr key={i.id} className="border-b align-top">
                <td className="py-1.5 pr-3 font-medium">{i.reference}</td>
                <td className="py-1.5 pr-3">{formatDateTime(i.occurredAt, timezone)}</td>
                <td className="py-1.5 pr-3">
                  {INCIDENT_TYPE_LABELS[i.type] ?? i.type} · {INCIDENT_SEVERITY_LABELS[i.severity] ?? i.severity}
                </td>
                <td className="py-1.5 pr-3">{INCIDENT_STATUS_LABELS[i.status] ?? i.status}</td>
                <td className="whitespace-pre-wrap py-1.5">{i.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const SIGNATURE_BOXES = [
  { moment: 'À la remise', who: 'Le conducteur' },
  { moment: 'À la remise', who: 'Pour le parc (remettant)' },
  { moment: 'À la restitution', who: 'Le conducteur' },
  { moment: 'À la restitution', who: 'Pour le parc (réceptionnaire)' },
] as const;

/** Cadres de signature laissés vides, à compléter à la main sur la fiche imprimée. */
export function UsageSheetHandSignatures() {
  return (
    <section aria-labelledby="sheet-signatures" className="space-y-3 border-t pt-4">
      <h2 id="sheet-signatures" className="text-base font-semibold">
        Signatures manuscrites
      </h2>
      <p className="text-xs text-muted-foreground">À compléter à la main sur la fiche imprimée.</p>
      <div className="grid gap-4 sm:grid-cols-2 print:grid-cols-2">
        {SIGNATURE_BOXES.map((box) => (
          <div key={`${box.moment}-${box.who}`} className="space-y-3 rounded-md border p-3 print:break-inside-avoid">
            <p className="font-medium">
              {box.moment} — {box.who}
            </p>
            <p className="flex items-end gap-2">
              <span className="text-muted-foreground">Nom :</span>
              <span className="h-5 flex-1 border-b border-dashed" aria-hidden="true" />
            </p>
            <p className="flex items-end gap-2">
              <span className="text-muted-foreground">Date :</span>
              <span className="h-5 flex-1 border-b border-dashed" aria-hidden="true" />
            </p>
            <p className="text-muted-foreground">Signature :</p>
            <div className="h-16" aria-hidden="true" />
          </div>
        ))}
      </div>
    </section>
  );
}
