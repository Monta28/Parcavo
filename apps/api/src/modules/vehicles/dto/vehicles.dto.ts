import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { FRESHNESS_STATUS, type FreshnessStatus } from '@parc-auto/contracts';
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
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsString() @MaxLength(30) vin?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) @IsOptional() @Type(() => Number) @IsInt() @Min(1950) @Max(2100) year?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'date' }) @IsOptional() @IsDateString() commissioningDate?: string | null;
  @ApiPropertyOptional({ enum: ENERGIES }) @IsOptional() @IsIn(ENERGIES) energy?: (typeof ENERGIES)[number] | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsNumberString() tankCapacityLiters?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsUUID() siteId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsUUID() departmentId?: string | null;
  @ApiPropertyOptional({ enum: OWNERSHIP }) @IsOptional() @IsIn(OWNERSHIP) ownershipMode?: (typeof OWNERSHIP)[number] | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsUUID() contractSupplierId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'date' }) @IsOptional() @IsDateString() contractEndDate?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsString() @MaxLength(4000) notes?: string | null;
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
  @ApiPropertyOptional({ description: 'Restreint la liste à ce véhicule (liste justificative d’un tableau de bord filtré par véhicule, 11.1) ; hors périmètre : liste vide.' })
  @IsOptional()
  @IsUUID('all', { message: 'Identifiant de véhicule invalide.' })
  vehicleId?: string;
  @ApiPropertyOptional({ enum: LIFECYCLES }) @IsOptional() @IsIn(LIFECYCLES) lifecycleStatus?: (typeof LIFECYCLES)[number];
  @ApiPropertyOptional({ enum: ['IMMOBILISE', 'EN_UTILISATION', 'DISPONIBLE'] }) @IsOptional() @IsIn(['IMMOBILISE', 'EN_UTILISATION', 'DISPONIBLE']) operationalStatus?: 'IMMOBILISE' | 'EN_UTILISATION' | 'DISPONIBLE';
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() siteId?: string;
  @ApiPropertyOptional({ description: 'Inclure les véhicules archivés et cédés.' }) @IsOptional() @IsIn(['true', 'false']) includeInactive?: 'true' | 'false';
  @ApiPropertyOptional({ enum: FRESHNESS_STATUS, description: 'Fraîcheur du kilométrage (5.5) : INCONNU (aucun relevé accepté), A_ACTUALISER (dernière observation acceptée plus ancienne que le seuil de la société), A_JOUR.' })
  @IsOptional()
  @IsIn(FRESHNESS_STATUS, { message: 'Fraîcheur attendue : INCONNU, A_ACTUALISER ou A_JOUR.' })
  freshness?: FreshnessStatus;
  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'true : véhicules dont un document bloquant applicable est manquant ou expiré au jour local (7.2) ; false : les autres.' })
  @IsOptional()
  @IsIn(['true', 'false'], { message: 'Valeur attendue : true ou false.' })
  blockingDocuments?: 'true' | 'false';
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

/** Utilisation EN_COURS du véhicule. */
export class VehicleCurrentUsageDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) driverId!: string;
  @ApiProperty({ type: String }) driverName!: string;
  @ApiProperty({ type: String, format: 'date-time' }) checkedOutAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) expectedReturnAt!: string;
}

/** Responsable habituel en cours. */
export class VehicleResponsibleDto {
  @ApiProperty({ type: String }) assignmentId!: string;
  @ApiProperty({ type: String }) driverId!: string;
  @ApiProperty({ type: String }) driverName!: string;
  @ApiProperty({ type: String, format: 'date-time' }) since!: string;
}

/** Dernier relevé accepté (toutes sources) et fraîcheur calculée par l'API. */
export class VehicleOdometerSummaryDto {
  @ApiProperty({ type: String }) readingId!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Compteur affiché à 3 décimales (chaîne décimale).' }) physicalKm!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Kilométrage cumulé à 3 décimales (chaîne décimale).' }) cumulativeKm!: string | null;
  @ApiProperty({ type: Boolean }) cumulativeKnown!: boolean;
  @ApiProperty({ type: Boolean }) isEstimate!: boolean;
  @ApiProperty({ type: String }) measurementKind!: string;
  @ApiProperty({ type: String }) source!: string;
  @ApiProperty({ type: String, format: 'date-time' }) observedAt!: string;
  @ApiProperty({ type: String, enum: ['INCONNU', 'A_ACTUALISER', 'A_JOUR'] }) freshness!: string;
  @ApiProperty({ type: Number, nullable: true }) ageDays!: number | null;
}

/** Échéance d'entretien d'un plan actif. */
export class VehicleUpcomingMaintenanceDto {
  @ApiProperty({ type: String }) planId!: string;
  @ApiProperty({ type: String }) maintenanceTypeLabel!: string;
  @ApiProperty({ type: String }) status!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Kilométrage d’échéance à 3 décimales (chaîne décimale).' }) nextDueKm!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true, description: 'Date civile AAAA-MM-JJ.' }) nextDueDate!: string | null;
}

/** Compteurs de conformité documentaire du véhicule. */
export class VehicleDocumentComplianceDto {
  @ApiProperty({ type: Number, description: 'Documents manquants ou expirés bloquant la remise.' }) blocking!: number;
  @ApiProperty({ type: Number }) missing!: number;
  @ApiProperty({ type: Number }) expired!: number;
  @ApiProperty({ type: Number }) expiringSoon!: number;
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
  @ApiProperty({ type: VehicleCurrentUsageDto, description: 'Utilisation EN_COURS, si elle existe.', nullable: true }) currentUsage!: VehicleCurrentUsageDto | null;
  @ApiProperty({ nullable: true, type: String }) activeImmobilizationId!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() version!: number;
}

export class VehicleSynthesisDto extends VehicleViewDto {
  @ApiProperty({ type: VehicleResponsibleDto, nullable: true }) responsible!: VehicleResponsibleDto | null;
  @ApiProperty({ type: LocationReportViewDto, nullable: true }) lastLocation!: LocationReportViewDto | null;
  @ApiProperty({ type: VehicleOdometerSummaryDto, nullable: true, description: 'Dernier relevé accepté (toutes sources) et fraîcheur.' }) odometer!: VehicleOdometerSummaryDto | null;
  @ApiProperty({ enum: ['INCONNU', 'A_ACTUALISER', 'A_JOUR'] }) freshness!: string;
  @ApiProperty({ type: [VehicleUpcomingMaintenanceDto], description: 'Prochaines échéances d’entretien (plans actifs, les plus urgentes d’abord).' }) upcomingMaintenance!: VehicleUpcomingMaintenanceDto[];
  @ApiProperty({ type: VehicleDocumentComplianceDto, nullable: true, description: 'Absent (null) pour un compte conducteur (D-116).' }) documentCompliance!: VehicleDocumentComplianceDto | null;
  @ApiProperty({ nullable: true, type: Number, description: 'Absent (null) pour un compte conducteur.' }) openIncidents!: number | null;
  @ApiProperty({ nullable: true, type: Number, description: 'Absent (null) pour un compte conducteur.' }) pendingReadings!: number | null;
  @ApiProperty({ type: [String] }) photoAttachmentIds!: string[];
  @ApiProperty({ nullable: true, type: String, description: 'Absent (null) pour un compte conducteur.' }) qrToken!: string | null;
}

export class QrResolveDto {
  @ApiProperty() vehicleId!: string;
  @ApiProperty() code!: string;
  @ApiProperty() registration!: string;
}

export class VehiclePhotoResultDto {
  @ApiProperty({ type: String, format: 'uuid', description: 'Pièce jointe rattachée comme photo du véhicule.' }) attachmentId!: string;
}

export class QrTokenDto {
  @ApiProperty({ type: String, format: 'uuid', description: 'Nouveau jeton du QR code interne ; l’ancien n’est plus résolu.' }) qrToken!: string;
}
