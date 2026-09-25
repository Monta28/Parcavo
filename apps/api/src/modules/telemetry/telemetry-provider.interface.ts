/**
 * Contrat unique des canaux télématiques (CDC 14.3 ; D-292, D-294). Chaque adaptateur (TRACCAR, WIALON,
 * RAPPORT_GENERIQUE, SIMULATEUR) l'implémente ; le service de synchronisation ne connaît que ce contrat.
 *
 * Normalisation imposée à l'adaptateur :
 *  - kilomètres en chaîne décimale à 3 décimales au plus (mètres convertis par l'adaptateur) ;
 *  - observedAt = instant UTC fourni par le fournisseur ; un échantillon sans horodatage fournisseur est
 *    rejeté (receivedAt ne remplace jamais observedAt) ;
 *  - sourceReference = identifiant stable du fournisseur pour l'échantillon s'il existe (idempotence
 *    D-184/D-195), sinon null (repli sur unité + instant + valeur) ;
 *  - aucune valeur inventée : une mesure absente est omise, jamais remplacée par 0.
 */

import type { Clock } from '../../common/clock.js';

export type ProviderOdometerKind = 'COMPTEUR_CAN' | 'DISTANCE_GPS';
export type ProviderFuelKind = 'NIVEAU_CAN' | 'NIVEAU_SONDE' | 'CONSOMMATION_CAN';

/** Unité (boîtier) telle que déclarée par le fournisseur. */
export interface ProviderUnit {
  /** Identifiant de l'unité chez le fournisseur (stable). */
  externalId: string;
  label: string;
  /** Immatriculation déclarée chez le fournisseur, si renseignée. */
  declaredRegistration: string | null;
  /** Natures de mesure que l'unité remonte réellement (constatées dans les données du fournisseur). */
  odometerKinds: ProviderOdometerKind[];
  fuelKinds: ProviderFuelKind[];
}

export interface OdometerSample {
  unitExternalId: string;
  kind: ProviderOdometerKind;
  /** Kilomètres, chaîne décimale (ex. « 80450.125 »). */
  valueKm: string;
  observedAt: Date;
  sourceReference: string | null;
}

export interface FuelSample {
  unitExternalId: string;
  kind: ProviderFuelKind;
  /** Litres (chaîne décimale) si le fournisseur les donne. */
  liters: string | null;
  /** Pourcentage de niveau (chaîne décimale) si le fournisseur le donne. */
  percent: string | null;
  engineOn: boolean | null;
  speedKmh: string | null;
  observedAt: Date;
  sourceReference: string | null;
}

export interface ProviderHealth {
  ok: boolean;
  /** Message expurgé (jamais de secret, d'URL avec jeton ni de corps de réponse brut). */
  message: string;
  /** Latence mesurée en millisecondes, si un appel a été fait. */
  latencyMs: number | null;
  checkedAt: Date;
}

/** Erreur fournisseur typée : sert aux reprises, au respect des quotas et au coupe-circuit (D-297). */
export class ProviderError extends Error {
  constructor(
    readonly kind: 'AUTHENTIFICATION' | 'QUOTA' | 'INJOIGNABLE' | 'REPONSE_INVALIDE' | 'CONFIGURATION',
    message: string,
    /** Délai demandé par le fournisseur (en-tête Retry-After), en secondes. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * Compteurs d'un adaptateur pour l'exécution en cours (TelemetrySyncRun.errorCount / errorSummary) :
 * valeurs écartées par motif, jamais de secret ni de contenu brut du fournisseur.
 */
export interface AdapterDiagnostics {
  /** Valeurs ou lignes écartées (jamais remplacées), par motif en français. */
  rejected: Record<string, number>;
  /** Canal RAPPORT : fichiers lus, déjà traités (empreinte connue), illisibles, et lignes lues. */
  files?: { read: number; alreadyProcessed: number; unreadable: number; rows: number };
}

export interface TelemetryProvider {
  /**
   * Vrai lorsque listUnits ne connaît que les unités présentes dans les données reçues (canal RAPPORT) :
   * une unité absente de la liste n'a pas pour autant disparu chez le fournisseur.
   */
  readonly partialUnitList?: boolean;
  listUnits(): Promise<ProviderUnit[]>;
  /**
   * Dernier état connu des compteurs des unités demandées, trié par observedAt (canal RAPPORT : tous les
   * relevés des fichiers nouveaux, le lot n'ayant pas d'« état courant »).
   */
  getOdometers(unitExternalIds: string[]): Promise<OdometerSample[]>;
  /** Historique des compteurs (reprise initiale, calibrage) ; absent si le canal ne le permet pas (D-294). */
  getOdometerHistory?(unitExternalIds: string[], from: Date, to: Date): Promise<OdometerSample[]>;
  getFuel(unitExternalIds: string[], from: Date, to: Date): Promise<FuelSample[]>;
  healthCheck(): Promise<ProviderHealth>;
  /**
   * Canal RAPPORT : à appeler après l'ingestion réussie des échantillons renvoyés pendant l'exécution.
   * L'adaptateur inscrit alors les fichiers au registre (SHA-256) puis les marque lus ou les déplace chez
   * la source. Sans acquittement (échec du run), les fichiers restent à traiter et sont relus au run
   * suivant ; l'idempotence ligne par ligne évite tout doublon (D-184).
   */
  acknowledge?(): Promise<void>;
  /** Valeurs écartées depuis la création de l'adaptateur (compteurs du run). */
  diagnostics?(): AdapterDiagnostics;
  /** Libération des ressources (session fournisseur, connexion IMAP/SFTP). */
  close?(): Promise<void>;
}

/** Configuration résolue d'un fournisseur, secrets déchiffrés en mémoire uniquement le temps de l'appel. */
export interface AdapterConfig {
  providerId: string;
  baseUrl: string | null;
  /** Paramètres non secrets (TelemetryProvider.settings). */
  settings: Record<string, unknown>;
  /** Secrets déchiffrés par nature (JETON_API, IDENTIFIANTS_API, IMAP, SFTP) ; jamais journalisés. */
  secrets: Partial<Record<'JETON_API' | 'IDENTIFIANTS_API' | 'IMAP' | 'SFTP', string>>;
  /** Délai maximal d'un appel réseau. */
  timeoutMs: number;
  /** Fuseau de l'organisation : horodatages de rapports sans décalage interprétés en heure locale. */
  timezone: string;
  /** Registre des fichiers de rapport déjà traités (canal RAPPORT, TelemetryReportFile) fourni par le service. */
  reportLedger?: ReportLedger;
  /** Lots reçus par webhook (canal WEBHOOK, TelemetryWebhookDelivery) : découverte des unités et état. */
  webhookInbox?: WebhookInbox;
  /** Horloge du service (instant des contrôles de santé) ; horloge système à défaut. */
  clock?: Clock;
}

/** Idempotence des fichiers de rapport (canal RAPPORT) : empreinte SHA-256 par fournisseur. */
export interface ReportLedger {
  isProcessed(sha256: string): Promise<boolean>;
  markProcessed(file: { sourceName: string; sha256: string; rowCount: number }): Promise<void>;
}

/**
 * File des lots reçus par webhook (canal WEBHOOK, D-298), en lecture seule pour l'adaptateur : les lots
 * ne sont ingérés que par le worker (TelemetrySyncService.runWebhooks), jamais à la demande.
 */
export interface WebhookInbox {
  /** Contenus normalisés des lots reçus récemment (fenêtre et nombre bornés), pour lister les unités vues. */
  recentPayloads(): Promise<unknown[]>;
  status(): Promise<WebhookInboxStatus>;
}

export interface WebhookInboxStatus {
  signingSecretConfigured: boolean;
  receivedLast24h: number;
  pending: number;
  failedLast24h: number;
  lastReceivedAt: Date | null;
}

export type AdapterFactory = (config: AdapterConfig) => TelemetryProvider;
