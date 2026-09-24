import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination.js';

const LIFECYCLES = ['ACTIF', 'HORS_SERVICE', 'CEDE', 'ARCHIVE'] as const;
const ENERGIES = ['DIESEL', 'ESSENCE', 'GPL', 'HYBRIDE', 'ELECTRIQUE', 'AUTRE'] as const;
const OWNERSHIP = ['ACHAT', 'LOCATION', 'LEASING', 'AUTRE'] as const;

export class CreateVehicleDto {
  @ApiProperty() @IsUUID() companyId!: string;
  @ApiProperty({ example: 'VH-0001', description: 'Code interne unique dans l’organisation.' }) @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,29}$/) code!: string;
  @ApiProperty({ example: '123 TU 4567', description: 'Immatriculation ou identifiant provisoire (valeur d’affichage conservée).' }) @IsString() @MinLength(1) @MaxLength(30) registration!: string;
  @ApiPropertyOptional({ description: 'Identifiant provisoire (véhicule non encore immatriculé).' }) @IsOptional() @IsBoolean() provisionalRegistration?: boolean;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(80) make!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(80) model!: string;
  @ApiProperty() @IsUUID() categoryId!: string;
  @ApiPropertyOptional({ enum: LIFECYCLES, default: 'ACTIF' }) @IsOptional() @IsIn(LIFECYCLES) lifecycleStatus?: (typeof LIFECYCLES)[number];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) vin?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1950) @Max(2100) year?: number;
  @ApiPropertyOptional({ format: 'date' }) @IsOptional() @IsDateString() commissioningDate?: string;
  @ApiPropertyOptional({ enum: ENERGIES }) @IsOptional() @IsIn(ENERGIES) energy?: (typeof ENERGIES)[number];
  @ApiPropertyOptional({ description: 'Capacité du réservoir en litres (décimal en chaîne).' }) @IsOptional() @IsNumberString() tankCapacityLiters?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() siteId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional({ enum: OWNERSHIP }) @IsOptional() @IsIn(OWNERSHIP) ownershipMode?: (typeof OWNERSHIP)[number];
  @ApiPropertyOptional() @IsOptional() @IsUUID() contractSupplierId?: string;
  @ApiPropertyOptional({ format: 'date' }) @IsOptional() @IsDateString() contractEndDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

export class UpdateVehicleDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(30) registration?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() provisionalRegistration?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(80) make?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(80) model?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) vin?: string | null;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1950) @Max(2100) year?: number | null;
  @ApiPropertyOptional({ format: 'date' }) @IsOptional() @IsDateString() commissioningDate?: string | null;
  @ApiPropertyOptional({ enum: ENERGIES }) @IsOptional() @IsIn(ENERGIES) energy?: (typeof ENERGIES)[number] | null;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() tankCapacityLiters?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() siteId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string | null;
  @ApiPropertyOptional({ enum: OWNERSHIP }) @IsOptional() @IsIn(OWNERSHIP) ownershipMode?: (typeof OWNERSHIP)[number] | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() contractSupplierId?: string | null;
  @ApiPropertyOptional({ format: 'date' }) @IsOptional() @IsDateString() contractEndDate?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) notes?: string | null;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class ChangeLifecycleDto {
  @ApiProperty({ enum: LIFECYCLES }) @IsIn(LIFECYCLES) lifecycleStatus!: (typeof LIFECYCLES)[number];
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class CreateLocationReportDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() siteId?: string;
  @ApiPropertyOptional({ description: 'Lieu libre si aucun site.' }) @IsOptional() @IsString() @MaxLength(300) placeLabel?: string;
  @ApiProperty({ description: 'Date/heure d’observation (ISO 8601), non future.' }) @IsDateString() observedAt!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) comment?: string;
}

export class AttachPhotoDto {
  @ApiProperty() @IsUUID() attachmentId!: string;
}

export class VehiclesQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
  @ApiPropertyOptional({ enum: LIFECYCLES }) @IsOptional() @IsIn(LIFECYCLES) lifecycleStatus?: (typeof LIFECYCLES)[number];
  @ApiPropertyOptional({ enum: ['IMMOBILISE', 'EN_UTILISATION', 'DISPONIBLE'] }) @IsOptional() @IsIn(['IMMOBILISE', 'EN_UTILISATION', 'DISPONIBLE']) operationalStatus?: 'IMMOBILISE' | 'EN_UTILISATION' | 'DISPONIBLE';
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() siteId?: string;
  @ApiPropertyOptional({ description: 'Inclure les véhicules archivés et cédés.' }) @IsOptional() @IsIn(['true', 'false']) includeInactive?: 'true' | 'false';
}

export class LocationReportViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) siteId!: string | null;
  @ApiProperty({ nullable: true, type: String }) siteName!: string | null;
  @ApiProperty({ nullable: true, type: String }) placeLabel!: string | null;
  @ApiProperty() observedAt!: string;
  @ApiProperty({ nullable: true, type: String }) comment!: string | null;
  @ApiProperty() context!: string;
  @ApiProperty({ nullable: true, type: String }) createdById!: string | null;
  @ApiProperty({ nullable: true, type: String }) createdByName!: string | null;
  @ApiProperty() createdAt!: string;
}

export class VehicleViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() companyCode!: string;
  @ApiProperty() code!: string;
  @ApiProperty() registration!: string;
  @ApiProperty() provisionalRegistration!: boolean;
  @ApiProperty() make!: string;
  @ApiProperty() model!: string;
  @ApiProperty() categoryId!: string;
  @ApiProperty() categoryLabel!: string;
  @ApiProperty({ enum: LIFECYCLES }) lifecycleStatus!: string;
  @ApiProperty({ enum: ['IMMOBILISE', 'EN_UTILISATION', 'DISPONIBLE'], nullable: true, type: String }) operationalStatus!: string | null;
  @ApiProperty({ nullable: true, type: String }) vin!: string | null;
  @ApiProperty({ nullable: true, type: Number }) year!: number | null;
  @ApiProperty({ nullable: true, type: String }) commissioningDate!: string | null;
  @ApiProperty({ nullable: true, type: String }) energy!: string | null;
  @ApiProperty({ nullable: true, type: String }) tankCapacityLiters!: string | null;
  @ApiProperty({ nullable: true, type: String }) siteId!: string | null;
  @ApiProperty({ nullable: true, type: String }) departmentId!: string | null;
  @ApiProperty({ nullable: true, type: String }) ownershipMode!: string | null;
  @ApiProperty({ nullable: true, type: String }) contractSupplierId!: string | null;
  @ApiProperty({ nullable: true, type: String }) contractEndDate!: string | null;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty({ description: 'Utilisation EN_COURS, si elle existe.', nullable: true }) currentUsage!: { id: string; driverId: string; driverName: string; checkedOutAt: string; expectedReturnAt: string } | null;
  @ApiProperty({ nullable: true, type: String }) activeImmobilizationId!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() version!: number;
}

export class VehicleSynthesisDto extends VehicleViewDto {
  @ApiProperty({ nullable: true }) responsible!: { assignmentId: string; driverId: string; driverName: string; since: string } | null;
  @ApiProperty({ nullable: true }) lastLocation!: LocationReportViewDto | null;
  @ApiProperty({ nullable: true, description: 'Dernier relevé accepté (toutes sources) et fraîcheur.' }) odometer!: {
    readingId: string;
    physicalKm: string | null;
    cumulativeKm: string | null;
    cumulativeKnown: boolean;
    isEstimate: boolean;
    measurementKind: string;
    source: string;
    observedAt: string;
    freshness: string;
    ageDays: number | null;
  } | null;
  @ApiProperty({ enum: ['INCONNU', 'A_ACTUALISER', 'A_JOUR'] }) freshness!: string;
  @ApiProperty({ description: 'Prochaines échéances d’entretien (plans actifs, les plus urgentes d’abord).' }) upcomingMaintenance!: Array<{ planId: string; maintenanceTypeLabel: string; status: string; nextDueKm: string | null; nextDueDate: string | null }>;
  @ApiProperty() documentCompliance!: { blocking: number; missing: number; expired: number; expiringSoon: number };
  @ApiProperty() openIncidents!: number;
  @ApiProperty() pendingReadings!: number;
  @ApiProperty({ type: [String] }) photoAttachmentIds!: string[];
  @ApiProperty() qrToken!: string;
}

export class QrResolveDto {
  @ApiProperty() vehicleId!: string;
  @ApiProperty() code!: string;
  @ApiProperty() registration!: string;
}
