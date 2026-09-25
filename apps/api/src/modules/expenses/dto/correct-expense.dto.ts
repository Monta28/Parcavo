import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { EXPENSE_CATEGORIES, type ExpenseCategoryKey } from '../../../domain/expense-ledger.js';
import { DATE_MESSAGE, DATE_ONLY, UUID_MESSAGE } from './create-expense.dto.js';

const VERSION_MESSAGE = 'La version attendue (entier ≥ 1) est obligatoire.';
const REASON_MESSAGE = 'Motif obligatoire (3 à 500 caractères).';

/**
 * Correction d'une dépense validée (D-229) : nouvelle dépense VALIDEE qui remplace l'ancienne
 * (REMPLACEE), même société, même nature, motif obligatoire. Les champs omis sont repris de la
 * dépense corrigée ; null efface un champ facultatif.
 */
export class CorrectExpenseDto {
  @ApiProperty({ description: 'Motif de la correction (audit).' })
  @IsString({ message: REASON_MESSAGE })
  @MinLength(3, { message: REASON_MESSAGE })
  @MaxLength(500, { message: REASON_MESSAGE })
  reason!: string;

  @ApiProperty({ description: 'Version de la dépense corrigée (verrou optimiste).' })
  @Type(() => Number)
  @IsInt({ message: VERSION_MESSAGE })
  @Min(1, { message: VERSION_MESSAGE })
  expectedVersion!: number;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'Véhicule (null : dépense société non affectée, catégories assurance, taxes, location, autre).' })
  @IsOptional()
  @IsUUID('all', { message: UUID_MESSAGE })
  vehicleId?: string | null;

  @ApiPropertyOptional({ format: 'date' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  occurredOn?: string;

  @ApiPropertyOptional({ enum: EXPENSE_CATEGORIES })
  @IsOptional()
  @IsIn(EXPENSE_CATEGORIES, { message: 'Catégorie de dépense inconnue.' })
  category?: ExpenseCategoryKey;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @IsUUID('all', { message: UUID_MESSAGE })
  supplierId?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @IsString({ message: 'La référence est une chaîne de caractères.' })
  @MaxLength(100, { message: 'Référence : 100 caractères au plus.' })
  reference?: string | null;

  @ApiPropertyOptional({ type: String, example: '125.500', description: 'Montant TTC corrigé (chaîne décimale, trois décimales au plus).' })
  @IsOptional()
  @IsString({ message: 'Le montant est transmis en chaîne (ex. "125.500").' })
  @MaxLength(20, { message: 'Montant trop long.' })
  amount?: string;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'Nouveau justificatif ; omis : le justificatif de la dépense corrigée est conservé.' })
  @IsOptional()
  @IsUUID('all', { message: UUID_MESSAGE })
  attachmentId?: string | null;

  @ApiPropertyOptional({ description: 'Confirmer malgré un justificatif identique déjà rattaché ailleurs (D-232).' })
  @IsOptional()
  @IsBoolean({ message: 'Une valeur vrai/faux est attendue.' })
  confirmDuplicateAttachment?: boolean;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @IsString({ message: 'Les notes sont une chaîne de caractères.' })
  @MaxLength(2000, { message: 'Notes : 2 000 caractères au plus.' })
  notes?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @IsUUID('all', { message: UUID_MESSAGE })
  relatedIncidentId?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'Avoir uniquement : dépense d’origine.' })
  @IsOptional()
  @IsUUID('all', { message: UUID_MESSAGE })
  relatedExpenseId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'Une valeur vrai/faux est attendue.' })
  excludedFromOperatingCost?: boolean;

  @ApiPropertyOptional({ description: 'Clé d’idempotence (ou en-tête Idempotency-Key).' })
  @IsOptional()
  @IsString({ message: 'La clé d’idempotence est une chaîne de caractères.' })
  @MinLength(8, { message: 'Clé d’idempotence : 8 caractères au moins.' })
  @MaxLength(128, { message: 'Clé d’idempotence : 128 caractères au plus.' })
  idempotencyKey?: string;
}

/** Annulation d'une dépense validée (D-229) : le coût disparaît de sa période d'origine. */
export class CancelExpenseDto {
  @ApiProperty({ description: 'Motif de l’annulation (audit).' })
  @IsString({ message: REASON_MESSAGE })
  @MinLength(3, { message: REASON_MESSAGE })
  @MaxLength(500, { message: REASON_MESSAGE })
  reason!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsInt({ message: VERSION_MESSAGE })
  @Min(1, { message: VERSION_MESSAGE })
  expectedVersion!: number;
}

/** Bascule « exclue du coût d'exploitation » (D-233), auditée. */
export class OperatingCostDto {
  @ApiProperty({ description: 'Vrai : conservée à titre informatif, hors coût d’exploitation.' })
  @IsBoolean({ message: 'Une valeur vrai/faux est attendue.' })
  excludedFromOperatingCost!: boolean;

  @ApiPropertyOptional({ description: 'Motif (audit).' })
  @IsOptional()
  @IsString({ message: 'Le motif est une chaîne de caractères.' })
  @MaxLength(500, { message: 'Motif : 500 caractères au plus.' })
  reason?: string;

  @ApiProperty()
  @Type(() => Number)
  @IsInt({ message: VERSION_MESSAGE })
  @Min(1, { message: VERSION_MESSAGE })
  expectedVersion!: number;
}
