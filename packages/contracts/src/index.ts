// Contrats partagés entre l'API, le worker et le web : identifiants de permissions,
// rôles, libellés français des énumérations. Aucune règle de calcul ici (CDC 14.2).

export const PERMISSIONS = [
  'costs.read',
  'costs.write',
  'reports.export',
  'readings.approve',
  'readings.correct',
  'maintenance.complete',
  'documents.manage',
  'exceptions.override',
  'users.manage',
] as const;
export type PermissionKey = (typeof PERMISSIONS)[number];

export const ROLES = ['ADMIN', 'CHEF_PARC', 'OPERATEUR', 'CONDUCTEUR', 'LECTEUR'] as const;
export type RoleKey = (typeof ROLES)[number];

/** Permissions par défaut de chaque rôle (CDC 2.2). Le lecteur n'a ni coûts ni export sans permission explicite. */
export const DEFAULT_ROLE_PERMISSIONS: Record<RoleKey, readonly PermissionKey[]> = {
  ADMIN: PERMISSIONS,
  CHEF_PARC: [
    'costs.read',
    'costs.write',
    'reports.export',
    'readings.approve',
    'readings.correct',
    'maintenance.complete',
    'documents.manage',
    'exceptions.override',
  ],
  OPERATEUR: ['costs.write', 'documents.manage'],
  CONDUCTEUR: [],
  LECTEUR: [],
};

export const ROLE_LABELS: Record<RoleKey, string> = {
  ADMIN: 'Administrateur groupe',
  CHEF_PARC: 'Chef de parc',
  OPERATEUR: 'Opérateur',
  CONDUCTEUR: 'Conducteur',
  LECTEUR: 'Lecteur',
};

export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  'costs.read': 'Consulter les coûts',
  'costs.write': 'Saisir des coûts',
  'reports.export': 'Exporter les rapports',
  'readings.approve': 'Valider les relevés',
  'readings.correct': 'Corriger les relevés acceptés',
  'maintenance.complete': "Clôturer les interventions d'entretien",
  'documents.manage': 'Gérer les documents',
  'exceptions.override': 'Accorder des dérogations',
  'users.manage': 'Gérer les utilisateurs',
};

export const VEHICLE_LIFECYCLE_LABELS = {
  ACTIF: 'Actif',
  HORS_SERVICE: 'Hors service',
  CEDE: 'Cédé',
  ARCHIVE: 'Archivé',
} as const;

export const VEHICLE_OPERATIONAL_STATUS = ['IMMOBILISE', 'EN_UTILISATION', 'DISPONIBLE'] as const;
export type VehicleOperationalStatus = (typeof VEHICLE_OPERATIONAL_STATUS)[number];
export const VEHICLE_OPERATIONAL_STATUS_LABELS: Record<VehicleOperationalStatus, string> = {
  IMMOBILISE: 'Immobilisé',
  EN_UTILISATION: 'En utilisation',
  DISPONIBLE: 'Disponible',
};

export const FRESHNESS_STATUS = ['INCONNU', 'A_ACTUALISER', 'A_JOUR'] as const;
export type FreshnessStatus = (typeof FRESHNESS_STATUS)[number];
export const FRESHNESS_LABELS: Record<FreshnessStatus, string> = {
  INCONNU: 'Inconnu',
  A_ACTUALISER: 'À actualiser',
  A_JOUR: 'À jour',
};

export const READING_STATUS_LABELS = {
  EN_ATTENTE: 'En attente',
  ACCEPTE: 'Accepté',
  REJETE: 'Rejeté',
  REMPLACE: 'Remplacé',
} as const;

export const READING_SOURCE_LABELS = {
  MANUAL: 'Manuel',
  IMPORT: 'Import',
  TELEMATICS: 'Télématique',
} as const;

export const READING_CONTEXT_LABELS = {
  RELEVE_LIBRE: 'Relevé libre',
  REMISE: 'Remise',
  RESTITUTION: 'Restitution',
  CARBURANT: 'Carburant',
  ENTRETIEN: 'Entretien',
  SYNCHRONISATION: 'Synchronisation',
  INITIALISATION: 'Initialisation',
  TRANSFERT: 'Transfert',
} as const;

export const MEASUREMENT_KIND_LABELS = {
  COMPTEUR_AFFICHE: 'Compteur affiché',
  COMPTEUR_CAN: 'Compteur CAN',
  DISTANCE_GPS: 'Distance GPS (estimation)',
} as const;

export const RESERVATION_STATUS_LABELS = {
  CONFIRMEE: 'Confirmée',
  CONVERTIE: 'Convertie',
  ANNULEE: 'Annulée',
  NON_HONOREE: 'Non honorée',
} as const;

export const USAGE_STATUS_LABELS = { EN_COURS: 'En cours', TERMINEE: 'Terminée' } as const;

/** État d'une affectation habituelle (responsable habituel, CDC 4.1), calculé par l'API. */
export const ASSIGNMENT_STATUS_LABELS = { A_VENIR: 'À venir', EN_COURS: 'En cours', TERMINEE: 'Terminée' } as const;

export const DISTANCE_STATUS_LABELS = {
  VALIDEE: 'Distance validée',
  NON_VALIDEE: 'Distance non validée',
  INDETERMINEE: 'Distance indéterminée',
} as const;

export const PLAN_STATUS_LABELS = {
  INCOMPLET: 'Incomplet',
  A_JOUR: 'À jour',
  A_PREVOIR: 'À prévoir',
  A_FAIRE: 'À faire',
  EN_RETARD: 'En retard',
} as const;

export const INTERVENTION_STATUS_LABELS = {
  BROUILLON: 'Brouillon',
  PLANIFIEE: 'Planifiée',
  EN_COURS: 'En cours',
  TERMINEE: 'Terminée',
  ANNULEE: 'Annulée',
} as const;

export const DOCUMENT_STATUS = ['MANQUANT', 'VALIDE', 'A_RENOUVELER', 'EXPIRE'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUS)[number];
export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  MANQUANT: 'Manquant',
  VALIDE: 'Valide',
  A_RENOUVELER: 'À renouveler',
  EXPIRE: 'Expiré',
};

export const INCIDENT_TYPE_LABELS = {
  PANNE: 'Panne',
  DOMMAGE: 'Dommage',
  ACCIDENT: 'Accident',
  CREVAISON: 'Crevaison',
  ANOMALIE_COMPTEUR: 'Anomalie compteur',
  CONTRAVENTION: 'Contravention',
  AUTRE: 'Autre',
} as const;

export const INCIDENT_SEVERITY_LABELS = {
  FAIBLE: 'Faible',
  MOYENNE: 'Moyenne',
  ELEVEE: 'Élevée',
  CRITIQUE: 'Critique',
} as const;

export const INCIDENT_STATUS_LABELS = {
  OUVERT: 'Ouvert',
  EN_TRAITEMENT: 'En traitement',
  RESOLU: 'Résolu',
  CLOTURE: 'Clôturé',
} as const;

export const SUPPLIER_CATEGORY_LABELS = {
  GARAGE: 'Garage',
  STATION: 'Station',
  ASSURANCE: 'Assurance',
  LOUEUR: 'Loueur',
  AUTRE: 'Autre',
} as const;

export const FUEL_ENTRY_STATUS_LABELS = {
  SOUMIS: 'Soumis (à valider)',
  VALIDE: 'Validé',
  REJETE: 'Rejeté',
  ANNULE: 'Annulé',
  REMPLACE: 'Remplacé (corrigé)',
} as const;

/** Contexte d'une déclaration de localisation (CDC 3.4 ; déclarative, sans suivi en direct). */
export const LOCATION_CONTEXT_LABELS = {
  DECLARATION: 'Déclaration',
  REMISE: 'Remise',
  RESTITUTION: 'Restitution',
  GARAGE: 'Garage',
  TRANSFERT: 'Transfert',
} as const;

export const EXPENSE_CATEGORY_LABELS = {
  ENTRETIEN_REPARATION: 'Entretien / réparation',
  CARBURANT: 'Carburant',
  ASSURANCE: 'Assurance',
  LOCATION: 'Location',
  TAXES: 'Taxes',
  PEAGE: 'Péage',
  STATIONNEMENT: 'Stationnement',
  ACHAT_VEHICULE: 'Achat de véhicule',
  AUTRE: 'Autre',
} as const;

export const ENERGY_LABELS = {
  DIESEL: 'Diesel',
  ESSENCE: 'Essence',
  GPL: 'GPL',
  HYBRIDE: 'Hybride',
  ELECTRIQUE: 'Électrique',
  AUTRE: 'Autre',
} as const;

export const FUEL_GAUGE_LABELS = {
  VIDE: 'Vide',
  QUART: '1/4',
  DEMI: '1/2',
  TROIS_QUARTS: '3/4',
  PLEIN: 'Plein',
} as const;

export const ALERT_TYPE_LABELS = {
  ENTRETIEN_ECHEANCE: 'Entretien à prévoir / à faire / en retard',
  ENTRETIEN_PLAN_INCOMPLET: "Plan d'entretien incomplet",
  DOCUMENT_MANQUANT: 'Document manquant',
  DOCUMENT_ECHEANCE: 'Document proche d’expiration / expiré',
  KILOMETRAGE_ABSENT: 'Kilométrage absent',
  KILOMETRAGE_ANCIEN: 'Kilométrage ancien',
  RELEVE_A_VALIDER: 'Relevé à valider',
  RETOUR_DEPASSE: 'Retour dépassé',
  RESERVATION_COMPROMISE: 'Réservation compromise',
  INCIDENT_CRITIQUE: 'Incident critique non traité',
  DEPART_SANS_RELEVE: 'Départ sans relevé',
  DISTANCE_NON_VALIDEE: 'Distance non validée',
  IMMOBILISATION_PENDANT_UTILISATION: 'Immobilisation pendant une utilisation',
  GPS_SOURCE_MUETTE: 'Source GPS muette',
  GPS_DERIVE: 'Dérive GPS',
  GPS_UNITE_NON_MAPPEE: 'Unité GPS non mappée',
  GPS_SYNCHRO_EN_ECHEC: 'Synchronisation GPS en échec',
  CARBURANT_BAISSE_ANORMALE: 'Baisse anormale de carburant',
  CARBURANT_ECART_TICKET: 'Écart entre remplissage détecté et ticket',
  CARBURANT_REMPLISSAGE_DETECTE: 'Remplissage détecté',
} as const;

export const ALERT_SEVERITY_LABELS = {
  INFO: 'Information',
  ATTENTION: 'Attention',
  URGENT: 'Urgent',
  CRITIQUE: 'Critique',
} as const;

export const TELEMETRY_CHANNEL_LABELS = { API: 'API', RAPPORT: 'Rapport (CSV/XLSX)', RPA: 'RPA (portail)' } as const;
export const TELEMETRY_PROVIDER_KIND_LABELS = {
  TRACCAR: 'Traccar (API)',
  WIALON: 'Wialon (Remote API)',
  RAPPORT_GENERIQUE: 'Rapports CSV/XLSX (IMAP ou SFTP)',
  RPA: 'RPA — non activable en V1',
  SIMULATEUR: 'Simulateur de test (jamais en production)',
} as const;
export const FUEL_MEASURE_KIND_LABELS = {
  NIVEAU_CAN: 'Niveau CAN',
  NIVEAU_SONDE: 'Niveau sonde',
  CONSOMMATION_CAN: 'Consommation CAN',
} as const;
export const FUEL_EVENT_TYPE_LABELS = {
  REMPLISSAGE_DETECTE: 'Remplissage détecté',
  BAISSE_ANORMALE: "Baisse anormale à l'arrêt",
  ECART_TICKET: 'Écart remplissage / ticket',
} as const;

/** Clés de paramètres (CDC 17.1) avec leurs valeurs initiales. */
export const SETTING_DEFAULTS = {
  'odometer.staleAfterDays': 7,
  'odometer.plausibilityMaxKmPerDay': 1500,
  'odometer.plausibilityMinKm': 300,
  'maintenance.noticeKm': 500,
  'maintenance.noticeDays': 30,
  'documents.noticeDays': [30, 15, 7],
  'usage.lateReturnToleranceMinutes': 0,
  'alerts.catchUpIntervalMinutes': 15,
  'email.dailyDigestLocalTime': '08:00',
  'attachments.maxSizeBytes': 10 * 1024 * 1024,
  'imports.maxSizeBytes': 5 * 1024 * 1024,
  'imports.maxRows': 2000,
  'pagination.defaultPageSize': 25,
  'pagination.maxPageSize': 100,
  'fuel.amountToleranceRatio': 0.01,
  'fuel.amountToleranceTnd': 0.1,
  'fuel.driverLateSubmissionDays': 7,
  'telemetry.syncIntervalMinutes': 15,
  'telemetry.silentAfterHours': 24,
  'telemetry.driftThresholdPercent': 3,
  'telemetry.historizeEveryMinutes': 60,
  'telemetry.fuelDropLiters': 10,
  'telemetry.fuelDropPercent': 5,
  'telemetry.fuelDropWindowMinutes': 30,
  'telemetry.fuelFillMinLiters': 10,
  'telemetry.fuelTicketWindowHours': 2,
  'telemetry.fuelTicketToleranceLiters': 5,
  'telemetry.fuelSampleStepMinutes': 5,
  'telemetry.fuelSampleRetentionDays': 90,
  'session.ttlHours': 12,
  'usage.checklistItems': ['Clés', 'Carte grise', 'Attestation d’assurance', 'Gilet de sécurité', 'Triangle', 'Roue de secours', 'Cric'],
  'telemetry.calibrationMaxGapMinutes': 60,
  'expenses.vehiclePurchaseExcludedByDefault': true,
  'incidents.driverLateDeclarationHours': 24,
  'reservations.noShowGraceMinutes': 60,
  'reservations.conversionEarlyMinutes': 120,
  /** D-268 : ouvre les soumissions du conducteur sur le véhicule dont il est responsable habituel en cours. */
  'drivers.allowHabitualVehicleSubmissions': false,
} as const;
export type SettingKey = keyof typeof SETTING_DEFAULTS;

/** Description des paramètres (CDC 17.1) : libellé, unité et bornes, pour l'écran d'administration et la validation serveur. */
export interface SettingDescriptor {
  label: string;
  kind: 'integer' | 'number' | 'boolean' | 'time' | 'integer-list' | 'string-list';
  min?: number;
  max?: number;
  unit?: string;
  /** Nombre maximal de décimales d'une valeur `number` (montant en TND : 3, règle d'affichage du CDC 17.1). */
  decimals?: number;
  /** Surcharge possible par société (sinon valeur groupe uniquement). */
  companyOverride: boolean;
  /**
   * Valeur fixe du produit, affichée mais non modifiable (PUT refusé en 422 PARAMETRE_NON_MODIFIABLE) :
   * le texte explique pourquoi. Sans ce champ, le paramètre est modifiable par l'administrateur.
   */
  fixed?: string;
}

/** Pagination (CDC 15.1, 17.1) : borne du contrat de l'API documentée dans OpenAPI, identique pour toutes les organisations. */
const PAGINATION_FIXED = `Borne du contrat de l’API (CDC 15.1), documentée dans OpenAPI et identique pour toutes les organisations : ${SETTING_DEFAULTS['pagination.defaultPageSize']} lignes par défaut, ${SETTING_DEFAULTS['pagination.maxPageSize']} au plus par requête.`;

export const SETTING_DESCRIPTORS: Record<SettingKey, SettingDescriptor> = {
  'odometer.staleAfterDays': { label: 'Kilométrage ancien après', kind: 'integer', min: 1, max: 365, unit: 'jours', companyOverride: true },
  'odometer.plausibilityMaxKmPerDay': { label: 'Seuil de plausibilité par 24 h (filtre administratif, pas une limite physique)', kind: 'integer', min: 100, max: 5000, unit: 'km', companyOverride: true },
  'odometer.plausibilityMinKm': { label: 'Tolérance minimale de plausibilité entre deux relevés rapprochés (filtre administratif, pas une limite physique)', kind: 'integer', min: 10, max: 5000, unit: 'km', companyOverride: true },
  'maintenance.noticeKm': { label: 'Préavis entretien par défaut (distance)', kind: 'integer', min: 0, max: 50000, unit: 'km', companyOverride: true },
  'maintenance.noticeDays': { label: 'Préavis entretien par défaut (durée)', kind: 'integer', min: 0, max: 365, unit: 'jours', companyOverride: true },
  'documents.noticeDays': { label: 'Préavis documents', kind: 'integer-list', min: 0, max: 365, unit: 'jours', companyOverride: true },
  'usage.lateReturnToleranceMinutes': { label: 'Tolérance de retard au retour', kind: 'integer', min: 0, max: 1440, unit: 'minutes', companyOverride: true },
  'alerts.catchUpIntervalMinutes': { label: 'Rattrapage des alertes', kind: 'integer', min: 5, max: 60, unit: 'minutes', companyOverride: false },
  'email.dailyDigestLocalTime': { label: 'Heure du récapitulatif e-mail', kind: 'time', companyOverride: false },
  'attachments.maxSizeBytes': { label: 'Taille maximale d’une pièce jointe', kind: 'integer', min: 1024, max: 10485760, unit: 'octets', companyOverride: false },
  'imports.maxSizeBytes': { label: 'Taille maximale d’un import', kind: 'integer', min: 1024, max: 5242880, unit: 'octets', companyOverride: false },
  'imports.maxRows': { label: 'Lignes maximales par import', kind: 'integer', min: 1, max: 2000, unit: 'lignes', companyOverride: false },
  'pagination.defaultPageSize': { label: 'Pagination par défaut', kind: 'integer', min: 5, max: 100, unit: 'lignes', companyOverride: false, fixed: PAGINATION_FIXED },
  'pagination.maxPageSize': { label: 'Pagination maximale', kind: 'integer', min: 10, max: 100, unit: 'lignes', companyOverride: false, fixed: PAGINATION_FIXED },
  'fuel.amountToleranceRatio': { label: 'Tolérance litres × prix / total', kind: 'number', min: 0, max: 0.5, unit: 'ratio', companyOverride: true },
  'telemetry.syncIntervalMinutes': { label: 'Synchronisation télématique', kind: 'integer', min: 5, max: 1440, unit: 'minutes', companyOverride: false },
  'telemetry.silentAfterHours': { label: 'Source GPS muette après', kind: 'integer', min: 1, max: 720, unit: 'heures', companyOverride: true },
  'telemetry.driftThresholdPercent': { label: 'Dérive GPS au-delà de', kind: 'number', min: 0.1, max: 50, unit: '%', companyOverride: true },
  'telemetry.historizeEveryMinutes': { label: 'Historisation automatique au plus toutes les', kind: 'integer', min: 5, max: 1440, unit: 'minutes', companyOverride: false },
  'telemetry.fuelDropLiters': { label: 'Baisse carburant à l’arrêt (litres)', kind: 'number', min: 0.5, max: 500, unit: 'L', companyOverride: true },
  'telemetry.fuelDropPercent': { label: 'Baisse carburant à l’arrêt (pourcentage)', kind: 'number', min: 0.5, max: 100, unit: '%', companyOverride: true },
  'telemetry.fuelDropWindowMinutes': { label: 'Fenêtre de baisse carburant', kind: 'integer', min: 5, max: 1440, unit: 'minutes', companyOverride: true },
  'telemetry.fuelFillMinLiters': { label: 'Seuil de remplissage détecté', kind: 'number', min: 1, max: 1000, unit: 'L', companyOverride: true },
  'telemetry.fuelTicketWindowHours': { label: 'Fenêtre de rapprochement ticket', kind: 'integer', min: 1, max: 48, unit: 'heures', companyOverride: true },
  'telemetry.fuelTicketToleranceLiters': { label: 'Tolérance litres remplissage / ticket', kind: 'number', min: 0, max: 200, unit: 'L', companyOverride: true },
  'telemetry.fuelSampleStepMinutes': { label: 'Pas des échantillons carburant', kind: 'integer', min: 1, max: 5, unit: 'minutes', companyOverride: false },
  'telemetry.fuelSampleRetentionDays': { label: 'Rétention des échantillons carburant', kind: 'integer', min: 7, max: 730, unit: 'jours', companyOverride: false },
  'telemetry.calibrationMaxGapMinutes': { label: 'Écart maximal pour le calibrage GPS', kind: 'integer', min: 5, max: 1440, unit: 'minutes', companyOverride: false },
  'session.ttlHours': { label: 'Durée de session (appliquée aux nouvelles connexions)', kind: 'integer', min: 1, max: 72, unit: 'heures', companyOverride: false },
  'usage.checklistItems': { label: 'Checklist de remise et de restitution', kind: 'string-list', companyOverride: true },
  'expenses.vehiclePurchaseExcludedByDefault': { label: 'Achats de véhicules exclus du coût d’exploitation', kind: 'boolean', companyOverride: false },
  'incidents.driverLateDeclarationHours': { label: 'Déclaration d’incident par le conducteur après restitution', kind: 'integer', min: 0, max: 168, unit: 'heures', companyOverride: true },
  'reservations.noShowGraceMinutes': { label: 'Délai avant constat manuel de non-présentation (après le début prévu)', kind: 'integer', min: 0, max: 1440, unit: 'minutes', companyOverride: true },
  'reservations.conversionEarlyMinutes': { label: 'Avance maximale d’une remise convertissant une réservation (avant le début prévu)', kind: 'integer', min: 0, max: 1440, unit: 'minutes', companyOverride: true },
  'fuel.amountToleranceTnd': { label: 'Écart toléré (litres × prix / total), part fixe', kind: 'number', min: 0, max: 100, unit: 'TND', decimals: 3, companyOverride: true },
  'fuel.driverLateSubmissionDays': { label: 'Soumission d’un ticket carburant après restitution', kind: 'integer', min: 0, max: 30, unit: 'jours', companyOverride: true },
  'drivers.allowHabitualVehicleSubmissions': { label: 'Soumissions du conducteur sur le véhicule dont il est responsable habituel (sans utilisation en cours)', kind: 'boolean', companyOverride: false },
};

/** Bornes de pagination de l'API (CDC 15.1, 17.1) : valeurs fixes des paramètres pagination.* (non modifiables). */
export const PAGINATION = { defaultPageSize: SETTING_DEFAULTS['pagination.defaultPageSize'], maxPageSize: SETTING_DEFAULTS['pagination.maxPageSize'] } as const;
