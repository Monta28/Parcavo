// Types des réponses de l'API télématique F11 (apps/api/src/modules/telemetry/dto/*.ts et
// sync/dto/telemetry-sync.dto.ts) et libellés d'affichage. Aucune règle de calcul ici : états, natures,
// estimations, dérives et qualifications sont toujours fournis par l'API.

export type ProviderKind = 'TRACCAR' | 'WIALON' | 'RAPPORT_GENERIQUE' | 'WEBHOOK_GENERIQUE' | 'RPA' | 'SIMULATEUR';
export type ProviderChannel = 'API' | 'RAPPORT' | 'RPA' | 'WEBHOOK';
export type ProviderStatus = 'BROUILLON' | 'ACTIF' | 'SUSPENDU' | 'DESACTIVE';
export type CredentialKind = 'JETON_API' | 'IDENTIFIANTS_API' | 'IMAP' | 'SFTP' | 'RPA' | 'SIGNATURE_WEBHOOK';
export type MappingStatus = 'PROPOSE' | 'CONFIRME' | 'REJETE' | 'CLOTURE';
export type MappingOdometerKind = 'COMPTEUR_CAN' | 'DISTANCE_GPS' | 'AUCUN';
export type FuelKind = 'NIVEAU_CAN' | 'NIVEAU_SONDE' | 'CONSOMMATION_CAN';
export type SyncRunStatus = 'EN_COURS' | 'SUCCES' | 'PARTIEL' | 'ECHEC' | 'IGNORE';
export type UnitCategory = 'NON_ASSOCIEES' | 'PROPOSEES' | 'ASSOCIEES' | 'VEHICULES_SANS_UNITE' | 'IGNOREES';
export type UnmappedReason = 'INCONNUE' | 'IMMATRICULATION_ABSENTE' | 'AMBIGUE' | 'VEHICULE_DEJA_EQUIPE' | 'PROPOSITION_REJETEE' | 'VEHICULE_NON_ELIGIBLE' | 'A_REEXAMINER' | 'IGNOREE';
export type FuelEventStatus = 'A_QUALIFIER' | 'QUALIFIE';
export type FuelEventQualification = 'JUSTIFIE' | 'ANOMALIE_CONFIRMEE' | 'ERREUR_CAPTEUR';

/** GET /telemetry/provider-kinds (administrateur). */
export interface ProviderKindView {
  kind: ProviderKind;
  label: string;
  channel: ProviderChannel;
  available: boolean;
  reason: string | null;
}

export interface CredentialStatus {
  kind: CredentialKind;
  configured: boolean;
  rotatedAt: string | null;
  /** SIGNATURE_WEBHOOK : l'ancien secret reste accepté jusqu'à cette date après une rotation. */
  previousValidUntil?: string | null;
}

export type WebhookDeliveryStatus = 'EN_ATTENTE' | 'EN_COURS' | 'TRAITE' | 'IGNORE' | 'ECHEC';

/** WebhookViewDto : GET /telemetry/providers/:id/webhook (administrateur) ; jamais la valeur du secret. */
export interface WebhookView {
  providerId: string;
  url: string;
  method: 'POST';
  timestampHeader: string;
  signatureHeader: string;
  signedContent: string;
  formatVersion: number;
  maxBodyBytes: number;
  maxSamplesPerList: number;
  maxRequestsPerMinute: number;
  toleranceSeconds: number;
  rotationOverlapHours: number;
  secret: CredentialStatus;
  counts: { pending: number; receivedLast24h: number; processedLast24h: number; ignoredLast24h: number; failedLast24h: number; lastReceivedAt: string | null };
  recent: Array<{
    id: string;
    status: WebhookDeliveryStatus;
    signedAt: string;
    receivedAt: string;
    sizeBytes: number;
    units: number;
    odometers: number;
    fuel: number;
    attempts: number;
    processedAt: string | null;
    lastError: string | null;
    syncRunIds: string[];
  }>;
  notice?: string | null;
}

/** ProviderViewDto : configuration (baseUrl, settings, backfillDays, credentials) visible par l'administrateur seulement. */
export interface ProviderView {
  id: string;
  name: string;
  kind: ProviderKind;
  kindLabel: string;
  channel: ProviderChannel;
  status: ProviderStatus;
  isSimulator: boolean;
  notice: string | null;
  syncIntervalMinutes: number;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  circuitOpenUntil: string | null;
  lastErrorSummary: string | null;
  companyIds: string[];
  version: number;
  configurationVisible: boolean;
  baseUrl?: string | null;
  settings?: Record<string, unknown>;
  backfillDays?: number;
  credentials?: CredentialStatus[];
  createdAt?: string;
}

export interface ProviderHealthView {
  ok: boolean;
  message: string;
  latencyMs: number | null;
  checkedAt: string;
}

/** CompanyTelemetryViewDto : GET /telemetry/companies, POST /telemetry/companies/:id/enable|disable. */
export interface CompanyTelemetryView {
  companyId: string;
  code: string;
  legalName: string;
  telemetryEnabled: boolean;
  providers: Array<{ id: string; name: string; kind: ProviderKind; kindLabel: string; status: ProviderStatus }>;
  version: number;
  resolvedAlerts?: number;
}

export interface UnitView {
  id: string;
  providerId: string;
  providerName: string;
  providerKind: ProviderKind;
  isSimulator: boolean;
  externalId: string;
  label: string;
  declaredRegistration: string | null;
  registrationNormalized: string | null;
  presentAtProvider: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Unité ignorée (D-249) : ni proposition ni alerte « unité non associée ». */
  ignoredAt: string | null;
  ignoredById: string | null;
  ignoredReason: string | null;
}

export interface VehicleRef {
  id: string;
  code: string;
  registration: string;
  companyId: string;
  lifecycleStatus: string;
}

export interface MappingView {
  id: string;
  providerId: string;
  providerName: string;
  isSimulator: boolean;
  unitId: string;
  unitExternalId: string;
  unitLabel: string;
  unitDeclaredRegistration: string | null;
  vehicle: VehicleRef;
  companyId: string;
  status: MappingStatus;
  odometerKind: MappingOdometerKind;
  fuelKinds: FuelKind[];
  validFrom: string | null;
  validTo: string | null;
  proposedAt: string;
  proposalReason: string | null;
  decidedAt: string | null;
  decidedById: string | null;
  closedReason: string | null;
  version: number;
}

export interface UnitRow {
  category: UnitCategory;
  unit: UnitView | null;
  mapping: MappingView | null;
  vehicle: VehicleRef | null;
  unmappedReason: UnmappedReason | null;
}

export interface UnitsPage {
  items: UnitRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: { nonAssociees: number; proposees: number; associees: number; vehiculesSansUnite: number; ignorees: number };
}

export interface DiscoveryResult {
  syncRunId: string;
  unitsSeen: number;
  unitsCreated: number;
  unitsUpdated: number;
  unitsMissing: number;
  proposalsCreated: number;
  proposalsPending: number;
  /** Unités non associées, hors unités ignorées. */
  unmapped: number;
  /** Unités ignorées (D-249) : aucune proposition. */
  ignored: number;
  rejectedUnits: number;
}

export interface CloseMappingResult {
  closed: MappingView;
  replacement: MappingView | null;
}

export interface SyncRunView {
  id: string;
  providerId: string;
  providerName: string;
  companyId: string | null;
  trigger: string;
  status: SyncRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  unitsSeen: number;
  odometerSamples: number;
  readingsCreated: number;
  readingsPending: number;
  duplicatesIgnored: number;
  fuelSamples: number;
  fuelEventsCreated: number;
  errorCount: number;
  errorSummary: string | null;
  requestedById: string | null;
}

/** POST /telemetry/providers/:id/sync (202). */
export interface ManualSyncResult {
  providerId: string;
  runs: Array<{ syncRunId: string | null; companyId: string; trigger: string; status: SyncRunStatus; alreadyRunning: boolean; message: string | null }>;
}

export interface FuelEventView {
  id: string;
  /** Événement issu d'un fournisseur SIMULATEUR : affiché « SIMULATEUR — données fictives » (D-303). */
  isSimulator: boolean;
  companyId: string;
  vehicleId: string;
  vehicleCode: string;
  vehicleRegistration: string;
  unitId: string | null;
  type: 'REMPLISSAGE_DETECTE' | 'BAISSE_ANORMALE' | 'ECART_TICKET';
  typeLabel: string;
  measureKind: FuelKind;
  measureKindLabel: string;
  detectedAt: string;
  windowStart: string;
  windowEnd: string;
  litersDelta: string | null;
  percentDelta: string | null;
  fuelEntryId: string | null;
  status: FuelEventStatus;
  qualification: FuelEventQualification | null;
  qualifiedAt: string | null;
  qualifiedById: string | null;
  qualificationNote: string | null;
  details: Record<string, unknown> | null;
  version: number;
}

/** GET /telemetry/vehicles/:vehicleId — panneau télématique de la fiche véhicule. */
export interface VehicleCalibrationView {
  id: string;
  status: 'CALIBRE' | 'NON_CALIBRABLE';
  referenceAt: string;
  referenceKm: string;
  estimatedKmAtReference: string | null;
  distanceSincePreviousKm: string | null;
  deviationKm: string | null;
  deviationPercent: string | null;
  deviationPercentLabel: string | null;
  driftAlertRaised: boolean;
  statusReason: string | null;
}

export interface VehicleTelemetryView {
  vehicleId: string;
  vehicleCode: string;
  companyId: string;
  telemetryEnabled: boolean;
  mapping: MappingView | null;
  pendingProposals: number;
  provider: {
    id: string;
    name: string;
    kind: ProviderKind;
    kindLabel: string;
    isSimulator: boolean;
    status: ProviderStatus;
    lastSuccessAt: string | null;
    consecutiveFailures: number;
    circuitOpenUntil: string | null;
  } | null;
  lastObservation: {
    odometerKm: string | null;
    odometerKind: 'COMPTEUR_CAN' | 'DISTANCE_GPS' | null;
    odometerObservedAt: string | null;
    fuelKind: FuelKind | null;
    fuelLiters: string | null;
    fuelPercent: string | null;
    fuelObservedAt: string | null;
    receivedAt: string | null;
  } | null;
  lastEstimate: {
    readingId: string;
    cumulativeKm: string;
    gpsDistanceKm: string | null;
    observedAt: string;
    label: string | null;
    referenceAt: string | null;
    referenceKm: string | null;
  } | null;
  lastCalibration: VehicleCalibrationView | null;
  lastDrift: VehicleCalibrationView | null;
}

// ---------------------------------------------------------------------------------------------
// Libellés d'affichage (toujours accompagnés d'un texte, CDC 10.1)
// ---------------------------------------------------------------------------------------------

/** Libellé imposé au simulateur partout où il apparaît (D-303). */
export const SIMULATOR_LABEL = 'SIMULATEUR — données fictives';

export const PROVIDER_STATUS_LABELS: Record<ProviderStatus, string> = { BROUILLON: 'Brouillon', ACTIF: 'Actif', SUSPENDU: 'Suspendu', DESACTIVE: 'Désactivé' };

export const CREDENTIAL_KIND_LABELS: Record<CredentialKind, string> = {
  JETON_API: 'Jeton d’API',
  IDENTIFIANTS_API: 'Identifiants d’API',
  IMAP: 'Accès boîte e-mail (IMAP)',
  SFTP: 'Accès SFTP',
  RPA: 'Compte portail (RPA)',
  SIGNATURE_WEBHOOK: 'Secret de signature du webhook',
};

/** Format attendu du secret, rappelé à côté du champ (le contrôle réel est fait par l'API). */
export const CREDENTIAL_FORMAT_HINTS: Record<CredentialKind, string> = {
  JETON_API: 'Jeton brut du compte de lecture dédié.',
  IDENTIFIANTS_API: 'Format « identifiant:motdepasse » (compte de lecture dédié).',
  IMAP: 'Format « identifiant:motdepasse » de la boîte dédiée.',
  SFTP: 'Format « identifiant:motdepasse », ou « identifiant: » suivi de la clé privée PEM.',
  RPA: 'Non accepté en V1.',
  SIGNATURE_WEBHOOK: '32 à 256 caractères imprimables sans espace, fourni par le fournisseur ; ou générez-le dans la section « Réception webhook ». Un remplacement est une rotation : l’ancien secret reste accepté pendant la période de recouvrement.',
};

export const WEBHOOK_DELIVERY_STATUS_LABELS: Record<WebhookDeliveryStatus, string> = {
  EN_ATTENTE: 'En attente',
  EN_COURS: 'En cours',
  TRAITE: 'Ingéré',
  IGNORE: 'Ignoré (non ingéré)',
  ECHEC: 'En échec',
};

export const MAPPING_STATUS_LABELS: Record<MappingStatus, string> = { PROPOSE: 'Proposée', CONFIRME: 'Confirmée', REJETE: 'Rejetée', CLOTURE: 'Clôturée' };

export const MAPPING_ODOMETER_KIND_LABELS: Record<MappingOdometerKind, string> = {
  COMPTEUR_CAN: 'Compteur CAN',
  DISTANCE_GPS: 'Distance GPS (estimation calibrée)',
  AUCUN: 'Aucun kilométrage',
};

/** Nature d'une valeur brute reçue du fournisseur (dernière observation) : jamais une estimation calibrée. */
export const OBSERVED_ODOMETER_KIND_LABELS: Record<Exclude<MappingOdometerKind, 'AUCUN'>, string> = {
  COMPTEUR_CAN: 'Compteur CAN lu par le boîtier',
  DISTANCE_GPS: 'Distance GPS brute du fournisseur, non calibrée',
};

export const MAPPING_ODOMETER_KIND_HELP: Record<MappingOdometerKind, string> = {
  COMPTEUR_CAN: 'Valeur du compteur du tableau de bord lue sur le bus CAN/FMS : traitée comme un compteur physique.',
  DISTANCE_GPS: 'Odomètre virtuel calculé à partir des positions : converti en kilométrage « estimé GPS » à partir des relevés manuels, jamais présenté comme le compteur.',
  AUCUN: 'Aucun kilométrage n’est ingéré pour ce véhicule (carburant seul, par exemple).',
};

export const FUEL_KIND_HELP: Record<FuelKind, string> = {
  NIVEAU_CAN: 'Jauge lue sur le bus CAN : tendance et contrôle grossier seulement.',
  NIVEAU_SONDE: 'Sonde de réservoir étalonnée : seule nature exploitable pour détecter une baisse anormale.',
  CONSOMMATION_CAN: 'Compteur de litres consommés fourni par le calculateur.',
};

export const SYNC_RUN_STATUS_LABELS: Record<SyncRunStatus, string> = { EN_COURS: 'En cours', SUCCES: 'Réussie', PARTIEL: 'Partielle', ECHEC: 'En échec', IGNORE: 'Ignorée' };

export const SYNC_TRIGGER_LABELS: Record<string, string> = {
  PLANIFIE: 'Planifiée',
  MANUEL: 'Manuelle',
  REPRISE_INITIALE: 'Reprise initiale',
  WEBHOOK: 'Webhook',
};

export const UNMAPPED_REASON_LABELS: Record<UnmappedReason, string> = {
  INCONNUE: 'Immatriculation inconnue parmi les véhicules éligibles de votre périmètre',
  IMMATRICULATION_ABSENTE: 'Aucune immatriculation déclarée par le fournisseur',
  AMBIGUE: 'Correspondance ambiguë (plusieurs véhicules ou unités)',
  VEHICULE_DEJA_EQUIPE: 'Le véhicule correspondant a déjà une unité associée',
  PROPOSITION_REJETEE: 'Proposition rejetée pour ce véhicule',
  VEHICULE_NON_ELIGIBLE: 'Véhicule non éligible (société non couverte ou sans module, véhicule non actif)',
  A_REEXAMINER: 'Correspondance possible : relancez la découverte pour créer la proposition',
  IGNOREE: 'Unité ignorée (volontairement sans véhicule)',
};

export const FUEL_EVENT_STATUS_LABELS: Record<FuelEventStatus, string> = { A_QUALIFIER: 'À qualifier', QUALIFIE: 'Qualifié' };

export const FUEL_EVENT_QUALIFICATION_LABELS: Record<FuelEventQualification, string> = {
  JUSTIFIE: 'Justifié',
  ANOMALIE_CONFIRMEE: 'Anomalie confirmée',
  ERREUR_CAPTEUR: 'Erreur de capteur',
};

export const FUEL_EVENT_QUALIFICATION_HELP: Record<FuelEventQualification, string> = {
  JUSTIFIE: 'L’événement a une explication (plein saisi, opération connue).',
  ANOMALIE_CONFIRMEE: 'L’anomalie est avérée : à traiter hors de l’application (aucune dépense ni retenue n’est créée).',
  ERREUR_CAPTEUR: 'La mesure est erronée (sonde, jauge, transmission).',
};

export const CALIBRATION_STATUS_LABELS: Record<VehicleCalibrationView['status'], string> = { CALIBRE: 'Calibré', NON_CALIBRABLE: 'Non calibrable' };

// ---------------------------------------------------------------------------------------------
// Seuils carburant propres à un véhicule (GET/PUT /telemetry/vehicles/:id/fuel-thresholds ; D-238, D-240)
// ---------------------------------------------------------------------------------------------

export type FuelThresholdSource = 'vehicule' | 'societe' | 'groupe' | 'defaut';
export type FuelThresholdField = 'dropLiters' | 'dropPercent' | 'dropWindowMinutes' | 'fillLiters' | 'fillPercent' | 'fillWindowMinutes';

export interface VehicleFuelThresholdRow {
  field: FuelThresholdField;
  key: string;
  label: string;
  unit: string | null;
  /** Surcharge du véhicule (null : valeur de la société). */
  vehicleValue: number | null;
  companyValue: number;
  companySource: Exclude<FuelThresholdSource, 'vehicule'>;
  /** Valeur appliquée par la détection, choisie par l'API. */
  effectiveValue: number;
  source: FuelThresholdSource;
  min: number | null;
  max: number | null;
}

export interface VehicleFuelThresholdsView {
  vehicleId: string;
  vehicleCode: string;
  companyId: string;
  /** Version des seuils du véhicule (0 : aucune surcharge) ; verrou optimiste. */
  version: number;
  reason: string | null;
  updatedAt: string | null;
  updatedByName: string | null;
  canEdit: boolean;
  thresholds: VehicleFuelThresholdRow[];
}

export const FUEL_THRESHOLD_SOURCE_LABELS: Record<FuelThresholdSource, string> = {
  vehicule: 'Propre au véhicule',
  societe: 'Surcharge de la société',
  groupe: 'Valeur du groupe',
  defaut: 'Valeur initiale',
};
