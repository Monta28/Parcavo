import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { IncidentSeverity } from '@parc-auto/db';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
  isUUID,
  registerDecorator,
  type ValidationArguments,
} from 'class-validator';
import { PageQueryDto } from '../../../common/pagination.js';
import { TelematicsHintDto } from '../../odometer/dto/odometer.dto.js';

const GAUGES = ['VIDE', 'QUART', 'DEMI', 'TROIS_QUARTS', 'PLEIN'] as const;
const SEVERITIES = ['FAIBLE', 'MOYENNE', 'ELEVEE', 'CRITIQUE'] as const satisfies readonly IncidentSeverity[];

/** Espaces de début et de fin retirés avant validation (un texte vide ou blanc est refusé). */
const trimmed = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
const present = (value: unknown): boolean => value !== undefined && value !== null;

/** Lieu (D-134) : un site OU un lieu libre, exclusivement ; identifiant de site bien formé. */
function locationProblem(object: object): string | null {
  const { siteId, placeLabel } = object as { siteId?: unknown; placeLabel?: unknown };
  if (!present(siteId) && !present(placeLabel)) return 'Indiquez le lieu : un site ou un lieu libre.';
  if (present(siteId) && present(placeLabel)) return 'Indiquez soit un site, soit un lieu libre, pas les deux.';
  if (present(siteId) && !(typeof siteId === 'string' && isUUID(siteId))) return 'Un identifiant de site valide est attendu.';
  return null;
}

function SiteXorPlace(): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'siteOuLieuExclusif',
      target: target.constructor,
      propertyName: String(propertyName),
      validator: {
        validate: (_value: unknown, args: ValidationArguments) => locationProblem(args.object) === null,
        defaultMessage: (args: ValidationArguments) => locationProblem(args.object) ?? 'Lieu invalide.',
      },
    });
  };
}

export class UsageReadingDto {
  @ApiProperty({ description: 'Valeur lue sur le tableau de bord (jamais inventée).' }) @IsNumberString() physicalKm!: string;
  @ApiPropertyOptional({ description: 'Photo du compteur.' }) @IsOptional() @IsUUID() attachmentId?: string;
}

export class UsageExceptionDto {
  @ApiProperty({ description: 'Motif de l’exception (chef ou administrateur).' }) @IsString() @MinLength(5) @MaxLength(500) reason!: string;
}

/**
 * Lieu de remise ou de restitution (CDC 4.3, 4.4 ; D-134), obligatoire : soit un site actif de la société
 * du véhicule (vérifié par le serveur), soit un lieu libre de 1 à 200 caractères, exclusivement.
 */
export class UsageLocationDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Site actif de la société du véhicule (exclusif de placeLabel).' })
  @SiteXorPlace()
  siteId?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 200, description: 'Lieu libre (exclusif de siteId).' })
  @Transform(trimmed)
  @ValidateIf((o: UsageLocationDto) => present(o.placeLabel))
  @IsString()
  @MinLength(1, { message: 'Le lieu libre ne peut pas être vide.' })
  @MaxLength(200, { message: 'Le lieu libre ne peut pas dépasser 200 caractères.' })
  placeLabel?: string;
}

/** Dommage constaté à la restitution (CDC 4.4) : ouvre un incident DOMMAGE que le retour ne clôture pas. */
export class DamageIncidentDto {
  @ApiProperty({ minLength: 1, maxLength: 4000, description: 'Description du dommage constaté.' })
  @Transform(trimmed)
  @IsString()
  @IsNotEmpty({ message: 'Décrivez le dommage constaté.' })
  @MaxLength(4000)
  description!: string;

  @ApiPropertyOptional({ enum: SEVERITIES, default: 'MOYENNE' }) @IsOptional() @IsIn(SEVERITIES) severity?: (typeof SEVERITIES)[number];
  @ApiPropertyOptional({ type: [String], description: 'Photos du dommage, rattachées à l’incident.' }) @IsOptional() @IsArray() @ArrayMaxSize(10) @IsUUID('all', { each: true }) photoAttachmentIds?: string[];
}

/** Prolongation du retour prévu (D-135) : motif obligatoire, version attendue. */
export class ExtendUsageDto {
  @ApiProperty({ format: 'date-time', description: 'Nouveau retour prévu.' }) @IsDateString() expectedReturnAt!: string;
  @ApiProperty({ minLength: 3, maxLength: 500 }) @Transform(trimmed) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class ChecklistItemDto {
  @ApiProperty() @IsString() @MaxLength(80) label!: string;
  @ApiProperty() @IsBoolean() present!: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) comment?: string;
}

export class CheckoutDto {
  @ApiProperty() @IsUUID() vehicleId!: string;
  @ApiProperty() @IsUUID() driverId!: string;
  @ApiProperty({ description: 'Date/heure réelle de la remise.' }) @IsDateString() checkedOutAt!: string;
  @ApiProperty() @IsDateString() expectedReturnAt!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(300) purpose!: string;
  @ApiPropertyOptional({ description: 'Réservation à convertir (même véhicule et conducteur, départ dans [début − reservations.conversionEarlyMinutes, fin[). Absente : la réservation CONFIRMEE du même couple dont la fenêtre contient le départ est convertie.' }) @IsOptional() @IsUUID() reservationId?: string;
  @ApiPropertyOptional({ type: UsageReadingDto }) @IsOptional() @ValidateNested() @Type(() => UsageReadingDto) reading?: UsageReadingDto;
  @ApiPropertyOptional({ type: UsageExceptionDto, description: 'Départ sans relevé : exception motivée (chef/admin).' }) @IsOptional() @ValidateNested() @Type(() => UsageExceptionDto) readingException?: UsageExceptionDto;
  @ApiPropertyOptional({ description: 'Dérogation motivée aux blocages documentaires ou de permis (exceptions.override).' }) @IsOptional() @IsString() @MinLength(5) @MaxLength(500) overrideReason?: string;
  @ApiProperty({ type: UsageLocationDto, description: 'Lieu de remise (obligatoire, D-134).' })
  @IsDefined({ message: 'Le lieu de remise est obligatoire.' })
  @ValidateNested({ message: 'Le lieu doit préciser un site ou un lieu libre.' })
  @Type(() => UsageLocationDto)
  location!: UsageLocationDto;
  @ApiPropertyOptional({ enum: GAUGES }) @IsOptional() @IsIn(GAUGES) fuelGauge?: (typeof GAUGES)[number];
  @ApiPropertyOptional({ type: [ChecklistItemDto] }) @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => ChecklistItemDto) checklist?: ChecklistItemDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @ApiPropertyOptional({ description: 'Confirmation nominative (non certifiée).' }) @IsOptional() @IsString() @MaxLength(150) confirmedByName?: string;
  @ApiPropertyOptional({ type: [String], description: 'Photos téléversées.' }) @IsOptional() @IsArray() @ArrayMaxSize(10) @IsUUID('all', { each: true }) photoAttachmentIds?: string[];
  @ApiPropertyOptional({ description: 'Clé d’idempotence (sinon en-tête Idempotency-Key).' }) @IsOptional() @IsString() @MaxLength(128) idempotencyKey?: string;
}

export class ReturnDto {
  @ApiProperty() @IsDateString() returnedAt!: string;
  @ApiPropertyOptional({ type: UsageReadingDto }) @IsOptional() @ValidateNested() @Type(() => UsageReadingDto) reading?: UsageReadingDto;
  @ApiPropertyOptional({ type: UsageExceptionDto, description: 'Retour constaté sans relevé valide (chef/admin) : distance non validée.' }) @IsOptional() @ValidateNested() @Type(() => UsageExceptionDto) readingException?: UsageExceptionDto;
  @ApiProperty({ type: UsageLocationDto, description: 'Lieu de restitution (obligatoire, D-134).' })
  @IsDefined({ message: 'Le lieu de restitution est obligatoire.' })
  @ValidateNested({ message: 'Le lieu doit préciser un site ou un lieu libre.' })
  @Type(() => UsageLocationDto)
  location!: UsageLocationDto;
  @ApiPropertyOptional({ enum: GAUGES }) @IsOptional() @IsIn(GAUGES) fuelGauge?: (typeof GAUGES)[number];
  @ApiPropertyOptional({ type: [ChecklistItemDto] }) @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => ChecklistItemDto) checklist?: ChecklistItemDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(150) confirmedByName?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(10) @IsUUID('all', { each: true }) photoAttachmentIds?: string[];
  @ApiPropertyOptional({ type: DamageIncidentDto, description: 'Dommage constaté : ouvre un incident DOMMAGE (non clôturé par le retour).' })
  @IsOptional()
  @ValidateNested({ message: 'Le dommage doit préciser au moins une description.' })
  @Type(() => DamageIncidentDto)
  damageIncident?: DamageIncidentDto;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(128) idempotencyKey?: string;
}

/** Nouveau relevé du retour saisi a posteriori (photo retrouvée, compteur relu) : même contrôle que tout relevé. */
export class RegularizationReadingDto {
  @ApiProperty({ description: 'Valeur lue sur le tableau de bord au retour (jamais inventée).' }) @IsNumberString() physicalKm!: string;
  @ApiPropertyOptional({ format: 'date-time', description: 'Instant d’observation : par défaut l’heure du retour ; sinon entre le retour et la remise suivante du véhicule (le véhicule n’a pas roulé entre-temps).' })
  @IsOptional()
  @IsDateString()
  observedAt?: string;
  @ApiPropertyOptional({ description: 'Photo du compteur.' }) @IsOptional() @IsUUID() attachmentId?: string;
}

/**
 * Régularisation du relevé de retour (CDC 4.4) après un retour constaté sans relevé ou avec un relevé rejeté :
 * soit un nouveau relevé (reading), soit un relevé déjà accepté du véhicule (readingId), exclusivement.
 */
export class RegularizeReturnReadingDto {
  @ApiPropertyOptional({ type: RegularizationReadingDto }) @IsOptional() @ValidateNested() @Type(() => RegularizationReadingDto) reading?: RegularizationReadingDto;
  @ApiPropertyOptional({ format: 'uuid', description: 'Relevé accepté du véhicule (hors estimation GPS), observé entre le retour et la remise suivante, rattaché à aucune autre utilisation.' })
  @IsOptional()
  @IsUUID()
  readingId?: string;
  @ApiProperty({ minLength: 5, maxLength: 500, description: 'Motif de la régularisation (journalisé).' }) @Transform(trimmed) @IsString() @MinLength(5) @MaxLength(500) reason!: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(128) idempotencyKey?: string;
}

export class UsagesQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() companyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() vehicleId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() driverId?: string;
  @ApiPropertyOptional({ enum: ['EN_COURS', 'TERMINEE'] }) @IsOptional() @IsIn(['EN_COURS', 'TERMINEE']) status?: 'EN_COURS' | 'TERMINEE';
  @ApiPropertyOptional({ description: 'Uniquement les retours dépassés : même règle et même tolérance (usage.lateReturnToleranceMinutes) que isLate et l’alerte RETOUR_DEPASSE.' }) @IsOptional() @IsIn(['true', 'false']) late?: 'true' | 'false';
  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'Retours attendus : utilisations en cours dont le retour prévu tombe au plus tard à la fin de la journée locale (retards compris).' })
  @IsOptional()
  @IsIn(['true', 'false'], { message: 'Valeur attendue : true ou false.' })
  returnDue?: 'true' | 'false';
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;
}

/** Référence d'un incident rattaché (identifiant et référence métier INC-AAAA-NNNNNN). */
export class UsageIncidentRefDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'INC-2026-000001' }) reference!: string;
}

/** Relevé de remise ou de restitution rattaché à l'utilisation. */
export class UsageReadingRefDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Compteur affiché à 3 décimales (chaîne décimale).' }) physicalKm!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Kilométrage cumulé à 3 décimales (chaîne décimale).' }) cumulativeKm!: string | null;
  @ApiProperty({ type: String }) status!: string;
  @ApiProperty({ type: String, format: 'date-time' }) observedAt!: string;
}

export class UsageViewDto {
  @ApiProperty() id!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() vehicleId!: string;
  @ApiProperty() vehicleCode!: string;
  @ApiProperty() vehicleRegistration!: string;
  @ApiProperty() driverId!: string;
  @ApiProperty() driverName!: string;
  @ApiProperty({ enum: ['EN_COURS', 'TERMINEE'] }) status!: string;
  @ApiProperty() purpose!: string;
  @ApiProperty() checkedOutAt!: string;
  @ApiProperty() expectedReturnAt!: string;
  @ApiProperty({ nullable: true, type: String }) returnedAt!: string | null;
  @ApiProperty({ description: 'Retour dépassé, tolérance usage.lateReturnToleranceMinutes comprise (même règle que l’alerte RETOUR_DEPASSE).' }) isLate!: boolean;
  @ApiProperty({ type: UsageReadingRefDto, nullable: true }) checkoutReading!: UsageReadingRefDto | null;
  @ApiProperty({ type: UsageReadingRefDto, nullable: true }) returnReading!: UsageReadingRefDto | null;
  @ApiProperty() checkoutWithoutReading!: boolean;
  @ApiProperty({ nullable: true, type: String }) checkoutExceptionReason!: string | null;
  @ApiProperty() returnWithoutReading!: boolean;
  @ApiProperty({ nullable: true, type: String }) returnExceptionReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) documentOverrideReason!: string | null;
  @ApiProperty({ enum: ['VALIDEE', 'NON_VALIDEE', 'INDETERMINEE'] }) distanceStatus!: string;
  @ApiProperty({ nullable: true, type: String }) distanceKm!: string | null;
  @ApiProperty({ nullable: true, type: String }) checkoutFuelGauge!: string | null;
  @ApiProperty({ nullable: true, type: String }) returnFuelGauge!: string | null;
  @ApiProperty({ type: [ChecklistItemDto], nullable: true, description: 'Checklist enregistrée à la remise.' }) checkoutChecklist!: unknown;
  @ApiProperty({ type: [ChecklistItemDto], nullable: true, description: 'Checklist enregistrée à la restitution (null tant que l’utilisation est en cours).' }) returnChecklist!: unknown;
  @ApiProperty({ nullable: true, type: String }) checkoutNotes!: string | null;
  @ApiProperty({ nullable: true, type: String }) returnNotes!: string | null;
  @ApiProperty({ nullable: true, type: String }) checkoutConfirmedBy!: string | null;
  @ApiProperty({ nullable: true, type: String }) returnConfirmedBy!: string | null;
  @ApiProperty({ nullable: true, type: String }) reservationId!: string | null;
  @ApiProperty({ nullable: true, type: String }) checkoutLocation!: string | null;
  @ApiProperty({ nullable: true, type: String }) returnLocation!: string | null;
  @ApiProperty({ type: UsageIncidentRefDto, nullable: true, description: 'Incident de dommage ouvert lors de la restitution (4.4) ; le retour ne le clôture pas.' }) damageIncident!: UsageIncidentRefDto | null;
  @ApiProperty({ description: 'Vrai si la distance non validée peut être régularisée par POST /usages/:id/return-reading : utilisation restituée, relevé de départ accepté, retour sans relevé ou avec un relevé rejeté (règle serveur ; la permission exceptions.override est contrôlée à l’appel).' })
  returnReadingRegularizable!: boolean;
  @ApiProperty({ type: [String] }) photoAttachmentIds!: string[];
  @ApiProperty({ nullable: true, type: String }) checkedOutByName!: string | null;
  @ApiProperty({ nullable: true, type: String }) returnedByName!: string | null;
  @ApiProperty() version!: number;
}

export class CheckoutBlockerDto {
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) message!: string;
  @ApiProperty({ type: Boolean, description: 'Dérogeable avec la permission exceptions.override et un motif.' }) overridable!: boolean;
}

export class LastAcceptedReadingDto {
  @ApiProperty({ type: String, nullable: true, description: 'Compteur affiché à 3 décimales (chaîne décimale).' }) physicalKm!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) observedAt!: string;
}

export class ConflictingReservationDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, format: 'date-time' }) startAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) endAt!: string;
  @ApiProperty({ type: String }) driverName!: string;
}

export class CheckoutPreviewDto {
  @ApiProperty({ type: [CheckoutBlockerDto] }) blockers!: CheckoutBlockerDto[];
  @ApiProperty({ type: LastAcceptedReadingDto, nullable: true, description: 'Dernier compteur accepté (aide) et dernière valeur télématique (aide, jamais enregistrée à la place de la lecture).' })
  lastReading!: LastAcceptedReadingDto | null;
  @ApiProperty({ type: TelematicsHintDto, nullable: true }) telematicsHint!: TelematicsHintDto | null;
  @ApiProperty({ type: [String] }) checklistItems!: string[];
  @ApiProperty({ type: [ConflictingReservationDto] }) conflictingReservations!: ConflictingReservationDto[];
}
