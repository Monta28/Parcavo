import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsISO8601, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { CONSUMPTION_UNAVAILABLE_REASONS } from '../../../domain/consumption.js';
import { FUEL_ENERGIES } from '../../../domain/fuel-rules.js';
import { TELEMATIC_CONSUMPTION_REASONS } from '../../../domain/telemetry/telematic-consumption.js';
import { INSTANT_PATTERN, trimmed } from './create-fuel-entry.dto.js';
import { DATE_ONLY } from './fuel-entry-view.dto.js';

export class ConsumptionQueryDto {
  @ApiPropertyOptional({ format: 'date', description: 'Début de période (date civile locale, incluse) : intervalles dont le plein B tombe dans la période.' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'Date de début : format AAAA-MM-JJ.' })
  @IsISO8601({ strict: true }, { message: 'Date de début : date calendaire inexistante.' })
  from?: string;

  @ApiPropertyOptional({ format: 'date', description: 'Fin de période (date civile locale, incluse).' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'Date de fin : format AAAA-MM-JJ.' })
  @IsISO8601({ strict: true }, { message: 'Date de fin : date calendaire inexistante.' })
  to?: string;
}

export class ConsumptionReasonDto {
  @ApiProperty({ enum: CONSUMPTION_UNAVAILABLE_REASONS }) code!: string;
  @ApiProperty() label!: string;
}

/** Motif d'une consommation télématique N/D (D-234). */
export class TelematicConsumptionReasonDto {
  @ApiProperty({ enum: TELEMATIC_CONSUMPTION_REASONS }) code!: string;
  @ApiProperty() label!: string;
}

/**
 * Consommation télématique en parallèle (CDC 8.5 ; D-234, D-236) : même intervalle A → B et mêmes kilomètres
 * que la consommation déclarée ; nature de la mesure et écart avec la consommation déclarée.
 */
export class TelematicConsumptionDto {
  @ApiProperty({ enum: ['CONSOMMATION_CAN', 'NIVEAU_SONDE'] }) kind!: string;
  @ApiProperty({ description: 'Libellé de la nature (« Consommation CAN », « Niveau sonde »).' }) kindLabel!: string;
  @ApiProperty({ description: 'Faux : N/D motivé, jamais remplacé par une estimation.' }) available!: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'Litres consommés selon la télématique.' }) liters!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'L/100 km arrondi à 1 décimale.' }) litersPer100Km!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'L/100 km exact.' }) litersPer100KmExact!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Écart signé en % par rapport à la consommation déclarée (1 décimale, ex. « +4.2 »).' }) deviationPercent!: string | null;
  @ApiProperty({ type: [TelematicConsumptionReasonDto] }) reasons!: TelematicConsumptionReasonDto[];
}

export class TelematicConsumptionTotalDto extends TelematicConsumptionDto {
  @ApiProperty({ description: 'Intervalles comparés : consommation déclarée retenue et télématique disponible.' }) comparedIntervals!: number;
  @ApiProperty({ nullable: true, type: String }) distanceKm!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Litres déclarés des intervalles comparés.' }) declaredLiters!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Consommation déclarée des seuls intervalles comparés (1 décimale).' }) declaredLitersPer100Km!: string | null;
}

export class ConsumptionIntervalDto {
  @ApiProperty({ enum: FUEL_ENERGIES }) energy!: string;
  @ApiProperty({ nullable: true, type: String, description: 'Plein complet de référence A.' }) startFuelEntryId!: string | null;
  @ApiProperty({ description: 'Plein complet B.' }) endFuelEntryId!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) startFilledAt!: string | null;
  @ApiProperty({ format: 'date-time' }) endFilledAt!: string;
  @ApiProperty({ nullable: true, type: String, description: 'Kilométrage cumulé validé en A.' }) startKm!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Kilométrage cumulé validé en B.' }) endKm!: string | null;
  @ApiProperty({ nullable: true, type: String }) distanceKm!: string | null;
  @ApiProperty({ description: 'Litres achetés après A, B inclus.' }) liters!: string;
  @ApiProperty({ type: [String], description: 'Achats de ]A, B].' }) fuelEntryIds!: string[];
  @ApiProperty() retained!: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'L/100 km arrondi à 1 décimale (affichage).' }) litersPer100Km!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'L/100 km exact (non arrondi).' }) litersPer100KmExact!: string | null;
  @ApiProperty({ type: [ConsumptionReasonDto] }) reasons!: ConsumptionReasonDto[];
  @ApiPropertyOptional({ type: TelematicConsumptionDto, description: 'Consommation télématique du même intervalle (8.5 ; D-234, D-236) ; absente sans mesure CONSOMMATION_CAN ou NIVEAU_SONDE.' })
  telematics?: TelematicConsumptionDto;
}

export class ConsumptionTotalDto {
  @ApiProperty({ enum: FUEL_ENERGIES }) energy!: string;
  @ApiProperty({ description: 'Faux : N/D, jamais remplacé par une estimation.' }) available!: boolean;
  @ApiProperty({ nullable: true, type: String }) liters!: string | null;
  @ApiProperty({ nullable: true, type: String }) distanceKm!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'L/100 km arrondi à 1 décimale.' }) litersPer100Km!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'L/100 km exact.' }) litersPer100KmExact!: string | null;
  @ApiProperty({ type: [ConsumptionReasonDto] }) reasons!: ConsumptionReasonDto[];
  @ApiProperty() retainedIntervals!: number;
  @ApiProperty() excludedIntervals!: number;
  @ApiPropertyOptional({ type: TelematicConsumptionTotalDto, description: 'Consommation télématique sur les intervalles comparables (8.5 ; D-234, D-236) ; absente sans mesure CONSOMMATION_CAN ou NIVEAU_SONDE.' })
  telematics?: TelematicConsumptionTotalDto;
}

export class ConsumptionViewDto {
  @ApiProperty() vehicleId!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date' }) from!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date' }) to!: string | null;
  @ApiProperty({ example: 'L/100 km' }) unit!: string;
  @ApiProperty({ description: 'Nature du résultat (8.3) : estimation fondée sur les saisies, pas une mesure télématique.' }) nature!: string;
  @ApiProperty() available!: boolean;
  @ApiProperty({ type: [ConsumptionReasonDto], description: 'Motifs du N/D global.' }) reasons!: ConsumptionReasonDto[];
  @ApiProperty({ type: [ConsumptionTotalDto], description: 'Consommation par énergie.' }) totals!: ConsumptionTotalDto[];
  @ApiProperty({ type: [ConsumptionIntervalDto], description: 'Intervalles retenus et exclus.' }) intervals!: ConsumptionIntervalDto[];
}

export class CreateFuelPurchaseGapDto {
  @ApiProperty({ format: 'date-time', description: 'Début de la période sans achats complets.' })
  @IsDateString({ strict: true }, { message: 'Début : horodatage ISO 8601 attendu.' })
  @Matches(INSTANT_PATTERN, { message: 'Début : heure et fuseau obligatoires (ex. 2026-09-15T00:00:00+01:00).' })
  startsAt!: string;

  @ApiProperty({ format: 'date-time', description: 'Fin de la période (postérieure au début).' })
  @IsDateString({ strict: true }, { message: 'Fin : horodatage ISO 8601 attendu.' })
  @Matches(INSTANT_PATTERN, { message: 'Fin : heure et fuseau obligatoires (ex. 2026-09-16T00:00:00+01:00).' })
  endsAt!: string;

  @ApiProperty({ description: 'Motif (ex. carte carburant perdue, tickets non remis).' })
  @Transform(trimmed)
  @IsString({ message: 'Motif : texte attendu.' })
  @MinLength(3, { message: 'Motif : 3 caractères au moins.' })
  @MaxLength(500, { message: 'Motif : 500 caractères au plus.' })
  reason!: string;
}

export class FuelPurchaseGapViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() vehicleId!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty({ format: 'date-time' }) startsAt!: string;
  @ApiProperty({ format: 'date-time' }) endsAt!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ nullable: true, type: String }) createdById!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
