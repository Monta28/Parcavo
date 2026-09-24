import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsISO8601, IsNumberString, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination.js';

const KINDS = ['PREVENTIF', 'CORRECTIF'] as const;
const STATUSES = ['BROUILLON', 'PLANIFIEE', 'EN_COURS', 'TERMINEE', 'ANNULEE'] as const;
const LINE_KINDS = ['PIECE', 'MAIN_OEUVRE', 'AUTRE'] as const;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const READING_SOURCES = ['MANUAL', 'IMPORT', 'TELEMATICS'] as const;
const READING_STATUSES = ['EN_ATTENTE', 'ACCEPTE', 'REJETE', 'REMPLACE'] as const;
const MEASUREMENT_KINDS = ['COMPTEUR_AFFICHE', 'COMPTEUR_CAN', 'DISTANCE_GPS'] as const;
const ATTACHMENT_KINDS = ['INTERVENTION', 'FACTURE', 'RELEVE'] as const;

/** Tris autorisés de GET /interventions (CDC 15.1 : tri sur liste autorisée). Sans tri : création la plus récente d'abord. */
export const INTERVENTION_SORTS = ['reference', 'vehicleCode', 'status', 'plannedStartAt', 'startedAt', 'performedOn', 'completedAt', 'createdAt'] as const;
export type InterventionSort = (typeof INTERVENTION_SORTS)[number];

export class TaskInputDto {
  @ApiPropertyOptional({ description: 'Plan véhicule/opération réalisé par cette ligne de travail (6.4).' }) @IsOptional() @IsUUID() planId?: string;
  @ApiPropertyOptional({ description: 'Opération du catalogue (sans plan).' }) @IsOptional() @IsUUID() maintenanceTypeId?: string;
  @ApiPropertyOptional({ description: 'Libellé libre (obligatoire sans plan ni type).' }) @IsOptional() @IsString() @MinLength(2) @MaxLength(200) label?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class CreateInterventionDto {
  @ApiProperty() @IsUUID() vehicleId!: string;
  @ApiProperty({ enum: KINDS }) @IsIn(KINDS) kind!: (typeof KINDS)[number];
  @ApiPropertyOptional({ description: 'Garage / fournisseur de la société du véhicule.' }) @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional({ format: 'date-time' }) @IsOptional() @IsDateString() plannedStartAt?: string;
  @ApiPropertyOptional({ format: 'date-time' }) @IsOptional() @IsDateString() plannedEndAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) diagnosis?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) workDescription?: string;
  @ApiPropertyOptional({ description: 'Incident source (intervention urgente ouverte depuis un incident, 6.3).' }) @IsOptional() @IsUUID() incidentId?: string;
  @ApiPropertyOptional({ description: 'Opération historique saisie a posteriori (import, rattrapage).' }) @IsOptional() @IsBoolean() isHistorical?: boolean;
  @ApiProperty({ type: [TaskInputDto] }) @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => TaskInputDto) tasks!: TaskInputDto[];
}

/**
 * Modification (PATCH) : ne change jamais le statut (D-204). Renseigner des dates sur un BROUILLON le
 * laisse BROUILLON (action « Planifier » requise) ; effacer le début prévu d'une PLANIFIEE est refusé
 * (422 DATE_PREVUE_REQUISE : replanifier ou annuler).
 */
export class UpdateInterventionDto {
  @ApiPropertyOptional({ enum: KINDS }) @IsOptional() @IsIn(KINDS) kind?: (typeof KINDS)[number];
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsUUID() supplierId?: string | null;
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Début prévu. Ne change pas le statut : un brouillon reste brouillon jusqu’à l’action « Planifier » ; null est refusé (422 DATE_PREVUE_REQUISE) sur une intervention planifiée.',
  })
  @IsOptional()
  @IsDateString()
  plannedStartAt?: string | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) @IsOptional() @IsDateString() plannedEndAt?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsString() @MaxLength(4000) diagnosis?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @IsString() @MaxLength(4000) workDescription?: string | null;
  @ApiPropertyOptional({ type: [TaskInputDto], description: 'Remplace les lignes de travail (avant clôture uniquement).' }) @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => TaskInputDto) tasks?: TaskInputDto[];
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class PlanInterventionDto {
  @ApiProperty({ format: 'date-time' }) @IsDateString() plannedStartAt!: string;
  @ApiPropertyOptional({ format: 'date-time' }) @IsOptional() @IsDateString() plannedEndAt?: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class StartInterventionDto {
  @ApiPropertyOptional({ format: 'date-time', description: 'Début réel (défaut : maintenant).' }) @IsOptional() @IsDateString() startedAt?: string;
  @ApiPropertyOptional({ description: 'Immobiliser le véhicule (cause INTERVENTION), explicite (6.3, D-205).' }) @IsOptional() @IsBoolean() immobilize?: boolean;
  @ApiPropertyOptional({ description: 'Motif de l’immobilisation (requis si immobilize).' }) @IsOptional() @IsString() @MinLength(3) @MaxLength(500) immobilizationReason?: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class CostLineDto {
  @ApiPropertyOptional({ description: 'Ligne de travail concernée.' }) @IsOptional() @IsUUID() taskId?: string;
  @ApiProperty({ enum: LINE_KINDS }) @IsIn(LINE_KINDS) kind!: (typeof LINE_KINDS)[number];
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) label!: string;
  @ApiProperty({ description: 'Quantité (décimal exact).' }) @IsNumberString() quantity!: string;
  @ApiProperty({ description: 'Prix unitaire TTC en TND (3 décimales).' }) @IsNumberString() unitPrice!: string;
}

export class NewReadingDto {
  @ApiProperty({ description: 'Valeur physique affichée au compteur.' }) @IsNumberString() physicalKm!: string;
  @ApiProperty({ format: 'date-time' }) @IsDateString() observedAt!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() attachmentId?: string;
}

/** Contrat CompleteIntervention (CDC 15.3). */
export class CompleteInterventionDto {
  @ApiProperty({ format: 'date', description: 'Date effective de réalisation (date civile locale, AAAA-MM-JJ, date calendaire existante).', example: '2026-09-24' })
  @Matches(DATE_ONLY, { message: 'Date attendue au format AAAA-MM-JJ.' })
  @IsISO8601({ strict: true }, { message: 'Date calendaire inexistante.' })
  performedOn!: string;
  @ApiPropertyOptional({ description: 'Relevé accepté correspondant (obligatoire si un plan réalisé a un intervalle en km).' }) @IsOptional() @IsUUID() acceptedReadingId?: string;
  @ApiPropertyOptional({ type: NewReadingDto, description: 'Ou relevé créé dans la même transaction (contexte ENTRETIEN).' }) @IsOptional() @ValidateNested() @Type(() => NewReadingDto) newReading?: NewReadingDto;
  @ApiProperty({ type: [String], description: 'Lignes de travail effectivement réalisées.' }) @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) completedTaskIds!: string[];
  @ApiPropertyOptional({ type: [CostLineDto], description: 'Lignes pièces / main-d’œuvre (le total est leur somme).' }) @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => CostLineDto) lines?: CostLineDto[];
  @ApiPropertyOptional({ description: 'Total TTC saisi sans lignes (TND).' }) @IsOptional() @IsNumberString() totalAmount?: string;
  @ApiPropertyOptional({ description: 'Intervention sans coût (aucune dépense).' }) @IsOptional() @IsBoolean() noCost?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) attachmentIds?: string[];
  @ApiPropertyOptional({ description: 'Mettre fin à la cause d’immobilisation liée (défaut : oui, D-205).' }) @IsOptional() @IsBoolean() endImmobilization?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) workDescription?: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @ApiPropertyOptional({ description: 'Clé d’idempotence (ou en-tête Idempotency-Key).' }) @IsOptional() @IsString() @MinLength(8) @MaxLength(128) idempotencyKey?: string;
}

export class RecordCostDto {
  @ApiPropertyOptional({ type: [CostLineDto] }) @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => CostLineDto) lines?: CostLineDto[];
  @ApiPropertyOptional() @IsOptional() @IsNumberString() totalAmount?: string;
  @ApiPropertyOptional({ description: 'Déclarer l’intervention sans coût.' }) @IsOptional() @IsBoolean() noCost?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional({ description: 'Facture rattachée à la dépense créée. Refusée (422 FACTURE_SANS_COUT) avec un total nul ou « sans coût ».' }) @IsOptional() @IsUUID() invoiceAttachmentId?: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class ReasonDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiPropertyOptional({ description: 'Mettre fin à la cause d’immobilisation liée (défaut : oui).' }) @IsOptional() @IsBoolean() endImmobilization?: boolean;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class InterventionsQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() vehicleId?: string;
  @ApiPropertyOptional({ enum: STATUSES }) @IsOptional() @IsIn(STATUSES) status?: (typeof STATUSES)[number];
  @ApiPropertyOptional({ description: 'Ouvertes : BROUILLON, PLANIFIEE, EN_COURS.' }) @IsOptional() @IsIn(['true', 'false']) open?: 'true' | 'false';
  @ApiPropertyOptional({ enum: KINDS }) @IsOptional() @IsIn(KINDS) kind?: (typeof KINDS)[number];
  @ApiPropertyOptional({ description: 'Garage / fournisseur (historique des interventions d’un fournisseur, même archivé).' }) @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional({
    format: 'date',
    description: 'Date civile (fuseau de l’organisation) au plus tôt, appliquée à la date de référence : date effective si réalisée, sinon jour local du début réel, sinon jour local du début prévu.',
  })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'Date attendue au format AAAA-MM-JJ.' })
  @IsISO8601({ strict: true }, { message: 'Date calendaire inexistante.' })
  from?: string;
  @ApiPropertyOptional({ format: 'date', description: 'Date civile (fuseau de l’organisation) au plus tard, incluse, sur la même date de référence.' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'Date attendue au format AAAA-MM-JJ.' })
  @IsISO8601({ strict: true }, { message: 'Date calendaire inexistante.' })
  to?: string;
  @ApiPropertyOptional({ enum: INTERVENTION_SORTS, description: 'Tri (sens : order). Dates absentes en dernier. Sans tri : création la plus récente d’abord.' })
  @IsOptional()
  @IsIn(INTERVENTION_SORTS, { message: `Tri inconnu : ${INTERVENTION_SORTS.join(', ')}.` })
  override sort?: InterventionSort;
}

export class TaskViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ nullable: true, type: String }) planId!: string | null;
  @ApiProperty({ nullable: true, type: String }) maintenanceTypeId!: string | null;
  @ApiProperty({ nullable: true, type: String }) maintenanceTypeLabel!: string | null;
  @ApiProperty() completed!: boolean;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
}

export class LineViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) taskId!: string | null;
  @ApiProperty({ enum: LINE_KINDS }) kind!: string;
  @ApiProperty() label!: string;
  @ApiProperty() quantity!: string;
  @ApiProperty() unitPrice!: string;
  @ApiProperty() amount!: string;
}

/** Relevé d'exécution rattaché à la clôture (6.3, D-207, D-307). Kilomètres tronqués (13.1). */
export class ExecutionReadingViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String, description: 'Valeur lue au compteur, kilomètre entier tronqué.' }) physicalKm!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Kilométrage cumulé, kilomètre entier tronqué.' }) cumulativeKm!: string | null;
  @ApiProperty({ format: 'date-time' }) observedAt!: string;
  @ApiProperty({ enum: READING_SOURCES }) source!: string;
  @ApiProperty({ enum: MEASUREMENT_KINDS }) measurementKind!: string;
  @ApiProperty() context!: string;
  @ApiProperty({ enum: READING_STATUSES, description: 'Statut courant (REMPLACE si le relevé a été corrigé depuis).' }) status!: string;
  @ApiProperty() isEstimate!: boolean;
}

/** Pièce jointe visible sur la fiche (métadonnées chargées en lot). */
export class InterventionAttachmentViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ATTACHMENT_KINDS, description: 'INTERVENTION : fichier de la clôture ; FACTURE : facture de la dépense liée (costs.read) ; RELEVE : photo du relevé d’exécution.' }) kind!: string;
  @ApiProperty() originalName!: string;
  @ApiProperty() mimeType!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty({ description: 'Chemin de téléchargement autorisé (session requise).' }) downloadPath!: string;
}

export class InterventionViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() vehicleId!: string;
  @ApiProperty() vehicleCode!: string;
  @ApiProperty() vehicleRegistration!: string;
  @ApiProperty({ enum: KINDS }) kind!: string;
  @ApiProperty({ enum: STATUSES }) status!: string;
  @ApiProperty({ nullable: true, type: String }) supplierId!: string | null;
  @ApiProperty({ nullable: true, type: String }) supplierName!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) plannedStartAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) plannedEndAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) startedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) completedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date' }) performedOn!: string | null;
  @ApiProperty({ nullable: true, type: String }) performedReadingId!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Kilométrage cumulé retenu à la clôture, kilomètre entier tronqué (13.1).' }) performedKm!: string | null;
  @ApiProperty({ nullable: true, type: ExecutionReadingViewDto }) executionReading!: ExecutionReadingViewDto | null;
  @ApiProperty({ nullable: true, type: String }) diagnosis!: string | null;
  @ApiProperty({ nullable: true, type: String }) workDescription!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Visible avec costs.read.' }) totalAmount!: string | null;
  @ApiProperty({ enum: ['A_SAISIR', 'SAISI', 'SANS_COUT'] }) costStatus!: string;
  @ApiProperty({ nullable: true, type: String }) expenseId!: string | null;
  @ApiProperty({ nullable: true, type: String }) incidentId!: string | null;
  @ApiProperty() isHistorical!: boolean;
  @ApiProperty({ nullable: true, type: String }) cancelReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) reopenReason!: string | null;
  @ApiProperty({ type: [TaskViewDto] }) tasks!: TaskViewDto[];
  @ApiProperty({ type: [LineViewDto], description: 'Visibles avec costs.read.' }) lines!: LineViewDto[];
  @ApiProperty({ type: [InterventionAttachmentViewDto], description: 'Pièces jointes que l’utilisateur peut télécharger (même contrôle que GET /attachments/:id/download).' }) attachments!: InterventionAttachmentViewDto[];
  @ApiProperty({ nullable: true, type: String, description: 'Cause d’immobilisation ouverte liée.' }) openImmobilizationCauseId!: string | null;
  @ApiProperty() version!: number;
}
