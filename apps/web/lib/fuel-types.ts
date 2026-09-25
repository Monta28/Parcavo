// Types des réponses de l'API carburant (apps/api/src/modules/fuel : FuelEntryViewDto, ConsumptionViewDto,
// FuelPurchaseGapViewDto) et des cibles de soumission conducteur (GET /driver-submissions/vehicles).
// Aucune règle ici : admissibilité, écarts, capacité, consommation et N/D sont calculés par le serveur.
import { FUEL_ENTRY_STATUS_LABELS } from '@parc-auto/contracts';

export type FuelEntryStatus = 'SOUMIS' | 'VALIDE' | 'REJETE' | 'ANNULE' | 'REMPLACE';
export type FuelEnergy = 'DIESEL' | 'ESSENCE' | 'GPL';
export type FuelReadingStatus = 'EN_ATTENTE' | 'ACCEPTE' | 'REJETE' | 'REMPLACE';
export type FuelEligibility = 'ADMISSIBLE' | 'NON_VALIDE' | 'COMPTEUR_NON_VALIDE' | 'BORNE_ESTIMEE' | 'CAPACITE_NON_CONFIRMEE';

export const FUEL_ENTRY_STATUSES: readonly FuelEntryStatus[] = ['SOUMIS', 'VALIDE', 'REJETE', 'ANNULE', 'REMPLACE'];
export const FUEL_ENERGIES: readonly FuelEnergy[] = ['DIESEL', 'ESSENCE', 'GPL'];

/** Libellés des statuts (contrats partagés, REMPLACE compris : D-222, correction d'un plein validé). */
export const FUEL_STATUS_LABELS: Readonly<Record<FuelEntryStatus, string>> = FUEL_ENTRY_STATUS_LABELS;

export function fuelStatusLabel(status: string): string {
  return FUEL_STATUS_LABELS[status as FuelEntryStatus] ?? status;
}

/** Vue d'un plein (GET /fuel-entries, GET /fuel-entries/:id). Montants null sans costs.read (conducteur : ses saisies). */
export interface FuelEntryView {
  id: string;
  companyId: string;
  vehicleId: string;
  vehicleCode: string;
  vehicleRegistration: string;
  driverId: string | null;
  driverName: string | null;
  supplierId: string | null;
  supplierName: string | null;
  /** Horodatage UTC du plein. */
  filledAt: string;
  /** Litres (décimal exact, 3 décimales). */
  liters: string;
  unitPrice: string | null;
  totalAmount: string | null;
  energy: FuelEnergy;
  isFullTank: boolean;
  declaredPhysicalKm: string | null;
  readingId: string | null;
  readingStatus: FuelReadingStatus | null;
  readingStatusReason: string | null;
  consumptionEligibility: FuelEligibility;
  consumptionEligibilityLabel: string;
  ticketAttachmentId: string | null;
  status: FuelEntryStatus;
  amountMismatch: boolean;
  amountMismatchValue: string | null;
  tankCapacityExceeded: boolean;
  capacityConfirmedAt: string | null;
  replacesFuelEntryId: string | null;
  replacedByFuelEntryId: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  notes: string | null;
  /** Dépense de synthèse active (costs.read ; jamais pour le conducteur). */
  expenseId: string | null;
  createdAt: string;
  version: number;
}

export interface ConsumptionReason {
  code: string;
  label: string;
}

export interface ConsumptionInterval {
  energy: FuelEnergy;
  startFuelEntryId: string | null;
  endFuelEntryId: string;
  startFilledAt: string | null;
  endFilledAt: string;
  startKm: string | null;
  endKm: string | null;
  distanceKm: string | null;
  liters: string;
  fuelEntryIds: string[];
  retained: boolean;
  /** L/100 km arrondi à une décimale par l'API (affichage). */
  litersPer100Km: string | null;
  litersPer100KmExact: string | null;
  reasons: ConsumptionReason[];
}

export interface ConsumptionTotal {
  energy: FuelEnergy;
  available: boolean;
  liters: string | null;
  distanceKm: string | null;
  litersPer100Km: string | null;
  litersPer100KmExact: string | null;
  reasons: ConsumptionReason[];
  retainedIntervals: number;
  excludedIntervals: number;
}

/** GET /vehicles/:id/consumption : estimation fondée sur les saisies (8.3), N/D motivé. */
export interface ConsumptionView {
  vehicleId: string;
  from: string | null;
  to: string | null;
  unit: string;
  /** Nature du résultat, fournie par l'API (estimation, pas une mesure télématique). */
  nature: string;
  available: boolean;
  reasons: ConsumptionReason[];
  totals: ConsumptionTotal[];
  intervals: ConsumptionInterval[];
}

/** GET/POST /vehicles/:id/fuel-purchase-gaps : période déclarée « achats incomplets » (D-227). */
export interface FuelPurchaseGapView {
  id: string;
  vehicleId: string;
  companyId: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  createdById: string | null;
  createdAt: string;
}

/** GET /driver-submissions/vehicles : véhicules sur lesquels le conducteur connecté peut soumettre (D-268). */
export interface SubmissionTargetView {
  vehicleId: string;
  vehicleCode: string;
  registration: string;
  basis: 'UTILISATION_EN_COURS' | 'RESPONSABLE_HABITUEL';
  usageId: string | null;
}
