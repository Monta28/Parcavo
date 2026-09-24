// Types des réponses de l'API utilisations (apps/api/src/modules/usages, UsageViewDto) utilisés par le web.

export type UsageStatus = 'EN_COURS' | 'TERMINEE';

/** Vue utilisation (GET /usages, GET /usages/:id) : champs affichés par le web. `isLate` est calculé par l'API. */
export interface UsageView {
  id: string;
  companyId: string;
  vehicleId: string;
  vehicleCode: string;
  vehicleRegistration: string;
  driverId: string;
  driverName: string;
  status: UsageStatus;
  purpose: string;
  checkedOutAt: string;
  expectedReturnAt: string;
  returnedAt: string | null;
  isLate: boolean;
  distanceStatus: 'VALIDEE' | 'NON_VALIDEE' | 'INDETERMINEE';
  distanceKm: string | null;
  version: number;
}

export type FuelGauge = 'VIDE' | 'QUART' | 'DEMI' | 'TROIS_QUARTS' | 'PLEIN';
export type UsageReadingStatus = 'EN_ATTENTE' | 'ACCEPTE' | 'REJETE' | 'REMPLACE';

/** Relevé de départ ou de retour rattaché à l'utilisation (statut fourni par l'API). */
export interface UsageReadingRef {
  id: string;
  physicalKm: string | null;
  cumulativeKm: string | null;
  status: UsageReadingStatus;
  observedAt: string;
}

/** Élément de checklist enregistré (clés, documents, accessoires). */
export interface UsageChecklistEntry {
  label: string;
  present: boolean;
  comment?: string | null;
}

/** Vue complète d'une utilisation (GET /usages/:id, réponses de remise, restitution et prolongation). */
export interface UsageDetailView extends UsageView {
  checkoutReading: UsageReadingRef | null;
  returnReading: UsageReadingRef | null;
  checkoutWithoutReading: boolean;
  checkoutExceptionReason: string | null;
  returnWithoutReading: boolean;
  returnExceptionReason: string | null;
  documentOverrideReason: string | null;
  checkoutFuelGauge: FuelGauge | null;
  returnFuelGauge: FuelGauge | null;
  /** JSON enregistré tel quel par l'API (liste d'éléments de checklist). */
  checkoutChecklist: unknown;
  returnChecklist: unknown;
  checkoutNotes: string | null;
  returnNotes: string | null;
  checkoutConfirmedBy: string | null;
  returnConfirmedBy: string | null;
  reservationId: string | null;
  checkoutLocation: string | null;
  returnLocation: string | null;
  /** Incident de dommage ouvert lors de la restitution (le retour ne le clôture pas). */
  damageIncident: { id: string; reference: string } | null;
  /**
   * Vrai si la distance non validée peut être régularisée (POST /usages/:id/return-reading) : règle calculée
   * par l'API (restituée, départ accepté, retour sans relevé ou relevé rejeté) ; la permission est contrôlée à l'appel.
   */
  returnReadingRegularizable: boolean;
  photoAttachmentIds: string[];
  checkedOutByName: string | null;
  returnedByName: string | null;
}

/** Blocage renvoyé par GET /usages/checkout-preview ; `overridable` : levable par dérogation motivée. */
export interface CheckoutBlocker {
  code: string;
  message: string;
  overridable: boolean;
}

export interface ConflictingReservation {
  id: string;
  startAt: string;
  endAt: string;
  driverName: string;
}

/** Contrôles préalables à une remise (GET /usages/checkout-preview). */
export interface CheckoutPreview {
  blockers: CheckoutBlocker[];
  lastReading: { physicalKm: string | null; observedAt: string } | null;
  telematicsHint: { valueKm: string; kind: string; observedAt: string } | null;
  checklistItems: string[];
  conflictingReservations: ConflictingReservation[];
}

/** Compteur courant du véhicule (GET /vehicles/:id/odometer) : dernier relevé accepté et fraîcheur calculés par l'API. */
export interface CurrentOdometerView {
  reading: {
    id: string;
    physicalKm: string | null;
    cumulativeKm: string | null;
    isEstimate: boolean;
    source: string;
    measurementKind: string;
    status: string;
    observedAt: string;
  } | null;
  freshness: 'INCONNU' | 'A_ACTUALISER' | 'A_JOUR';
  ageDays: number | null;
  cumulativeKnown: boolean;
  openSegmentId: string | null;
  pendingCount: number;
  lastTelematicsHint: { valueKm: string; kind: string; observedAt: string } | null;
}

/** Paramètre effectif (GET /settings?companyId=) : la checklist vient de `usage.checklistItems`. */
export interface EffectiveSettingView {
  key: string;
  label: string;
  unit: string | null;
  value: unknown;
  source: 'defaut' | 'groupe' | 'societe';
  settingVersion: number | null;
  companyOverride: boolean;
}
