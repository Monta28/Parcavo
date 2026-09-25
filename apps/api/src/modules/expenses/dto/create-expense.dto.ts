import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { EXPENSE_CATEGORIES, EXPENSE_KINDS, type ExpenseCategoryKey, type ExpenseKindKey } from '../../../domain/expense-ledger.js';

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export const DATE_MESSAGE = 'Date attendue au format AAAA-MM-JJ.';
export const UUID_MESSAGE = 'Un identifiant valide est attendu.';

/**
 * Saisie d'une dépense manuelle ou d'un avoir (CDC 8.4, D-229, D-230, D-232, D-233). La société
 * imputée n'est jamais choisie librement quand un véhicule est indiqué : c'est la société qui le
 * gérait à la date de la dépense (historique des transferts).
 */
export class CreateExpenseDto {
  @ApiPropertyOptional({ enum: EXPENSE_KINDS, default: 'DEPENSE', description: 'AVOIR : montant saisi en positif et soustrait du coût (jamais un paiement).' })
  @IsOptional()
  @IsIn(EXPENSE_KINDS, { message: 'Nature attendue : DEPENSE ou AVOIR.' })
  kind?: ExpenseKindKey;

  @ApiPropertyOptional({ description: 'Véhicule concerné ; facultatif uniquement pour assurance, taxes, location et autre (« Dépense société non affectée »).' })
  @IsOptional()
  @IsUUID('all', { message: UUID_MESSAGE })
  vehicleId?: string;

  @ApiPropertyOptional({ description: 'Société imputée d’une dépense sans véhicule. Avec un véhicule, la société est déduite (société gestionnaire à la date) ; si elle est fournie, elle doit concorder.' })
  @IsOptional()
  @IsUUID('all', { message: UUID_MESSAGE })
  companyId?: string;

  @ApiProperty({ format: 'date', example: '2026-09-24', description: 'Date civile de la dépense (fuseau du groupe), jamais future.' })
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  occurredOn!: string;

  @ApiProperty({ enum: EXPENSE_CATEGORIES })
  @IsIn(EXPENSE_CATEGORIES, { message: 'Catégorie de dépense inconnue.' })
  category!: ExpenseCategoryKey;

  @ApiPropertyOptional({ description: 'Fournisseur actif de la société imputée.' })
  @IsOptional()
  @IsUUID('all', { message: UUID_MESSAGE })
  supplierId?: string;

  @ApiPropertyOptional({ description: 'Référence fournisseur (facture, ticket) : unique par société et fournisseur parmi les dépenses validées saisies, sans tenir compte de la casse.' })
  @IsOptional()
  @IsString({ message: 'La référence est une chaîne de caractères.' })
  @MaxLength(100, { message: 'Référence : 100 caractères au plus.' })
  reference?: string;

  @ApiProperty({ type: String, example: '125.500', description: 'Montant TTC en devise du groupe (TND), décimal exact transmis en chaîne, strictement positif, trois décimales au plus.' })
  @IsString({ message: 'Le montant est transmis en chaîne (ex. "125.500").' })
  @MaxLength(20, { message: 'Montant trop long.' })
  amount!: string;

  @ApiPropertyOptional({ description: 'Justificatif téléversé au préalable, rattaché à la dépense.' })
  @IsOptional()
  @IsUUID('all', { message: UUID_MESSAGE })
  attachmentId?: string;

  @ApiPropertyOptional({ description: 'Confirmer l’enregistrement malgré un justificatif identique déjà rattaché à une dépense ou à un plein actif de la société (avertissement D-232).' })
  @IsOptional()
  @IsBoolean({ message: 'Une valeur vrai/faux est attendue.' })
  confirmDuplicateAttachment?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: 'Les notes sont une chaîne de caractères.' })
  @MaxLength(2000, { message: 'Notes : 2 000 caractères au plus.' })
  notes?: string;

  @ApiPropertyOptional({ description: 'Incident auquel la dépense se rattache (même véhicule, D-217).' })
  @IsOptional()
  @IsUUID('all', { message: UUID_MESSAGE })
  relatedIncidentId?: string;

  @ApiPropertyOptional({ description: 'Avoir uniquement : dépense d’origine validée de la même société (facultative).' })
  @IsOptional()
  @IsUUID('all', { message: UUID_MESSAGE })
  relatedExpenseId?: string;

  @ApiPropertyOptional({ description: 'Exclure du coût d’exploitation (défaut : oui pour un achat de véhicule, sinon non).' })
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
