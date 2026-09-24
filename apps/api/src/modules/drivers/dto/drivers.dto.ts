import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDateString, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination.js';

export class CreateDriverDto {
  @ApiProperty() @IsUUID() companyId!: string;
  @ApiProperty({ example: 'COND-0012' }) @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,29}$/) code!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) firstName!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) lastName!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() siteId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class UpdateDriverDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(100) firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(100) lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) phone?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) email?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() siteId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class DeactivateDriverDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class ReactivateDriverDto {
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class UpsertPermitDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(50) number!: string;
  @ApiProperty({ type: [String], example: ['B'] }) @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(10, { each: true }) categories!: string[];
  @ApiPropertyOptional({ format: 'date' }) @IsOptional() @IsDateString() issuedOn?: string;
  @ApiPropertyOptional({ format: 'date' }) @IsOptional() @IsDateString() expiresOn?: string;
  @ApiPropertyOptional({ description: 'Justificatif téléversé (PDF/JPEG/PNG).' }) @IsOptional() @IsUUID() attachmentId?: string;
}

export class DriversQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
  @ApiPropertyOptional({ enum: ['ACTIF', 'INACTIF'] }) @IsOptional() @IsIn(['ACTIF', 'INACTIF']) status?: 'ACTIF' | 'INACTIF';
}

export class PermitViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() number!: string;
  @ApiProperty({ type: [String] }) categories!: string[];
  @ApiProperty({ nullable: true, type: String }) issuedOn!: string | null;
  @ApiProperty({ nullable: true, type: String }) expiresOn!: string | null;
  @ApiProperty({ nullable: true, type: String }) attachmentId!: string | null;
}

export class DriverViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() code!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty({ nullable: true, type: String }) phone!: string | null;
  @ApiProperty({ nullable: true, type: String }) email!: string | null;
  @ApiProperty({ enum: ['ACTIF', 'INACTIF'] }) status!: string;
  @ApiProperty({ nullable: true, type: String }) siteId!: string | null;
  @ApiProperty({ nullable: true, type: String }) departmentId!: string | null;
  @ApiProperty({ nullable: true, type: String }) userId!: string | null;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty({ type: [PermitViewDto] }) permits!: PermitViewDto[];
  @ApiProperty({ description: 'Utilisation EN_COURS du conducteur, si elle existe.', nullable: true, type: String }) currentUsageId!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() version!: number;
}

/** Vue réduite d'un conducteur pour les listes déroulantes et le périmètre conducteur. */
export class DriverSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() code!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty() status!: string;
}
