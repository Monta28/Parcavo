import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination.js';

const CATEGORIES = ['GARAGE', 'STATION', 'ASSURANCE', 'LOUEUR', 'AUTRE'] as const;
type Category = (typeof CATEGORIES)[number];

export class CreateSupplierDto {
  @ApiProperty() @IsUUID() companyId!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(160) name!: string;
  @ApiProperty({ enum: CATEGORIES }) @IsIn(CATEGORIES) category!: Category;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) contactName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(200) email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class UpdateSupplierDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(160) name?: string;
  @ApiPropertyOptional({ enum: CATEGORIES }) @IsOptional() @IsIn(CATEGORIES) category?: Category;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsString() @MaxLength(160) contactName?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsString() @MaxLength(40) phone?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsEmail() @MaxLength(200) email?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsString() @MaxLength(500) address?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

/** « Copier vers une autre société » (D-221) : société de destination, différente de celle du fournisseur. */
export class CopySupplierDto {
  @ApiProperty({ description: 'Société de destination (chef de parc des deux sociétés ou administrateur).' }) @IsUUID() companyId!: string;
}

export class SupplierStatusDto {
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class SuppliersQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
  @ApiPropertyOptional({ enum: CATEGORIES }) @IsOptional() @IsIn(CATEGORIES) category?: Category;
  @ApiPropertyOptional({ enum: ['ACTIF', 'ARCHIVE'] }) @IsOptional() @IsIn(['ACTIF', 'ARCHIVE']) status?: 'ACTIF' | 'ARCHIVE';
}

export class SupplierViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: CATEGORIES }) category!: string;
  @ApiProperty({ nullable: true, type: String }) contactName!: string | null;
  @ApiProperty({ nullable: true, type: String }) phone!: string | null;
  @ApiProperty({ nullable: true, type: String }) email!: string | null;
  @ApiProperty({ nullable: true, type: String }) address!: string | null;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty({ enum: ['ACTIF', 'ARCHIVE'] }) status!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) archivedAt!: string | null;
  @ApiProperty() version!: number;
}
