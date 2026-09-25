// Paramètres non secrets documentés par type de fournisseur (docs/connecteur-telematique.md, section
// « Canaux et adaptateurs »). Ce fichier ne décrit que la saisie : la validation réelle est faite par
// l'API avec les analyseurs des adaptateurs (parseTraccarSettings, parseWialonSettings,
// parseReportSettings, parseWebhookSettings, parseSimulatorScenario) et ses erreurs sont affichées telles quelles.
import type { ProviderKind } from '@/lib/telemetry-types';

type Settings = Record<string, unknown>;

interface BaseField {
  /** Chemin dans l'objet de paramètres (« imap.host »). */
  path: string;
  label: string;
  help?: string;
  placeholder?: string;
  required?: boolean;
  /** Champ affiché seulement si la condition est vraie (ex. paramètres IMAP quand source = IMAP). */
  visibleWhen?: (settings: Settings) => boolean;
}

export type SettingField =
  | (BaseField & { type: 'text' })
  | (BaseField & { type: 'integer'; min: number; max: number })
  | (BaseField & { type: 'select'; options: ReadonlyArray<{ value: string; label: string }>; defaultLabel: string })
  | (BaseField & { type: 'boolean' })
  | (BaseField & { type: 'nullable-text'; disabledLabel: string })
  | (BaseField & { type: 'list' })
  | (BaseField & { type: 'json'; rows?: number });

export interface SettingGroup {
  title: string;
  fields: readonly SettingField[];
}

export interface KindSettingsSpec {
  /** URL de base : obligatoire avant activation (API), ou sans objet (canal RAPPORT, simulateur). */
  baseUrl: { mode: 'required'; help: string; placeholder: string } | { mode: 'none' };
  intro: string;
  groups: readonly SettingGroup[];
  example: Settings;
}

const FUEL_KIND_OPTIONS = [
  { value: 'NIVEAU_CAN', label: 'NIVEAU_CAN — jauge CAN' },
  { value: 'NIVEAU_SONDE', label: 'NIVEAU_SONDE — sonde étalonnée' },
  { value: 'CONSOMMATION_CAN', label: 'CONSOMMATION_CAN — litres consommés' },
] as const;

const ODOMETER_KIND_OPTIONS = [
  { value: 'COMPTEUR_CAN', label: 'COMPTEUR_CAN — compteur du tableau de bord' },
  { value: 'DISTANCE_GPS', label: 'DISTANCE_GPS — distance calculée par GPS' },
] as const;

const API_CALLS: SettingGroup = {
  title: 'Appels à l’API',
  fields: [
    { type: 'integer', path: 'historyChunkHours', label: 'Tranche de lecture de l’historique (heures)', min: 1, max: 168, placeholder: '24', help: 'Découpe des lectures d’historique ; 24 h par défaut.' },
    { type: 'integer', path: 'maxRequestsPerMinute', label: 'Appels au plus par minute', min: 1, max: 6000, help: 'Respect du quota du fournisseur ; aucun espacement par défaut.' },
    { type: 'boolean', path: 'allowPlainHttp', label: 'Autoriser HTTP sans chiffrement', help: 'Réservé à un serveur interne ; HTTPS est exigé sinon (hôte local excepté).' },
  ],
};

const isImap = (s: Settings) => s['source'] === 'IMAP';
const isSftp = (s: Settings) => s['source'] === 'SFTP';

export const KIND_SETTINGS: Readonly<Partial<Record<ProviderKind, KindSettingsSpec>>> = {
  TRACCAR: {
    baseUrl: { mode: 'required', placeholder: 'https://traccar.exemple.tn', help: 'Racine du serveur Traccar (le suffixe /api est accepté), sans identifiant ni paramètre.' },
    intro: 'Compte Traccar dédié en lecture seule (readonly), rattaché aux seuls appareils du parc. Secret : jeton d’API (prioritaire) ou identifiants « email:motdepasse ».',
    groups: [
      {
        title: 'Identification des unités',
        fields: [
          { type: 'text', path: 'registrationSource', label: 'Source de l’immatriculation déclarée', placeholder: 'name', help: '« name », « uniqueId » ou « attribute:<clé> » (attribut de l’appareil). Défaut : name.' },
          { type: 'select', path: 'timeSource', label: 'Instant de l’échantillon', defaultLabel: 'Par défaut (fixTime)', options: [{ value: 'fixTime', label: 'fixTime' }, { value: 'deviceTime', label: 'deviceTime' }] },
          {
            type: 'integer',
            path: 'staleFixToleranceSeconds',
            label: 'Tolérance d’un horodatage GPS figé (secondes)',
            min: 0,
            max: 86400,
            placeholder: '60',
            help: 'Avec fixTime : une position dont le fixTime retarde de plus que cette durée sur deviceTime (position reçue sans nouveau point GPS) est écartée et comptée, jamais datée faussement. Défaut : 60 s.',
            visibleWhen: (s) => s['timeSource'] !== 'deviceTime',
          },
        ],
      },
      {
        title: 'Kilométrage (attributs de position en mètres)',
        fields: [
          { type: 'nullable-text', path: 'canOdometerAttribute', label: 'Attribut traité comme COMPTEUR_CAN', placeholder: 'odometer', disabledLabel: 'Nature COMPTEUR_CAN désactivée', help: 'Défaut : odometer. À désactiver si le boîtier y remonte un compteur calculé par GPS (annexe A).' },
          { type: 'nullable-text', path: 'gpsDistanceAttribute', label: 'Attribut traité comme DISTANCE_GPS', placeholder: 'totalDistance', disabledLabel: 'Nature DISTANCE_GPS désactivée', help: 'Défaut : totalDistance. Un même attribut ne peut pas porter les deux natures.' },
        ],
      },
      {
        title: 'Carburant et moteur',
        fields: [
          { type: 'text', path: 'fuelAttribute', label: 'Attribut carburant', placeholder: 'fuel', help: 'Sans lui, aucun carburant n’est collecté.' },
          { type: 'select', path: 'fuelUnit', label: 'Unité du carburant', defaultLabel: 'Non renseignée', options: [{ value: 'L', label: 'Litres (L)' }, { value: '%', label: 'Pourcentage (%)' }], help: 'Obligatoire avec un attribut carburant.', visibleWhen: (s) => Boolean(s['fuelAttribute']) || s['fuelUnit'] !== undefined },
          { type: 'select', path: 'fuelKind', label: 'Nature du carburant', defaultLabel: 'Non renseignée', options: FUEL_KIND_OPTIONS, help: 'Obligatoire avec un attribut carburant (annexe A).', visibleWhen: (s) => Boolean(s['fuelAttribute']) || s['fuelKind'] !== undefined },
          { type: 'text', path: 'ignitionAttribute', label: 'Attribut de l’état moteur', placeholder: 'ignition' },
        ],
      },
      API_CALLS,
    ],
    example: { registrationSource: 'attribute:immatriculation', fuelAttribute: 'fuel', fuelUnit: 'L', fuelKind: 'NIVEAU_SONDE' },
  },
  WIALON: {
    baseUrl: { mode: 'required', placeholder: 'https://hst-api.wialon.com', help: 'Hôte de l’API Wialon (Wialon Hosting ou installation locale) ; l’adaptateur appelle <URL>/wialon/ajax.html.' },
    intro: 'Utilisateur Wialon dédié avec droits de consultation (propriétés, messages, capteurs), sans droit de modification. Secret : jeton d’accès, envoyé dans le corps de la requête, jamais dans l’URL.',
    groups: [
      {
        title: 'Kilométrage et identification',
        fields: [
          { type: 'select', path: 'odometerKind', label: 'Nature du compteur des unités', required: true, defaultLabel: 'À choisir', options: ODOMETER_KIND_OPTIONS, help: 'Wialon calcule le compteur par GPS ou le lit sur un capteur selon son paramétrage : reprendre la réponse écrite du fournisseur (annexe A).' },
          { type: 'text', path: 'registrationSource', label: 'Source de l’immatriculation déclarée', placeholder: 'name', help: '« name », « uid », « profile:<champ> » (ex. profile:registration_plate) ou « custom:<champ> ».' },
          { type: 'json', path: 'mileageSensor', label: 'Capteur de kilométrage (JSON)', placeholder: '{ "type": "mileage" }', help: 'Active la lecture d’historique. À ne renseigner que si le compteur de l’unité repose sur ce capteur.', rows: 2 },
        ],
      },
      {
        title: 'Carburant et moteur',
        fields: [
          { type: 'json', path: 'fuelSensors', label: 'Capteurs carburant (JSON)', placeholder: '[{ "type": "fuel level", "kind": "NIVEAU_SONDE" }]', help: 'Liste de { type, name, kind } ; vide : aucun carburant collecté. Un seul capteur par nature et par unité (préciser name sinon).', rows: 3 },
          { type: 'json', path: 'engineSensor', label: 'Capteur de l’état moteur (JSON)', placeholder: '{ "type": "engine operation" }', help: 'Défaut : { "type": "engine operation" } ; null pour ne pas lire l’état moteur.', rows: 2 },
        ],
      },
      API_CALLS,
    ],
    example: { odometerKind: 'COMPTEUR_CAN', registrationSource: 'profile:registration_plate', fuelSensors: [{ type: 'fuel level', kind: 'NIVEAU_SONDE' }], mileageSensor: { type: 'mileage' } },
  },
  RAPPORT_GENERIQUE: {
    baseUrl: { mode: 'none' },
    intro: 'Rapports planifiés CSV/XLSX envoyés vers une boîte e-mail dédiée (IMAP) ou déposés sur un SFTP dédié. Secret : accès IMAP ou SFTP « identifiant:motdepasse » (SFTP : clé privée PEM acceptée).',
    groups: [
      {
        title: 'Source des rapports',
        fields: [
          { type: 'select', path: 'source', label: 'Source', required: true, defaultLabel: 'À choisir', options: [{ value: 'IMAP', label: 'Boîte e-mail (IMAP)' }, { value: 'SFTP', label: 'Répertoire SFTP' }] },
          { type: 'text', path: 'imap.host', label: 'Serveur IMAP', required: true, visibleWhen: isImap },
          { type: 'integer', path: 'imap.port', label: 'Port IMAP', min: 1, max: 65535, placeholder: '993', help: '993 en TLS implicite, 143 sinon.', visibleWhen: isImap },
          { type: 'select', path: 'imap.tls', label: 'Chiffrement', defaultLabel: 'Par défaut (implicite)', options: [{ value: 'implicite', label: 'TLS implicite' }, { value: 'starttls', label: 'STARTTLS exigé' }, { value: 'aucun', label: 'Aucun (hôte local ou serveur interne)' }], visibleWhen: isImap },
          { type: 'boolean', path: 'imap.allowUnencrypted', label: 'Autoriser IMAP sans chiffrement vers un serveur interne', visibleWhen: isImap },
          { type: 'text', path: 'imap.mailbox', label: 'Dossier lu', placeholder: 'INBOX', help: 'Messages non lus uniquement, ouverts en lecture seule jusqu’à l’acquittement.', visibleWhen: isImap },
          { type: 'select', path: 'imap.afterProcessing', label: 'Après traitement', defaultLabel: 'Par défaut (marquer lu)', options: [{ value: 'marquer_lu', label: 'Marquer lu' }, { value: 'deplacer', label: 'Déplacer' }], visibleWhen: isImap },
          { type: 'text', path: 'imap.processedMailbox', label: 'Dossier des messages traités', help: 'Obligatoire pour « Déplacer » ; créé s’il manque.', visibleWhen: (s) => isImap(s) && (s['imap'] as Settings | undefined)?.['afterProcessing'] === 'deplacer' },
          { type: 'integer', path: 'imap.maxMessages', label: 'Messages au plus par exécution', min: 1, max: 500, placeholder: '50', visibleWhen: isImap },
          { type: 'integer', path: 'imap.maxMessageMegabytes', label: 'Taille maximale d’un message (Mo)', min: 1, max: 100, placeholder: '25', visibleWhen: isImap },
          { type: 'text', path: 'sftp.host', label: 'Serveur SFTP', required: true, visibleWhen: isSftp },
          { type: 'integer', path: 'sftp.port', label: 'Port SFTP', min: 1, max: 65535, placeholder: '22', visibleWhen: isSftp },
          { type: 'text', path: 'sftp.hostKeySha256', label: 'Empreinte de la clé d’hôte', required: true, placeholder: 'SHA256:…', help: 'ssh-keyscan -p <port> <hôte> | ssh-keygen -lf - ; une clé différente est refusée.', visibleWhen: isSftp },
          { type: 'text', path: 'sftp.directory', label: 'Répertoire lu', required: true, placeholder: '/rapports', visibleWhen: isSftp },
          { type: 'select', path: 'sftp.afterProcessing', label: 'Après traitement', defaultLabel: 'Par défaut (déplacer)', options: [{ value: 'deplacer', label: 'Déplacer' }, { value: 'laisser', label: 'Laisser (écarté par son empreinte)' }], visibleWhen: isSftp },
          { type: 'text', path: 'sftp.processedDirectory', label: 'Répertoire des fichiers traités', placeholder: '<répertoire>/traites', visibleWhen: isSftp },
          { type: 'integer', path: 'sftp.maxFiles', label: 'Fichiers au plus par exécution', min: 1, max: 1000, placeholder: '100', visibleWhen: isSftp },
        ],
      },
      {
        title: 'Colonnes du fichier (en-têtes)',
        fields: [
          { type: 'text', path: 'columns.unit', label: 'Identifiant d’unité', required: true },
          { type: 'text', path: 'columns.timestamp', label: 'Horodatage', required: true },
          { type: 'text', path: 'columns.odometer', label: 'Compteur', help: 'Au moins une colonne de mesure : compteur, litres ou pourcentage.' },
          { type: 'text', path: 'columns.fuelLiters', label: 'Carburant (litres)' },
          { type: 'text', path: 'columns.fuelPercent', label: 'Carburant (%)' },
          { type: 'text', path: 'columns.label', label: 'Libellé' },
          { type: 'text', path: 'columns.registration', label: 'Immatriculation déclarée' },
          { type: 'text', path: 'columns.engine', label: 'État moteur' },
          { type: 'text', path: 'columns.speed', label: 'Vitesse (km/h)' },
          { type: 'text', path: 'columns.reference', label: 'Identifiant de ligne du fournisseur' },
        ],
      },
      {
        title: 'Lecture des valeurs',
        fields: [
          { type: 'text', path: 'timestampFormat', label: 'Format de l’horodatage', required: true, placeholder: 'dd/MM/yyyy HH:mm:ss', help: 'ISO, EPOCH_S, EPOCH_MS ou format Luxon comportant l’heure.' },
          { type: 'text', path: 'timezone', label: 'Fuseau horaire', placeholder: 'Fuseau de l’organisation', help: 'Pour un horodatage sans décalage et les cellules XLSX (ex. Africa/Tunis).' },
          { type: 'select', path: 'decimalSeparator', label: 'Séparateur décimal', defaultLabel: 'Par défaut (point)', options: [{ value: '.', label: 'Point (.)' }, { value: ',', label: 'Virgule (,)' }] },
          { type: 'select', path: 'odometerUnit', label: 'Unité du compteur', defaultLabel: 'Non renseignée', options: [{ value: 'km', label: 'Kilomètres' }, { value: 'm', label: 'Mètres' }], help: 'Obligatoire avec une colonne compteur.' },
          { type: 'select', path: 'odometerKind', label: 'Nature du compteur', defaultLabel: 'Non renseignée', options: ODOMETER_KIND_OPTIONS, help: 'Obligatoire avec une colonne compteur (annexe A).' },
          { type: 'select', path: 'fuelKind', label: 'Nature du carburant', defaultLabel: 'Non renseignée', options: FUEL_KIND_OPTIONS, help: 'Obligatoire avec une colonne carburant.' },
          { type: 'list', path: 'engineOnValues', label: 'Valeurs « moteur en marche »', placeholder: '1, oui, on, true, vrai, marche, allumé', help: 'Séparées par des virgules ; sans casse.' },
          { type: 'list', path: 'engineOffValues', label: 'Valeurs « moteur coupé »', placeholder: '0, non, off, false, faux, arrêt, arret, éteint', help: 'Séparées par des virgules ; sans casse.' },
          { type: 'integer', path: 'maxRowsPerFile', label: 'Lignes au plus par fichier', min: 1, max: 1_000_000, placeholder: '200000' },
          { type: 'integer', path: 'maxFileMegabytes', label: 'Taille maximale d’un fichier (Mo)', min: 1, max: 100, placeholder: '20' },
        ],
      },
    ],
    example: {
      source: 'SFTP',
      sftp: { host: 'sftp.fournisseur.tn', directory: '/rapports', hostKeySha256: 'SHA256:…' },
      columns: { unit: 'Unité', registration: 'Immatriculation', timestamp: 'Date', odometer: 'Compteur (km)', fuelLiters: 'Carburant (L)', engine: 'Moteur', reference: 'N°' },
      timestampFormat: 'dd/MM/yyyy HH:mm:ss',
      decimalSeparator: ',',
      odometerUnit: 'km',
      odometerKind: 'COMPTEUR_CAN',
      fuelKind: 'NIVEAU_SONDE',
    },
  },
  WEBHOOK_GENERIQUE: {
    baseUrl: { mode: 'none' },
    intro:
      'Le fournisseur pousse des lots JSON signés (HMAC-SHA256) vers l’URL de réception indiquée sur la fiche, section « Réception webhook ». Secret : secret de signature généré sur la fiche et communiqué au fournisseur. Aucun appel sortant n’est fait vers le fournisseur.',
    groups: [
      {
        title: 'Réception des lots',
        fields: [
          { type: 'integer', path: 'maxRequestsPerMinute', label: 'Lots acceptés au plus par minute', min: 1, max: 600, placeholder: '60', help: 'Au-delà, réponse 429 avec Retry-After. Défaut : 60.' },
          { type: 'integer', path: 'toleranceSeconds', label: 'Tolérance de l’horodatage signé (secondes)', min: 60, max: 900, placeholder: '300', help: 'Écart maximal avec l’horloge du serveur ; au-delà, lot refusé (401, rejeu tardif). Défaut : 300.' },
          { type: 'integer', path: 'rotationOverlapHours', label: 'Recouvrement à la rotation du secret (heures)', min: 0, max: 168, placeholder: '24', help: 'Durée pendant laquelle l’ancien secret reste accepté après une rotation (0 : aucune). Défaut : 24.' },
        ],
      },
    ],
    example: { maxRequestsPerMinute: 60, toleranceSeconds: 300, rotationOverlapHours: 24 },
  },
  SIMULATEUR: {
    baseUrl: { mode: 'none' },
    intro: 'SIMULATEUR — données fictives. Scénario déterministe réservé aux tests et à la démonstration ; impossible à créer ou à activer en production.',
    groups: [
      {
        title: 'Scénario (données fictives)',
        fields: [
          {
            type: 'json',
            path: 'scenario',
            label: 'Scénario du simulateur (JSON)',
            required: true,
            rows: 14,
            help: 'Champs admis : units, odometerSamples, fuelSamples, failures, duplicates, order, authRequired, supportsHistory, echoRequestUrlInErrors.',
          },
        ],
      },
    ],
    example: {
      scenario: {
        units: [{ externalId: 'SIM-1', label: 'Unité fictive 1', declaredRegistration: '000 TU 0001', odometerKinds: ['COMPTEUR_CAN'], fuelKinds: ['NIVEAU_SONDE'], removedAt: null }],
        odometerSamples: [{ unitExternalId: 'SIM-1', kind: 'COMPTEUR_CAN', valueKm: '50000.000', observedAt: '2026-09-24T08:00:00Z', sourceReference: 'sim-1' }],
        fuelSamples: [{ unitExternalId: 'SIM-1', kind: 'NIVEAU_SONDE', liters: '80', percent: null, engineOn: false, speedKmh: '0', observedAt: '2026-09-24T08:00:00Z' }],
        failures: [],
        duplicates: false,
        order: 'CHRONOLOGIQUE',
        authRequired: false,
        supportsHistory: true,
      },
    },
  },
};
