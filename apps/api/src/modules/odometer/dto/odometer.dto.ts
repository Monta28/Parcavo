import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination.js';

/** Contextes saisissables depuis l'interface (remise/restitution passent par /usages). */
export const MANUAL_READING_CONTEXTS = ['RELEVE_LIBRE', 'CARBURANT', 'ENTRETIEN', 'TRANSFERT'] as const;

export class CreateReadingDto {
  @ApiProperty({ description: 'Valeur physique affichée au tableau de bord (décimal en chaîne, entier par défaut).', example: '89500' })
  @IsNumberString()
  physicalKm!: string;

  @ApiProperty({ description: 'Date/heure d’observation ISO 8601 (non future).' })
  @IsDateString()
  observedAt!: string;

  @ApiPropertyOptional({ enum: MANUAL_READING_CONTEXTS, default: 'RELEVE_LIBRE' })
  @IsOptional()
  @IsIn(MANUAL_READING_CONTEXTS)
  context?: (typeof MANUAL_READING_CONTEXTS)[number];

  @ApiPropertyOptional({ description: 'Segment de compteur concerné (relevé rétroactif sur un compteur remplacé).' })
  @IsOptional()
  @IsUUID()
  odometerSegmentId?: string;

  @ApiPropertyOptional({ description: 'Photo du compteur (pièce jointe téléversée).' })
  @IsOptional()
  @IsUUID()
  attachmentId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class BatchReadingItemDto {
  @ApiProperty({ description: 'Véhicule (une seule ligne par véhicule et par lot).' }) @IsUUID() vehicleId!: string;
  @ApiProperty({ description: 'Valeur physique affichée au tableau de bord (décimal en chaîne).', example: '89500' }) @IsNumberString() physicalKm!: string;
  @ApiProperty({ description: 'Date/heure d’observation ISO 8601 (non future).' }) @IsDateString() observedAt!: string;
  @ApiPropertyOptional({ description: 'Photo du compteur (pièce jointe téléversée), rattachée au relevé comme pour une saisie unitaire.' }) @IsOptional() @IsUUID() attachmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

/**
 * Saisie rapide par parc (10.2, D-265). La clé d'idempotence du lot (en-tête Idempotency-Key ou champ
 * idempotencyKey) est obligatoire : chaque ligne est exécutée sous la clé dérivée « <cléLot>:<vehicleId> ».
 */
export class BatchReadingsDto {
  @ApiProperty({ type: [BatchReadingItemDto], maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BatchReadingItemDto)
  items!: BatchReadingItemDto[];

  @ApiPropertyOptional({ description: 'Clé d’idempotence du lot (sinon en-tête Idempotency-Key).' }) @IsOptional() @IsString() @MaxLength(128) idempotencyKey?: string;
}

export class DecideReadingDto {
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @ApiPropertyOptional({ description: 'Motif (obligatoire pour un rejet).' }) @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class ReplacementReadingDto {
  @ApiProperty() @IsNumberString() physicalKm!: string;
  @ApiPropertyOptional({ description: 'Date d’observation corrigée ; par défaut celle de l’original.' }) @IsOptional() @IsDateString() observedAt?: string;
}

export class CorrectReadingDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiProperty({ type: ReplacementReadingDto }) @ValidateNested() @Type(() => ReplacementReadingDto) replacementReading!: ReplacementReadingDto;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class InitSegmentDto {
  @ApiProperty({ enum: ['INITIAL', 'REPLACEMENT'] }) @IsIn(['INITIAL', 'REPLACEMENT']) mode!: 'INITIAL' | 'REPLACEMENT';
  @ApiProperty({ description: 'Date d’effet (installation ou remplacement).' }) @IsDateString() startedAt!: string;
  @ApiProperty({ description: 'Valeur physique affichée par le compteur (nouveau compteur en cas de remplacement).' }) @IsNumberString() physicalKm!: string;
  @ApiPropertyOptional({ description: 'INITIAL : base cumulée validée si le compteur n’est pas d’origine.' }) @IsOptional() @IsNumberString() cumulativeKm?: string;
  @ApiPropertyOptional({ description: 'INITIAL : faux si l’historique antérieur est inconnu (« cumul incomplet »).' }) @IsOptional() @IsBoolean() cumulativeKnown?: boolean;
  @ApiPropertyOptional({ description: 'REPLACEMENT : dernière valeur lue sur l’ancien compteur (relevé de clôture).' }) @IsOptional() @IsNumberString() oldCounterFinalKm?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(3) @MaxLength(500) reason?: string;
  @ApiPropertyOptional({ description: 'Justificatif du remplacement (pièce jointe).' }) @IsOptional() @IsUUID() justificationAttachmentId?: string;
}

export class ReadingsQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() vehicleId?: string;
  @ApiPropertyOptional({ enum: ['EN_ATTENTE', 'ACCEPTE', 'REJETE', 'REMPLACE'] }) @IsOptional() @IsIn(['EN_ATTENTE', 'ACCEPTE', 'REJETE', 'REMPLACE']) status?: 'EN_ATTENTE' | 'ACCEPTE' | 'REJETE' | 'REMPLACE';
  @ApiPropertyOptional({ enum: ['MANUAL', 'IMPORT', 'TELEMATICS'] }) @IsOptional() @IsIn(['MANUAL', 'IMPORT', 'TELEMATICS']) source?: 'MANUAL' | 'IMPORT' | 'TELEMATICS';
  @ApiPropertyOptional({ enum: ['true', 'false'], description: '« Mes soumissions » : uniquement les relevés dont l’utilisateur courant est l’auteur (implicite pour un compte conducteur).' })
  @IsOptional()
  @IsIn(['true', 'false'], { message: 'Valeur attendue : true ou false.' })
  mine?: 'true' | 'false';

  @ApiPropertyOptional({ format: 'date-time', description: 'Relevés observés à partir de cet instant (inclus).' }) @IsOptional() @IsDateString() observedFrom?: string;
  @ApiPropertyOptional({ format: 'date-time', description: 'Relevés observés jusqu’à cet instant (inclus).' }) @IsOptional() @IsDateString() observedTo?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Soumissions d’un conducteur (fiche conducteur, CDC 3.3) : relevés saisis par le compte utilisateur lié à sa fiche, dans le périmètre de l’appelant ; conducteur hors périmètre : 404 ; fiche sans compte : liste vide.' })
  @IsOptional()
  @IsUUID()
  driverId?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc', description: 'Ordre de la date d’observation (le plus récent d’abord par défaut).' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  override order: 'asc' | 'desc' = 'desc';
}

export class ReadingViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() vehicleId!: string;
  @ApiProperty() vehicleCode!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() segmentId!: string;
  @ApiProperty() segmentSequence!: number;
  @ApiProperty({ enum: ['MANUAL', 'IMPORT', 'TELEMATICS'] }) source!: string;
  @ApiProperty() context!: string;
  @ApiProperty({ enum: ['COMPTEUR_AFFICHE', 'COMPTEUR_CAN', 'DISTANCE_GPS'] }) measurementKind!: string;
  @ApiProperty({ enum: ['EN_ATTENTE', 'ACCEPTE', 'REJETE', 'REMPLACE'] }) status!: string;
  @ApiProperty({ nullable: true, type: String }) physicalKm!: string | null;
  @ApiProperty({ nullable: true, type: String }) cumulativeKm!: string | null;
  @ApiProperty() isEstimate!: boolean;
  @ApiProperty({ nullable: true, type: String }) gpsDistanceKm!: string | null;
  @ApiProperty() observedAt!: string;
  @ApiProperty() enteredAt!: string;
  @ApiProperty({ nullable: true, type: String }) statusReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) anomalyCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) attachmentId!: string | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty({ nullable: true, type: String }) replacesReadingId!: string | null;
  @ApiProperty({ nullable: true, type: String }) replacedByReadingId!: string | null;
  @ApiProperty({ nullable: true, type: String }) correctionReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) authorName!: string | null;
  @ApiProperty({ nullable: true, type: String }) decidedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) decisionReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) channel!: string | null;
  @ApiProperty() version!: number;
}

export class SegmentViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() sequence!: number;
  @ApiProperty() startedAt!: string;
  @ApiProperty({ nullable: true, type: String }) endedAt!: string | null;
  @ApiProperty() startPhysicalKm!: string;
  @ApiProperty() startCumulativeKm!: string;
  @ApiProperty() cumulativeKnown!: boolean;
  @ApiProperty({ nullable: true, type: String }) lastPhysicalKm!: string | null;
  @ApiProperty({ nullable: true, type: String }) replacementReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) justificationAttachmentId!: string | null;
}

/** Dernière valeur télématique reçue : aide à la saisie, jamais enregistrée à la place du compteur lu. */
export class TelematicsHintDto {
  @ApiProperty({ type: String, description: 'Kilométrage à 3 décimales (chaîne décimale).' }) valueKm!: string;
  @ApiProperty({ type: String, description: 'Nature de la valeur (compteur CAN, odomètre GPS…).' }) kind!: string;
  @ApiProperty({ type: String, format: 'date-time' }) observedAt!: string;
}

export class ReadingAnomalyDto {
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) reason!: string;
}

export class CurrentOdometerDto {
  @ApiProperty({ nullable: true, type: ReadingViewDto }) reading!: ReadingViewDto | null;
  @ApiProperty({ enum: ['INCONNU', 'A_ACTUALISER', 'A_JOUR'] }) freshness!: string;
  @ApiProperty({ nullable: true, type: Number }) ageDays!: number | null;
  @ApiProperty() cumulativeKnown!: boolean;
  @ApiProperty({ nullable: true, type: String }) openSegmentId!: string | null;
  @ApiProperty() pendingCount!: number;
  @ApiProperty({ type: TelematicsHintDto, nullable: true, description: 'Dernière valeur automatique reçue (aide à la saisie, jamais enregistrée à la place du compteur lu).' })
  lastTelematicsHint!: TelematicsHintDto | null;
}

export class IngestResultDto {
  @ApiProperty({ type: ReadingViewDto }) reading!: ReadingViewDto;
  @ApiProperty({ enum: ['ACCEPTE', 'EN_ATTENTE', 'IDEMPOTENT'] }) outcome!: string;
  @ApiProperty({ type: ReadingAnomalyDto, nullable: true }) anomaly!: ReadingAnomalyDto | null;
}

export class BatchResultItemDto {
  @ApiProperty() vehicleId!: string;
  @ApiProperty({ enum: ['ACCEPTE', 'EN_ATTENTE', 'IDEMPOTENT', 'REFUSE'] }) outcome!: string;
  @ApiProperty({ nullable: true, type: String }) readingId!: string | null;
  @ApiProperty({ nullable: true, type: String }) code!: string | null;
  @ApiProperty({ nullable: true, type: String }) message!: string | null;
}
