import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination.js';

/**
 * Lieu d'immobilisation (7.4) : un seul lieu parmi site, garage et lieu libre (422 LIEU_EXCLUSIF sinon).
 * Sur une immobilisation déjà active, un lieu fourni remplace explicitement le lieu enregistré (audité).
 */
export class ImmobilizationPlaceDto {
  @ApiPropertyOptional({ description: 'Site actif de la société (exclusif du garage et du lieu libre).' }) @IsOptional() @IsUUID() siteId?: string;
  @ApiPropertyOptional({ description: 'Garage : fournisseur ACTIF de catégorie GARAGE de la société (archivé : 422 FOURNISSEUR_ARCHIVE).' }) @IsOptional() @IsUUID() garageSupplierId?: string;
  @ApiPropertyOptional({ description: 'Lieu libre (200 caractères), exclusif du site et du garage.' }) @IsOptional() @IsString() @MaxLength(200) locationLabel?: string;
}

export class CreateImmobilizationDto extends ImmobilizationPlaceDto {
  @ApiProperty() @IsUUID() vehicleId!: string;
  @ApiProperty({ description: 'Motif de la cause.' }) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiPropertyOptional({ description: 'Incident source (cause INCIDENT).' }) @IsOptional() @IsUUID() incidentId?: string;
  @ApiPropertyOptional({ description: 'Intervention source (cause INTERVENTION).' }) @IsOptional() @IsUUID() interventionId?: string;
  @ApiPropertyOptional({ format: 'date-time', description: 'Début (défaut : maintenant) ; jamais dans le futur.' }) @IsOptional() @IsDateString() startedAt?: string;
  @ApiPropertyOptional({ format: 'date-time', description: 'Fin prévue, postérieure au début. Sur une immobilisation déjà active, elle remplace explicitement la fin prévue enregistrée.' }) @IsOptional() @IsDateString() expectedEndAt?: string;
}

export class AddCauseDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() incidentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() interventionId?: string;
  @ApiPropertyOptional({ format: 'date-time' }) @IsOptional() @IsDateString() startedAt?: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class EndCauseDto {
  @ApiPropertyOptional({ format: 'date-time', description: 'Fin réelle (défaut : maintenant).' }) @IsOptional() @IsDateString() endedAt?: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class UpdateImmobilizationDto extends ImmobilizationPlaceDto {
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) @IsOptional() @IsDateString() expectedEndAt?: string | null;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class ImmobilizationsQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() vehicleId?: string;
  @ApiPropertyOptional({ enum: ['ACTIVE', 'TERMINEE'] }) @IsOptional() @IsIn(['ACTIVE', 'TERMINEE']) status?: 'ACTIVE' | 'TERMINEE';
}

export class ImmobilizationCauseViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['INCIDENT', 'INTERVENTION', 'AUTRE'] }) kind!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ nullable: true, type: String }) incidentId!: string | null;
  @ApiProperty({ nullable: true, type: String }) incidentReference!: string | null;
  @ApiProperty({ nullable: true, type: String }) interventionId!: string | null;
  @ApiProperty({ nullable: true, type: String }) interventionReference!: string | null;
  @ApiProperty({ format: 'date-time' }) startedAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) endedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) endReason!: string | null;
  @ApiProperty({ description: 'Durée propre de la cause en heures (une décimale), jusqu’à maintenant si elle est ouverte.' }) durationHours!: number;
  @ApiProperty({ description: 'Durée propre de la cause en jours (une décimale).' }) durationDays!: number;
}

export class ImmobilizationViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() vehicleId!: string;
  @ApiProperty() vehicleCode!: string;
  @ApiProperty() vehicleRegistration!: string;
  @ApiProperty({ enum: ['ACTIVE', 'TERMINEE'] }) status!: string;
  @ApiProperty({ format: 'date-time' }) startedAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) expectedEndAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) endedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) siteId!: string | null;
  @ApiProperty({ nullable: true, type: String }) siteName!: string | null;
  @ApiProperty({ nullable: true, type: String }) garageSupplierId!: string | null;
  @ApiProperty({ nullable: true, type: String }) garageName!: string | null;
  @ApiProperty({ nullable: true, type: String }) locationLabel!: string | null;
  @ApiProperty({ description: 'Durée totale en heures, une décimale : union des intervalles des causes (D-219), jusqu’à maintenant si en cours.' }) durationHours!: number;
  @ApiProperty({ description: 'Durée totale en jours, une décimale (même union).' }) durationDays!: number;
  @ApiProperty({ description: 'Vrai si la somme des durées propres des causes dépasse le total (causes superposées).' }) causesOverlap!: boolean;
  @ApiProperty({ description: 'Mention à afficher avec la ventilation par cause.' }) causeDurationsNote!: string;
  @ApiProperty({ nullable: true, type: String, description: 'Utilisation en cours pendant l’immobilisation (conservée, restitution possible).' }) openUsageId!: string | null;
  @ApiProperty({ type: [ImmobilizationCauseViewDto] }) causes!: ImmobilizationCauseViewDto[];
  @ApiProperty() version!: number;
}
