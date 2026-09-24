// Types des réponses de l'API responsables habituels (apps/api/src/modules/assignments, AssignmentViewDto)
// utilisés par le web. Aucune règle de période ici : `status`, `isCurrent` et `canEnd` sont calculés par l'API.
import { ASSIGNMENT_STATUS_LABELS } from '@parc-auto/contracts';

/** État d'une affectation à l'instant de la réponse (A_VENIR, EN_COURS, TERMINEE), calculé par l'API. */
export type AssignmentStatus = keyof typeof ASSIGNMENT_STATUS_LABELS;

/** Affectation habituelle (GET /responsible-assignments, POST, POST /:id/end). */
export interface AssignmentView {
  id: string;
  companyId: string;
  vehicleId: string;
  vehicleCode: string;
  driverId: string;
  driverName: string;
  startsAt: string;
  /** Fin de la responsabilité ; null si aucune fin n'est prévue. */
  endsAt: string | null;
  notes: string | null;
  /** Motif de fin saisi à la clôture (ou remplacement explicite). */
  endReason: string | null;
  status: AssignmentStatus;
  /** Équivaut à status = EN_COURS (calculé par l'API). */
  isCurrent: boolean;
  /** Vrai si l'utilisateur peut terminer l'affectation (non terminée et droits suffisants, calculé par l'API). */
  canEnd: boolean;
  /**
   * Champs que l'utilisateur peut modifier (PATCH /responsible-assignments/:id), calculés par l'API : tous pour une
   * affectation à venir, fin prévue et notes pour une affectation en cours, aucun sinon.
   */
  editableFields: Array<'driverId' | 'startsAt' | 'endsAt' | 'notes'>;
  version: number;
}

type Tone = 'neutral' | 'success' | 'info';

const STATUS_TONES: Record<AssignmentStatus, Tone> = { A_VENIR: 'info', EN_COURS: 'success', TERMINEE: 'neutral' };

/** Libellé et ton du statut calculé par l'API (jamais déduit des dates côté client). */
export function assignmentState(a: Pick<AssignmentView, 'status'>): { label: string; tone: Tone } {
  return { label: ASSIGNMENT_STATUS_LABELS[a.status], tone: STATUS_TONES[a.status] };
}

/** Rappel CDC 4.1, affiché partout où le responsable habituel apparaît. */
export const RESPONSIBLE_REMINDER = 'Le responsable habituel n’est pas une preuve de conduite.';
