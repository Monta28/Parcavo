import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { VEHICLE_FUEL_THRESHOLD_FIELDS } from '../../../domain/telemetry/fuel-thresholds.js';

const FIELDS = VEHICLE_FUEL_THRESHOLD_FIELDS.map((f) => f.field);
const SOURCES = ['vehicule', 'societe', 'groupe', 'defaut'] as const;

/**
 * Seuils carburant propres à un véhicule (CDC 8.5, 17.1 ; D-238, D-240) : un champ absent ou nul reprend
 * la valeur effective de la société. PUT remplace l'ensemble des surcharges du véhicule ; tous les champs
 * nuls retirent la surcharge. Bornes identiques aux paramètres telemetry.fuel* correspondants (422 sinon).
 */
export class UpdateVehicleFuelThresholdsDto {
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Baisse à l’arrêt : seuil en litres (telemetry.fuelDropLiters).' }) @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false }) dropLiters?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Baisse à l’arrêt : seuil en pourcentage du réservoir (telemetry.fuelDropPercent).' }) @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false }) dropPercent?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Baisse à l’arrêt : fenêtre en minutes (telemetry.fuelDropWindowMinutes).' }) @IsOptional() @IsInt() dropWindowMinutes?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Remplissage détecté : seuil en litres (telemetry.fuelFillMinLiters).' }) @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false }) fillLiters?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Remplissage détecté : seuil en pourcentage du réservoir (telemetry.fuelFillPercent).' }) @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false }) fillPercent?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Remplissage détecté : fenêtre en minutes (telemetry.fuelFillWindowMinutes).' }) @IsOptional() @IsInt() fillWindowMinutes?: number | null;
  @ApiProperty({ description: 'Motif de la modification (audité).' }) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiProperty({ description: 'Version courante des seuils du véhicule (0 quand le véhicule n’en a pas encore).' }) @Type(() => Number) @IsInt() @Min(0) expectedVersion!: number;
}

export class VehicleFuelThresholdDto {
  @ApiProperty({ enum: FIELDS }) field!: string;
  @ApiProperty({ description: 'Paramètre société correspondant.' }) key!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ nullable: true, type: String }) unit!: string | null;
  @ApiProperty({ nullable: true, type: Number, description: 'Surcharge du véhicule (null : valeur de la société).' }) vehicleValue!: number | null;
  @ApiProperty({ description: 'Valeur de la société (surcharge société, sinon groupe, sinon produit).' }) companyValue!: number;
  @ApiProperty({ enum: ['societe', 'groupe', 'defaut'] }) companySource!: string;
  @ApiProperty({ description: 'Valeur appliquée à la détection pour ce véhicule.' }) effectiveValue!: number;
  @ApiProperty({ enum: SOURCES }) source!: string;
  @ApiProperty({ nullable: true, type: Number }) min!: number | null;
  @ApiProperty({ nullable: true, type: Number }) max!: number | null;
}

export class VehicleFuelThresholdsViewDto {
  @ApiProperty() vehicleId!: string;
  @ApiProperty() vehicleCode!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty({ description: 'Version des seuils du véhicule (0 : aucune surcharge).' }) version!: number;
  @ApiProperty({ nullable: true, type: String }) reason!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) updatedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Auteur de la dernière modification.' }) updatedByName!: string | null;
  @ApiProperty({ description: 'Vrai si l’utilisateur peut modifier ces seuils (chef de parc de la société, administrateur).' }) canEdit!: boolean;
  @ApiProperty({ type: [VehicleFuelThresholdDto] }) thresholds!: VehicleFuelThresholdDto[];
}
