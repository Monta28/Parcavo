// Types des réponses de l'API d'entretien préventif (module maintenance, CDC 6.1 et 6.2). Les types des
// interventions sont dans lib/interventions-types.ts.
// Aucune règle de calcul ici : échéances, restes et statuts viennent toujours de l'API.

export type PlanStatus = 'INCOMPLET' | 'A_JOUR' | 'A_PREVOIR' | 'A_FAIRE' | 'EN_RETARD';
export type PlanBaseMode = 'DERNIERE_OPERATION' | 'BASE_TECHNIQUE' | 'ECHEANCE_INITIALE' | 'AUCUNE';
export type AcceptedSources = 'TOUTES' | 'MANUEL_OU_CAN';
export type CatalogStatus = 'ACTIF' | 'ARCHIVE';
export type OnExisting = 'IGNORER' | 'METTRE_A_JOUR';

/** GET /maintenance-plans, GET /maintenance-plans/:id. */
export interface MaintenancePlanView {
  id: string;
  companyId: string;
  vehicleId: string;
  vehicleCode: string;
  maintenanceTypeId: string;
  maintenanceTypeLabel: string;
  intervalKm: string | null;
  intervalMonths: number | null;
  intervalDays: number | null;
  noticeKm: string | null;
  noticeDays: number | null;
  baseMode: PlanBaseMode;
  baseKm: string | null;
  baseDate: string | null;
  nextDueKm: string | null;
  nextDueDate: string | null;
  status: PlanStatus;
  kmStatus: PlanStatus | null;
  dateStatus: PlanStatus | null;
  remainingKm: string | null;
  remainingDays: number | null;
  currentKm: string | null;
  warnings: string[];
  currentKmSource: 'ESTIME_GPS' | 'COMPTEUR_CAN' | 'COMPTEUR_AFFICHE' | null;
  currentKmObservedAt: string | null;
  templateId: string | null;
  acceptedSources: AcceptedSources;
  active: boolean;
  responsibleUserId: string | null;
  /** Prénom et nom du responsable (null sans responsable). */
  responsibleUserName: string | null;
  deactivationReason: string | null;
  version: number;
}

/**
 * Tris de GET /maintenance-plans (paramètre sort, avec order asc|desc) : urgence (desc = le plus urgent
 * d'abord : EN_RETARD, A_FAIRE, A_PREVOIR, INCOMPLET, A_JOUR), restes km et jours, échéance, véhicule, opération.
 */
export type PlanSort = 'urgence' | 'resteKm' | 'resteJours' | 'echeance' | 'vehicule' | 'operation';
export const PLAN_SORTS: PlanSort[] = ['urgence', 'resteKm', 'resteJours', 'echeance', 'vehicule', 'operation'];

/** PATCH /maintenance-plans/:id (avec preview=true : impact calculé sans enregistrement, et état « avant »). */
export interface MaintenancePlanUpdateResult extends MaintenancePlanView {
  preview: boolean;
  before?: MaintenancePlanView;
}

/** GET /maintenance-types (tableau). */
export interface MaintenanceTypeView {
  id: string;
  code: string;
  label: string;
  description: string | null;
  status: CatalogStatus;
  version: number;
}

export interface MaintenanceTemplateItemView {
  id: string;
  maintenanceTypeId: string;
  maintenanceTypeLabel: string;
  /** ARCHIVE : opération archivée au catalogue depuis ; ligne conservée mais non copiée. */
  maintenanceTypeStatus: CatalogStatus;
  intervalKm: string | null;
  intervalMonths: number | null;
  intervalDays: number | null;
  noticeKm: string | null;
  noticeDays: number | null;
}

/** GET /maintenance-templates (tableau), GET /maintenance-templates/:id. */
export interface MaintenanceTemplateView {
  id: string;
  name: string;
  description: string | null;
  status: CatalogStatus;
  items: MaintenanceTemplateItemView[];
  version: number;
}

/** État d'un plan avant/après application d'un modèle (valeurs calculées par l'API). */
export interface PlanImpactState {
  intervalKm: string | null;
  intervalMonths: number | null;
  intervalDays: number | null;
  noticeKm: string | null;
  noticeDays: number | null;
  nextDueKm: string | null;
  nextDueDate: string | null;
  status: PlanStatus;
  remainingKm: string | null;
  remainingDays: number | null;
}

/** Impact plan par plan d'une application de modèle (17.1). */
export interface TemplatePlanImpact {
  /** null : plan qui serait créé (prévisualisation). */
  planId: string | null;
  vehicleId: string;
  vehicleCode: string;
  maintenanceTypeLabel: string;
  action: 'CREATION' | 'MISE_A_JOUR';
  /** Version du plan existant lue par la prévisualisation (renvoyée à la confirmation) ; null pour une création. */
  planVersion: number | null;
  before: PlanImpactState | null;
  after: PlanImpactState;
}

/**
 * Plans existants annoncés « mis à jour » par une prévisualisation, à renvoyer tels quels à la confirmation
 * (expectedPlanVersions) : l'API refuse (409) si l'impact a changé entre-temps.
 */
export function expectedPlanVersions(preview: Pick<ApplyTemplateResult, 'impacts'>): Array<{ planId: string; version: number }> {
  return preview.impacts.flatMap((i) => (i.action === 'MISE_A_JOUR' && i.planId !== null && i.planVersion !== null ? [{ planId: i.planId, version: i.planVersion }] : []));
}

/** POST /maintenance-templates/:id/apply (choix par véhicule prioritaire sur onExisting, D-198 ; preview=true : rien n'est enregistré). */
export interface ApplyTemplateResult {
  templateId: string;
  vehicles: Array<{ vehicleId: string; vehicleCode: string; onExisting: OnExisting; created: string[]; updated: string[]; ignored: string[] }>;
  /** Opérations du modèle archivées au catalogue : non copiées. */
  archivedSkipped: string[];
  preview: boolean;
  impacts: TemplatePlanImpact[];
}

/** POST /maintenance-types/initial-catalog (administrateur). */
export interface InstallMaintenanceCatalogResult {
  created: MaintenanceTypeView[];
  skipped: Array<{ code: string; label: string; reason: 'CODE_EXISTANT' | 'LIBELLE_EXISTANT' }>;
}

/** GET /maintenance-calendar?month=AAAA-MM : échéances en date et interventions planifiées du mois. */
export interface MaintenanceCalendarView {
  month: string;
  from: string;
  to: string;
  timezone: string;
  dueItems: Array<{ planId: string; companyId: string; vehicleId: string; vehicleCode: string; maintenanceTypeLabel: string; date: string; nextDueKm: string | null; status: PlanStatus }>;
  interventions: Array<{ id: string; reference: string; companyId: string; vehicleId: string; vehicleCode: string; kind: 'PREVENTIF' | 'CORRECTIF'; date: string; plannedStartAt: string; plannedEndAt: string | null; tasks: string[] }>;
  /** Plans EN_RETARD dont l'échéance en date précède le mois affiché. */
  overdueBeforeCount: number;
  truncated: boolean;
}

/** GET /users (administrateur) : seuls les champs utilisés pour choisir un responsable. */
export interface UserOption {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  status: string;
}

// Libellés d'affichage absents de @parc-auto/contracts ------------------------------------------

export const BASE_MODE_LABELS: Record<PlanBaseMode, string> = {
  DERNIERE_OPERATION: 'Dernière opération connue',
  BASE_TECHNIQUE: 'Base technique (aucune opération)',
  ECHEANCE_INITIALE: 'Échéance initiale',
  AUCUNE: 'Aucune base (plan incomplet)',
};

export const BASE_MODE_DESCRIPTIONS: Record<PlanBaseMode, string> = {
  DERNIERE_OPERATION: 'Kilométrage cumulé et date de la dernière réalisation connue de cette opération.',
  BASE_TECHNIQUE: 'Point de départ validé sans opération ni facture : aucune fausse opération n’est créée.',
  ECHEANCE_INITIALE: 'Prochaine échéance fixée directement (km et/ou date), sans base connue.',
  AUCUNE: 'Aucun historique fiable : le plan reste INCOMPLET avec une alerte jusqu’à sa première base.',
};

export const ACCEPTED_SOURCES_LABELS: Record<AcceptedSources, string> = {
  TOUTES: 'Tous les relevés acceptés (y compris estimation GPS)',
  MANUEL_OU_CAN: 'Relevés manuels et compteur CAN uniquement',
};

export const CATALOG_STATUS_LABELS: Record<CatalogStatus, string> = { ACTIF: 'Actif', ARCHIVE: 'Archivé' };

export const ON_EXISTING_LABELS: Record<OnExisting, string> = {
  IGNORER: 'Ignorer le plan existant',
  METTRE_A_JOUR: 'Mettre à jour ses intervalles et préavis (base conservée)',
};

/** Données manquantes ou anciennes renvoyées par l'API, affichées séparément du statut (6.2, D-196). */
export const PLAN_WARNING_LABELS: Record<string, string> = {
  KILOMETRAGE_INCONNU: 'Kilométrage inconnu : aucun relevé admissible',
  KILOMETRAGE_ANCIEN: 'Kilométrage ancien : relevé à actualiser',
  CUMUL_INCOMPLET: 'Cumul incomplet : historique kilométrique antérieur inconnu',
  BASE_KM_MANQUANTE: 'Échéance km non initialisée (base km manquante)',
  BASE_DATE_MANQUANTE: 'Échéance date non initialisée (base date manquante)',
  AUCUNE_BASE: 'Aucune base de calcul : échéance non calculable',
};

export const KM_SOURCE_LABELS: Record<NonNullable<MaintenancePlanView['currentKmSource']>, string> = {
  ESTIME_GPS: 'selon estimation GPS',
  COMPTEUR_CAN: 'compteur CAN',
  COMPTEUR_AFFICHE: 'compteur affiché',
};
