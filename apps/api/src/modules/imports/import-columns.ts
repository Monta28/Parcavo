import type { ImportKind } from '@parc-auto/db';

/**
 * Colonnes des modèles d'import (CDC 12.2, D-279). Les colonnes obligatoires sont celles du CDC ;
 * les colonnes facultatives complètent la fiche. L'ordre d'import des dépendances est : sociétés et
 * sites (administration), véhicules, conducteurs, relevés, bases d'entretien.
 */
export interface ColumnSpec {
  name: string;
  required: boolean;
  description: string;
  example: string;
}

export const IMPORT_COLUMNS: Record<ImportKind, ColumnSpec[]> = {
  VEHICULES: [
    { name: 'company_code', required: true, description: 'Code de la société (dans votre périmètre)', example: 'NORD' },
    { name: 'vehicle_code', required: true, description: 'Code interne unique du véhicule', example: 'VN-001' },
    { name: 'registration', required: true, description: 'Immatriculation (unique)', example: '123 TU 4567' },
    { name: 'make', required: true, description: 'Marque', example: 'Peugeot' },
    { name: 'model', required: true, description: 'Modèle', example: '208' },
    { name: 'category', required: true, description: 'Code de la catégorie de véhicule', example: 'VP' },
    { name: 'vin', required: false, description: 'Numéro VIN', example: 'VF3XXXXXXXXXXXXXX' },
    { name: 'energy', required: false, description: 'DIESEL, ESSENCE, GPL, HYBRIDE, ELECTRIQUE ou AUTRE', example: 'DIESEL' },
    { name: 'site', required: false, description: 'Nom exact d’un site actif de la société', example: 'Dépôt Tunis' },
    { name: 'year', required: false, description: 'Année du modèle (4 chiffres)', example: '2022' },
    { name: 'commissioning_date', required: false, description: 'Mise en service (AAAA-MM-JJ ou JJ/MM/AAAA)', example: '2022-03-15' },
    { name: 'tank_capacity_liters', required: false, description: 'Capacité du réservoir en litres', example: '50' },
  ],
  CONDUCTEURS: [
    { name: 'company_code', required: true, description: 'Code de la société (dans votre périmètre)', example: 'NORD' },
    { name: 'driver_code', required: true, description: 'Code unique du conducteur dans l’organisation', example: 'D-042' },
    { name: 'first_name', required: true, description: 'Prénom', example: 'Salma' },
    { name: 'last_name', required: true, description: 'Nom', example: 'Ben Ali' },
    { name: 'active', required: true, description: 'oui/non, true/false, 1/0, actif/inactif', example: 'oui' },
    { name: 'phone', required: false, description: 'Téléphone', example: '+216 20 000 000' },
    { name: 'email', required: false, description: 'E-mail', example: 'salma@exemple.tn' },
    { name: 'site', required: false, description: 'Nom exact d’un site actif de la société', example: 'Dépôt Tunis' },
  ],
  RELEVES: [
    { name: 'company_code', required: true, description: 'Code de la société du véhicule', example: 'NORD' },
    { name: 'vehicle_code', required: true, description: 'Code du véhicule', example: 'VN-001' },
    { name: 'observed_at', required: true, description: 'Date et heure d’observation (heure locale du groupe sans décalage)', example: '2026-09-01 08:30' },
    { name: 'physical_km', required: true, description: 'Valeur affichée au compteur, entier sans séparateur', example: '45230' },
    { name: 'meter_reference', required: true, description: 'INITIAL (premier compteur) ou COURANT (compteur en service)', example: 'COURANT' },
    { name: 'initial_cumulative_km', required: false, description: 'INITIAL seulement : kilomètres cumulés validés si le compteur a déjà été remplacé', example: '' },
    { name: 'note', required: false, description: 'Commentaire', example: 'Reprise de l’historique' },
  ],
  BASES_ENTRETIEN: [
    { name: 'company_code', required: true, description: 'Code de la société du véhicule', example: 'NORD' },
    { name: 'vehicle_code', required: true, description: 'Code du véhicule', example: 'VN-001' },
    { name: 'maintenance_type', required: true, description: 'Code de l’opération du catalogue', example: 'VIDANGE' },
    { name: 'interval_km', required: false, description: 'Intervalle en km (au moins un intervalle requis)', example: '10000' },
    { name: 'interval_months', required: false, description: 'Intervalle en mois (ou interval_days)', example: '12' },
    { name: 'interval_days', required: false, description: 'Intervalle en jours (exclusif de interval_months)', example: '' },
    { name: 'base_mode', required: true, description: 'DERNIERE_OPERATION, BASE_TECHNIQUE, ECHEANCE_INITIALE ou AUCUNE', example: 'DERNIERE_OPERATION' },
    { name: 'base_km', required: false, description: 'Base en kilomètres cumulés (DERNIERE_OPERATION / BASE_TECHNIQUE)', example: '80000' },
    { name: 'base_date', required: false, description: 'Date de la base', example: '2026-01-10' },
    { name: 'next_due_km', required: false, description: 'ECHEANCE_INITIALE : prochaine échéance en km cumulés', example: '' },
    { name: 'next_due_date', required: false, description: 'ECHEANCE_INITIALE : prochaine échéance (date)', example: '' },
    { name: 'notice_km', required: false, description: 'Préavis en km (défaut paramétré)', example: '500' },
    { name: 'notice_days', required: false, description: 'Préavis en jours (défaut paramétré)', example: '30' },
  ],
};

/** Correspondance automatique proposée : en-tête identique au nom de colonne (casse et espaces ignorés). */
export function suggestMapping(kind: ImportKind, headers: readonly string[]): Record<string, string> {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const mapping: Record<string, string> = {};
  for (const col of IMPORT_COLUMNS[kind]) {
    const header = headers.find((h) => norm(h) === col.name);
    if (header) mapping[col.name] = header;
  }
  return mapping;
}
