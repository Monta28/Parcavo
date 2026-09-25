import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PAGINATION } from '@parc-auto/contracts';
import { PageMetaDto } from '../../../common/pagination.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = 'Date attendue au format AAAA-MM-JJ.';
export const ACTOR_TYPES = ['UTILISATEUR', 'SYSTEME'] as const;
export type ActorTypeValue = (typeof ACTOR_TYPES)[number];

/** Libellé de l'acteur d'un événement système ou sans utilisateur. */
export const SYSTEM_ACTOR_LABEL = 'Système';

/** Filtres communs du journal (période, société) : liste et listes de valeurs des filtres. */
export class AuditScopeQueryDto {
  @ApiPropertyOptional({
    format: 'date',
    description: 'Début de période (date civile incluse, fuseau de l’organisation).',
  })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  from?: string;

  @ApiPropertyOptional({
    format: 'date',
    description: 'Fin de période (date civile incluse, fuseau de l’organisation).',
  })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  to?: string;

  @ApiPropertyOptional({
    description:
      'Société (recoupée avec les habilitations : hors périmètre 404, société sans rôle de chef 403).',
  })
  @IsOptional()
  @IsUUID('all', { message: 'Identifiant de société invalide.' })
  companyId?: string;
}

/** Filtres de GET /audit (CDC 16.1 ; D-109). Tri imposé : date décroissante. */
export class AuditQueryDto extends AuditScopeQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Un entier est attendu.' })
  @Min(1, { message: 'La page commence à 1.' })
  page: number = 1;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: PAGINATION.maxPageSize,
    default: PAGINATION.defaultPageSize,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Un entier est attendu.' })
  @Min(1, { message: 'Au moins une ligne par page.' })
  @Max(PAGINATION.maxPageSize, { message: `Au plus ${PAGINATION.maxPageSize} lignes par page.` })
  pageSize: number = PAGINATION.defaultPageSize;

  @ApiPropertyOptional({ description: 'Utilisateur auteur de l’action.' })
  @IsOptional()
  @IsUUID('all', { message: 'Identifiant d’utilisateur invalide.' })
  actorUserId?: string;

  @ApiPropertyOptional({
    enum: ACTOR_TYPES,
    description: 'Nature de l’acteur : utilisateur ou traitement système.',
  })
  @IsOptional()
  @IsIn(ACTOR_TYPES, { message: 'Valeur attendue : UTILISATEUR ou SYSTEME.' })
  actorType?: ActorTypeValue;

  @ApiPropertyOptional({
    description: 'Action ou préfixe d’action (ex. « releve. » ou « releve.correction »).',
    example: 'releve.',
  })
  @IsOptional()
  @IsString({ message: 'Une chaîne de caractères est attendue.' })
  @MinLength(1, { message: 'Préfixe d’action vide.' })
  @MaxLength(100, { message: 'Préfixe d’action trop long (100 caractères au plus).' })
  @Matches(/^[a-z0-9_.]+$/i, {
    message: 'Préfixe d’action invalide : lettres, chiffres, « _ » et « . » uniquement.',
  })
  action?: string;

  @ApiPropertyOptional({ description: 'Type d’objet exact (ex. OdometerReading, Vehicle).' })
  @IsOptional()
  @IsString({ message: 'Une chaîne de caractères est attendue.' })
  @MaxLength(100, { message: 'Type d’objet trop long (100 caractères au plus).' })
  objectType?: string;

  @ApiPropertyOptional({ description: 'Identifiant exact de l’objet.' })
  @IsOptional()
  @IsString({ message: 'Une chaîne de caractères est attendue.' })
  @MaxLength(200, { message: 'Identifiant d’objet trop long (200 caractères au plus).' })
  objectId?: string;
}

export class AuditEventViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ format: 'date-time', description: 'Horodatage UTC de l’événement.' })
  createdAt!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Société concernée ; null pour un événement de niveau organisation (administrateur seulement).',
  })
  companyId!: string | null;
  @ApiProperty({ nullable: true, type: String }) companyCode!: string | null;
  @ApiProperty({ enum: ACTOR_TYPES }) actorType!: ActorTypeValue;
  @ApiProperty({ nullable: true, type: String }) actorUserId!: string | null;
  @ApiProperty({ description: 'Nom de l’utilisateur auteur, ou « Système ».' }) actorName!: string;
  @ApiProperty({ example: 'releve.correction' }) action!: string;
  @ApiProperty({ example: 'OdometerReading' }) objectType!: string;
  @ApiProperty({ nullable: true, type: String }) objectId!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Motif saisi (assaini).' }) reason!:
    string | null;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      'Valeurs avant, expurgées (aucun mot de passe, jeton, empreinte ni clé) ; montants masqués sans costs.read sur la société de l’événement.',
  })
  before!: unknown;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description: 'Valeurs après, expurgées ; montants masqués sans costs.read.',
  })
  after!: unknown;
  @ApiProperty({ nullable: true, type: String }) requestId!: string | null;
  @ApiProperty({ nullable: true, type: String }) ipAddress!: string | null;
}

export class AuditPageDto extends PageMetaDto {
  @ApiProperty({ type: [AuditEventViewDto] }) items!: AuditEventViewDto[];
}

export class AuditActionFacetDto {
  @ApiProperty({ example: 'releve.correction' }) action!: string;
  @ApiProperty({ description: 'Nombre d’événements visibles.' }) count!: number;
}

export class AuditObjectTypeFacetDto {
  @ApiProperty({ example: 'OdometerReading' }) objectType!: string;
  @ApiProperty() count!: number;
}

export class AuditActorFacetDto {
  @ApiProperty({ enum: ACTOR_TYPES }) actorType!: ActorTypeValue;
  @ApiProperty({ nullable: true, type: String }) actorUserId!: string | null;
  @ApiProperty({ description: 'Nom de l’utilisateur, ou « Système ».' }) actorName!: string;
  @ApiProperty() count!: number;
}
