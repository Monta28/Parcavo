// Types des réponses de l'API centre d'alertes (apps/api/src/modules/alerts, AlertViewDto, AlertCountsDto).
import type { ALERT_SEVERITY_LABELS, ALERT_TYPE_LABELS } from '@parc-auto/contracts';

export type AlertType = keyof typeof ALERT_TYPE_LABELS;
export type AlertSeverity = keyof typeof ALERT_SEVERITY_LABELS;
export type AlertStatus = 'ACTIVE' | 'RESOLUE';
/** Filtre des reports de l'utilisateur courant (GET /alerts?snoozed=). */
export type AlertSnoozeFilter = 'include' | 'exclude' | 'only';

export const ALERT_STATUS_LABELS: Record<AlertStatus, string> = {
  ACTIVE: 'Active',
  RESOLUE: 'Résolue',
};

export const ALERT_SNOOZE_FILTER_LABELS: Record<AlertSnoozeFilter, string> = {
  include: 'Reportées incluses',
  exclude: 'Sans mes reports',
  only: 'Mes reports uniquement',
};

/** Gravités de la plus grave à la moins grave (ordre d'affichage des compteurs). */
export const ALERT_SEVERITY_ORDER: readonly AlertSeverity[] = ['CRITIQUE', 'URGENT', 'ATTENTION', 'INFO'];

export interface AlertSnoozeInfo {
  userId: string;
  userName: string;
  until: string;
  reason: string;
}

export interface AlertView {
  id: string;
  type: AlertType;
  typeLabel: string;
  severity: AlertSeverity;
  severityLabel: string;
  status: AlertStatus;
  companyId: string;
  companyName: string;
  /** Type de l'objet concerné (Vehicle, VehicleMaintenancePlan, DocumentVersion…). */
  objectType: string;
  objectId: string;
  vehicleId: string | null;
  vehicleCode: string | null;
  vehicleRegistration: string | null;
  title: string;
  message: string;
  condition: unknown;
  /** Chemin de l'application vers l'action utile, fourni par l'API. */
  actionPath: string;
  responsibleUserId: string | null;
  responsibleName: string;
  triggeredAt: string;
  lastEvaluatedAt: string;
  resolvedAt: string | null;
  resolutionReason: string | null;
  version: number;
  /** Lu par l'utilisateur courant. */
  readAt: string | null;
  /** Report de l'utilisateur courant (date civile incluse). */
  snoozedUntil: string | null;
  snoozeReason: string | null;
  /** Reports en cours de tous les destinataires (motif et auteur). */
  snoozes: AlertSnoozeInfo[];
  /** L'utilisateur courant peut reporter cette alerte (rôle opérationnel, alerte active). */
  canSnooze: boolean;
}

export interface AlertCounts {
  total: number;
  bySeverity: Record<AlertSeverity, number>;
  unread: number;
  snoozed: number;
}
