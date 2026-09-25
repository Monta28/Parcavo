'use client';

import Link from 'next/link';
import { StatusBadge } from '@/components/status-badge';
import { formatDateTime } from '@/lib/format';
import type { AlertSeverity, AlertSummaryView } from './dashboard-types';

type Tone = NonNullable<Parameters<typeof StatusBadge>[0]['tone']>;

const SEVERITY_TONES: Record<AlertSeverity, Tone> = {
  CRITIQUE: 'danger',
  URGENT: 'danger',
  ATTENTION: 'warning',
  INFO: 'info',
};

/**
 * Sections de l'application qui existent aujourd'hui dans apps/web/app/(app) : le lien d'action d'une
 * alerte (actionPath, fourni par l'API) n'est rendu cliquable que s'il vise l'une d'elles ; sinon le
 * titre est affiché sans lien plutôt qu'un lien vers une page absente.
 */
const EXISTING_SECTIONS = new Set(['vehicules', 'conducteurs', 'planning', 'utilisations', 'kilometrage', 'entretiens', 'interventions', 'documents', 'incidents', 'immobilisations', 'fournisseurs', 'imports', 'rapports', 'administration', 'telematique', 'carburant', 'depenses', 'alertes']);

/** Chemin interne de l'application (jamais d'URL externe ou protocolaire) vers une section existante. */
function isLinkableAppPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  const section = path.slice(1).split(/[/?#]/, 1)[0] ?? '';
  return EXISTING_SECTIONS.has(section);
}

/** Une alerte telle que renvoyée par GET /alerts : gravité, titre (lien d'action), message et contexte. */
export function AlertListItem({ alert, timezone, showCompany }: { alert: AlertSummaryView; timezone: string; showCompany: boolean }) {
  return (
    <li className="space-y-1 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge label={alert.severityLabel} tone={SEVERITY_TONES[alert.severity] ?? 'neutral'} />
        {isLinkableAppPath(alert.actionPath) ? (
          <Link href={alert.actionPath} className="font-medium underline-offset-4 hover:underline">
            {alert.title}
          </Link>
        ) : (
          <span className="font-medium">{alert.title}</span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{alert.message}</p>
      <p className="text-xs text-muted-foreground">
        {alert.typeLabel}
        {showCompany ? ` · ${alert.companyName}` : ''}
        {alert.vehicleCode ? ` · ${alert.vehicleCode}` : ''} · déclenchée le {formatDateTime(alert.triggeredAt, timezone)} · responsable : {alert.responsibleName}
      </p>
    </li>
  );
}
