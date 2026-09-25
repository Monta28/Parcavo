// Types des réponses de l'API notifications (apps/api/src/modules/notifications, NotificationStatusDto,
// OutboxEntryDto, NotificationPreferencesViewDto).
import type { AlertSeverity } from './alerts-types';

export type OutboxStatus = 'EN_ATTENTE' | 'EN_COURS' | 'ENVOYE' | 'ECHEC' | 'ABANDONNE' | 'ANNULE';
export type OutboxKind = 'ALERTE_CRITIQUE' | 'RECAPITULATIF_QUOTIDIEN' | 'REINITIALISATION_MOT_DE_PASSE' | 'INVITATION';

export const OUTBOX_STATUSES: readonly OutboxStatus[] = ['EN_ATTENTE', 'EN_COURS', 'ENVOYE', 'ECHEC', 'ABANDONNE', 'ANNULE'];

export const OUTBOX_STATUS_LABELS: Record<OutboxStatus, string> = {
  EN_ATTENTE: 'En attente',
  EN_COURS: 'Envoi en cours',
  ENVOYE: 'Envoyé',
  ECHEC: 'Échec (nouvelle tentative prévue)',
  ABANDONNE: 'Abandonné',
  ANNULE: 'Annulé avant envoi',
};

export const OUTBOX_KIND_LABELS: Record<OutboxKind, string> = {
  ALERTE_CRITIQUE: 'Alerte immédiate',
  RECAPITULATIF_QUOTIDIEN: 'Récapitulatif quotidien',
  REINITIALISATION_MOT_DE_PASSE: 'Réinitialisation du mot de passe',
  INVITATION: 'Invitation',
};

export interface NotificationStatus {
  emailChannelConfigured: boolean;
  /** « Canal e-mail configuré » ou « Canal e-mail non configuré », libellé fourni par l'API. */
  message: string;
  outbox: Record<OutboxStatus, number>;
  oldestPendingAt: string | null;
  lastSentAt: string | null;
}

export interface OutboxEntry {
  id: string;
  kind: OutboxKind;
  status: OutboxStatus;
  recipientUserId: string;
  /** Adresse telle que renvoyée par l'API (jamais reconstituée côté navigateur). */
  recipientEmail: string;
  subject: string;
  companyId: string | null;
  alertId: string | null;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  /** Dernière erreur, expurgée de tout secret par l'API. */
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationPreferences {
  emailCritical: boolean;
  emailDailyDigest: boolean;
  minimumSeverity: AlertSeverity;
  /** 0 : préférences par défaut, jamais enregistrées. */
  version: number;
  isDefault: boolean;
  emailChannelConfigured: boolean;
  /** Le compte reçoit des e-mails (chef de parc ou administrateur). */
  receivesEmails: boolean;
  /** Gravités effectivement envoyées immédiatement selon les préférences (calculées par l'API). */
  immediateSeverities: AlertSeverity[];
  /** Heure locale du récapitulatif quotidien (paramètre du groupe). */
  dailyDigestLocalTime: string;
}
