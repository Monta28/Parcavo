import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination.js';
import { TaskInputDto } from '../../interventions/dto/interventions.dto.js';

const TYPES = ['PANNE', 'DOMMAGE', 'ACCIDENT', 'CREVAISON', 'ANOMALIE_COMPTEUR', 'CONTRAVENTION', 'AUTRE'] as const;
const SEVERITIES = ['FAIBLE', 'MOYENNE', 'ELEVEE', 'CRITIQUE'] as const;
const STATUSES = ['OUVERT', 'EN_TRAITEMENT', 'RESOLU', 'CLOTURE'] as const;

export class CreateIncidentDto {
  @ApiPropertyOptional({ description: 'Véhicule (fixé par le serveur pour un conducteur : véhicule de son utilisation).' }) @IsOptional() @IsUUID() vehicleId?: string;
  @ApiProperty({ enum: TYPES }) @IsIn(TYPES) type!: (typeof TYPES)[number];
  @ApiPropertyOptional({ enum: SEVERITIES, description: 'Défaut : MOYENNE (ACCIDENT : ELEVEE).' }) @IsOptional() @IsIn(SEVERITIES) severity?: (typeof SEVERITIES)[number];
  @ApiPropertyOptional({ format: 'date-time', description: 'Date/heure du fait (défaut : maintenant).' }) @IsOptional() @IsDateString() occurredAt?: string;
  @ApiPropertyOptional({ description: 'Lieu déclaré (texte libre).' }) @IsOptional() @IsString() @MaxLength(200) locationLabel?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() siteId?: string;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(4000) description!: string;
  @ApiPropertyOptional({ description: 'Conducteur concerné (personnel uniquement).' }) @IsOptional() @IsUUID() driverId?: string;
  @ApiPropertyOptional({ description: 'Utilisation concernée (personnel uniquement).' }) @IsOptional() @IsUUID() usageId?: string;
  @ApiPropertyOptional({ description: 'Responsable du suivi (personnel uniquement).' }) @IsOptional() @IsUUID() followUpUserId?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(10) @IsUUID('all', { each: true }) photoAttachmentIds?: string[];
}

export class UpdateIncidentDto {
  @ApiPropertyOptional({ enum: TYPES }) @IsOptional() @IsIn(TYPES) type?: (typeof TYPES)[number];
  @ApiPropertyOptional({ enum: SEVERITIES, description: 'Requalification de la gravité (chef ou administrateur).' }) @IsOptional() @IsIn(SEVERITIES) severity?: (typeof SEVERITIES)[number];
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(5) @MaxLength(4000) description?: string;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsString() @MaxLength(200) locationLabel?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsUUID() siteId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsUUID() followUpUserId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Lien explicite avec un conducteur (action du chef, sans libellé « responsable »).' }) @IsOptional() @IsUUID() driverId?: string | null;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(10) @IsUUID('all', { each: true }) photoAttachmentIds?: string[];
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class TransitionIncidentDto {
  @ApiProperty({ enum: STATUSES }) @IsIn(STATUSES) to!: (typeof STATUSES)[number];
  @ApiPropertyOptional({ description: 'Note de résolution, motif de clôture « sans suite » ou de réouverture.' }) @IsOptional() @IsString() @MinLength(3) @MaxLength(2000) note?: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class CreateCommentDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(4000) body!: string;
  @ApiPropertyOptional({ enum: ['INTERNE', 'PARTAGE_CONDUCTEUR'], description: 'Défaut INTERNE ; un commentaire de conducteur est toujours partagé.' }) @IsOptional() @IsIn(['INTERNE', 'PARTAGE_CONDUCTEUR']) visibility?: 'INTERNE' | 'PARTAGE_CONDUCTEUR';
}

export class IncidentInterventionDto {
  @ApiPropertyOptional({ enum: ['PREVENTIF', 'CORRECTIF'], default: 'CORRECTIF' }) @IsOptional() @IsIn(['PREVENTIF', 'CORRECTIF']) kind?: 'PREVENTIF' | 'CORRECTIF';
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional({ format: 'date-time' }) @IsOptional() @IsDateString() plannedStartAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) diagnosis?: string;
  @ApiPropertyOptional({ type: [TaskInputDto] }) @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => TaskInputDto) tasks?: TaskInputDto[];
}

/**
 * Immobilisation depuis l'incident. Si une immobilisation est déjà active, la cause s'y ajoute et le lieu
 * et la fin prévue fournis la mettent à jour explicitement. Lieu : site, garage ou lieu libre, exclusifs.
 */
export class IncidentImmobilizeDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiPropertyOptional({ format: 'date-time' }) @IsOptional() @IsDateString() startedAt?: string;
  @ApiPropertyOptional({ format: 'date-time', description: 'Fin prévue, postérieure au début.' }) @IsOptional() @IsDateString() expectedEndAt?: string;
  @ApiPropertyOptional({ description: 'Site actif de la société.' }) @IsOptional() @IsUUID() siteId?: string;
  @ApiPropertyOptional({ description: 'Garage : fournisseur ACTIF de catégorie GARAGE de la société.' }) @IsOptional() @IsUUID() garageSupplierId?: string;
  @ApiPropertyOptional({ description: 'Lieu libre.' }) @IsOptional() @IsString() @MaxLength(200) locationLabel?: string;
}

export class IncidentsQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() vehicleId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() driverId?: string;
  @ApiPropertyOptional({ description: 'Incidents rattachés à cette utilisation (recoupé avec le périmètre de l’appelant).' }) @IsOptional() @IsUUID() usageId?: string;
  @ApiPropertyOptional({ enum: STATUSES }) @IsOptional() @IsIn(STATUSES) status?: (typeof STATUSES)[number];
  @ApiPropertyOptional({ description: 'Non clôturés : OUVERT, EN_TRAITEMENT, RESOLU.' }) @IsOptional() @IsIn(['true', 'false']) open?: 'true' | 'false';
  @ApiPropertyOptional({ enum: TYPES }) @IsOptional() @IsIn(TYPES) type?: (typeof TYPES)[number];
  @ApiPropertyOptional({ enum: SEVERITIES }) @IsOptional() @IsIn(SEVERITIES) severity?: (typeof SEVERITIES)[number];
}

export class IncidentCommentViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() body!: string;
  @ApiProperty({ enum: ['INTERNE', 'PARTAGE_CONDUCTEUR'] }) visibility!: string;
  @ApiProperty({ nullable: true, type: String }) authorName!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class IncidentViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() vehicleId!: string;
  @ApiProperty() vehicleCode!: string;
  @ApiProperty() vehicleRegistration!: string;
  @ApiProperty({ nullable: true, type: String }) driverId!: string | null;
  @ApiProperty({ nullable: true, type: String }) driverName!: string | null;
  @ApiProperty({ nullable: true, type: String }) usageId!: string | null;
  @ApiProperty({ enum: TYPES }) type!: string;
  @ApiProperty({ enum: SEVERITIES }) severity!: string;
  @ApiProperty({ enum: STATUSES }) status!: string;
  @ApiProperty({ format: 'date-time' }) occurredAt!: string;
  @ApiProperty({ nullable: true, type: String }) locationLabel!: string | null;
  @ApiProperty({ nullable: true, type: String }) siteId!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Nom du site déclaré.' }) siteName!: string | null;
  @ApiProperty() description!: string;
  @ApiProperty({ nullable: true, type: String, description: 'Responsable du suivi (personnel ; null pour un conducteur).' }) followUpUserId!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Nom du responsable du suivi (personnel ; null pour un conducteur).' }) followUpUserName!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Note de résolution : suivi interne, jamais renvoyée à un compte conducteur (D-216) ; le conducteur lit les commentaires partagés.' }) resolutionNote!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) resolvedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) closureNote!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) closedAt!: string | null;
  @ApiProperty({ type: [String] }) photoAttachmentIds!: string[];
  @ApiProperty({ type: [String], description: 'Interventions ouvertes depuis l’incident (personnel).' }) interventionIds!: string[];
  @ApiProperty({ nullable: true, type: String, description: 'Cause d’immobilisation ouverte liée (personnel).' }) openImmobilizationCauseId!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Coût lié (dépenses rattachées et interventions issues), visible avec costs.read.' }) linkedCost!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Contravention : utilisation en cours à l’instant déclaré, à titre d’information seulement.' }) usageAtTimeId!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Conducteur de cette utilisation, à titre d’information (aucune responsabilité déduite, D-217).' }) usageAtTimeDriverId!: string | null;
  @ApiProperty({ nullable: true, type: String }) usageAtTimeDriverName!: string | null;
  @ApiProperty() version!: number;
}

export class FollowUpCandidatesQueryDto {
  @ApiProperty({ description: 'Société de l’incident.' }) @IsUUID() companyId!: string;
}

/** Responsable de suivi possible : administrateur, chef de parc ou opérateur actif de la société (nom seulement). */
export class FollowUpCandidateDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Prénom et nom.' }) name!: string;
}

/** Résultat de POST /incidents/:id/immobilize. */
export class IncidentImmobilizeResultDto {
  @ApiProperty({ description: 'Immobilisation créée ou complétée par la cause INCIDENT.' }) immobilizationId!: string;
  @ApiProperty() causeId!: string;
  @ApiProperty({ description: 'Vrai : nouvelle immobilisation ; faux : cause ajoutée à l’immobilisation active du véhicule.' }) created!: boolean;
  @ApiProperty({ description: 'Lieu fourni appliqué à l’immobilisation (y compris en remplacement du lieu de l’immobilisation active).' }) placeApplied!: boolean;
  @ApiProperty({ description: 'Fin prévue fournie appliquée à l’immobilisation (même règle).' }) expectedEndApplied!: boolean;
  @ApiProperty({ type: () => IncidentViewDto }) incident!: IncidentViewDto;
}
