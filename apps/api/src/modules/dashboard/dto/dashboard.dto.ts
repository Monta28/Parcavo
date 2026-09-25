import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = 'Date attendue au format AAAA-MM-JJ.';

export const INDICATOR_KINDS = ['ETAT', 'FLUX'] as const;
export type IndicatorKind = (typeof INDICATOR_KINDS)[number];
export const INDICATOR_GROUPS = ['parc', 'entretiens', 'documents', 'kilometrage', 'utilisations', 'interventions', 'couts', 'alertes'] as const;
export type IndicatorGroup = (typeof INDICATOR_GROUPS)[number];

export class DashboardQueryDto {
  @ApiPropertyOptional({ description: 'Société du périmètre ; absent : toutes les sociétés du périmètre (consolidation). Hors périmètre : 404.' })
  @IsOptional()
  @IsUUID('all', { message: 'Identifiant de société invalide.' })
  companyId?: string;

  @ApiPropertyOptional({ description: 'Véhicule du périmètre (11.1 « par véhicule ») : tous les indicateurs et leurs listes justificatives sont restreints à ce véhicule. Hors périmètre ou hors de la société demandée : 404.' })
  @IsOptional()
  @IsUUID('all', { message: 'Identifiant de véhicule invalide.' })
  vehicleId?: string;

  @ApiPropertyOptional({ format: 'date', description: 'Début de la période des flux (date civile incluse). Avec « to », ou aucun des deux : mois civil local en cours.' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  from?: string;

  @ApiPropertyOptional({ format: 'date', description: 'Fin de la période des flux (date civile incluse).' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  to?: string;
}

export class IndicatorPeriodDto {
  @ApiProperty({ format: 'date' }) from!: string;
  @ApiProperty({ format: 'date' }) to!: string;
}

export class IndicatorDenominatorDto {
  @ApiProperty({ description: 'Clé de l’indicateur servant de dénominateur.' }) key!: string;
  @ApiProperty() label!: string;
  @ApiProperty() value!: number;
}

export class IndicatorLinkDto {
  @ApiProperty({ description: 'Chemin de la liste (route de l’API ou écran web).' }) path!: string;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' }, description: 'Paramètres de la liste, identiques à ceux du calcul.' }) query!: Record<string, string>;
}

export class IndicatorJustificationDto extends IndicatorLinkDto {
  @ApiProperty({ description: 'Champ de la réponse de la liste égal à la valeur : « total » (nombre de lignes) ou « operating.net » (montant du registre).' }) field!: string;
  @ApiProperty({ type: IndicatorLinkDto, nullable: true, description: 'Écran web qui affiche la même liste filtrée (paramètres d’URL de l’écran) ; null si l’écran ne propose pas ce filtre.' })
  screen!: IndicatorLinkDto | null;
}

export class IndicatorDto {
  @ApiProperty({ example: 'vehicles.available' }) key!: string;
  @ApiProperty({ example: 'Disponibles' }) label!: string;
  @ApiProperty({ description: 'Définition du calcul (aucun indicateur opaque).' }) definition!: string;
  @ApiProperty({ enum: INDICATOR_GROUPS }) group!: IndicatorGroup;
  @ApiProperty({ enum: INDICATOR_KINDS, description: 'ETAT : instantané horodaté (asOf) ; FLUX : période civile incluse (period).' }) kind!: IndicatorKind;
  @ApiProperty({ description: 'Nombre entier, ou montant exact en chaîne décimale lorsque l’unité est une devise.', oneOf: [{ type: 'integer' }, { type: 'string' }] })
  value!: number | string;
  @ApiProperty({ example: 'vehicules', description: 'vehicules, plans, documents, utilisations, interventions, alertes, ou code devise (montant).' }) unit!: string;
  @ApiProperty({ type: IndicatorDenominatorDto, nullable: true }) denominator!: IndicatorDenominatorDto | null;
  @ApiProperty({ nullable: true, type: String, description: 'Indicateur dont celui-ci est un sous-ensemble (« dont … »).' }) parentKey!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time', description: 'Instant de l’état (UTC).' }) asOf!: string | null;
  @ApiProperty({ type: IndicatorPeriodDto, nullable: true }) period!: IndicatorPeriodDto | null;
  @ApiProperty({ type: IndicatorJustificationDto }) justification!: IndicatorJustificationDto;
}

export class OmittedIndicatorDto {
  @ApiProperty() key!: string;
  @ApiProperty() label!: string;
  @ApiProperty() reason!: string;
}

export class DashboardDto {
  @ApiProperty({ format: 'date-time', description: 'Instant du calcul (UTC) : horodatage des états.' }) asOf!: string;
  @ApiProperty({ example: 'Africa/Tunis' }) timezone!: string;
  @ApiProperty({ format: 'date', description: 'Jour local du calcul.' }) today!: string;
  @ApiProperty({ type: IndicatorPeriodDto, description: 'Période des flux (dates civiles incluses).' }) period!: IndicatorPeriodDto;
  @ApiProperty({ description: 'Vrai si la période est le mois civil local par défaut.' }) periodIsDefault!: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'Société filtrée, ou null pour toutes les sociétés du périmètre.' }) companyId!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Véhicule filtré, ou null pour tous les véhicules du périmètre.' }) vehicleId!: string | null;
  @ApiProperty({ type: [IndicatorDto] }) indicators!: IndicatorDto[];
  @ApiProperty({ type: [OmittedIndicatorDto], description: 'Indicateurs non fournis et motif (ex. coûts sans permission costs.read) : absents, jamais remplacés par 0.' }) omitted!: OmittedIndicatorDto[];
}
