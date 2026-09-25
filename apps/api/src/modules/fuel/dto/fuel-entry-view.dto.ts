import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsUUID, Matches } from 'class-validator';
import { PageMetaDto, PageQueryDto } from '../../../common/pagination.js';
import { ENTRY_ELIGIBILITY_LABELS, type EntryEligibility } from '../../../domain/consumption.js';
import { FUEL_ENERGIES } from '../../../domain/fuel-rules.js';

export const FUEL_ENTRY_STATUSES = ['SOUMIS', 'VALIDE', 'REJETE', 'ANNULE', 'REMPLACE'] as const;
export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ELIGIBILITIES = Object.keys(ENTRY_ELIGIBILITY_LABELS) as EntryEligibility[];

export class FuelEntriesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Société courante (recoupée avec le périmètre).' })
  @IsOptional()
  @IsUUID('all', { message: 'Société : identifiant invalide.' })
  companyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('all', { message: 'Véhicule : identifiant invalide.' })
  vehicleId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('all', { message: 'Conducteur : identifiant invalide.' })
  driverId?: string;

  @ApiPropertyOptional({ enum: FUEL_ENTRY_STATUSES })
  @IsOptional()
  @IsIn(FUEL_ENTRY_STATUSES, { message: 'Statut inconnu.' })
  status?: (typeof FUEL_ENTRY_STATUSES)[number];

  @ApiPropertyOptional({ format: 'date', description: 'Début de période (date civile locale du plein, incluse).' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'Date de début : format AAAA-MM-JJ.' })
  @IsISO8601({ strict: true }, { message: 'Date de début : date calendaire inexistante.' })
  from?: string;

  @ApiPropertyOptional({ format: 'date', description: 'Fin de période (date civile locale du plein, incluse).' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'Date de fin : format AAAA-MM-JJ.' })
  @IsISO8601({ strict: true }, { message: 'Date de fin : date calendaire inexistante.' })
  to?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'Filtre « Écart montant » (D-224).' })
  @IsOptional()
  @IsIn(['true', 'false'], { message: 'Écart montant : true ou false.' })
  amountMismatch?: 'true' | 'false';
}

export class FuelEntryViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Société au fait générateur (société du véhicule à la date du plein).' }) companyId!: string;
  @ApiProperty() vehicleId!: string;
  @ApiProperty() vehicleCode!: string;
  @ApiProperty() vehicleRegistration!: string;
  @ApiProperty({ nullable: true, type: String }) driverId!: string | null;
  @ApiProperty({ nullable: true, type: String }) driverName!: string | null;
  @ApiProperty({ nullable: true, type: String }) supplierId!: string | null;
  @ApiProperty({ nullable: true, type: String }) supplierName!: string | null;
  @ApiProperty({ format: 'date-time' }) filledAt!: string;
  @ApiProperty({ description: 'Litres (3 décimales).' }) liters!: string;
  @ApiProperty({ nullable: true, type: String, description: 'Prix unitaire TTC (visible avec costs.read ; conducteur : sa saisie).' }) unitPrice!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Montant total TTC (visible avec costs.read ; conducteur : sa saisie).' }) totalAmount!: string | null;
  @ApiProperty({ enum: FUEL_ENERGIES }) energy!: string;
  @ApiProperty() isFullTank!: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'Compteur physique proposé avec le plein.' }) declaredPhysicalKm!: string | null;
  @ApiProperty({ nullable: true, type: String }) readingId!: string | null;
  @ApiProperty({ nullable: true, type: String, enum: ['EN_ATTENTE', 'ACCEPTE', 'REJETE', 'REMPLACE'] }) readingStatus!: string | null;
  @ApiProperty({ nullable: true, type: String }) readingStatusReason!: string | null;
  @ApiProperty({ enum: ELIGIBILITIES, description: 'Admissibilité au calcul de consommation (calculée à la volée).' }) consumptionEligibility!: EntryEligibility;
  @ApiProperty() consumptionEligibilityLabel!: string;
  @ApiProperty({ nullable: true, type: String }) ticketAttachmentId!: string | null;
  @ApiProperty({ enum: FUEL_ENTRY_STATUSES }) status!: string;
  @ApiProperty({ description: 'Écart litres × prix unitaire / total au-delà de la tolérance (signalé, jamais corrigé).' }) amountMismatch!: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'Écart absolu en TND (visible avec costs.read ; conducteur : sa saisie).' }) amountMismatchValue!: string | null;
  @ApiProperty({ description: 'Litres supérieurs à 105 % de la capacité du réservoir.' }) tankCapacityExceeded!: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) capacityConfirmedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) replacesFuelEntryId!: string | null;
  @ApiProperty({ nullable: true, type: String }) replacedByFuelEntryId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) decidedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Motif de rejet, d’annulation ou de correction.' }) decisionReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Dépense de synthèse active (costs.read ; jamais visible du conducteur).' }) expenseId!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() version!: number;
}

export class FuelEntriesPageDto extends PageMetaDto {
  @ApiProperty({ type: [FuelEntryViewDto] }) items!: FuelEntryViewDto[];
}
