import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { PageMetaDto, PageQueryDto } from '../../../common/pagination.js';

const BASE_MODES = ['DERNIERE_OPERATION', 'BASE_TECHNIQUE', 'ECHEANCE_INITIALE', 'AUCUNE'] as const;
const SOURCES = ['TOUTES', 'MANUEL_OU_CAN'] as const;
const STATUSES = ['INCOMPLET', 'A_JOUR', 'A_PREVOIR', 'A_FAIRE', 'EN_RETARD'] as const;
/**
 * Tris de la liste des plans (10.1) : urgence (rang EN_RETARD > A_FAIRE > A_PREVOIR > INCOMPLET > A_JOUR,
 * desc = le plus urgent d'abord), reste km, reste jours, échéance (date puis km), véhicule, opération.
 */
export const PLAN_SORTS = ['urgence', 'resteKm', 'resteJours', 'echeance', 'vehicule', 'operation'] as const;
export type PlanSort = (typeof PLAN_SORTS)[number];

export class CreateMaintenanceTypeDto {
  @ApiProperty({ example: 'VIDANGE' }) @IsString() @Matches(/^[A-Z0-9][A-Z0-9_-]{0,29}$/) code!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) label!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) description?: string;
}

export class UpdateMaintenanceTypeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) label?: string;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsString() @MaxLength(1000) description?: string | null;
  @ApiPropertyOptional({ enum: ['ACTIF', 'ARCHIVE'] }) @IsOptional() @IsIn(['ACTIF', 'ARCHIVE']) status?: 'ACTIF' | 'ARCHIVE';
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class IntervalsDto {
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Intervalle en km (consigne retenue par le client).' }) @IsOptional() @IsNumberString() intervalKm?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Intervalle en mois calendaires.' }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(240) intervalMonths?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Intervalle en jours (alternative aux mois).' }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3650) intervalDays?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Préavis en km (défaut paramétré : 500).' }) @IsOptional() @IsNumberString() noticeKm?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Préavis en jours (défaut paramétré : 30).' }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) noticeDays?: number | null;
}

export class TemplateItemDto extends IntervalsDto {
  @ApiProperty() @IsUUID() maintenanceTypeId!: string;
}

export class CreateTemplateDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @ApiProperty({ type: [TemplateItemDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => TemplateItemDto) items!: TemplateItemDto[];
}

export class PlanBaseDto {
  @ApiProperty({ enum: BASE_MODES, description: 'Dernière opération connue, base technique validée, échéance initiale, ou aucune (plan INCOMPLET).' }) @IsIn(BASE_MODES) baseMode!: (typeof BASE_MODES)[number];
  @ApiPropertyOptional({ description: 'Kilomètres cumulés de la base.' }) @IsOptional() @IsNumberString() baseKm?: string;
  @ApiPropertyOptional({ format: 'date' }) @IsOptional() @IsDateString() baseDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() nextDueKm?: string;
  @ApiPropertyOptional({ format: 'date' }) @IsOptional() @IsDateString() nextDueDate?: string;
}

export class UpdateTemplateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsString() @MaxLength(1000) description?: string | null;
  @ApiPropertyOptional({ enum: ['ACTIF', 'ARCHIVE'] }) @IsOptional() @IsIn(['ACTIF', 'ARCHIVE']) status?: 'ACTIF' | 'ARCHIVE';
  @ApiPropertyOptional({ type: [TemplateItemDto], description: 'Remplace les lignes du modèle ; les plans déjà copiés ne changent pas (copie instantanée).' })
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => TemplateItemDto) items?: TemplateItemDto[];
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

const ON_EXISTING = ['IGNORER', 'METTRE_A_JOUR'] as const;

export class ApplyTemplateVehicleChoiceDto {
  @ApiProperty({ description: 'Véhicule de la sélection concerné par ce choix.' }) @IsUUID() vehicleId!: string;
  @ApiProperty({ enum: ON_EXISTING, description: 'Choix pour ce véhicule, prioritaire sur le choix global.' }) @IsIn(ON_EXISTING) onExisting!: (typeof ON_EXISTING)[number];
}

/** Plan existant présenté par la prévisualisation, à la version alors lue (verrou optimiste, 17.1). */
export class ExpectedPlanVersionDto {
  @ApiProperty({ description: 'Plan existant que la prévisualisation annonçait mis à jour.' }) @IsUUID() planId!: string;
  @ApiProperty({ description: 'Version du plan lue par la prévisualisation (planVersion).' }) @Type(() => Number) @IsInt() @Min(1) version!: number;
}

export class ApplyTemplateDto {
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('all', { each: true }) vehicleIds!: string[];
  @ApiPropertyOptional({ enum: ON_EXISTING, default: 'IGNORER', description: 'Choix par défaut quand un plan actif du même type existe : l’ignorer, ou mettre à jour intervalles et préavis en gardant sa base (D-198).' })
  @IsOptional() @IsIn(ON_EXISTING) onExisting?: (typeof ON_EXISTING)[number];
  @ApiPropertyOptional({ type: [ApplyTemplateVehicleChoiceDto], description: 'Choix par véhicule (D-198), prioritaire sur onExisting ; un véhicule au plus une fois.' })
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => ApplyTemplateVehicleChoiceDto) perVehicle?: ApplyTemplateVehicleChoiceDto[];
  @ApiPropertyOptional({ enum: SOURCES }) @IsOptional() @IsIn(SOURCES) acceptedSources?: (typeof SOURCES)[number];
  @ApiPropertyOptional({ description: 'true : calcule et renvoie l’impact (plans créés ou mis à jour, échéances et statuts avant/après) sans rien enregistrer (17.1).' })
  @IsOptional() @IsBoolean() preview?: boolean;
  @ApiPropertyOptional({
    type: [ExpectedPlanVersionDto],
    description:
      'Confirmation d’une prévisualisation (17.1) : plans existants annoncés « mis à jour » avec leur version (impacts MISE_A_JOUR : planId, planVersion). Si l’application ne mettrait plus à jour exactement ces plans à ces versions (plan modifié, créé ou désactivé entre-temps), 409 VERSION_OBSOLETE et rien n’est enregistré : prévisualiser de nouveau.',
  })
  @IsOptional() @IsArray() @ArrayMaxSize(10000) @ValidateNested({ each: true }) @Type(() => ExpectedPlanVersionDto) expectedPlanVersions?: ExpectedPlanVersionDto[];
}

export class PlanImpactStateDto {
  @ApiProperty({ nullable: true, type: String }) intervalKm!: string | null;
  @ApiProperty({ nullable: true, type: Number }) intervalMonths!: number | null;
  @ApiProperty({ nullable: true, type: Number }) intervalDays!: number | null;
  @ApiProperty({ nullable: true, type: String }) noticeKm!: string | null;
  @ApiProperty({ nullable: true, type: Number }) noticeDays!: number | null;
  @ApiProperty({ nullable: true, type: String }) nextDueKm!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date' }) nextDueDate!: string | null;
  @ApiProperty({ enum: STATUSES }) status!: string;
  @ApiProperty({ nullable: true, type: String }) remainingKm!: string | null;
  @ApiProperty({ nullable: true, type: Number }) remainingDays!: number | null;
}

export class TemplatePlanImpactDto {
  @ApiProperty({ nullable: true, type: String, description: 'Plan concerné (null pour un plan qui serait créé, en prévisualisation).' }) planId!: string | null;
  @ApiProperty() vehicleId!: string;
  @ApiProperty() vehicleCode!: string;
  @ApiProperty() maintenanceTypeLabel!: string;
  @ApiProperty({ enum: ['CREATION', 'MISE_A_JOUR'] }) action!: string;
  @ApiProperty({ nullable: true, type: Number, description: 'Version du plan existant lue avant la mise à jour (à renvoyer dans expectedPlanVersions pour confirmer l’aperçu) ; null pour une création.' }) planVersion!: number | null;
  @ApiProperty({ type: PlanImpactStateDto, nullable: true, description: 'État avant (plan existant), statut du jour local.' }) before!: PlanImpactStateDto | null;
  @ApiProperty({ type: PlanImpactStateDto, description: 'État après recalcul depuis les opérations validées (base conservée).' }) after!: PlanImpactStateDto;
}

export class ApplyTemplateVehicleResultDto {
  @ApiProperty() vehicleId!: string;
  @ApiProperty() vehicleCode!: string;
  @ApiProperty({ enum: ON_EXISTING, description: 'Choix appliqué à ce véhicule pour ses plans actifs existants.' }) onExisting!: string;
  @ApiProperty({ type: [String], description: 'Plans créés (base : dernière opération de ce type, sinon INCOMPLET).' }) created!: string[];
  @ApiProperty({ type: [String] }) updated!: string[];
  @ApiProperty({ type: [String], description: 'Types ignorés car un plan actif existe déjà.' }) ignored!: string[];
}

export class ApplyTemplateResultDto {
  @ApiProperty() templateId!: string;
  @ApiProperty({ type: [ApplyTemplateVehicleResultDto] }) vehicles!: ApplyTemplateVehicleResultDto[];
  @ApiProperty({ type: [String], description: 'Opérations du modèle archivées au catalogue : non copiées.' }) archivedSkipped!: string[];
  @ApiProperty({ description: 'true : prévisualisation, rien n’a été enregistré.' }) preview!: boolean;
  @ApiProperty({ type: [TemplatePlanImpactDto], description: 'Impact plan par plan : échéances futures seulement, historique inchangé.' }) impacts!: TemplatePlanImpactDto[];
}

export class MaintenanceTypeViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({ enum: ['ACTIF', 'ARCHIVE'] }) status!: string;
  @ApiProperty() version!: number;
}

export class CatalogSkippedItemDto {
  @ApiProperty() code!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ enum: ['CODE_EXISTANT', 'LIBELLE_EXISTANT'], description: 'Élément existant (actif ou archivé) de même code ou de même libellé : non modifié.' }) reason!: string;
}

export class InstallMaintenanceCatalogResultDto {
  @ApiProperty({ type: [MaintenanceTypeViewDto], description: 'Opérations ajoutées au catalogue.' }) created!: MaintenanceTypeViewDto[];
  @ApiProperty({ type: [CatalogSkippedItemDto], description: 'Opérations du catalogue initial déjà présentes : ignorées, jamais modifiées.' }) skipped!: CatalogSkippedItemDto[];
}

export class TemplateItemViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() maintenanceTypeId!: string;
  @ApiProperty() maintenanceTypeLabel!: string;
  @ApiProperty({ enum: ['ACTIF', 'ARCHIVE'], description: 'Statut de l’opération au catalogue (ARCHIVE : ligne conservée, non copiée).' }) maintenanceTypeStatus!: string;
  @ApiProperty({ nullable: true, type: String }) intervalKm!: string | null;
  @ApiProperty({ nullable: true, type: Number }) intervalMonths!: number | null;
  @ApiProperty({ nullable: true, type: Number }) intervalDays!: number | null;
  @ApiProperty({ nullable: true, type: String }) noticeKm!: string | null;
  @ApiProperty({ nullable: true, type: Number }) noticeDays!: number | null;
}

export class TemplateViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({ enum: ['ACTIF', 'ARCHIVE'] }) status!: string;
  @ApiProperty({ type: [TemplateItemViewDto] }) items!: TemplateItemViewDto[];
  @ApiProperty() version!: number;
}

export class CatalogQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsIn(['true', 'false']) includeArchived?: 'true' | 'false';
}

export class CreatePlanDto extends IntervalsDto {
  @ApiProperty() @IsUUID() vehicleId!: string;
  @ApiProperty() @IsUUID() maintenanceTypeId!: string;
  @ApiProperty({ type: PlanBaseDto }) @ValidateNested() @Type(() => PlanBaseDto) base!: PlanBaseDto;
  @ApiPropertyOptional({ enum: SOURCES, description: 'Relevés admissibles : tous, ou manuels et compteur CAN uniquement (5.6).' }) @IsOptional() @IsIn(SOURCES) acceptedSources?: (typeof SOURCES)[number];
  @ApiPropertyOptional() @IsOptional() @IsUUID() responsibleUserId?: string;
}

export class UpdatePlanDto extends IntervalsDto {
  @ApiPropertyOptional({ enum: SOURCES }) @IsOptional() @IsIn(SOURCES) acceptedSources?: (typeof SOURCES)[number];
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsUUID() responsibleUserId?: string | null;
  @ApiPropertyOptional({ type: PlanBaseDto, description: 'Réinitialisation de la base (base technique validée).' }) @IsOptional() @ValidateNested() @Type(() => PlanBaseDto) base?: PlanBaseDto;
  @ApiPropertyOptional({ description: 'Prévisualiser l’impact sans enregistrer.' }) @IsOptional() @IsBoolean() preview?: boolean;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class DeactivatePlanDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class ReactivatePlanDto {
  @ApiProperty({ description: 'Motif de la réactivation (audité).' }) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class PlansQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: PLAN_SORTS, default: 'echeance', description: 'urgence (desc = le plus urgent d’abord), resteKm, resteJours, echeance (date puis km), vehicule, operation.' })
  @IsOptional() @IsIn(PLAN_SORTS) override sort?: PlanSort;
  @ApiPropertyOptional({ description: 'Recherche : code ou immatriculation du véhicule, libellé de l’opération.' }) @IsOptional() @IsString() @MaxLength(200) override q?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() vehicleId?: string;
  @ApiPropertyOptional({ enum: STATUSES }) @IsOptional() @IsIn(STATUSES) status?: (typeof STATUSES)[number];
  @ApiPropertyOptional({ description: 'Uniquement A_FAIRE et EN_RETARD.' }) @IsOptional() @IsIn(['true', 'false']) urgent?: 'true' | 'false';
  @ApiPropertyOptional() @IsOptional() @IsIn(['true', 'false']) includeInactive?: 'true' | 'false';
}

export class PlanViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() vehicleId!: string;
  @ApiProperty() vehicleCode!: string;
  @ApiProperty() maintenanceTypeId!: string;
  @ApiProperty() maintenanceTypeLabel!: string;
  @ApiProperty({ nullable: true, type: String }) intervalKm!: string | null;
  @ApiProperty({ nullable: true, type: Number }) intervalMonths!: number | null;
  @ApiProperty({ nullable: true, type: Number }) intervalDays!: number | null;
  @ApiProperty({ nullable: true, type: String }) noticeKm!: string | null;
  @ApiProperty({ nullable: true, type: Number }) noticeDays!: number | null;
  @ApiProperty({ enum: BASE_MODES, description: 'Mode de la base retenue (baseKm, baseDate) : DERNIERE_OPERATION dès qu’une opération réalisée sert de base, sinon mode de la base déclarée.' }) baseMode!: string;
  @ApiProperty({ nullable: true, type: String }) baseKm!: string | null;
  @ApiProperty({ nullable: true, type: String }) baseDate!: string | null;
  @ApiProperty({ nullable: true, type: String }) nextDueKm!: string | null;
  @ApiProperty({ nullable: true, type: String }) nextDueDate!: string | null;
  @ApiProperty({ enum: STATUSES }) status!: string;
  @ApiProperty({ nullable: true, enum: STATUSES }) kmStatus!: string | null;
  @ApiProperty({ nullable: true, enum: STATUSES }) dateStatus!: string | null;
  @ApiProperty({ nullable: true, type: String }) remainingKm!: string | null;
  @ApiProperty({ nullable: true, type: Number }) remainingDays!: number | null;
  @ApiProperty({ nullable: true, type: String }) currentKm!: string | null;
  @ApiProperty({ type: [String] }) warnings!: string[];
  @ApiProperty({ nullable: true, type: String, description: 'Source du kilométrage courant retenu (ex. estimation GPS).' }) currentKmSource!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) currentKmObservedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) templateId!: string | null;
  @ApiProperty({ enum: SOURCES }) acceptedSources!: string;
  @ApiProperty() active!: boolean;
  @ApiProperty({ nullable: true, type: String }) responsibleUserId!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Prénom et nom du responsable.' }) responsibleUserName!: string | null;
  @ApiProperty({ nullable: true, type: String }) deactivationReason!: string | null;
  @ApiProperty() version!: number;
}

export class PlanPageDto extends PageMetaDto {
  @ApiProperty({ type: [PlanViewDto] }) items!: PlanViewDto[];
}

export class MaintenanceCalendarQueryDto {
  @ApiProperty({ example: '2026-10', description: 'Mois civil (AAAA-MM) dans le fuseau de l’organisation.' }) @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) month!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() vehicleId?: string;
}

export class CalendarDueItemDto {
  @ApiProperty() planId!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() vehicleId!: string;
  @ApiProperty() vehicleCode!: string;
  @ApiProperty() maintenanceTypeLabel!: string;
  @ApiProperty({ format: 'date', description: 'Échéance en date (prochaineEcheanceDate calculée par l’API).' }) date!: string;
  @ApiProperty({ nullable: true, type: String, description: 'Échéance en km du même plan, le cas échéant (premier seuil atteint).' }) nextDueKm!: string | null;
  @ApiProperty({ enum: STATUSES, description: 'Statut matérialisé du plan au jour local (même valeur que la liste des échéances).' }) status!: string;
}

export class CalendarInterventionDto {
  @ApiProperty() id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() vehicleId!: string;
  @ApiProperty() vehicleCode!: string;
  @ApiProperty({ enum: ['PREVENTIF', 'CORRECTIF'] }) kind!: string;
  @ApiProperty({ format: 'date', description: 'Jour local du début prévu.' }) date!: string;
  @ApiProperty({ format: 'date-time' }) plannedStartAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) plannedEndAt!: string | null;
  @ApiProperty({ type: [String], description: 'Travaux prévus (libellés).' }) tasks!: string[];
}

export class MaintenanceCalendarDto {
  @ApiProperty({ example: '2026-10' }) month!: string;
  @ApiProperty({ format: 'date' }) from!: string;
  @ApiProperty({ format: 'date' }) to!: string;
  @ApiProperty({ description: 'Fuseau de l’organisation (jours civils du calendrier).' }) timezone!: string;
  @ApiProperty({ type: [CalendarDueItemDto], description: 'Échéances en date des plans actifs tombant dans le mois, par date puis véhicule.' }) dueItems!: CalendarDueItemDto[];
  @ApiProperty({ type: [CalendarInterventionDto], description: 'Interventions PLANIFIEE dont le début prévu tombe dans le mois (planifier n’est pas exécuter).' }) interventions!: CalendarInterventionDto[];
  @ApiProperty({ description: 'Plans actifs EN_RETARD dont l’échéance en date précède le mois affiché.' }) overdueBeforeCount!: number;
  @ApiProperty({ description: 'true si le mois dépasse la limite d’éléments renvoyés : affiner par société ou véhicule.' }) truncated!: boolean;
}
