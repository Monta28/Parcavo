import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { PAGINATION } from '@parc-auto/contracts';
import { PageMetaDto } from '../../../common/pagination.js';

/** Catégories de la chronologie (filtre de l'onglet Historique). */
export const TIMELINE_CATEGORIES = [
  'DOSSIER',
  'UTILISATIONS',
  'KILOMETRAGE',
  'ENTRETIEN',
  'DOCUMENTS',
  'INCIDENTS',
  'IMMOBILISATIONS',
  'RESERVATIONS',
  'AFFECTATIONS',
] as const;
export type TimelineCategory = (typeof TIMELINE_CATEGORIES)[number];

export const TIMELINE_CATEGORY_LABELS: Readonly<Record<TimelineCategory, string>> = {
  DOSSIER: 'Dossier et société',
  UTILISATIONS: 'Utilisations',
  KILOMETRAGE: 'Kilométrage',
  ENTRETIEN: 'Entretien',
  DOCUMENTS: 'Documents',
  INCIDENTS: 'Incidents',
  IMMOBILISATIONS: 'Immobilisations',
  RESERVATIONS: 'Réservations',
  AFFECTATIONS: 'Affectations habituelles',
};

/** Types d'événements, dans l'ordre chronologique naturel à instant égal (rang). */
export const TIMELINE_EVENT_TYPES = [
  'VEHICULE_CREE',
  'SOCIETE_TRANSFERT',
  'AFFECTATION_DEBUT',
  'RESERVATION_CREEE',
  'COMPTEUR_INITIALISE',
  'COMPTEUR_REMPLACE',
  'RELEVE',
  'UTILISATION_REMISE',
  'UTILISATION_RETOUR',
  'INCIDENT_DECLARE',
  'IMMOBILISATION_DEBUT',
  'PLAN_CREE',
  'INTERVENTION_CREEE',
  'INTERVENTION_TERMINEE',
  'INTERVENTION_ROUVERTE',
  'INTERVENTION_ANNULEE',
  'PLAN_DESACTIVE',
  'DOCUMENT_ENREGISTRE',
  'DOCUMENT_RENOUVELE',
  'INCIDENT_RESOLU',
  'INCIDENT_CLOTURE',
  'IMMOBILISATION_FIN',
  'RESERVATION_ANNULEE',
  'RESERVATION_NON_HONOREE',
  'AFFECTATION_FIN',
] as const;
export type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];

export const TIMELINE_DETAIL_KINDS = ['TEXTE', 'KM', 'MONTANT', 'DATE', 'DATE_HEURE'] as const;
export type TimelineDetailKind = (typeof TIMELINE_DETAIL_KINDS)[number];

export const TIMELINE_ACCESS = ['COMPLET', 'TECHNIQUE'] as const;
export type TimelineAccessValue = (typeof TIMELINE_ACCESS)[number];

export class TimelineQueryDto {
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

  @ApiPropertyOptional({
    enum: TIMELINE_CATEGORIES,
    description: 'Restreint la chronologie à une catégorie.',
  })
  @IsOptional()
  @IsIn(TIMELINE_CATEGORIES, { message: 'Catégorie inconnue.' })
  category?: TimelineCategory;

  @ApiPropertyOptional({
    enum: ['asc', 'desc'],
    default: 'desc',
    description: 'Ordre chronologique (plus récent d’abord par défaut).',
  })
  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'Valeur attendue : asc ou desc.' })
  order: 'asc' | 'desc' = 'desc';
}

export class TimelineDetailDto {
  @ApiProperty({ example: 'Conducteur' }) label!: string;
  @ApiProperty({
    description:
      'Valeur brute : texte, kilométrage ou montant décimal exact (chaîne), date AAAA-MM-JJ ou horodatage ISO UTC.',
  })
  value!: string;
  @ApiProperty({
    enum: TIMELINE_DETAIL_KINDS,
    description: 'Nature de la valeur, pour son affichage (le serveur ne formate pas).',
  })
  kind!: TimelineDetailKind;
}

export class TimelineEventDto {
  @ApiProperty({ description: 'Identifiant stable de l’événement (type:objet).' }) id!: string;
  @ApiProperty({ enum: TIMELINE_EVENT_TYPES }) type!: TimelineEventType;
  @ApiProperty({ enum: TIMELINE_CATEGORIES }) category!: TimelineCategory;
  @ApiProperty() categoryLabel!: string;
  @ApiProperty({ format: 'date-time', description: 'Horodatage UTC de l’événement.' })
  occurredAt!: string;
  @ApiProperty({ example: 'Remise du véhicule' }) title!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Société historique de l’objet (null si l’objet n’en porte pas).',
  })
  companyId!: string | null;
  @ApiProperty({ nullable: true, type: String }) companyCode!: string | null;
  @ApiProperty({
    enum: TIMELINE_ACCESS,
    description:
      'COMPLET : objet de vos sociétés ; TECHNIQUE : objet d’une autre société montré en vue technique (D-275), sans auteur, texte libre, montant ni fournisseur.',
  })
  access!: TimelineAccessValue;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Auteur : nom, « Utilisateur d’une autre société », « Connecteur télématique », ou null si inconnu.',
  })
  actorName!: string | null;
  @ApiProperty({ example: 'VehicleUsage', description: 'Type de l’objet source.' })
  objectType!: string;
  @ApiProperty() objectId!: string;
  @ApiProperty({
    description: 'Vrai si l’objet source est consultable par le lecteur (fiche détaillée).',
  })
  objectAccessible!: boolean;
  @ApiProperty({ type: [TimelineDetailDto] }) details!: TimelineDetailDto[];
}

export class TimelinePageDto extends PageMetaDto {
  @ApiProperty({ type: [TimelineEventDto] }) items!: TimelineEventDto[];
}
