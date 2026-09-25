import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination.js';
import { BACKFILL_DAYS_MAX, CREDENTIAL_KINDS, PROVIDER_KINDS, SYNC_INTERVAL_MAX, SYNC_INTERVAL_MIN } from '../telemetry-settings.js';

const PROVIDER_STATUSES = ['BROUILLON', 'ACTIF', 'SUSPENDU', 'DESACTIVE'] as const;
const CHANNELS = ['API', 'RAPPORT', 'RPA', 'WEBHOOK'] as const;
const MAPPING_STATUSES = ['PROPOSE', 'CONFIRME', 'REJETE', 'CLOTURE'] as const;
export const MAPPING_ODOMETER_KINDS = ['COMPTEUR_CAN', 'DISTANCE_GPS', 'AUCUN'] as const;
export const MAPPING_FUEL_KINDS = ['NIVEAU_CAN', 'NIVEAU_SONDE', 'CONSOMMATION_CAN'] as const;
const SYNC_STATUSES = ['EN_COURS', 'SUCCES', 'PARTIEL', 'ECHEC', 'IGNORE'] as const;
export const UNIT_CATEGORIES = ['NON_ASSOCIEES', 'PROPOSEES', 'ASSOCIEES', 'VEHICULES_SANS_UNITE', 'IGNOREES'] as const;
export type UnitCategory = (typeof UNIT_CATEGORIES)[number];
export const UNMAPPED_REASONS = ['INCONNUE', 'IMMATRICULATION_ABSENTE', 'AMBIGUE', 'VEHICULE_DEJA_EQUIPE', 'PROPOSITION_REJETEE', 'VEHICULE_NON_ELIGIBLE', 'A_REEXAMINER', 'IGNOREE'] as const;
export type UnmappedReason = (typeof UNMAPPED_REASONS)[number];

// ---------------------------------------------------------------------------------------------
// Fournisseurs (administrateur, D-112, D-304)
// ---------------------------------------------------------------------------------------------

export class CreateProviderDto {
  @ApiProperty({ description: 'Nom unique dans l’organisation.' }) @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @ApiProperty({ enum: PROVIDER_KINDS, description: 'Type ; le canal (API, RAPPORT) en est déduit. RPA refusé en V1 (D-292) ; SIMULATEUR refusé en production (D-303).' })
  @IsIn(PROVIDER_KINDS)
  kind!: (typeof PROVIDER_KINDS)[number];
  @ApiPropertyOptional({ type: String, nullable: true, description: 'URL de base de l’API (http/https, sans identifiant ni paramètre).' }) @IsOptional() @IsString() @MaxLength(500) baseUrl?: string | null;
  @ApiPropertyOptional({ type: Object, description: 'Paramètres non secrets propres au type (jamais de jeton ni de mot de passe).' }) @IsOptional() @IsObject() settings?: Record<string, unknown>;
  @ApiPropertyOptional({ minimum: SYNC_INTERVAL_MIN, maximum: SYNC_INTERVAL_MAX, description: 'Intervalle de synchronisation (défaut : paramètre telemetry.syncIntervalMinutes).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(SYNC_INTERVAL_MIN)
  @Max(SYNC_INTERVAL_MAX)
  syncIntervalMinutes?: number;
  @ApiPropertyOptional({ minimum: 0, maximum: BACKFILL_DAYS_MAX, description: 'Profondeur de la reprise initiale en jours (défaut 7).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(BACKFILL_DAYS_MAX)
  backfillDays?: number;
  @ApiProperty({ type: [String], description: 'Sociétés couvertes par le fournisseur.' }) @IsArray() @ArrayMaxSize(200) @ArrayUnique() @IsUUID('all', { each: true }) companyIds!: string[];
}

export class UpdateProviderDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsString() @MaxLength(500) baseUrl?: string | null;
  @ApiPropertyOptional({ type: Object }) @IsOptional() @IsObject() settings?: Record<string, unknown>;
  @ApiPropertyOptional({ minimum: SYNC_INTERVAL_MIN, maximum: SYNC_INTERVAL_MAX }) @IsOptional() @Type(() => Number) @IsInt() @Min(SYNC_INTERVAL_MIN) @Max(SYNC_INTERVAL_MAX) syncIntervalMinutes?: number;
  @ApiPropertyOptional({ minimum: 0, maximum: BACKFILL_DAYS_MAX }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(BACKFILL_DAYS_MAX) backfillDays?: number;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(200) @ArrayUnique() @IsUUID('all', { each: true }) companyIds?: string[];
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class ProviderTransitionDto {
  @ApiPropertyOptional({ description: 'Motif (obligatoire pour suspendre ou désactiver).' }) @IsOptional() @IsString() @MinLength(3) @MaxLength(500) reason?: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class ExpectedVersionQueryDto {
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class ProvidersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: PROVIDER_STATUSES }) @IsOptional() @IsIn(PROVIDER_STATUSES) status?: (typeof PROVIDER_STATUSES)[number];
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
}

export class PutCredentialDto {
  @ApiProperty({ description: 'Secret en écriture seule (jeton, identifiants, accès IMAP/SFTP) ; jamais renvoyé ni journalisé.', writeOnly: true })
  @IsString()
  @MinLength(4)
  @MaxLength(8192)
  secret!: string;
}

export class CredentialStatusDto {
  @ApiProperty({ enum: CREDENTIAL_KINDS }) kind!: string;
  @ApiProperty() configured!: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'date-time', description: 'Date du dernier dépôt du secret.' }) rotatedAt!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'SIGNATURE_WEBHOOK uniquement : l’ancien secret, remplacé à la dernière rotation, reste accepté jusqu’à cette date.',
  })
  previousValidUntil?: string | null;
}

export class ProviderViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: PROVIDER_KINDS }) kind!: string;
  @ApiProperty({ description: 'Libellé du type ; « SIMULATEUR — données fictives » pour le simulateur.' }) kindLabel!: string;
  @ApiProperty({ enum: CHANNELS }) channel!: string;
  @ApiProperty({ enum: PROVIDER_STATUSES }) status!: string;
  @ApiProperty() isSimulator!: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'Avertissement affiché pour un simulateur.' }) notice!: string | null;
  @ApiProperty() syncIntervalMinutes!: number;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) lastSyncAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) lastSuccessAt!: string | null;
  @ApiProperty() consecutiveFailures!: number;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) circuitOpenUntil!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Dernière erreur, expurgée.' }) lastErrorSummary!: string | null;
  @ApiProperty({ type: [String], description: 'Sociétés couvertes (limitées au périmètre du lecteur).' }) companyIds!: string[];
  @ApiProperty() version!: number;
  @ApiProperty({ description: 'Vrai si la vue contient la configuration (administrateur).' }) configurationVisible!: boolean;
  @ApiPropertyOptional({ nullable: true, type: String, description: 'Administrateur uniquement.' }) baseUrl?: string | null;
  @ApiPropertyOptional({ type: Object, description: 'Paramètres non secrets ; administrateur uniquement.' }) settings?: Record<string, unknown>;
  @ApiPropertyOptional({ description: 'Administrateur uniquement.' }) backfillDays?: number;
  @ApiPropertyOptional({ type: [CredentialStatusDto], description: 'État des secrets (jamais leur valeur) ; administrateur uniquement.' }) credentials?: CredentialStatusDto[];
  @ApiPropertyOptional({ type: String, format: 'date-time' }) createdAt?: string;
}

export class ProviderHealthDto {
  @ApiProperty() ok!: boolean;
  @ApiProperty({ description: 'Message expurgé.' }) message!: string;
  @ApiProperty({ nullable: true, type: Number }) latencyMs!: number | null;
  @ApiProperty({ format: 'date-time' }) checkedAt!: string;
}

export class ProviderKindDto {
  @ApiProperty({ enum: PROVIDER_KINDS }) kind!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: CHANNELS }) channel!: string;
  @ApiProperty() available!: boolean;
  @ApiProperty({ nullable: true, type: String }) reason!: string | null;
}

// ---------------------------------------------------------------------------------------------
// Activation par société (D-101, D-295)
// ---------------------------------------------------------------------------------------------

export class CompanyTelemetryDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiPropertyOptional({ description: 'Version attendue de la société (verrou optimiste).' }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) expectedVersion?: number;
}

export class CompanyProviderRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: PROVIDER_KINDS }) kind!: string;
  @ApiProperty() kindLabel!: string;
  @ApiProperty({ enum: PROVIDER_STATUSES }) status!: string;
}

export class CompanyTelemetryViewDto {
  @ApiProperty() companyId!: string;
  @ApiProperty() code!: string;
  @ApiProperty() legalName!: string;
  @ApiProperty() telemetryEnabled!: boolean;
  @ApiProperty({ type: [CompanyProviderRefDto] }) providers!: CompanyProviderRefDto[];
  @ApiProperty() version!: number;
  @ApiPropertyOptional({ description: 'Alertes F11 résolues par la désactivation.' }) resolvedAlerts?: number;
}

// ---------------------------------------------------------------------------------------------
// Unités et associations (14.5 ; D-175, D-186, D-300 à D-302)
// ---------------------------------------------------------------------------------------------

export class UnitViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() providerId!: string;
  @ApiProperty() providerName!: string;
  @ApiProperty({ enum: PROVIDER_KINDS }) providerKind!: string;
  @ApiProperty() isSimulator!: boolean;
  @ApiProperty() externalId!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ nullable: true, type: String }) declaredRegistration!: string | null;
  @ApiProperty({ nullable: true, type: String }) registrationNormalized!: string | null;
  @ApiProperty() presentAtProvider!: boolean;
  @ApiProperty({ format: 'date-time' }) firstSeenAt!: string;
  @ApiProperty({ format: 'date-time' }) lastSeenAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time', description: 'Unité ignorée (D-249) : ni proposition ni alerte « unité non associée ».' }) ignoredAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) ignoredById!: string | null;
  @ApiProperty({ nullable: true, type: String }) ignoredReason!: string | null;
}

export class VehicleRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() registration!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() lifecycleStatus!: string;
}

export class MappingViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() providerId!: string;
  @ApiProperty() providerName!: string;
  @ApiProperty() isSimulator!: boolean;
  @ApiProperty() unitId!: string;
  @ApiProperty() unitExternalId!: string;
  @ApiProperty() unitLabel!: string;
  @ApiProperty({ nullable: true, type: String }) unitDeclaredRegistration!: string | null;
  @ApiProperty({ type: VehicleRefDto }) vehicle!: VehicleRefDto;
  @ApiProperty({ description: 'Société gestionnaire courante du véhicule.' }) companyId!: string;
  @ApiProperty({ enum: MAPPING_STATUSES }) status!: string;
  @ApiProperty({ enum: MAPPING_ODOMETER_KINDS }) odometerKind!: string;
  @ApiProperty({ enum: MAPPING_FUEL_KINDS, isArray: true }) fuelKinds!: string[];
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) validFrom!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) validTo!: string | null;
  @ApiProperty({ format: 'date-time' }) proposedAt!: string;
  @ApiProperty({ nullable: true, type: String }) proposalReason!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) decidedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) decidedById!: string | null;
  @ApiProperty({ nullable: true, type: String }) closedReason!: string | null;
  @ApiProperty() version!: number;
}

export class UnitRowDto {
  @ApiProperty({ enum: UNIT_CATEGORIES }) category!: string;
  @ApiProperty({ type: UnitViewDto, nullable: true }) unit!: UnitViewDto | null;
  @ApiProperty({ type: MappingViewDto, nullable: true }) mapping!: MappingViewDto | null;
  @ApiProperty({ type: VehicleRefDto, nullable: true }) vehicle!: VehicleRefDto | null;
  @ApiProperty({ enum: UNMAPPED_REASONS, nullable: true, type: String }) unmappedReason!: UnmappedReason | null;
}

export class UnitCountsDto {
  @ApiProperty() nonAssociees!: number;
  @ApiProperty() proposees!: number;
  @ApiProperty() associees!: number;
  @ApiProperty() vehiculesSansUnite!: number;
  @ApiProperty({ description: 'Unités ignorées (D-249).' }) ignorees!: number;
}

export class UnitsPageDto {
  @ApiProperty({ type: [UnitRowDto] }) items!: UnitRowDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty({ type: UnitCountsDto }) counts!: UnitCountsDto;
}

export class UnitsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: UNIT_CATEGORIES, default: 'NON_ASSOCIEES' }) @IsOptional() @IsIn(UNIT_CATEGORIES) category: UnitCategory = 'NON_ASSOCIEES';
  @ApiPropertyOptional() @IsOptional() @IsUUID() providerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
}

export class DiscoveredUnitDto {
  @ApiProperty() unitId!: string;
  @ApiProperty() externalId!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ nullable: true, type: String }) declaredRegistration!: string | null;
  @ApiProperty({ enum: ['COMPTEUR_CAN', 'DISTANCE_GPS'], isArray: true, description: 'Natures remontées déclarées par le fournisseur lors de cette découverte.' }) odometerKinds!: string[];
  @ApiProperty({ enum: MAPPING_FUEL_KINDS, isArray: true }) fuelKinds!: string[];
  @ApiProperty({ enum: ['PROPOSEE', 'ASSOCIEE', 'NON_ASSOCIEE'] }) outcome!: 'PROPOSEE' | 'ASSOCIEE' | 'NON_ASSOCIEE';
  @ApiProperty({ nullable: true, type: String }) mappingId!: string | null;
  @ApiProperty({ nullable: true, type: String }) vehicleId!: string | null;
  @ApiProperty({ enum: UNMAPPED_REASONS, nullable: true, type: String }) unmappedReason!: UnmappedReason | null;
}

export class DiscoveryResultDto {
  @ApiProperty() syncRunId!: string;
  @ApiProperty() unitsSeen!: number;
  @ApiProperty() unitsCreated!: number;
  @ApiProperty() unitsUpdated!: number;
  @ApiProperty({ description: 'Unités précédemment connues absentes de la liste du fournisseur.' }) unitsMissing!: number;
  @ApiProperty() proposalsCreated!: number;
  @ApiProperty() proposalsPending!: number;
  @ApiProperty({ description: 'Unités non associées, hors unités ignorées.' }) unmapped!: number;
  @ApiProperty({ description: 'Unités ignorées (D-249) : aucune proposition.' }) ignored!: number;
  @ApiProperty() rejectedUnits!: number;
  @ApiProperty({ type: [DiscoveredUnitDto] }) units!: DiscoveredUnitDto[];
}

export class CreateMappingDto {
  @ApiProperty() @IsUUID() unitId!: string;
  @ApiProperty() @IsUUID() vehicleId!: string;
  @ApiProperty({ enum: MAPPING_ODOMETER_KINDS, description: 'Nature du kilométrage selon l’annexe A (COMPTEUR_CAN, DISTANCE_GPS ou AUCUN).' }) @IsIn(MAPPING_ODOMETER_KINDS) odometerKind!: (typeof MAPPING_ODOMETER_KINDS)[number];
  @ApiProperty({ enum: MAPPING_FUEL_KINDS, isArray: true }) @IsArray() @ArrayUnique() @ArrayMaxSize(3) @IsIn(MAPPING_FUEL_KINDS, { each: true }) fuelKinds!: Array<(typeof MAPPING_FUEL_KINDS)[number]>;
  @ApiPropertyOptional({ format: 'date-time', description: 'Date d’effet (D-301) ; défaut : la plus tardive de maintenant − reprise, début du compteur ouvert, entrée dans la société.' }) @IsOptional() @IsDateString() validFrom?: string;
}

export class ConfirmMappingDto {
  @ApiPropertyOptional({ format: 'date-time', description: 'Date d’effet (D-301).' }) @IsOptional() @IsDateString() validFrom?: string;
  @ApiProperty({ enum: MAPPING_ODOMETER_KINDS }) @IsIn(MAPPING_ODOMETER_KINDS) odometerKind!: (typeof MAPPING_ODOMETER_KINDS)[number];
  @ApiProperty({ enum: MAPPING_FUEL_KINDS, isArray: true }) @IsArray() @ArrayUnique() @ArrayMaxSize(3) @IsIn(MAPPING_FUEL_KINDS, { each: true }) fuelKinds!: Array<(typeof MAPPING_FUEL_KINDS)[number]>;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class RejectMappingDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

/** Ignorer une unité volontairement sans véhicule (remorque, boîtier de rechange ; D-249). */
export class IgnoreUnitDto {
  @ApiProperty({ description: 'Motif (remorque, boîtier de rechange...).' }) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class UnignoreUnitDto {
  @ApiPropertyOptional({ description: 'Motif de la reprise (facultatif).' }) @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class ReplacementUnitDto {
  @ApiProperty({ description: 'Nouvelle unité (boîtier) du véhicule.' }) @IsUUID() unitId!: string;
  @ApiProperty({ enum: MAPPING_ODOMETER_KINDS }) @IsIn(MAPPING_ODOMETER_KINDS) odometerKind!: (typeof MAPPING_ODOMETER_KINDS)[number];
  @ApiProperty({ enum: MAPPING_FUEL_KINDS, isArray: true }) @IsArray() @ArrayUnique() @ArrayMaxSize(3) @IsIn(MAPPING_FUEL_KINDS, { each: true }) fuelKinds!: Array<(typeof MAPPING_FUEL_KINDS)[number]>;
}

export class CloseMappingDto {
  @ApiProperty({ description: 'Motif (changement de boîtier, retrait...).' }) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiPropertyOptional({ format: 'date-time', description: 'Instant du changement (défaut : maintenant).' }) @IsOptional() @IsDateString() closedAt?: string;
  @ApiPropertyOptional({ type: ReplacementUnitDto, description: 'Changement de boîtier (D-300) : nouvelle association confirmée à la même date, sans modifier le kilométrage cumulé.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReplacementUnitDto)
  replacement?: ReplacementUnitDto;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class CloseMappingResultDto {
  @ApiProperty({ type: MappingViewDto }) closed!: MappingViewDto;
  @ApiProperty({ type: MappingViewDto, nullable: true }) replacement!: MappingViewDto | null;
}

export class MappingsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: MAPPING_STATUSES }) @IsOptional() @IsIn(MAPPING_STATUSES) status?: (typeof MAPPING_STATUSES)[number];
  @ApiPropertyOptional() @IsOptional() @IsUUID() providerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() vehicleId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() unitId?: string;
}

// ---------------------------------------------------------------------------------------------
// Exécutions de synchronisation (14.4)
// ---------------------------------------------------------------------------------------------

export class SyncRunsQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() providerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
  @ApiPropertyOptional({ enum: SYNC_STATUSES }) @IsOptional() @IsIn(SYNC_STATUSES) status?: (typeof SYNC_STATUSES)[number];
}

export class SyncRunViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() providerId!: string;
  @ApiProperty() providerName!: string;
  @ApiProperty({ nullable: true, type: String }) companyId!: string | null;
  @ApiProperty() trigger!: string;
  @ApiProperty({ enum: SYNC_STATUSES }) status!: string;
  @ApiProperty({ format: 'date-time' }) startedAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) finishedAt!: string | null;
  @ApiProperty({ nullable: true, type: Number }) durationMs!: number | null;
  @ApiProperty() unitsSeen!: number;
  @ApiProperty() odometerSamples!: number;
  @ApiProperty() readingsCreated!: number;
  @ApiProperty() readingsPending!: number;
  @ApiProperty() duplicatesIgnored!: number;
  @ApiProperty() fuelSamples!: number;
  @ApiProperty() fuelEventsCreated!: number;
  @ApiProperty() errorCount!: number;
  @ApiProperty({ nullable: true, type: String, description: 'Résumé expurgé.' }) errorSummary!: string | null;
  @ApiProperty({ nullable: true, type: String }) requestedById!: string | null;
}
