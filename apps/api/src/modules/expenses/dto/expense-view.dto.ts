import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { PageMetaDto, PageQueryDto } from '../../../common/pagination.js';
import { EXPENSE_CATEGORIES, EXPENSE_KINDS, EXPENSE_STATUSES, type ExpenseCategoryKey, type ExpenseKindKey } from '../../../domain/expense-ledger.js';
import { DATE_MESSAGE, DATE_ONLY, UUID_MESSAGE } from './create-expense.dto.js';

export const EXPENSE_STATUS_FILTER = ['VALIDEE', 'ANNULEE', 'REMPLACEE', 'TOUS'] as const;
export type ExpenseStatusFilter = (typeof EXPENSE_STATUS_FILTER)[number];
/** MANUELLE : dépenses saisies directement dans le registre (sans source). */
export const EXPENSE_SOURCE_FILTER = ['PLEIN', 'INTERVENTION', 'MANUELLE'] as const;
export type ExpenseSourceFilter = (typeof EXPENSE_SOURCE_FILTER)[number];
export const EXPENSE_SORTS = ['occurredOn', 'amount', 'createdAt'] as const;

/** Filtres communs à la liste et à la synthèse. Le périmètre est toujours recalculé côté serveur. */
export interface ExpenseFilters {
  companyId?: string;
  vehicleId?: string;
  unallocated?: 'true' | 'false';
  category?: ExpenseCategoryKey;
  supplierId?: string;
  from?: string;
  to?: string;
  kind?: ExpenseKindKey;
  sourceType?: ExpenseSourceFilter;
  relatedIncidentId?: string;
  q?: string;
}

export class ExpensesQueryDto extends PageQueryDto implements ExpenseFilters {
  @ApiPropertyOptional({ description: 'Société (dans le périmètre, avec costs.read).' }) @IsOptional() @IsUUID('all', { message: UUID_MESSAGE }) companyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('all', { message: UUID_MESSAGE }) vehicleId?: string;
  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'true : uniquement les dépenses société non affectées (sans véhicule).' }) @IsOptional() @IsIn(['true', 'false'], { message: 'Valeur attendue : true ou false.' }) unallocated?: 'true' | 'false';
  @ApiPropertyOptional({ enum: EXPENSE_CATEGORIES }) @IsOptional() @IsIn(EXPENSE_CATEGORIES, { message: 'Catégorie de dépense inconnue.' }) category?: ExpenseCategoryKey;
  @ApiPropertyOptional() @IsOptional() @IsUUID('all', { message: UUID_MESSAGE }) supplierId?: string;
  @ApiPropertyOptional({ format: 'date', description: 'Date de dépense (occurredOn) au plus tôt.' }) @IsOptional() @Matches(DATE_ONLY, { message: DATE_MESSAGE }) from?: string;
  @ApiPropertyOptional({ format: 'date', description: 'Date de dépense (occurredOn) au plus tard.' }) @IsOptional() @Matches(DATE_ONLY, { message: DATE_MESSAGE }) to?: string;
  @ApiPropertyOptional({ enum: EXPENSE_STATUS_FILTER, default: 'VALIDEE' }) @IsOptional() @IsIn(EXPENSE_STATUS_FILTER, { message: 'Statut inconnu.' }) status?: ExpenseStatusFilter;
  @ApiPropertyOptional({ enum: EXPENSE_KINDS }) @IsOptional() @IsIn(EXPENSE_KINDS, { message: 'Nature attendue : DEPENSE ou AVOIR.' }) kind?: ExpenseKindKey;
  @ApiPropertyOptional({ enum: EXPENSE_SOURCE_FILTER }) @IsOptional() @IsIn(EXPENSE_SOURCE_FILTER, { message: 'Source inconnue.' }) sourceType?: ExpenseSourceFilter;
  @ApiPropertyOptional({ description: 'Incident : dépenses rattachées et dépenses de synthèse des interventions issues de l’incident.' }) @IsOptional() @IsUUID('all', { message: UUID_MESSAGE }) relatedIncidentId?: string;
}

/**
 * Synthèse : mêmes filtres que la liste (société, véhicule, « sans véhicule », catégorie, fournisseur,
 * période, nature, source, incident, recherche), sur les seules dépenses validées ; l'état ne s'applique
 * qu'à la liste.
 */
export class ExpensesSummaryQueryDto implements ExpenseFilters {
  @ApiPropertyOptional({ description: 'Société (dans le périmètre, avec costs.read).' }) @IsOptional() @IsUUID('all', { message: UUID_MESSAGE }) companyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('all', { message: UUID_MESSAGE }) vehicleId?: string;
  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'true : uniquement les dépenses société non affectées (sans véhicule).' }) @IsOptional() @IsIn(['true', 'false'], { message: 'Valeur attendue : true ou false.' }) unallocated?: 'true' | 'false';
  @ApiPropertyOptional({ enum: EXPENSE_CATEGORIES }) @IsOptional() @IsIn(EXPENSE_CATEGORIES, { message: 'Catégorie de dépense inconnue.' }) category?: ExpenseCategoryKey;
  @ApiPropertyOptional() @IsOptional() @IsUUID('all', { message: UUID_MESSAGE }) supplierId?: string;
  @ApiPropertyOptional({ format: 'date' }) @IsOptional() @Matches(DATE_ONLY, { message: DATE_MESSAGE }) from?: string;
  @ApiPropertyOptional({ format: 'date' }) @IsOptional() @Matches(DATE_ONLY, { message: DATE_MESSAGE }) to?: string;
  @ApiPropertyOptional({ enum: EXPENSE_KINDS }) @IsOptional() @IsIn(EXPENSE_KINDS, { message: 'Nature attendue : DEPENSE ou AVOIR.' }) kind?: ExpenseKindKey;
  @ApiPropertyOptional({ enum: EXPENSE_SOURCE_FILTER }) @IsOptional() @IsIn(EXPENSE_SOURCE_FILTER, { message: 'Source inconnue.' }) sourceType?: ExpenseSourceFilter;
  @ApiPropertyOptional() @IsOptional() @IsUUID('all', { message: UUID_MESSAGE }) relatedIncidentId?: string;
  @ApiPropertyOptional({ description: 'Recherche dans la référence, les notes et le nom du fournisseur (comme la liste).' }) @IsOptional() @IsString() @MaxLength(200) q?: string;
}

export class ExpenseViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Société au fait générateur (jamais réimputée).' }) companyId!: string;
  @ApiProperty({ nullable: true, type: String }) vehicleId!: string | null;
  @ApiProperty({ nullable: true, type: String }) vehicleCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) vehicleRegistration!: string | null;
  @ApiProperty({ description: 'Véhicule, ou « Dépense société non affectée ».' }) allocationLabel!: string;
  @ApiProperty({ description: 'Vrai si la dépense n’a pas de véhicule (ligne « Non ventilé »).' }) unallocated!: boolean;
  @ApiProperty({ format: 'date' }) occurredOn!: string;
  @ApiProperty({ enum: EXPENSE_CATEGORIES }) category!: string;
  @ApiProperty() categoryLabel!: string;
  @ApiProperty({ enum: EXPENSE_KINDS }) kind!: string;
  @ApiProperty({ nullable: true, type: String }) supplierId!: string | null;
  @ApiProperty({ nullable: true, type: String }) supplierName!: string | null;
  @ApiProperty({ nullable: true, type: String }) reference!: string | null;
  @ApiProperty({ type: String, example: '125.500', description: 'Montant TTC saisi (positif).' }) amount!: string;
  @ApiProperty({ type: String, example: '-20.000', description: 'Montant signé : négatif pour un avoir.' }) signedAmount!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ nullable: true, type: String }) attachmentId!: string | null;
  @ApiProperty({ nullable: true, type: String }) relatedIncidentId!: string | null;
  @ApiProperty({ nullable: true, type: String }) relatedIncidentReference!: string | null;
  @ApiProperty({ nullable: true, type: String }) relatedExpenseId!: string | null;
  @ApiProperty({ nullable: true, enum: ['PLEIN', 'INTERVENTION'] }) sourceType!: string | null;
  @ApiProperty({ nullable: true, type: String }) sourceId!: string | null;
  @ApiProperty({ enum: EXPENSE_STATUSES }) status!: string;
  @ApiProperty({ nullable: true, type: String }) replacesExpenseId!: string | null;
  @ApiProperty({ nullable: true, type: String }) replacedByExpenseId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) cancelledAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelReason!: string | null;
  @ApiProperty() excludedFromOperatingCost!: boolean;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) createdById!: string | null;
  @ApiProperty() version!: number;
}

export class ExpensePageDto extends PageMetaDto {
  @ApiProperty({ type: [ExpenseViewDto] }) items!: ExpenseViewDto[];
}

export class ExpenseBucketDto {
  @ApiProperty({ type: String, example: '1200.000', description: 'Somme des dépenses.' }) expenses!: string;
  @ApiProperty({ type: String, example: '100.000', description: 'Somme des avoirs (positive).' }) credits!: string;
  @ApiProperty({ type: String, example: '1100.000', description: 'Dépenses − avoirs (peut être négatif).' }) net!: string;
  @ApiProperty() count!: number;
}

export class ExpenseCategoryTotalDto extends ExpenseBucketDto {
  @ApiProperty({ enum: EXPENSE_CATEGORIES }) category!: string;
  @ApiProperty() label!: string;
}

export class ExpenseLabelledBucketDto extends ExpenseBucketDto {
  @ApiProperty() label!: string;
}

export class ExpenseExcludedDto extends ExpenseLabelledBucketDto {
  @ApiProperty({ type: [ExpenseCategoryTotalDto] }) byCategory!: ExpenseCategoryTotalDto[];
}

export class ExpenseSummaryDto {
  @ApiProperty() currency!: string;
  @ApiProperty({ nullable: true, type: String }) companyId!: string | null;
  @ApiProperty({ nullable: true, type: String }) vehicleId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date' }) from!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date' }) to!: string | null;
  @ApiProperty({ type: [ExpenseCategoryTotalDto], description: 'Coût d’exploitation par catégorie (dépenses validées uniquement).' }) byCategory!: ExpenseCategoryTotalDto[];
  @ApiProperty({ type: ExpenseLabelledBucketDto, description: 'Coût d’exploitation total (dépenses − avoirs), dépenses sans véhicule incluses.' }) operating!: ExpenseLabelledBucketDto;
  @ApiProperty({ type: ExpenseLabelledBucketDto, description: 'Ligne « Non ventilé » : part du coût d’exploitation sans véhicule, jamais répartie.' }) unallocated!: ExpenseLabelledBucketDto;
  @ApiProperty({ type: ExpenseExcludedDto, description: 'Dépenses conservées à titre informatif, hors coût d’exploitation (achats de véhicules par défaut).' }) excludedFromOperatingCost!: ExpenseExcludedDto;
}
