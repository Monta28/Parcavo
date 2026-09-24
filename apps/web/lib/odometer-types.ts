// Types des réponses de l'API kilométrage (apps/api/src/modules/odometer/dto/odometer.dto.ts) utilisés par le web.
// Aucune règle de calcul ici : cumul, fraîcheur et statuts sont toujours fournis par l'API.

export type ReadingStatus = 'EN_ATTENTE' | 'ACCEPTE' | 'REJETE' | 'REMPLACE';
export type ReadingSource = 'MANUAL' | 'IMPORT' | 'TELEMATICS';
export type FreshnessStatus = 'INCONNU' | 'A_ACTUALISER' | 'A_JOUR';

/** Contextes saisissables depuis l'interface (CreateReadingDto.context) ; remise et restitution passent par /usages. */
export const MANUAL_READING_CONTEXTS = ['RELEVE_LIBRE', 'CARBURANT', 'ENTRETIEN', 'TRANSFERT'] as const;
export type ManualReadingContext = (typeof MANUAL_READING_CONTEXTS)[number];

/** Relevé (ReadingViewDto) : GET /readings, GET /vehicles/:id/readings, réponses d'approbation, rejet et correction. */
export interface ReadingView {
  id: string;
  vehicleId: string;
  vehicleCode: string;
  companyId: string;
  segmentId: string;
  segmentSequence: number;
  source: ReadingSource;
  context: string;
  measurementKind: 'COMPTEUR_AFFICHE' | 'COMPTEUR_CAN' | 'DISTANCE_GPS';
  status: ReadingStatus;
  physicalKm: string | null;
  cumulativeKm: string | null;
  isEstimate: boolean;
  gpsDistanceKm: string | null;
  observedAt: string;
  enteredAt: string;
  statusReason: string | null;
  anomalyCode: string | null;
  attachmentId: string | null;
  note: string | null;
  replacesReadingId: string | null;
  replacedByReadingId: string | null;
  correctionReason: string | null;
  authorName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  channel: string | null;
  version: number;
}

/** Segment de compteur (SegmentViewDto) : GET/POST /vehicles/:id/odometer-segments. */
export interface SegmentView {
  id: string;
  sequence: number;
  startedAt: string;
  endedAt: string | null;
  startPhysicalKm: string;
  startCumulativeKm: string;
  cumulativeKnown: boolean;
  lastPhysicalKm: string | null;
  replacementReason: string | null;
  justificationAttachmentId: string | null;
}

/** Compteur courant (CurrentOdometerDto) : GET /vehicles/:id/odometer. */
export interface OdometerCurrentView {
  reading: ReadingView | null;
  freshness: FreshnessStatus;
  ageDays: number | null;
  cumulativeKnown: boolean;
  openSegmentId: string | null;
  pendingCount: number;
  lastTelematicsHint: { valueKm: string; kind: string; observedAt: string } | null;
}

/** Résultat d'une saisie unitaire (IngestResultDto) : POST /vehicles/:id/readings. */
export interface IngestResult {
  reading: ReadingView;
  outcome: 'ACCEPTE' | 'EN_ATTENTE' | 'IDEMPOTENT';
  anomaly: { code: string; reason: string } | null;
}

/** Résultat par ligne de la saisie rapide (BatchResultItemDto) : POST /readings/batch. */
export interface BatchResultItem {
  vehicleId: string;
  outcome: 'ACCEPTE' | 'EN_ATTENTE' | 'IDEMPOTENT' | 'REFUSE';
  readingId: string | null;
  code: string | null;
  message: string | null;
}
