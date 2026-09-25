import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength, ValidateBy, type ValidationOptions } from 'class-validator';
import { FUEL_ENERGIES, type FuelEnergy } from '../../../domain/fuel-rules.js';
import { isPositiveDecimalString } from '../../../domain/money.js';

/** Compteur physique affiché : entier ou 3 décimales au plus. */
export const KM_PATTERN = /^\d{1,10}(\.\d{1,3})?$/;

/**
 * Horodatage complet (D-223) : date, heure et décalage explicite (Z ou ±hh:mm). Une date seule ou une heure
 * sans fuseau serait interprétée arbitrairement par le serveur : aucune heure fictive n'est inventée.
 */
export const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Retire les espaces de bord d'un texte libre avant validation (un motif blanc n'est pas un motif). */
export const trimmed = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

/** Décimal exact strictement positif (chaîne, 3 décimales au plus) : règle de domain/money.ts. */
export function IsPositiveDecimal(message: string, options?: ValidationOptions & { maxIntegerDigits?: number }): PropertyDecorator {
  const { maxIntegerDigits, ...validation } = options ?? {};
  return ValidateBy({ name: 'isPositiveDecimal', validator: { validate: (value: unknown) => isPositiveDecimalString(value, undefined, maxIntegerDigits), defaultMessage: () => message } }, validation);
}

/**
 * Bornes de vraisemblance : 99 999 L par plein, prix unitaire < 1 000 000 TND, total < 1 000 000 000 000 TND.
 * Elles garantissent que l'écart litres × prix − total reste représentable (D-224), sans refuser un plein réel.
 */
export const LITERS_MAX_INTEGER_DIGITS = 5;
export const UNIT_PRICE_MAX_INTEGER_DIGITS = 6;
export const TOTAL_MAX_INTEGER_DIGITS = 12;

const IDEMPOTENCY_DESCRIPTION = 'Clé d’idempotence (ou en-tête Idempotency-Key, 8 à 128 caractères).';

/**
 * Saisie d'un plein (CDC 8.2, D-222 à D-226). Le personnel (costs.write) crée un plein VALIDE et sa
 * dépense ; un conducteur crée une soumission (SOUMIS) sur le véhicule de son utilisation.
 */
export class CreateFuelEntryDto {
  @ApiProperty({ description: 'Véhicule ravitaillé.' })
  @IsUUID('all', { message: 'Véhicule : identifiant invalide.' })
  vehicleId!: string;

  @ApiProperty({ format: 'date-time', example: '2026-09-24T08:30:00+01:00', description: 'Date et heure du plein (non future à 5 minutes près, D-223).' })
  @IsDateString({ strict: true }, { message: 'Date et heure du plein : horodatage ISO 8601 attendu.' })
  @Matches(INSTANT_PATTERN, { message: 'Date et heure du plein : heure et fuseau obligatoires (ex. 2026-09-24T08:30:00+01:00).' })
  filledAt!: string;

  @ApiPropertyOptional({ description: 'Conducteur (facultatif pour le personnel ; imposé par le serveur pour un conducteur).' })
  @IsOptional()
  @IsUUID('all', { message: 'Conducteur : identifiant invalide.' })
  driverId?: string;

  @ApiPropertyOptional({ description: 'Station / fournisseur actif de la société du véhicule.' })
  @IsOptional()
  @IsUUID('all', { message: 'Fournisseur : identifiant invalide.' })
  supplierId?: string;

  @ApiProperty({ example: '40.000', description: 'Litres achetés (décimal exact strictement positif, 3 décimales au plus).' })
  @IsPositiveDecimal('Litres : nombre strictement positif, 3 décimales au plus, 99 999 au plus (ex. 40.250).', { maxIntegerDigits: LITERS_MAX_INTEGER_DIGITS })
  liters!: string;

  @ApiPropertyOptional({ example: '2.525', description: 'Prix unitaire TTC en TND (facultatif ; sans prix, aucun contrôle d’écart).' })
  @IsOptional()
  @IsPositiveDecimal('Prix unitaire : montant strictement positif, 3 décimales au plus (ex. 2.525).', { maxIntegerDigits: UNIT_PRICE_MAX_INTEGER_DIGITS })
  unitPrice?: string;

  @ApiProperty({ example: '101.000', description: 'Montant total TTC en TND, jamais recalculé.' })
  @IsPositiveDecimal('Montant total : montant strictement positif, 3 décimales au plus (ex. 101.000).', { maxIntegerDigits: TOTAL_MAX_INTEGER_DIGITS })
  totalAmount!: string;

  @ApiPropertyOptional({ enum: FUEL_ENERGIES, description: 'Carburant ; par défaut celui du véhicule thermique (obligatoire pour un hybride).' })
  @IsOptional()
  @IsIn(FUEL_ENERGIES, { message: 'Carburant : DIESEL, ESSENCE ou GPL.' })
  energy?: FuelEnergy;

  @ApiProperty({ description: 'Plein complet (true) ou partiel (false) : aucune valeur par défaut.' })
  @IsBoolean({ message: 'Indiquez si le plein est complet (true) ou partiel (false).' })
  isFullTank!: boolean;

  @ApiPropertyOptional({ example: '10400', description: 'Compteur physique affiché au moment du plein (relevé contexte CARBURANT, observé à la date du plein).' })
  @IsOptional()
  @Matches(KM_PATTERN, { message: 'Compteur : nombre positif, 3 décimales au plus.' })
  odometerKm?: string;

  @ApiPropertyOptional({ description: 'Ticket (pièce jointe téléversée) ; obligatoire pour une soumission conducteur.' })
  @IsOptional()
  @IsUUID('all', { message: 'Ticket : identifiant de pièce jointe invalide.' })
  ticketAttachmentId?: string;

  @ApiPropertyOptional({ description: 'Remarques.' })
  @IsOptional()
  @IsString({ message: 'Remarques : texte attendu.' })
  @MaxLength(2000, { message: 'Remarques : 2 000 caractères au plus.' })
  notes?: string;

  @ApiPropertyOptional({ description: IDEMPOTENCY_DESCRIPTION })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  idempotencyKey?: string;
}

/**
 * Correction d'un plein validé (D-222, D-229) : nouvelle ligne qui remplace l'ancienne, dépense remplacée.
 * Champ absent : valeur conservée ; null : valeur effacée (champs facultatifs). Le véhicule, la date et le
 * compteur ne se corrigent pas ici (annulation puis nouvelle saisie, ou correction du relevé).
 */
export class CorrectFuelEntryDto {
  @ApiProperty({ description: 'Motif de la correction (audit).' })
  @Transform(trimmed)
  @IsString({ message: 'Motif : texte attendu.' })
  @MinLength(3, { message: 'Motif : 3 caractères au moins.' })
  @MaxLength(500, { message: 'Motif : 500 caractères au plus.' })
  reason!: string;

  @ApiProperty({ description: 'Version connue du plein (verrou optimiste).' })
  @Type(() => Number)
  @IsInt({ message: 'Version attendue : entier requis.' })
  @Min(1, { message: 'Version attendue : entier positif.' })
  expectedVersion!: number;

  @ApiPropertyOptional({ example: '41.500' })
  @IsOptional()
  @IsPositiveDecimal('Litres : nombre strictement positif, 3 décimales au plus, 99 999 au plus.', { maxIntegerDigits: LITERS_MAX_INTEGER_DIGITS })
  liters?: string;

  @ApiPropertyOptional({ type: String, example: '2.525', nullable: true })
  @IsOptional()
  @IsPositiveDecimal('Prix unitaire : montant strictement positif, 3 décimales au plus.', { maxIntegerDigits: UNIT_PRICE_MAX_INTEGER_DIGITS })
  unitPrice?: string | null;

  @ApiPropertyOptional({ example: '104.788' })
  @IsOptional()
  @IsPositiveDecimal('Montant total : montant strictement positif, 3 décimales au plus.', { maxIntegerDigits: TOTAL_MAX_INTEGER_DIGITS })
  totalAmount?: string;

  @ApiPropertyOptional({ enum: FUEL_ENERGIES })
  @IsOptional()
  @IsIn(FUEL_ENERGIES, { message: 'Carburant : DIESEL, ESSENCE ou GPL.' })
  energy?: FuelEnergy;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'Plein complet : vrai ou faux.' })
  isFullTank?: boolean;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsUUID('all', { message: 'Fournisseur : identifiant invalide.' })
  supplierId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsUUID('all', { message: 'Conducteur : identifiant invalide.' })
  driverId?: string | null;

  @ApiPropertyOptional({ description: 'Nouveau ticket (sinon le ticket actuel est conservé).' })
  @IsOptional()
  @IsUUID('all', { message: 'Ticket : identifiant de pièce jointe invalide.' })
  ticketAttachmentId?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString({ message: 'Remarques : texte attendu.' })
  @MaxLength(2000, { message: 'Remarques : 2 000 caractères au plus.' })
  notes?: string | null;

  @ApiPropertyOptional({ description: IDEMPOTENCY_DESCRIPTION })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  idempotencyKey?: string;
}
