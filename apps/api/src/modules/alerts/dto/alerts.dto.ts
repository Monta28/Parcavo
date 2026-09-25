import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { PageMetaDto, PageQueryDto } from '../../../common/pagination.js';
import { ALERT_TYPES, SEVERITIES_DESC } from '../../../domain/alert-policy.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ['ACTIVE', 'RESOLUE'] as const;
const SNOOZE_FILTERS = ['include', 'exclude', 'only'] as const;
const SEVERITIES = [...SEVERITIES_DESC].reverse();

export class AlertsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: STATUSES, default: 'ACTIVE', description: 'Statut métier (ACTIVE par défaut).' })
  @IsOptional()
  @IsIn(STATUSES, { message: 'Statut inconnu (ACTIVE ou RESOLUE).' })
  status: (typeof STATUSES)[number] = 'ACTIVE';

  @ApiPropertyOptional({ enum: ALERT_TYPES })
  @IsOptional()
  @IsIn(ALERT_TYPES, { message: 'Type d’alerte inconnu.' })
  type?: (typeof ALERT_TYPES)[number];

  @ApiPropertyOptional({ enum: SEVERITIES })
  @IsOptional()
  @IsIn(SEVERITIES, { message: 'Gravité inconnue.' })
  severity?: (typeof SEVERITIES)[number];

  @ApiPropertyOptional({ description: 'Société courante (recoupée avec les habilitations ; hors périmètre : 404).' })
  @IsOptional()
  @IsUUID('all', { message: 'Identifiant de société invalide.' })
  companyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('all', { message: 'Identifiant de véhicule invalide.' })
  vehicleId?: string;

  @ApiPropertyOptional({ description: 'Non lues par l’utilisateur courant uniquement.', enum: ['true', 'false'] })
  @IsOptional()
  @IsIn(['true', 'false'], { message: 'Valeur attendue : true ou false.' })
  unread?: 'true' | 'false';

  @ApiPropertyOptional({ enum: SNOOZE_FILTERS, default: 'include', description: 'Alertes reportées par l’utilisateur courant : incluses, exclues ou seules.' })
  @IsOptional()
  @IsIn(SNOOZE_FILTERS, { message: 'Valeur attendue : include, exclude ou only.' })
  snoozed: (typeof SNOOZE_FILTERS)[number] = 'include';
}

export class AlertCountsQueryDto {
  @ApiPropertyOptional({ description: 'Société courante (recoupée avec les habilitations ; hors périmètre : 404).' })
  @IsOptional()
  @IsUUID('all', { message: 'Identifiant de société invalide.' })
  companyId?: string;
}

/** Report motivé (9.2, D-252) : propre à l'utilisateur, sans effet sur le statut ni sur le retard. */
export class SnoozeAlertDto {
  @ApiProperty({ description: 'Date civile de fin du report (incluse, jour local), future, 90 jours au plus.', example: '2026-10-01' })
  @Matches(DATE_ONLY, { message: 'Date attendue au format AAAA-MM-JJ.' })
  until!: string;

  @ApiProperty({ description: 'Motif du report (obligatoire, visible des autres destinataires).' })
  @IsString({ message: 'Le motif est obligatoire.' })
  @MinLength(3, { message: 'Le motif doit contenir au moins 3 caractères.' })
  @MaxLength(500, { message: 'Le motif ne peut pas dépasser 500 caractères.' })
  reason!: string;
}

export class AlertSnoozeInfoDto {
  @ApiProperty() userId!: string;
  @ApiProperty({ description: 'Auteur du report.' }) userName!: string;
  @ApiProperty({ format: 'date' }) until!: string;
  @ApiProperty() reason!: string;
}

export class AlertViewDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ALERT_TYPES }) type!: string;
  @ApiProperty() typeLabel!: string;
  @ApiProperty({ enum: SEVERITIES }) severity!: string;
  @ApiProperty() severityLabel!: string;
  @ApiProperty({ enum: STATUSES }) status!: string;
  @ApiProperty() companyId!: string;
  @ApiProperty() companyName!: string;
  @ApiProperty({ description: 'Type de l’objet concerné (VehicleMaintenancePlan, DocumentVersion…).' }) objectType!: string;
  @ApiProperty() objectId!: string;
  @ApiProperty({ nullable: true, type: String }) vehicleId!: string | null;
  @ApiProperty({ nullable: true, type: String }) vehicleCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) vehicleRegistration!: string | null;
  @ApiProperty() title!: string;
  @ApiProperty() message!: string;
  @ApiProperty({ type: 'object', additionalProperties: true, description: 'Condition de déclenchement (valeurs observées, seuils).' }) condition!: unknown;
  @ApiProperty({ description: 'Lien vers l’action utile (chemin de l’application).' }) actionPath!: string;
  @ApiProperty({ nullable: true, type: String }) responsibleUserId!: string | null;
  @ApiProperty({ description: 'Responsable ou « Non attribué » (D-244).' }) responsibleName!: string;
  @ApiProperty({ format: 'date-time' }) triggeredAt!: string;
  @ApiProperty({ format: 'date-time' }) lastEvaluatedAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) resolvedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) resolutionReason!: string | null;
  @ApiProperty() version!: number;
  @ApiProperty({ nullable: true, type: String, format: 'date-time', description: 'Lu par l’utilisateur courant.' }) readAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date', description: 'Report de l’utilisateur courant (actif jusqu’à la fin de ce jour local).' }) snoozedUntil!: string | null;
  @ApiProperty({ nullable: true, type: String }) snoozeReason!: string | null;
  @ApiProperty({ type: [AlertSnoozeInfoDto], description: 'Reports en cours de tous les destinataires (motif et auteur).' }) snoozes!: AlertSnoozeInfoDto[];
  @ApiProperty({ description: 'L’utilisateur courant peut reporter cette alerte (rôle opérationnel, alerte active).' }) canSnooze!: boolean;
}

export class AlertPageDto extends PageMetaDto {
  @ApiProperty({ type: [AlertViewDto] }) items!: AlertViewDto[];
}

export class AlertSeverityCountsDto {
  @ApiProperty() CRITIQUE!: number;
  @ApiProperty() URGENT!: number;
  @ApiProperty() ATTENTION!: number;
  @ApiProperty() INFO!: number;
}

export class AlertCountsDto {
  @ApiProperty({ description: 'Alertes actives dans le périmètre.' }) total!: number;
  @ApiProperty({ type: AlertSeverityCountsDto }) bySeverity!: AlertSeverityCountsDto;
  @ApiProperty({ description: 'Alertes actives non lues par l’utilisateur courant.' }) unread!: number;
  @ApiProperty({ description: 'Alertes actives reportées par l’utilisateur courant.' }) snoozed!: number;
}
