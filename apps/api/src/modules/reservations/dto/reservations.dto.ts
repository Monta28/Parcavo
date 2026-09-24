import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination.js';

/** Texte obligatoire : espaces de bord retirés avant les contrôles de longueur (un motif blanc n'est pas un motif). */
const trimmed = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
/** Texte facultatif effaçable : espaces de bord retirés, chaîne vide enregistrée comme absente (null). */
const blankToNull = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() || null : value);
/** Champ facultatif non effaçable : absent = inchangé ; null est refusé (422) au lieu d'être ignoré. */
const present = (_object: object, value: unknown): boolean => value !== undefined;

export class CreateReservationDto {
  @ApiProperty() @IsUUID() vehicleId!: string;
  @ApiProperty() @IsUUID() driverId!: string;
  @ApiProperty({ description: 'Début prévu (inclus), ISO 8601.' }) @IsDateString() startAt!: string;
  @ApiProperty({ description: 'Fin prévue (exclue) : [début, fin[.' }) @IsDateString() endAt!: string;
  @ApiProperty({ minLength: 2, maxLength: 300 }) @Transform(trimmed) @IsString() @MinLength(2) @MaxLength(300) purpose!: string;
  @ApiPropertyOptional({ type: String, maxLength: 300 }) @Transform(blankToNull) @IsOptional() @IsString() @MaxLength(300) destination?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() siteId?: string;
  @ApiPropertyOptional({ type: String, maxLength: 2000 }) @Transform(blankToNull) @IsOptional() @IsString() @MaxLength(2000) comment?: string | null;
  @ApiPropertyOptional({ minLength: 5, maxLength: 500, description: 'Dérogation motivée aux blocages documentaires ou de permis (exceptions.override) ; un texte blanc est refusé.' }) @Transform(trimmed) @ValidateIf(present) @IsString() @MinLength(5) @MaxLength(500) overrideReason?: string;
}

export class UpdateReservationDto {
  @ApiPropertyOptional({ description: 'Autre véhicule (société déduite du véhicule ; contrôles complets refaits). Non modifiable après le début prévu ; null refusé.' }) @ValidateIf(present) @IsUUID() vehicleId?: string;
  @ApiPropertyOptional({ description: 'Autre conducteur (même société que le véhicule ; contrôles complets refaits). Non modifiable après le début prévu ; null refusé.' }) @ValidateIf(present) @IsUUID() driverId?: string;
  @ApiPropertyOptional({ description: 'Nouveau début prévu (tronqué à la minute, au plus 15 min dans le passé). Non modifiable après le début prévu ; null refusé.' }) @ValidateIf(present) @IsDateString() startAt?: string;
  @ApiPropertyOptional({ description: 'Nouvelle fin prévue (exclue, tronquée à la minute) : seule donnée modifiable après le début prévu ; null refusé.' }) @ValidateIf(present) @IsDateString() endAt?: string;
  @ApiPropertyOptional({ minLength: 2, maxLength: 300, description: 'Motif de la réservation ; null ou texte blanc refusé.' }) @Transform(trimmed) @ValidateIf(present) @IsString() @MinLength(2) @MaxLength(300) purpose?: string;
  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 300, description: 'null ou texte blanc pour la retirer.' }) @Transform(blankToNull) @IsOptional() @IsString() @MaxLength(300) destination?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String, description: 'Site de destination de la société du véhicule ; null pour le retirer.' }) @IsOptional() @IsUUID() siteId?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 2000, description: 'null ou texte blanc pour le retirer.' }) @Transform(blankToNull) @IsOptional() @IsString() @MaxLength(2000) comment?: string | null;
  @ApiPropertyOptional({ minLength: 5, maxLength: 500, description: 'Dérogation motivée aux blocages documentaires ou de permis (exceptions.override), comme à la création ; un texte blanc est refusé.' }) @Transform(trimmed) @ValidateIf(present) @IsString() @MinLength(5) @MaxLength(500) overrideReason?: string;
  @ApiProperty({ description: 'Motif de la modification (conservé avec l’auteur et la date).' }) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class ReservationDecisionDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class ReservationsQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() vehicleId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() driverId?: string;
  @ApiPropertyOptional({ enum: ['CONFIRMEE', 'CONVERTIE', 'ANNULEE', 'NON_HONOREE'] }) @IsOptional() @IsIn(['CONFIRMEE', 'CONVERTIE', 'ANNULEE', 'NON_HONOREE']) status?: 'CONFIRMEE' | 'CONVERTIE' | 'ANNULEE' | 'NON_HONOREE';
  @ApiPropertyOptional({ description: 'Début de la fenêtre (chevauchement).' }) @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional({ description: 'Fin de la fenêtre (chevauchement).' }) @IsOptional() @IsDateString() to?: string;
}

export class PlanningQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() vehicleId?: string;
  @ApiProperty() @IsDateString() from!: string;
  @ApiProperty() @IsDateString() to!: string;
}

export class ReservationViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() vehicleId!: string;
  @ApiProperty() vehicleCode!: string;
  @ApiProperty() vehicleRegistration!: string;
  @ApiProperty() driverId!: string;
  @ApiProperty() driverName!: string;
  @ApiProperty() startAt!: string;
  @ApiProperty() endAt!: string;
  @ApiProperty() purpose!: string;
  @ApiProperty({ nullable: true, type: String }) destination!: string | null;
  @ApiProperty({ nullable: true, type: String }) siteId!: string | null;
  @ApiProperty({ nullable: true, type: String }) comment!: string | null;
  @ApiProperty({ enum: ['CONFIRMEE', 'CONVERTIE', 'ANNULEE', 'NON_HONOREE'] }) status!: string;
  @ApiProperty({ nullable: true, type: String }) convertedUsageId!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelledAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Motif de l’annulation ou du constat de non-présentation.' }) cancelReason!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Date du passage en NON_HONOREE (constat manuel ou rattrapage automatique).' }) noShowAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Auteur de l’annulation ou du constat manuel de non-présentation (null pour le rattrapage automatique).' }) closedByName!: string | null;
  @ApiProperty({ nullable: true, enum: ['COMPLETE', 'FIN_SEULEMENT'], description: 'Réservation CONFIRMEE : tout est modifiable avant le début prévu, seulement la fin ensuite ; null sinon.' }) editScope!: 'COMPLETE' | 'FIN_SEULEMENT' | null;
  @ApiProperty({ nullable: true, type: String, description: 'Réservation CONFIRMEE : premier instant du constat manuel de non-présentation (début + reservations.noShowGraceMinutes) ; null sinon.' }) noShowAllowedFrom!: string | null;
  @ApiProperty({ nullable: true, type: String }) createdByName!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() version!: number;
}

export class PlanningItemDto {
  @ApiProperty({ enum: ['RESERVATION', 'UTILISATION', 'IMMOBILISATION', 'INTERVENTION'] }) kind!: 'RESERVATION' | 'UTILISATION' | 'IMMOBILISATION' | 'INTERVENTION';
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Société de l’élément (réservation, utilisation, immobilisation ou intervention) : les actions en dépendent.' }) companyId!: string;
  @ApiProperty() vehicleId!: string;
  @ApiProperty() vehicleCode!: string;
  @ApiProperty({ nullable: true, type: String }) driverName!: string | null;
  @ApiProperty() startAt!: string;
  @ApiProperty({ nullable: true, type: String, description: 'Fin prévue ou réelle ; null si ouverte sans fin connue.' }) endAt!: string | null;
  @ApiProperty() status!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ description: 'Retour dépassé (utilisation) ou fin prévue dépassée (intervention), calculé par l’API.' }) isLate!: boolean;
}

export class PlanningWarningDto {
  @ApiProperty({ enum: ['INTERVENTION_CHEVAUCHE_RESERVATION'] }) code!: 'INTERVENTION_CHEVAUCHE_RESERVATION';
  @ApiProperty() message!: string;
  @ApiProperty() vehicleId!: string;
  @ApiProperty() vehicleCode!: string;
  @ApiProperty({ description: 'Société de la réservation concernée.' }) companyId!: string;
  @ApiProperty() interventionId!: string;
  @ApiProperty() interventionReference!: string;
  @ApiProperty() reservationId!: string;
  @ApiProperty() driverName!: string;
}

export class PlanningResponseDto {
  @ApiProperty({ type: [PlanningItemDto] }) items!: PlanningItemDto[];
  @ApiProperty({ type: [PlanningWarningDto], description: 'Avertissements sans blocage (D-205) : intervention planifiée ou en cours qui chevauche une réservation confirmée.' }) warnings!: PlanningWarningDto[];
}
