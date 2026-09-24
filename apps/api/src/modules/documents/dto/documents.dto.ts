import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination.js';

const OWNER_TYPES = ['VEHICULE', 'CONDUCTEUR'] as const;
const DOC_STATUSES = ['MANQUANT', 'VALIDE', 'A_RENOUVELER', 'EXPIRE'] as const;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class CreateDocumentTypeDto {
  @ApiProperty({ example: 'ASSURANCE' }) @IsString() @Matches(/^[A-Z0-9][A-Z0-9_-]{0,29}$/) code!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) label!: string;
  @ApiProperty({ enum: OWNER_TYPES }) @IsIn(OWNER_TYPES) ownerType!: (typeof OWNER_TYPES)[number];
  @ApiProperty({ description: 'Le document a une date de fin de validité.' }) @IsBoolean() hasExpiry!: boolean;
  @ApiProperty({ description: 'Document attendu pour chaque objet concerné (absence = MANQUANT).' }) @IsBoolean() required!: boolean;
  @ApiProperty({ description: 'Absence ou expiration bloque un nouveau départ (implique « requis »).' }) @IsBoolean() blocksCheckout!: boolean;
  @ApiPropertyOptional({ type: [Number], description: 'Préavis en jours (défaut : paramètre documents.noticeDays, 30/15/7).' }) @IsOptional() @IsArray() @ArrayMaxSize(5) @IsInt({ each: true }) @Min(0, { each: true }) @Max(365, { each: true }) noticeDays?: number[];
  @ApiPropertyOptional({ description: 'Consultable par le conducteur du véhicule en cours d’utilisation.' }) @IsOptional() @IsBoolean() visibleToDriver?: boolean;
  @ApiPropertyOptional({ type: [String], description: 'Restreint aux catégories de véhicule (vide = toutes).' }) @IsOptional() @IsArray() @IsUUID('all', { each: true }) vehicleCategoryIds?: string[];
  @ApiPropertyOptional({ type: [String], description: 'Restreint aux sociétés (vide = toutes).' }) @IsOptional() @IsArray() @IsUUID('all', { each: true }) companyIds?: string[];
}

export class UpdateDocumentTypeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) label?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() required?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() blocksCheckout?: boolean;
  @ApiPropertyOptional({ type: [Number] }) @IsOptional() @IsArray() @ArrayMaxSize(5) @IsInt({ each: true }) @Min(0, { each: true }) @Max(365, { each: true }) noticeDays?: number[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() visibleToDriver?: boolean;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsUUID('all', { each: true }) vehicleCategoryIds?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsUUID('all', { each: true }) companyIds?: string[];
  @ApiPropertyOptional({ enum: ['ACTIF', 'ARCHIVE'] }) @IsOptional() @IsIn(['ACTIF', 'ARCHIVE']) status?: 'ACTIF' | 'ARCHIVE';
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class DocumentFieldsDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) number?: string;
  @ApiPropertyOptional({ description: 'Organisme émetteur.' }) @IsOptional() @IsString() @MaxLength(160) issuer?: string;
  @ApiPropertyOptional({ format: 'date' }) @IsOptional() @Matches(DATE_ONLY) issuedOn?: string;
  @ApiPropertyOptional({ format: 'date', description: 'Début de validité (date civile).' }) @IsOptional() @Matches(DATE_ONLY) validFrom?: string;
  @ApiPropertyOptional({ format: 'date', description: 'Fin de validité : valable jusqu’à la fin de ce jour local.' }) @IsOptional() @Matches(DATE_ONLY) validTo?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() attachmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class CreateDocumentDto extends DocumentFieldsDto {
  @ApiProperty() @IsUUID() documentTypeId!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() vehicleId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() driverId?: string;
}

export class RenewDocumentDto extends DocumentFieldsDto {}

/**
 * Correction d'une faute de saisie (D-209) : champ absent = valeur conservée ; null (ou texte vide) = valeur
 * effacée. La fin de validité ne peut être effacée que pour un type sans expiration ; attachmentId null
 * détache le justificatif (version « justificatif absent », fichier supprimé logiquement avec le motif).
 */
export class CorrectDocumentDto {
  @ApiPropertyOptional({ nullable: true, type: String, description: 'Texte vide ou null : numéro effacé.' }) @IsOptional() @IsString() @MaxLength(80) number?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String, description: 'Organisme émetteur ; texte vide ou null : effacé.' }) @IsOptional() @IsString() @MaxLength(160) issuer?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String, format: 'date', description: 'null : date d’émission effacée.' }) @IsOptional() @Matches(DATE_ONLY) issuedOn?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String, format: 'date', description: 'Début de validité (date civile) ; null : effacé.' }) @IsOptional() @Matches(DATE_ONLY) validFrom?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String, format: 'date', description: 'Fin de validité ; null accepté seulement pour un type sans expiration.' }) @IsOptional() @Matches(DATE_ONLY) validTo?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String, description: 'Nouveau justificatif téléversé ; null : justificatif détaché (« justificatif absent »).' }) @IsOptional() @IsUUID() attachmentId?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String, description: 'Texte vide ou null : notes effacées.' }) @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @ApiProperty({ description: 'Motif de la correction (faute de saisie), tracé dans l’audit.' }) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class ArchiveDocumentDto {
  @ApiProperty({ description: 'Motif (version erronée) ; aucune suppression physique.' }) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class DocumentsQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() vehicleId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() driverId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() documentTypeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['true', 'false']) includeArchived?: 'true' | 'false';
}

export class ComplianceQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
  @ApiPropertyOptional({ enum: OWNER_TYPES }) @IsOptional() @IsIn(OWNER_TYPES) ownerType?: (typeof OWNER_TYPES)[number];
  @ApiPropertyOptional({ enum: DOC_STATUSES }) @IsOptional() @IsIn(DOC_STATUSES) status?: (typeof DOC_STATUSES)[number];
  @ApiPropertyOptional({ description: 'Uniquement les documents bloquants non conformes.' }) @IsOptional() @IsIn(['true', 'false']) blocking?: 'true' | 'false';
  @ApiPropertyOptional() @IsOptional() @IsUUID() vehicleId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() driverId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() documentTypeId?: string;
}

export class DocumentTypeViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: OWNER_TYPES }) ownerType!: string;
  @ApiProperty() hasExpiry!: boolean;
  @ApiProperty() required!: boolean;
  @ApiProperty() blocksCheckout!: boolean;
  @ApiProperty({ type: [Number] }) noticeDays!: number[];
  @ApiProperty() visibleToDriver!: boolean;
  @ApiProperty({ type: [String] }) vehicleCategoryIds!: string[];
  @ApiProperty({ type: [String] }) companyIds!: string[];
  @ApiProperty({ enum: ['ACTIF', 'ARCHIVE'] }) status!: string;
  @ApiProperty() version!: number;
}

export class DocumentTypeSkippedDto {
  @ApiProperty() code!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: OWNER_TYPES }) ownerType!: string;
  @ApiProperty({ enum: ['CODE_EXISTANT', 'LIBELLE_EXISTANT'], description: 'Type existant (actif ou archivé) de même code, ou de même libellé pour le même objet : non modifié.' }) reason!: string;
}

export class InstallDocumentCatalogResultDto {
  @ApiProperty({ type: [DocumentTypeViewDto], description: 'Types ajoutés (facultatifs et non bloquants : exigence et blocage restent à paramétrer).' }) created!: DocumentTypeViewDto[];
  @ApiProperty({ type: [DocumentTypeSkippedDto], description: 'Types du catalogue initial déjà présents : ignorés, jamais modifiés.' }) skipped!: DocumentTypeSkippedDto[];
}

export class DocumentViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() documentTypeId!: string;
  @ApiProperty() documentTypeLabel!: string;
  @ApiProperty({ enum: OWNER_TYPES }) ownerType!: string;
  @ApiProperty({ nullable: true, type: String }) vehicleId!: string | null;
  @ApiProperty({ nullable: true, type: String }) driverId!: string | null;
  @ApiProperty() ownerLabel!: string;
  @ApiProperty({ nullable: true, type: String }) number!: string | null;
  @ApiProperty({ nullable: true, type: String }) issuer!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date' }) issuedOn!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date' }) validFrom!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date' }) validTo!: string | null;
  @ApiProperty({ nullable: true, type: String }) attachmentId!: string | null;
  @ApiProperty({ description: 'Justificatif absent (version sans fichier).' }) missingFile!: boolean;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty({ nullable: true, type: String }) previousVersionId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) archivedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() version!: number;
}

export class ComplianceRowDto {
  @ApiProperty({ enum: OWNER_TYPES }) ownerType!: string;
  @ApiProperty() objectId!: string;
  @ApiProperty() objectLabel!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() documentTypeId!: string;
  @ApiProperty() documentTypeLabel!: string;
  @ApiProperty({ enum: DOC_STATUSES }) status!: string;
  @ApiProperty({ description: 'Détail rédigé en français, dates au format JJ/MM/AAAA (ex. « Expiré depuis le 20/09/2026. »).' }) detail!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date', description: 'Début de validité de la version retenue (en vigueur ou dernière expirée).' }) validFrom!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date', description: 'Fin de validité de la version retenue ; valable jusqu’à la fin de ce jour local.' }) validTo!: string | null;
  @ApiProperty({ nullable: true, type: Number }) daysRemaining!: number | null;
  @ApiProperty({ nullable: true, type: String }) currentVersionId!: string | null;
  @ApiProperty({ nullable: true, type: String }) upcomingVersionId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date', description: 'Début de validité de la version future (pas encore en vigueur).' }) nextValidFrom!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date', description: 'Fin de validité de la version future.' }) nextValidTo!: string | null;
  @ApiProperty() renewed!: boolean;
  @ApiProperty({ description: 'Le document bloque un nouveau départ en l’état.' }) blocksCheckout!: boolean;
}
