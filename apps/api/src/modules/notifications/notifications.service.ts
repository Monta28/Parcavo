import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { AlertType, NotificationPreference, OutboxStatus, Prisma } from '@parc-auto/db';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, ConflictError, ErrorCodes, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import { type Page, pageOf, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import { SEVERITIES_DESC, alertTypeVisibleToRole, isSnoozeActive } from '../../domain/alert-policy.js';
import { endOfLocalDay, fromDbDate, localDate, startOfLocalDay, toDbDate, type CivilDate } from '../../domain/civil-date.js';
import {
  DEFAULT_NOTIFICATION_PREFERENCE,
  EMAIL_RECIPIENT_ROLES,
  acceptsImmediateEmail,
  buildActionUrl,
  checkQueuedAlertEmail,
  checkQueuedDigest,
  criticalAlertDedupeKey,
  dailyDigestDedupeKey,
  digestTiming,
  immediateEmailSeverities,
  isEmailRecipientRole,
  redactDeliveryError,
  renderCriticalAlertEmail,
  renderDailyDigestEmail,
  type DigestTiming,
  type NotificationPreferenceValues,
  type RenderedEmail,
} from '../../domain/notification-rules.js';
import { AuditService } from '../../infra/audit.service.js';
import { APP_ENV, type AppEnv } from '../../infra/env.js';
import { PrismaService, isUniqueViolation } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { AlertsService } from '../alerts/alerts.service.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  OUTBOX_STATUSES,
  type NotificationPreferencesViewDto,
  type NotificationStatusDto,
  type OutboxEntryDto,
  type OutboxQueryDto,
  type UpdateNotificationPreferencesDto,
} from './dto/notifications.dto.js';

export const EMAIL_CHANNEL_NOT_CONFIGURED = 'Canal e-mail non configuré';
export const EMAIL_CHANNEL_CONFIGURED = 'Canal e-mail configuré';

/** Destinataire potentiel d'e-mails (chef de parc ou administrateur actif, D-244). */
interface EmailRecipient {
  userId: string;
  email: string;
  isAdmin: boolean;
  /** Sociétés actives où l'utilisateur est chef de parc (ignoré pour l'administrateur). */
  chefCompanyIds: readonly string[];
  preference: NotificationPreferenceValues;
}

export type DeliveryDecision = { allowed: true } | { allowed: false; reason: string };

export interface DailyDigestResult {
  organizationId: string;
  localDate: CivilDate;
  /** TRAITE : destinataires examinés ; sinon raison pour laquelle rien n'a été fait. */
  outcome: 'TRAITE' | 'CANAL_NON_CONFIGURE' | Exclude<DigestTiming, 'DU'>;
  /** Lignes d'outbox créées lors de cet appel. */
  created: number;
  /** Récapitulatifs déjà en file pour ce jour (jamais dupliqués). */
  alreadyQueued: number;
  /** Destinataires sans contenu (aucun envoi pour un récapitulatif vide). */
  empty: number;
  /** Destinataires ayant désactivé le récapitulatif. */
  optedOut: number;
}

/**
 * Notifications e-mail (CDC 9.4) par outbox persistante :
 *  - à la création ou à l'escalade d'une alerte, une ligne par destinataire autorisé (chef de parc de la
 *    société ou administrateur, D-244) dont la préférence accepte cette gravité (défaut : CRITIQUE seule,
 *    D-245/D-246) et qui ne l'a pas reportée (D-252) ; clé de déduplication stable par alerte, activation,
 *    destinataire et gravité : aucune duplication (T19, D-253) ;
 *  - récapitulatif quotidien : au plus une ligne par utilisateur et date locale (D-262) ;
 *  - sans SMTP, rien n'est mis en file (D-263) et l'état « Canal e-mail non configuré » est exposé.
 * L'envoi, les reprises et la revérification des droits avant envoi relèvent du worker (D-261).
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly alerts: AlertsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  onModuleInit(): void {
    this.alerts.onRaised(async (event) => {
      if (!event.created && !event.escalated) return;
      const count = await this.enqueueCriticalAlert(event.id);
      if (count > 0) this.logger.log(`Alerte ${event.id} : ${count} e-mail(s) mis en file.`);
    });
  }

  emailChannelConfigured(): boolean {
    return this.env.smtp !== null;
  }

  /**
   * Met en file l'e-mail immédiat d'une alerte active pour chaque destinataire dont la préférence accepte
   * sa gravité (D-245 ; défaut CRITIQUE, D-246). Idempotent : la clé alerte/activation/destinataire/gravité
   * empêche toute duplication. Lignes et gravité notifiée écrites dans une même transaction. Renvoie le
   * nombre de lignes créées.
   */
  async enqueueCriticalAlert(alertId: string): Promise<number> {
    if (!this.emailChannelConfigured()) return 0;
    const alert = await this.prisma.client.alert.findUnique({ where: { id: alertId } });
    if (!alert || alert.status !== 'ACTIVE') return 0;
    if (!acceptsImmediateEmail(DEFAULT_NOTIFICATION_PREFERENCE, alert.severity)) {
      // Gravité hors défaut (CRITIQUE) : seuls des comptes ayant abaissé leur gravité minimale peuvent la recevoir.
      const accepting = SEVERITIES_DESC.filter((minimumSeverity) => acceptsImmediateEmail({ ...DEFAULT_NOTIFICATION_PREFERENCE, minimumSeverity }, alert.severity));
      const candidates = await this.prisma.client.notificationPreference.count({ where: { organizationId: alert.organizationId, emailCritical: true, minimumSeverity: { in: accepting } } });
      if (candidates === 0) return 0;
    }
    const [org, company, vehicle, recipients, states] = await Promise.all([
      this.prisma.client.organization.findUniqueOrThrow({ where: { id: alert.organizationId }, select: { timezone: true } }),
      this.prisma.client.company.findFirst({ where: { id: alert.companyId, organizationId: alert.organizationId }, select: { legalName: true } }),
      alert.vehicleId ? this.prisma.client.vehicle.findFirst({ where: { id: alert.vehicleId, organizationId: alert.organizationId }, select: { code: true, registration: true } }) : Promise.resolve(null),
      this.emailRecipients(alert.organizationId),
      this.prisma.client.alertRecipientState.findMany({ where: { alertId: alert.id }, select: { userId: true, snoozedUntil: true } }),
    ]);
    const now = this.clock.now();
    const today = localDate(now, org.timezone);
    const snoozedBy = new Set(states.filter((s) => isSnoozeActive(fromDbDate(s.snoozedUntil), today)).map((s) => s.userId));
    const eligible = recipients.filter((r) => canSeeAlert(r, alert.companyId, alert.type) && acceptsImmediateEmail(r.preference, alert.severity) && !snoozedBy.has(r.userId));
    if (eligible.length === 0) return 0;
    const email: RenderedEmail = renderCriticalAlertEmail({
      type: alert.type,
      severity: alert.severity,
      companyName: company?.legalName ?? '',
      vehicle,
      triggeredAt: alert.triggeredAt,
      timezone: org.timezone,
      actionUrl: buildActionUrl(this.env.appOrigin, alert.actionPath),
      alertCenterUrl: buildActionUrl(this.env.appOrigin, '/alertes'),
    });
    return this.prisma.client.$transaction(async (tx) => {
      const { count } = await tx.notificationOutbox.createMany({
        data: eligible.map((r) => ({
          organizationId: alert.organizationId,
          companyId: alert.companyId,
          kind: 'ALERTE_CRITIQUE' as const,
          recipientUserId: r.userId,
          recipientEmail: r.email,
          subject: email.subject,
          bodyText: email.bodyText,
          dedupeKey: criticalAlertDedupeKey(alert.id, alert.triggeredAt, r.userId, alert.severity),
          alertId: alert.id,
          nextAttemptAt: now,
        })),
        skipDuplicates: true,
      });
      if (alert.emailNotifiedSeverity !== alert.severity) {
        await tx.alert.update({ where: { id: alert.id }, data: { emailNotifiedSeverity: alert.severity } });
      }
      return count;
    });
  }

  /**
   * Récapitulatif quotidien (D-262) d'une organisation pour une date locale : pour chaque chef de parc
   * ou administrateur actif dont la préférence est active, une ligne d'outbox (clé digest:utilisateur:date)
   * listant ses alertes actives non reportées, les retours attendus du jour et les soumissions en attente.
   * Rien sans SMTP (D-263), avant l'heure d'envoi locale, ni pour un jour passé ou futur ; récapitulatif
   * vide : aucun envoi. Appelé par le worker ; idempotent.
   */
  async buildDailyDigest(organizationId: string, date: string): Promise<DailyDigestResult> {
    const result: DailyDigestResult = { organizationId, localDate: date, outcome: 'TRAITE', created: 0, alreadyQueued: 0, empty: 0, optedOut: 0 };
    if (!this.emailChannelConfigured()) return { ...result, outcome: 'CANAL_NON_CONFIGURE' };
    const org = await this.prisma.client.organization.findUnique({ where: { id: organizationId }, select: { timezone: true } });
    if (!org) throw new NotFoundOrOutOfScopeError('Organisation');
    const sendTime = await this.settings.get(organizationId, 'email.dailyDigestLocalTime');
    let timing: DigestTiming;
    try {
      timing = digestTiming(this.clock.now(), org.timezone, date, sendTime);
    } catch (error) {
      throw new BusinessRuleError('RECAPITULATIF_PARAMETRE_INVALIDE', `Récapitulatif impossible : ${error instanceof Error ? error.message : String(error)}`);
    }
    if (timing !== 'DU') return { ...result, outcome: timing };
    for (const recipient of await this.emailRecipients(organizationId)) {
      if (!recipient.preference.emailDailyDigest) {
        result.optedOut += 1;
        continue;
      }
      const dedupeKey = dailyDigestDedupeKey(recipient.userId, date);
      if (await this.prisma.client.notificationOutbox.findUnique({ where: { dedupeKey }, select: { id: true } })) {
        result.alreadyQueued += 1;
        continue;
      }
      const email = await this.renderDigest(organizationId, org.timezone, recipient, date);
      if (!email) {
        result.empty += 1;
        continue;
      }
      const { count } = await this.prisma.client.notificationOutbox.createMany({
        data: [
          {
            organizationId,
            companyId: null,
            kind: 'RECAPITULATIF_QUOTIDIEN',
            recipientUserId: recipient.userId,
            recipientEmail: recipient.email,
            subject: email.subject,
            bodyText: email.bodyText,
            dedupeKey,
            nextAttemptAt: this.clock.now(),
          },
        ],
        skipDuplicates: true,
      });
      if (count === 1) result.created += 1;
      else result.alreadyQueued += 1;
    }
    return result;
  }

  /**
   * Revérification juste avant l'envoi (9.4, D-261, R-9.4-10), appelée par le distributeur d'outbox du
   * worker : compte actif et adresse inchangée ; pour une alerte, alerte encore active dans l'activation et
   * à la gravité annoncées par le message, habilitation du destinataire sur sa société, préférence et
   * absence de report ; pour le récapitulatif, habilitation, préférence et jour local encore en cours
   * (D-262). Un refus doit conduire au statut ANNULE avec le motif renvoyé.
   */
  async authorizeDelivery(outboxId: string): Promise<DeliveryDecision> {
    const entry = await this.prisma.client.notificationOutbox.findUnique({ where: { id: outboxId } });
    if (!entry) return deny('Message introuvable.');
    const user = await this.prisma.client.user.findFirst({ where: { id: entry.recipientUserId, organizationId: entry.organizationId }, select: { status: true, email: true } });
    if (!user || user.status !== 'ACTIF') return deny('Droits révoqués : compte du destinataire désactivé.');
    if (user.email !== entry.recipientEmail) return deny('Adresse e-mail du destinataire modifiée depuis la mise en file.');
    if (entry.kind === 'INVITATION' || entry.kind === 'REINITIALISATION_MOT_DE_PASSE') return { allowed: true };
    const [recipient] = await this.emailRecipients(entry.organizationId, entry.recipientUserId);
    if (!recipient) return deny('Droits révoqués : le destinataire n’est plus chef de parc ni administrateur.');
    if (entry.kind === 'RECAPITULATIF_QUOTIDIEN') {
      if (!recipient.preference.emailDailyDigest) return deny('Récapitulatif désactivé par le destinataire.');
      const org = await this.prisma.client.organization.findUniqueOrThrow({ where: { id: entry.organizationId }, select: { timezone: true } });
      const digest = checkQueuedDigest(entry.dedupeKey, recipient.userId, localDate(this.clock.now(), org.timezone));
      return digest.current ? { allowed: true } : deny(digest.reason);
    }
    const alert = entry.alertId ? await this.prisma.client.alert.findFirst({ where: { id: entry.alertId, organizationId: entry.organizationId } }) : null;
    if (!alert) return deny('Alerte introuvable.');
    if (alert.status !== 'ACTIVE') return deny('Alerte résolue avant l’envoi.');
    const queued = checkQueuedAlertEmail(entry.dedupeKey, alert, recipient.userId);
    if (!queued.current) return deny(queued.reason);
    if (!canSeeAlert(recipient, alert.companyId, alert.type)) return deny('Droits révoqués sur la société de l’alerte.');
    if (!acceptsImmediateEmail(recipient.preference, alert.severity)) return deny('Préférence du destinataire ou gravité incompatible avec un envoi immédiat.');
    const [org, state] = await Promise.all([
      this.prisma.client.organization.findUniqueOrThrow({ where: { id: entry.organizationId }, select: { timezone: true } }),
      this.prisma.client.alertRecipientState.findUnique({ where: { alertId_userId: { alertId: alert.id, userId: recipient.userId } }, select: { snoozedUntil: true } }),
    ]);
    if (isSnoozeActive(fromDbDate(state?.snoozedUntil), localDate(this.clock.now(), org.timezone))) return deny('Alerte reportée par le destinataire.');
    return { allowed: true };
  }

  /** État du canal e-mail et de l'outbox de l'organisation (administrateur). */
  async status(ctx: RequestContext): Promise<NotificationStatusDto> {
    this.access.requireAdmin(ctx);
    const [groups, oldestPending, lastSent] = await Promise.all([
      this.prisma.client.notificationOutbox.groupBy({ by: ['status'], where: { organizationId: ctx.organizationId }, _count: { _all: true } }),
      this.prisma.client.notificationOutbox.findFirst({ where: { organizationId: ctx.organizationId, status: { in: ['EN_ATTENTE', 'ECHEC'] } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      this.prisma.client.notificationOutbox.findFirst({ where: { organizationId: ctx.organizationId, status: 'ENVOYE', sentAt: { not: null } }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } }),
    ]);
    const outbox = Object.fromEntries(OUTBOX_STATUSES.map((s) => [s, 0])) as Record<OutboxStatus, number>;
    for (const g of groups) outbox[g.status] = g._count._all;
    const configured = this.emailChannelConfigured();
    return {
      emailChannelConfigured: configured,
      message: configured ? EMAIL_CHANNEL_CONFIGURED : EMAIL_CHANNEL_NOT_CONFIGURED,
      outbox,
      oldestPendingAt: oldestPending?.createdAt.toISOString() ?? null,
      lastSentAt: lastSent?.sentAt?.toISOString() ?? null,
    };
  }

  /** Outbox de l'organisation (administrateur) : statut exact, tentatives, prochaine tentative, erreur expurgée. */
  async outbox(ctx: RequestContext, query: OutboxQueryDto): Promise<Page<OutboxEntryDto>> {
    this.access.requireAdmin(ctx);
    const where: Prisma.NotificationOutboxWhereInput = {
      organizationId: ctx.organizationId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.q ? { OR: [{ subject: { contains: query.q, mode: 'insensitive' } }, { recipientEmail: { contains: query.q, mode: 'insensitive' } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.client.notificationOutbox.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...skipTake(query) }),
      this.prisma.client.notificationOutbox.count({ where }),
    ]);
    // Le corps n'est jamais exposé : il peut contenir un lien d'accès à usage unique (invitation, réinitialisation).
    const items: OutboxEntryDto[] = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      recipientUserId: r.recipientUserId,
      recipientEmail: r.recipientEmail,
      subject: r.subject,
      companyId: r.companyId,
      alertId: r.alertId,
      attempts: r.attempts,
      maxAttempts: r.maxAttempts,
      nextAttemptAt: r.nextAttemptAt.toISOString(),
      lastError: redactDeliveryError(r.lastError),
      sentAt: r.sentAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
    return pageOf(items, total, query);
  }

  async getPreferences(ctx: RequestContext): Promise<NotificationPreferencesViewDto> {
    this.access.requireStaff(ctx);
    const row = await this.prisma.client.notificationPreference.findUnique({ where: { userId: ctx.userId } });
    return this.preferencesView(ctx, row);
  }

  /** Préférences de l'utilisateur courant (versionnées, auditées). */
  async updatePreferences(ctx: RequestContext, dto: UpdateNotificationPreferencesDto): Promise<NotificationPreferencesViewDto> {
    this.access.requireStaff(ctx);
    const values: NotificationPreferenceValues = { emailCritical: dto.emailCritical, emailDailyDigest: dto.emailDailyDigest, minimumSeverity: dto.minimumSeverity };
    try {
      await this.prisma.client.$transaction(async (tx) => {
        const current = await tx.notificationPreference.findUnique({ where: { userId: ctx.userId } });
        assertExpectedVersion({ version: current?.version ?? 0 }, dto.expectedVersion, 'préférences de notification');
        if (!current) {
          await tx.notificationPreference.create({ data: { userId: ctx.userId, organizationId: ctx.organizationId, ...values, version: 1 } });
        } else {
          const { count } = await tx.notificationPreference.updateMany({ where: { userId: ctx.userId, version: dto.expectedVersion }, data: { ...values, version: { increment: 1 } } });
          if (count === 0) throw staleVersion();
        }
        await this.audit.record(
          ctx,
          {
            action: 'notifications.preferences.modification',
            objectType: 'NotificationPreference',
            objectId: ctx.userId,
            before: current ? { emailCritical: current.emailCritical, emailDailyDigest: current.emailDailyDigest, minimumSeverity: current.minimumSeverity } : { ...DEFAULT_NOTIFICATION_PREFERENCE, defaut: true },
            after: values,
          },
          tx,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw staleVersion();
      throw error;
    }
    return this.getPreferences(ctx);
  }

  // ---------------------------------------------------------------------------

  private async preferencesView(ctx: RequestContext, row: NotificationPreference | null): Promise<NotificationPreferencesViewDto> {
    const values = row ?? DEFAULT_NOTIFICATION_PREFERENCE;
    return {
      emailCritical: values.emailCritical,
      emailDailyDigest: values.emailDailyDigest,
      minimumSeverity: values.minimumSeverity,
      version: row?.version ?? 0,
      isDefault: row === null,
      emailChannelConfigured: this.emailChannelConfigured(),
      receivesEmails: ctx.isAdmin || [...ctx.grants.values()].some((g) => isEmailRecipientRole(g.role)),
      immediateSeverities: immediateEmailSeverities(values),
      dailyDigestLocalTime: await this.settings.get(ctx.organizationId, 'email.dailyDigestLocalTime'),
    };
  }

  /**
   * Chefs de parc (sociétés actives) et administrateurs actifs de l'organisation, avec leur préférence
   * (défaut D-245 si aucune n'est enregistrée). Les droits sont relus à chaque calcul.
   */
  private async emailRecipients(organizationId: string, userId?: string): Promise<EmailRecipient[]> {
    const users = await this.prisma.client.user.findMany({
      where: { organizationId, ...(userId ? { id: userId } : {}), status: 'ACTIF', memberships: { some: { role: { in: [...EMAIL_RECIPIENT_ROLES] } } } },
      select: {
        id: true,
        email: true,
        memberships: { select: { companyId: true, role: true, company: { select: { status: true } } } },
        notificationPreference: { select: { emailCritical: true, emailDailyDigest: true, minimumSeverity: true } },
      },
      orderBy: { id: 'asc' },
    });
    return users
      .map((u) => ({
        userId: u.id,
        email: u.email,
        isAdmin: u.memberships.some((m) => m.companyId === null && m.role === 'ADMIN'),
        chefCompanyIds: u.memberships.filter((m) => m.companyId !== null && isEmailRecipientRole(m.role) && m.company?.status === 'ACTIF').map((m) => m.companyId as string),
        preference: u.notificationPreference ?? DEFAULT_NOTIFICATION_PREFERENCE,
      }))
      .filter((r) => r.isAdmin || r.chefCompanyIds.length > 0);
  }

  private async renderDigest(organizationId: string, timezone: string, recipient: EmailRecipient, date: CivilDate): Promise<RenderedEmail | null> {
    const scope = recipient.isAdmin ? {} : { companyId: { in: [...recipient.chefCompanyIds] } };
    const [alerts, returns, pendingReadings, pendingFuel] = await Promise.all([
      this.prisma.client.alert.findMany({
        where: { organizationId, status: 'ACTIVE', ...scope, recipientStates: { none: { userId: recipient.userId, snoozedUntil: { gte: toDbDate(date) as Date } } } },
        select: { type: true, severity: true, companyId: true, vehicleId: true, triggeredAt: true, actionPath: true },
      }),
      this.prisma.client.vehicleUsage.findMany({
        where: { organizationId, status: 'EN_COURS', ...scope, expectedReturnAt: { gte: startOfLocalDay(date, timezone), lte: endOfLocalDay(date, timezone) } },
        select: { companyId: true, expectedReturnAt: true, vehicle: { select: { code: true, registration: true } } },
      }),
      this.prisma.client.odometerReading.count({ where: { organizationId, status: 'EN_ATTENTE', ...scope } }),
      this.prisma.client.fuelEntry.count({ where: { organizationId, status: 'SOUMIS', ...scope } }),
    ]);
    const visible = alerts.filter((a) => canSeeAlert(recipient, a.companyId, a.type));
    const companyIds = [...new Set([...visible.map((a) => a.companyId), ...returns.map((r) => r.companyId)])];
    const vehicleIds = [...new Set(visible.map((a) => a.vehicleId).filter((v): v is string => v !== null))];
    const [companies, vehicles] = await Promise.all([
      companyIds.length ? this.prisma.client.company.findMany({ where: { organizationId, id: { in: companyIds } }, select: { id: true, legalName: true } }) : Promise.resolve([]),
      vehicleIds.length ? this.prisma.client.vehicle.findMany({ where: { organizationId, id: { in: vehicleIds } }, select: { id: true, code: true, registration: true } }) : Promise.resolve([]),
    ]);
    const companyName = new Map(companies.map((c) => [c.id, c.legalName]));
    const vehicleById = new Map(vehicles.map((v) => [v.id, { code: v.code, registration: v.registration }]));
    return renderDailyDigestEmail({
      date,
      timezone,
      alerts: visible.map((a) => ({
        severity: a.severity,
        type: a.type,
        companyName: companyName.get(a.companyId) ?? '',
        vehicle: a.vehicleId ? (vehicleById.get(a.vehicleId) ?? null) : null,
        triggeredAt: a.triggeredAt,
        actionUrl: buildActionUrl(this.env.appOrigin, a.actionPath),
      })),
      expectedReturns: returns.map((r) => ({ companyName: companyName.get(r.companyId) ?? '', vehicle: r.vehicle, expectedReturnAt: r.expectedReturnAt })),
      pendingSubmissions: pendingReadings + pendingFuel,
      alertCenterUrl: buildActionUrl(this.env.appOrigin, '/alertes'),
    });
  }
}

function canSeeAlert(recipient: EmailRecipient, companyId: string, type: AlertType): boolean {
  if (recipient.isAdmin) return alertTypeVisibleToRole('ADMIN', type);
  return recipient.chefCompanyIds.includes(companyId) && alertTypeVisibleToRole('CHEF_PARC', type);
}

function deny(reason: string): DeliveryDecision {
  return { allowed: false, reason };
}

function staleVersion(): ConflictError {
  return new ConflictError(ErrorCodes.VERSION_OBSOLETE, 'Préférences de notification modifiées en parallèle : rechargez puis réessayez.');
}
