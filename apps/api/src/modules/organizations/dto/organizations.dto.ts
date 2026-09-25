import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination.js';

export class CreateCompanyDto {
  @ApiProperty({ example: 'SOC-A', description: 'Code unique dans l’organisation.' })
  @IsString()
  @Matches(/^[A-Z0-9][A-Z0-9_-]{0,19}$/, { message: 'Code : majuscules, chiffres, tirets (20 caractères max).' })
  code!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) legalName!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) taxIdentifier?: string;
}

export class UpdateCompanyDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(200) legalName?: string;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsString() @MaxLength(500) address?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsString() @MaxLength(50) phone?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsEmail() @MaxLength(254) email?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsString() @MaxLength(50) taxIdentifier?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Pièce jointe (logo) déjà téléversée.' }) @IsOptional() @IsUUID() logoAttachmentId?: string | null;
  @ApiPropertyOptional({ description: 'Module F11 activable par société (administrateur).' }) @IsOptional() @IsBoolean() telemetryEnabled?: boolean;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class CompanyViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() legalName!: string;
  @ApiProperty({ nullable: true, type: String }) address!: string | null;
  @ApiProperty({ nullable: true, type: String }) phone!: string | null;
  @ApiProperty({ nullable: true, type: String }) email!: string | null;
  @ApiProperty({ nullable: true, type: String }) taxIdentifier!: string | null;
  @ApiProperty({ nullable: true, type: String }) logoAttachmentId!: string | null;
  @ApiProperty({ enum: ['ACTIF', 'ARCHIVE'] }) status!: string;
  @ApiProperty() telemetryEnabled!: boolean;
  @ApiProperty({ nullable: true, type: String }) archivedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() version!: number;
}

export class CompaniesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['ACTIF', 'ARCHIVE'] }) @IsOptional() @IsIn(['ACTIF', 'ARCHIVE']) status?: 'ACTIF' | 'ARCHIVE';
}

export class CreateSiteDto {
  @ApiProperty() @IsUUID() companyId!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(150) name!: string;
  @ApiPropertyOptional({ description: 'Adresse libre ; jamais une position GPS.' }) @IsOptional() @IsString() @MaxLength(500) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(150) managerName?: string;
}

export class UpdateSiteDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(150) name?: string;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsString() @MaxLength(500) address?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsString() @MaxLength(150) managerName?: string | null;
  @ApiPropertyOptional({ enum: ['ACTIF', 'ARCHIVE'] }) @IsOptional() @IsIn(['ACTIF', 'ARCHIVE']) status?: 'ACTIF' | 'ARCHIVE';
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class SiteViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) address!: string | null;
  @ApiProperty({ nullable: true, type: String }) managerName!: string | null;
  @ApiProperty({ enum: ['ACTIF', 'ARCHIVE'] }) status!: string;
  @ApiProperty() version!: number;
}

export class SitesQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
  @ApiPropertyOptional({ enum: ['ACTIF', 'ARCHIVE'] }) @IsOptional() @IsIn(['ACTIF', 'ARCHIVE']) status?: 'ACTIF' | 'ARCHIVE';
}

export class CreateDepartmentDto {
  @ApiProperty() @IsUUID() companyId!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(150) name!: string;
}

export class UpdateDepartmentDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(150) name?: string;
  @ApiPropertyOptional({ enum: ['ACTIF', 'ARCHIVE'] }) @IsOptional() @IsIn(['ACTIF', 'ARCHIVE']) status?: 'ACTIF' | 'ARCHIVE';
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class DepartmentViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['ACTIF', 'ARCHIVE'] }) status!: string;
  @ApiProperty() version!: number;
}

export class CreateVehicleCategoryDto {
  @ApiProperty() @IsString() @Matches(/^[A-Z0-9][A-Z0-9_-]{0,19}$/) code!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) label!: string;
  @ApiPropertyOptional({ type: [String], description: 'Catégories de permis exigées (paramétrage client, aucune règle juridique inventée).' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(10, { each: true })
  requiredPermitCategories?: string[];
}

export class UpdateVehicleCategoryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(100) label?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(10, { each: true }) requiredPermitCategories?: string[];
  @ApiPropertyOptional({ enum: ['ACTIF', 'ARCHIVE'] }) @IsOptional() @IsIn(['ACTIF', 'ARCHIVE']) status?: 'ACTIF' | 'ARCHIVE';
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class VehicleCategoryViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ type: [String] }) requiredPermitCategories!: string[];
  @ApiProperty({ enum: ['ACTIF', 'ARCHIVE'] }) status!: string;
  @ApiProperty() version!: number;
}

export class OrganizationViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty() timezone!: string;
  @ApiProperty() currency!: string;
  @ApiProperty() currencyDecimals!: number;
  @ApiProperty() version!: number;
}

export class UpdateOrganizationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @ApiPropertyOptional({ example: 'Africa/Tunis' }) @IsOptional() @IsString() @MaxLength(64) timezone?: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}
