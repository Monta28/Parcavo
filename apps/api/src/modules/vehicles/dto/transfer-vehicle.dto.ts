import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { TRANSFER_BLOCKER_TYPES, TRANSFER_WARNING_TYPES } from '../../../domain/vehicle-transfer.js';
import { VehicleViewDto } from './vehicles.dto.js';

const PLAN_DECISIONS = ['KEEP', 'DEACTIVATE'] as const;

export class TransferAssignmentDecisionDto {
  @ApiProperty({ description: 'Clôture de l’affectation habituelle en cours à l’instant du transfert (obligatoire lorsqu’elle existe).' })
  @IsBoolean({ message: 'Clôture de l’affectation : vrai ou faux attendu.' })
  closeCurrent!: boolean;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'Nouveau responsable habituel facultatif : conducteur actif de la société cible.' })
  @IsOptional()
  @IsUUID('all', { message: 'Nouveau responsable : identifiant de conducteur invalide.' })
  newResponsibleDriverId?: string | null;
}

export class TransferPlanDecisionDto {
  @ApiProperty({ description: 'Plan d’entretien actif du véhicule.' })
  @IsUUID('all', { message: 'Identifiant de plan invalide.' })
  planId!: string;

  @ApiProperty({ enum: PLAN_DECISIONS, description: 'KEEP : plan conservé (bases et échéances inchangées) pour la société cible ; DEACTIVATE : plan désactivé.' })
  @IsIn(PLAN_DECISIONS, { message: 'Décision attendue : KEEP (conserver) ou DEACTIVATE (désactiver).' })
  decision!: (typeof PLAN_DECISIONS)[number];

  @ApiPropertyOptional({ nullable: true, type: String, description: 'KEEP : responsable choisi parmi les utilisateurs de la société cible, ou null (aucun).' })
  @IsOptional()
  @IsUUID('all', { message: 'Responsable : identifiant d’utilisateur invalide.' })
  responsibleUserId?: string | null;
}

export class TransferReadingDto {
  @ApiProperty({ example: '90412', description: 'Compteur physique lu au moment du transfert (décimal en chaîne). Observé à l’instant du transfert, rattaché à la société d’origine.' })
  @IsNumberString({}, { message: 'Kilométrage : nombre décimal en chaîne attendu.' })
  physicalKm!: string;

  @ApiPropertyOptional({ description: 'Photo du compteur (pièce jointe téléversée).' })
  @IsOptional()
  @IsUUID('all', { message: 'Pièce jointe : identifiant invalide.' })
  attachmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: 'Note : texte attendu.' })
  @MaxLength(1000, { message: 'Note : 1 000 caractères au plus.' })
  note?: string;
}

/** Transfert d'un véhicule (CDC 2.4 ; D-119 à D-125) : une décision explicite par objet à réexaminer. */
export class TransferVehicleDto {
  @ApiProperty({ description: 'Société destinataire (autre société de l’organisation).' })
  @IsUUID('all', { message: 'Société cible : identifiant invalide.' })
  targetCompanyId!: string;

  @ApiProperty({ description: 'Version du véhicule lue avant le transfert (verrou optimiste).' })
  @Type(() => Number)
  @IsInt({ message: 'Version : entier attendu.' })
  @Min(1, { message: 'Version : entier positif attendu.' })
  expectedVersion!: number;

  @ApiProperty({ description: 'Motif du transfert (historique et audit).' })
  @IsString({ message: 'Motif : texte attendu.' })
  @MinLength(3, { message: 'Motif : 3 caractères au moins.' })
  @MaxLength(500, { message: 'Motif : 500 caractères au plus.' })
  reason!: string;

  @ApiPropertyOptional({ type: TransferAssignmentDecisionDto, description: 'Décision sur l’affectation habituelle (obligatoire si une affectation est en cours ou prévue).' })
  @IsOptional()
  @ValidateNested({ message: 'Décision d’affectation invalide.' })
  @Type(() => TransferAssignmentDecisionDto)
  assignment?: TransferAssignmentDecisionDto;

  @ApiProperty({ type: [TransferPlanDecisionDto], description: 'Une décision pour chaque plan d’entretien actif (liste vide s’il n’y en a pas).' })
  @IsArray({ message: 'Plans : liste attendue.' })
  @ArrayMaxSize(200, { message: 'Plans : 200 décisions au plus.' })
  @ValidateNested({ each: true })
  @Type(() => TransferPlanDecisionDto)
  plans!: TransferPlanDecisionDto[];

  @ApiProperty({ nullable: true, type: String, description: 'Site de la société cible, ou null (décision explicite).' })
  @ValidateIf((o: TransferVehicleDto) => o.siteId !== null)
  @IsUUID('all', { message: 'Site : identifiant d’un site de la société cible, ou null.' })
  siteId!: string | null;

  @ApiProperty({ nullable: true, type: String, description: 'Service de la société cible, ou null (décision explicite).' })
  @ValidateIf((o: TransferVehicleDto) => o.departmentId !== null)
  @IsUUID('all', { message: 'Service : identifiant d’un service de la société cible, ou null.' })
  departmentId!: string | null;

  @ApiProperty({ type: [String], description: 'Versions de documents véhicule partagées avec la société cible (liste vide : aucun partage).' })
  @IsArray({ message: 'Documents partagés : liste attendue.' })
  @ArrayMaxSize(500, { message: 'Documents partagés : 500 au plus.' })
  @IsUUID('all', { each: true, message: 'Documents partagés : identifiants de versions invalides.' })
  sharedDocumentVersionIds!: string[];

  @ApiPropertyOptional({ type: TransferReadingDto, description: 'Relevé de transfert (contexte TRANSFERT) : borne la ventilation des distances entre les deux sociétés.' })
  @IsOptional()
  @ValidateNested({ message: 'Relevé de transfert invalide.' })
  @Type(() => TransferReadingDto)
  transferReading?: TransferReadingDto;

  @ApiPropertyOptional({ description: 'Motif obligatoire sans relevé de transfert (distance de la période non ventilable).' })
  @IsOptional()
  @IsString({ message: 'Motif d’absence de relevé : texte attendu.' })
  @MaxLength(500, { message: 'Motif d’absence de relevé : 500 caractères au plus.' })
  noReadingReason?: string;

  @ApiPropertyOptional({ description: 'Acquittement des avertissements (relevés, pleins en attente, incidents ouverts).' })
  @IsOptional()
  @IsBoolean({ message: 'Acquittement : vrai ou faux attendu.' })
  acknowledgeWarnings?: boolean;

  @ApiPropertyOptional({ description: 'Clé d’idempotence (ou en-tête Idempotency-Key).' })
  @IsOptional()
  @IsString({ message: 'Clé d’idempotence : texte attendu.' })
  @MinLength(8, { message: 'Clé d’idempotence : 8 caractères au moins.' })
  @MaxLength(128, { message: 'Clé d’idempotence : 128 caractères au plus.' })
  idempotencyKey?: string;
}

export class TransferBlockerDto {
  @ApiProperty({ enum: TRANSFER_BLOCKER_TYPES }) type!: string;
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Libellé de l’objet (référence, dates).' }) label!: string;
  @ApiProperty({ description: 'Action attendue avant le transfert.' }) action!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ description: 'Lien vers l’écran de traitement.' }) link!: string;
}

export class TransferWarningDto {
  @ApiProperty({ enum: TRANSFER_WARNING_TYPES }) type!: string;
  @ApiProperty() id!: string;
  @ApiProperty() label!: string;
  @ApiProperty() action!: string;
  @ApiProperty() status!: string;
  @ApiProperty() link!: string;
}

export class TransferAssignmentPreviewDto {
  @ApiProperty() id!: string;
  @ApiProperty() driverId!: string;
  @ApiProperty() driverName!: string;
  @ApiProperty() startsAt!: string;
  @ApiProperty({ nullable: true, type: String }) endsAt!: string | null;
  @ApiProperty({ description: 'Vrai : en cours (clôturée à l’instant du transfert) ; faux : prévue (retirée, jamais entrée en vigueur).' }) isCurrent!: boolean;
}

export class TransferPlanPreviewDto {
  @ApiProperty() id!: string;
  @ApiProperty() maintenanceTypeLabel!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ nullable: true, type: String }) baseKm!: string | null;
  @ApiProperty({ nullable: true, type: String }) baseDate!: string | null;
  @ApiProperty({ nullable: true, type: String }) nextDueKm!: string | null;
  @ApiProperty({ nullable: true, type: String }) nextDueDate!: string | null;
  @ApiProperty({ nullable: true, type: String }) responsibleUserId!: string | null;
  @ApiProperty() version!: number;
}

export class TransferDocumentPreviewDto {
  @ApiProperty() id!: string;
  @ApiProperty() documentTypeLabel!: string;
  @ApiProperty({ nullable: true, type: String }) number!: string | null;
  @ApiProperty({ nullable: true, type: String }) validFrom!: string | null;
  @ApiProperty({ nullable: true, type: String }) validTo!: string | null;
  @ApiProperty({ description: 'Présélection : version valable ou future au jour local du transfert.' }) suggested!: boolean;
  @ApiProperty({ type: [String] }) sharedWithCompanyIds!: string[];
}

export class TransferMappingPreviewDto {
  @ApiProperty() id!: string;
  @ApiProperty() providerId!: string;
  @ApiProperty() providerName!: string;
  @ApiProperty() unitLabel!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ description: 'Effet du transfert : clôture à la date du transfert (D-124).' }) outcome!: string;
}

export class TransferCompanyOptionDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() legalName!: string;
}

export class TransferLastReadingDto {
  @ApiProperty() readingId!: string;
  @ApiProperty({ nullable: true, type: String }) physicalKm!: string | null;
  @ApiProperty({ nullable: true, type: String }) cumulativeKm!: string | null;
  @ApiProperty() observedAt!: string;
}

/** Société cible dont on veut les responsables de plan éligibles (GET /vehicles/:id/transfer-responsibles). */
export class TransferResponsiblesQueryDto {
  @ApiProperty({ description: 'Société destinataire envisagée (autre société active de l’organisation).' })
  @IsUUID('all', { message: 'Société cible : identifiant invalide.' })
  companyId!: string;
}

export class TransferResponsibleDto {
  @ApiProperty() id!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ type: [String], enum: ['ADMIN', 'CHEF_PARC', 'OPERATEUR'], description: 'Rôles qui rendent le compte éligible (administrateur groupe, ou chef de parc/opérateur de la société cible).' }) roles!: string[];
}

/** Responsables de plan éligibles dans la société cible : même règle que le contrôle du transfert. */
export class TransferResponsiblesDto {
  @ApiProperty() companyId!: string;
  @ApiProperty({ type: [TransferResponsibleDto] }) items!: TransferResponsibleDto[];
}

export class TransferPreviewDto {
  @ApiProperty() vehicleId!: string;
  @ApiProperty() vehicleCode!: string;
  @ApiProperty() registration!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() companyCode!: string;
  @ApiProperty({ description: 'Version du véhicule à renvoyer dans expectedVersion.' }) version!: number;
  @ApiProperty({ description: 'Instant serveur de l’aperçu ; le transfert prend effet à l’heure du serveur lors de sa validation.' }) evaluatedAt!: string;
  @ApiProperty({ description: 'Faux tant qu’un objet bloquant existe.' }) canTransfer!: boolean;
  @ApiProperty({ type: [TransferBlockerDto] }) blockers!: TransferBlockerDto[];
  @ApiProperty({ type: [TransferWarningDto] }) warnings!: TransferWarningDto[];
  @ApiProperty({ type: [TransferAssignmentPreviewDto] }) assignments!: TransferAssignmentPreviewDto[];
  @ApiProperty({ type: [TransferPlanPreviewDto] }) plans!: TransferPlanPreviewDto[];
  @ApiProperty({ type: [TransferDocumentPreviewDto] }) documents!: TransferDocumentPreviewDto[];
  @ApiProperty({ type: [TransferMappingPreviewDto] }) telemetryMappings!: TransferMappingPreviewDto[];
  @ApiProperty({ type: [TransferCompanyOptionDto], description: 'Sociétés actives pouvant recevoir le véhicule.' }) targetCompanies!: TransferCompanyOptionDto[];
  @ApiProperty({ type: TransferLastReadingDto, nullable: true }) lastReading!: TransferLastReadingDto | null;
}

export class TransferResultDto {
  @ApiProperty({ type: VehicleViewDto }) vehicle!: VehicleViewDto;
  @ApiProperty() historyId!: string;
  @ApiProperty() fromCompanyId!: string;
  @ApiProperty() toCompanyId!: string;
  @ApiProperty() effectiveAt!: string;
  @ApiProperty({ nullable: true, type: String }) transferReadingId!: string | null;
  @ApiProperty({ type: [String] }) closedAssignmentIds!: string[];
  @ApiProperty({ type: [String], description: 'Affectations prévues retirées (jamais entrées en vigueur).' }) withdrawnAssignmentIds!: string[];
  @ApiProperty({ nullable: true, type: String }) newAssignmentId!: string | null;
  @ApiProperty({ type: [String] }) keptPlanIds!: string[];
  @ApiProperty({ type: [String] }) deactivatedPlanIds!: string[];
  @ApiProperty({ type: [String] }) sharedDocumentVersionIds!: string[];
  @ApiProperty({ type: [String] }) closedTelemetryMappingIds!: string[];
  @ApiProperty({ type: [String] }) proposedTelemetryMappingIds!: string[];
  @ApiProperty({ nullable: true, type: String, description: 'Fournisseur de contrat de la société d’origine retiré de la fiche (aucune référence vers une autre société).' }) clearedContractSupplierId!: string | null;
  @ApiProperty({ description: 'Alertes actives de la société d’origine résolues (motif transfert).' }) resolvedAlerts!: number;
}
