import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, Min } from 'class-validator';
import { PageMetaDto, PageQueryDto } from '../../../common/pagination.js';
import { SEVERITIES_DESC } from '../../../domain/alert-policy.js';

const SEVERITIES = [...SEVERITIES_DESC].reverse();
export const OUTBOX_STATUSES = ['EN_ATTENTE', 'EN_COURS', 'ENVOYE', 'ECHEC', 'ABANDONNE', 'ANNULE'] as const;
export const OUTBOX_KINDS = ['ALERTE_CRITIQUE', 'RECAPITULATIF_QUOTIDIEN', 'REINITIALISATION_MOT_DE_PASSE', 'INVITATION'] as const;

export class OutboxStatusCountsDto {
  @ApiProperty() EN_ATTENTE!: number;
  @ApiProperty() EN_COURS!: number;
  @ApiProperty() ENVOYE!: number;
  @ApiProperty() ECHEC!: number;
  @ApiProperty() ABANDONNE!: number;
  @ApiProperty() ANNULE!: number;
}

export class NotificationStatusDto {
  @ApiProperty({ description: 'Canal e-mail configuré (SMTP). Sans SMTP, rien n’est mis en file (D-263).' }) emailChannelConfigured!: boolean;
  @ApiProperty({ example: 'Canal e-mail non configuré' }) message!: string;
  @ApiProperty({ type: OutboxStatusCountsDto, description: 'Lignes d’outbox de l’organisation par statut exact.' }) outbox!: OutboxStatusCountsDto;
  @ApiProperty({ nullable: true, type: String, format: 'date-time', description: 'Plus ancienne ligne en attente (EN_ATTENTE ou ECHEC en reprise).' }) oldestPendingAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) lastSentAt!: string | null;
}

export class OutboxQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: OUTBOX_STATUSES })
  @IsOptional()
  @IsIn(OUTBOX_STATUSES, { message: 'Statut d’envoi inconnu.' })
  status?: (typeof OUTBOX_STATUSES)[number];

  @ApiPropertyOptional({ enum: OUTBOX_KINDS })
  @IsOptional()
  @IsIn(OUTBOX_KINDS, { message: 'Type de message inconnu.' })
  kind?: (typeof OUTBOX_KINDS)[number];
}

export class OutboxEntryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: OUTBOX_KINDS }) kind!: string;
  @ApiProperty({ enum: OUTBOX_STATUSES }) status!: string;
  @ApiProperty() recipientUserId!: string;
  @ApiProperty() recipientEmail!: string;
  @ApiProperty() subject!: string;
  @ApiProperty({ nullable: true, type: String }) companyId!: string | null;
  @ApiProperty({ nullable: true, type: String }) alertId!: string | null;
  @ApiProperty() attempts!: number;
  @ApiProperty() maxAttempts!: number;
  @ApiProperty({ format: 'date-time', description: 'Prochaine tentative.' }) nextAttemptAt!: string;
  @ApiProperty({ nullable: true, type: String, description: 'Dernière erreur, expurgée de tout secret.' }) lastError!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) sentAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class OutboxPageDto extends PageMetaDto {
  @ApiProperty({ type: [OutboxEntryDto] }) items!: OutboxEntryDto[];
}

export class NotificationPreferencesViewDto {
  @ApiProperty({ description: 'Recevoir immédiatement par e-mail les alertes de gravité au moins égale à minimumSeverity (D-245).' }) emailCritical!: boolean;
  @ApiProperty({ description: 'Recevoir le récapitulatif quotidien (D-262).' }) emailDailyDigest!: boolean;
  @ApiProperty({ enum: SEVERITIES, description: 'Gravité minimale d’un e-mail immédiat (défaut CRITIQUE : seules les alertes critiques partent immédiatement, D-245/D-246).' }) minimumSeverity!: string;
  @ApiProperty({ description: 'Version enregistrée (0 : préférences par défaut, jamais enregistrées).' }) version!: number;
  @ApiProperty({ description: 'Préférences par défaut (aucune préférence enregistrée).' }) isDefault!: boolean;
  @ApiProperty({ description: 'Canal e-mail configuré (SMTP).' }) emailChannelConfigured!: boolean;
  @ApiProperty({ description: 'Le compte reçoit des e-mails (chef de parc ou administrateur, D-244).' }) receivesEmails!: boolean;
  @ApiProperty({ enum: SEVERITIES, isArray: true, description: 'Gravités effectivement envoyées immédiatement à l’utilisateur selon ses préférences (vide si l’e-mail immédiat est désactivé).' }) immediateSeverities!: string[];
  @ApiProperty({ example: '08:00', description: 'Heure locale du récapitulatif quotidien (paramètre email.dailyDigestLocalTime).' }) dailyDigestLocalTime!: string;
}

export class UpdateNotificationPreferencesDto {
  @ApiProperty({ description: 'E-mail immédiat des alertes de gravité au moins égale à minimumSeverity.' }) @IsBoolean({ message: 'Valeur vrai/faux attendue.' }) emailCritical!: boolean;
  @ApiProperty({ description: 'Récapitulatif quotidien.' }) @IsBoolean({ message: 'Valeur vrai/faux attendue.' }) emailDailyDigest!: boolean;
  @ApiProperty({ enum: SEVERITIES, description: 'Gravité minimale d’un e-mail immédiat (CRITIQUE par défaut).' }) @IsIn(SEVERITIES, { message: 'Gravité inconnue.' }) minimumSeverity!: (typeof SEVERITIES)[number];
  @ApiProperty({ description: 'Version lue (0 si les préférences n’ont jamais été enregistrées).' })
  @Type(() => Number)
  @IsInt({ message: 'Un entier est attendu.' })
  @Min(0, { message: 'Version invalide.' })
  expectedVersion!: number;
}
