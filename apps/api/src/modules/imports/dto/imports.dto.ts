import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination.js';

export const IMPORT_KINDS = ['VEHICULES', 'CONDUCTEURS', 'RELEVES', 'BASES_ENTRETIEN'] as const;
export type ImportKindValue = (typeof IMPORT_KINDS)[number];
const STATUSES = ['TELEVERSE', 'CONTROLE', 'CONFIRME', 'ABANDONNE'] as const;
const ROW_STATUSES = ['VALIDE', 'ERREUR', 'IMPORTEE', 'IGNOREE'] as const;

export class UploadImportDto {
  @ApiProperty({ enum: IMPORT_KINDS }) @IsIn(IMPORT_KINDS) kind!: ImportKindValue;
}

export class ValidateImportDto {
  @ApiProperty({ description: 'Association colonne du modèle → en-tête du fichier.', type: 'object', additionalProperties: { type: 'string' }, example: { company_code: 'Société', vehicle_code: 'Code' } })
  @IsObject()
  mapping!: Record<string, string>;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class AbandonImportDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(3) @MaxLength(500) reason?: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class ImportsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: IMPORT_KINDS }) @IsOptional() @IsIn(IMPORT_KINDS) kind?: ImportKindValue;
  @ApiPropertyOptional({ enum: STATUSES }) @IsOptional() @IsIn(STATUSES) status?: (typeof STATUSES)[number];
}

export class ImportRowsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ROW_STATUSES }) @IsOptional() @IsIn(ROW_STATUSES) status?: (typeof ROW_STATUSES)[number];
}

export class TemplateQueryDto {
  @ApiPropertyOptional({ enum: ['csv', 'xlsx'], default: 'xlsx' }) @IsOptional() @IsIn(['csv', 'xlsx']) format?: 'csv' | 'xlsx';
}

export class ImportColumnDto {
  @ApiProperty() name!: string;
  @ApiProperty() required!: boolean;
  @ApiProperty() description!: string;
  @ApiProperty() example!: string;
}

export class ImportModelDto {
  @ApiProperty({ enum: IMPORT_KINDS }) kind!: ImportKindValue;
  @ApiProperty() label!: string;
  @ApiProperty({ type: [ImportColumnDto] }) columns!: ImportColumnDto[];
}

export class ImportCountsDto {
  @ApiProperty() total!: number;
  @ApiProperty({ description: 'Lignes valides (contrôle) ou importées (après confirmation).' }) valid!: number;
  @ApiProperty() errors!: number;
  @ApiProperty({ description: 'Relevés identiques déjà présents, ignorés (D-280).' }) ignored!: number;
  @ApiProperty({ description: 'Lignes valides assorties d’un avertissement (relevé en attente, heure non fournie…).' }) withNotes!: number;
}

export class ImportBatchViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: IMPORT_KINDS }) kind!: ImportKindValue;
  @ApiProperty({ enum: STATUSES }) status!: (typeof STATUSES)[number];
  @ApiProperty() fileName!: string;
  @ApiProperty() rowCount!: number;
  @ApiProperty() errorCount!: number;
  @ApiProperty({ type: [String] }) headers!: string[];
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' }, nullable: true, description: 'Association retenue (ou proposée avant le contrôle).' }) columnMapping!: Record<string, string> | null;
  @ApiProperty({ type: [String], description: 'Avertissements du lot (fichier déjà importé…).' }) warnings!: string[];
  @ApiProperty({ type: ImportCountsDto, nullable: true }) counts!: ImportCountsDto | null;
  @ApiProperty({ nullable: true, type: String }) createdByName!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) validatedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) committedAt!: string | null;
  @ApiProperty() version!: number;
}

export class ImportRowMessageDto {
  @ApiProperty({ nullable: true, type: String }) column!: string | null;
  @ApiProperty() message!: string;
}

export class ImportRowViewDto {
  @ApiProperty({ description: 'Numéro de ligne dans le fichier (en-tête = 1).' }) rowNumber!: number;
  @ApiProperty({ enum: ROW_STATUSES }) status!: (typeof ROW_STATUSES)[number];
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } }) values!: Record<string, string>;
  @ApiProperty({ type: [ImportRowMessageDto] }) errors!: ImportRowMessageDto[];
  @ApiProperty({ type: [String] }) notes!: string[];
  @ApiProperty({ nullable: true, type: String }) createdObjectId!: string | null;
}
