import { Injectable } from '@nestjs/common';
import type { Alert, AlertSeverity, MembershipRole, Prisma } from '@parc-auto/db';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, ConflictError, ForbiddenActionError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { type Page, pageOf, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import {
  ALERT_TYPE_LABELS,
  ALERT_TYPES,
  SEVERITY_LABELS,
  alertTypeVisibleToRole,
  checkSnoozeUntil,
  isSnoozeActive,
  roleCanSnooze,
  visibleAlertTypes,
} from '../../domain/alert-policy.js';
import { fromDbDate, localDate, toDbDate, type CivilDate } from '../../domain/civil-date.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, isUniqueViolation, type Tx } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import type { AlertCountsDto, AlertCountsQueryDto, AlertSnoozeInfoDto, AlertViewDto, AlertsQueryDto, SnoozeAlertDto } from './dto/alerts.dto.js';

const NOT_ASSIGNED = 'Non attribué';

type StateRow = Prisma.AlertRecipientStateGetPayload<{ include: { user: { select: { firstName: true; lastName: true } } } }>;
type AlertWithStates = Alert & { recipientStates: StateRow[] };

/**
 * Centre d'alertes (CDC 9.1, 9.2, 15.2) : lecture dans le périmètre, compteurs, états propres à chaque
 * utilisateur (lu, report motivé). Visibilité calculée au point d'accès selon le rôle détenu sur la
 * société de l'alerte (D-244) ; une alerte hors périmètre est introuvable (404). Lire ou reporter ne
 * résout jamais l'alerte et ne modifie pas le statut métier sous-jacent (T20) : seule la disparition de
 * la condition la résout (AlertsService).
 */
@Injectable()
export class AlertCenterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async list(ctx: RequestContext, query: AlertsQueryDto): Promise<Page<AlertViewDto>> {
    this.access.requireStaff(ctx);
    const today = await this.today(ctx);
    const where: Prisma.AlertWhereInput = {
      AND: [
        this.visibilityWhere(ctx),
        this.companyFilter(ctx, query.companyId),
        { status: query.status },
        query.type ? { type: query.type } : {},
        query.severity ? { severity: query.severity } : {},
        query.vehicleId ? { vehicleId: query.vehicleId } : {},
        query.unread === 'true' ? this.unreadWhere(ctx) : query.unread === 'false' ? { NOT: this.unreadWhere(ctx) } : {},
        query.snoozed === 'only' ? this.snoozedWhere(ctx, today) : query.snoozed === 'exclude' ? { NOT: this.snoozedWhere(ctx, today) } : {},
        query.q ? { title: { contains: query.q, mode: 'insensitive' } } : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.client.alert.findMany({
        where,
        include: this.statesInclude(ctx, today),
        orderBy: [{ severity: 'desc' }, { triggeredAt: 'desc' }, { id: 'asc' }],
        ...skipTake(query),
      }),
      this.prisma.client.alert.count({ where }),
    ]);
    return pageOf(await this.views(ctx, rows, today), total, query);
  }

  /** Compteurs des alertes actives du périmètre, par gravité, non lues et reportées (sans fuite d'autres sociétés). */
  async counts(ctx: RequestContext, query: AlertCountsQueryDto): Promise<AlertCountsDto> {
    this.access.requireStaff(ctx);
    const today = await this.today(ctx);
    const base: Prisma.AlertWhereInput = { AND: [this.visibilityWhere(ctx), this.companyFilter(ctx, query.companyId), { status: 'ACTIVE' }] };
    const [groups, unread, snoozed] = await Promise.all([
      this.prisma.client.alert.groupBy({ by: ['severity'], where: base, _count: { _all: true } }),
      this.prisma.client.alert.count({ where: { AND: [base, this.unreadWhere(ctx)] } }),
      this.prisma.client.alert.count({ where: { AND: [base, this.snoozedWhere(ctx, today)] } }),
    ]);
    const bySeverity: Record<AlertSeverity, number> = { CRITIQUE: 0, URGENT: 0, ATTENTION: 0, INFO: 0 };
    for (const g of groups) bySeverity[g.severity] = g._count._all;
    return { total: Object.values(bySeverity).reduce((a, b) => a + b, 0), bySeverity, unread, snoozed };
  }

  async get(ctx: RequestContext, id: string): Promise<AlertViewDto> {
    const alert = await this.loadVisible(ctx, id);
    return this.view(ctx, alert);
  }

  /** « Lu » : état propre à l'utilisateur ; la première date de lecture est conservée. */
  async markRead(ctx: RequestContext, id: string): Promise<AlertViewDto> {
    const alert = await this.loadVisible(ctx, id);
    const current = await this.prisma.client.alertRecipientState.findUnique({ where: { alertId_userId: { alertId: alert.id, userId: ctx.userId } } });
    if (!current?.readAt) await this.writeState(ctx, alert.id, { readAt: this.clock.now() });
    return this.view(ctx, alert);
  }

  async markUnread(ctx: RequestContext, id: string): Promise<AlertViewDto> {
    const alert = await this.loadVisible(ctx, id);
    await this.prisma.client.alertRecipientState.updateMany({ where: { alertId: alert.id, userId: ctx.userId, readAt: { not: null } }, data: { readAt: null } });
    return this.view(ctx, alert);
  }

  /**
   * Report motivé (9.2, D-252) : propre à l'utilisateur, jusqu'à une date civile future (fin du jour
   * local), motif obligatoire et visible des autres destinataires. L'alerte reste ACTIVE, garde sa gravité
   * et le statut de retard de l'objet est inchangé. Réservé aux rôles opérationnels ; audité.
   */
  async snooze(ctx: RequestContext, id: string, dto: SnoozeAlertDto): Promise<AlertViewDto> {
    const alert = await this.loadVisible(ctx, id);
    const role = this.access.roleIn(ctx, alert.companyId);
    if (!role || !roleCanSnooze(role)) throw new ForbiddenActionError('Le report d’une alerte est réservé aux opérateurs, chefs de parc et administrateurs.');
    if (alert.status !== 'ACTIVE') throw new ConflictError('ALERTE_RESOLUE', 'Cette alerte est résolue : elle ne peut pas être reportée.');
    const reason = dto.reason.trim();
    if (reason.length < 3) throw new BusinessRuleError('MOTIF_REQUIS', 'Indiquez le motif du report.', { fieldErrors: { reason: ['Motif requis (3 caractères au moins).'] } });
    const today = await this.today(ctx);
    const rejection = checkSnoozeUntil(dto.until, today);
    if (rejection) throw new BusinessRuleError(rejection.code, rejection.message, { fieldErrors: { until: [rejection.message] } });
    const previous = await this.prisma.client.alertRecipientState.findUnique({ where: { alertId_userId: { alertId: alert.id, userId: ctx.userId } } });
    const previousUntil = fromDbDate(previous?.snoozedUntil);
    if (previousUntil === dto.until && previous?.snoozeReason === reason) return this.view(ctx, alert);
    await this.prisma.client.$transaction(async (tx) => {
      await this.writeState(ctx, alert.id, { snoozedUntil: toDbDate(dto.until), snoozeReason: reason }, tx);
      await this.audit.record(
        ctx,
        {
          action: 'alerte.report',
          objectType: 'Alert',
          objectId: alert.id,
          companyId: alert.companyId,
          reason,
          before: { snoozedUntil: previousUntil, snoozeReason: previous?.snoozeReason ?? null },
          after: { snoozedUntil: dto.until, snoozeReason: reason, status: alert.status, severity: alert.severity },
        },
        tx,
      );
    });
    return this.view(ctx, alert);
  }

  /** Annule son propre report (aucun effet sur l'alerte elle-même). */
  async unsnooze(ctx: RequestContext, id: string): Promise<AlertViewDto> {
    const alert = await this.loadVisible(ctx, id);
    const previous = await this.prisma.client.alertRecipientState.findUnique({ where: { alertId_userId: { alertId: alert.id, userId: ctx.userId } } });
    if (previous?.snoozedUntil) {
      await this.prisma.client.$transaction(async (tx) => {
        await tx.alertRecipientState.update({ where: { id: previous.id }, data: { snoozedUntil: null, snoozeReason: null } });
        await this.audit.record(
          ctx,
          { action: 'alerte.report_annule', objectType: 'Alert', objectId: alert.id, companyId: alert.companyId, before: { snoozedUntil: fromDbDate(previous.snoozedUntil), snoozeReason: previous.snoozeReason } },
          tx,
        );
      });
    }
    return this.view(ctx, alert);
  }

  // ---------------------------------------------------------------------------

  /**
   * Filtre de visibilité (D-244), calculé côté serveur à partir des habilitations : l'administrateur voit
   * toute l'organisation ; ailleurs, chaque société n'expose que les types visibles au rôle détenu.
   * Un compte uniquement conducteur est refusé (403).
   */
  private visibilityWhere(ctx: RequestContext): Prisma.AlertWhereInput {
    this.access.requireStaff(ctx);
    if (ctx.isAdmin) return { organizationId: ctx.organizationId };
    const byRole = new Map<MembershipRole, string[]>();
    for (const grant of ctx.grants.values()) {
      const list = byRole.get(grant.role) ?? [];
      list.push(grant.companyId);
      byRole.set(grant.role, list);
    }
    const clauses: Prisma.AlertWhereInput[] = [];
    for (const [role, companyIds] of byRole) {
      const types = visibleAlertTypes(role);
      if (types.length === 0) continue;
      clauses.push({ companyId: { in: companyIds }, ...(types.length === ALERT_TYPES.length ? {} : { type: { in: [...types] } }) });
    }
    return { organizationId: ctx.organizationId, OR: clauses.length > 0 ? clauses : [{ id: { in: [] } }] };
  }

  private companyFilter(ctx: RequestContext, companyId: string | undefined): Prisma.AlertWhereInput {
    if (!companyId) return {};
    this.access.assertCompanyReadable(ctx, companyId);
    return { companyId };
  }

  private unreadWhere(ctx: RequestContext): Prisma.AlertWhereInput {
    return { recipientStates: { none: { userId: ctx.userId, readAt: { not: null } } } };
  }

  private snoozedWhere(ctx: RequestContext, today: CivilDate): Prisma.AlertWhereInput {
    return { recipientStates: { some: { userId: ctx.userId, snoozedUntil: { gte: toDbDate(today) as Date } } } };
  }

  /** États utiles à la vue : celui de l'utilisateur courant et les reports en cours des autres destinataires. */
  private statesInclude(ctx: RequestContext, today: CivilDate) {
    return {
      recipientStates: {
        where: { OR: [{ userId: ctx.userId }, { snoozedUntil: { gte: toDbDate(today) as Date } }] },
        include: { user: { select: { firstName: true, lastName: true } } },
        orderBy: { updatedAt: 'asc' },
      },
    } satisfies Prisma.AlertInclude;
  }

  private async loadVisible(ctx: RequestContext, id: string): Promise<Alert> {
    this.access.requireStaff(ctx);
    const alert = await this.prisma.client.alert.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!alert) throw new NotFoundOrOutOfScopeError('Alerte');
    const role = this.access.roleIn(ctx, alert.companyId);
    if (!role || !alertTypeVisibleToRole(role, alert.type)) throw new NotFoundOrOutOfScopeError('Alerte');
    return alert;
  }

  private async writeState(ctx: RequestContext, alertId: string, data: { readAt?: Date; snoozedUntil?: Date | null; snoozeReason?: string | null }, tx?: Tx): Promise<void> {
    const client = tx ?? this.prisma.client;
    const where = { alertId_userId: { alertId, userId: ctx.userId } };
    try {
      await client.alertRecipientState.upsert({ where, create: { organizationId: ctx.organizationId, alertId, userId: ctx.userId, ...data }, update: data });
    } catch (error) {
      // Création concurrente de l'état du même utilisateur (hors transaction) : la ligne existe, on la met à jour.
      if (tx || !isUniqueViolation(error)) throw error;
      await client.alertRecipientState.update({ where, data });
    }
  }

  private async today(ctx: RequestContext): Promise<CivilDate> {
    const org = await this.prisma.client.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } });
    return localDate(this.clock.now(), org.timezone);
  }

  private async view(ctx: RequestContext, alert: Alert): Promise<AlertViewDto> {
    const today = await this.today(ctx);
    const row = await this.prisma.client.alert.findUniqueOrThrow({ where: { id: alert.id }, include: this.statesInclude(ctx, today) });
    const [view] = await this.views(ctx, [row], today);
    return view as AlertViewDto;
  }

  private async views(ctx: RequestContext, rows: AlertWithStates[], today: CivilDate): Promise<AlertViewDto[]> {
    if (rows.length === 0) return [];
    const companyIds = [...new Set(rows.map((r) => r.companyId))];
    const vehicleIds = [...new Set(rows.map((r) => r.vehicleId).filter((v): v is string => v !== null))];
    const responsibleIds = [...new Set(rows.map((r) => r.responsibleUserId).filter((v): v is string => v !== null))];
    const [companies, vehicles, responsibles] = await Promise.all([
      this.prisma.client.company.findMany({ where: { organizationId: ctx.organizationId, id: { in: companyIds } }, select: { id: true, legalName: true } }),
      vehicleIds.length ? this.prisma.client.vehicle.findMany({ where: { organizationId: ctx.organizationId, id: { in: vehicleIds } }, select: { id: true, code: true, registration: true } }) : Promise.resolve([]),
      responsibleIds.length ? this.prisma.client.user.findMany({ where: { organizationId: ctx.organizationId, id: { in: responsibleIds } }, select: { id: true, firstName: true, lastName: true } }) : Promise.resolve([]),
    ]);
    const companyName = new Map(companies.map((c) => [c.id, c.legalName]));
    const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
    const responsibleName = new Map(responsibles.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
    return rows.map((a) => {
      const own = a.recipientStates.find((s) => s.userId === ctx.userId);
      const ownSnoozeUntil = fromDbDate(own?.snoozedUntil);
      const ownSnoozeActive = isSnoozeActive(ownSnoozeUntil, today);
      const snoozes: AlertSnoozeInfoDto[] = a.recipientStates
        .filter((s) => isSnoozeActive(fromDbDate(s.snoozedUntil), today))
        .map((s) => ({ userId: s.userId, userName: `${s.user.firstName} ${s.user.lastName}`.trim(), until: fromDbDate(s.snoozedUntil) as string, reason: s.snoozeReason ?? '' }));
      const vehicle = a.vehicleId ? vehicleById.get(a.vehicleId) : undefined;
      const role = this.access.roleIn(ctx, a.companyId);
      return {
        id: a.id,
        type: a.type,
        typeLabel: ALERT_TYPE_LABELS[a.type],
        severity: a.severity,
        severityLabel: SEVERITY_LABELS[a.severity],
        status: a.status,
        companyId: a.companyId,
        companyName: companyName.get(a.companyId) ?? '',
        objectType: a.objectType,
        objectId: a.objectId,
        vehicleId: a.vehicleId,
        vehicleCode: vehicle?.code ?? null,
        vehicleRegistration: vehicle?.registration ?? null,
        title: a.title,
        message: a.message,
        condition: a.condition,
        actionPath: a.actionPath,
        responsibleUserId: a.responsibleUserId,
        responsibleName: (a.responsibleUserId ? responsibleName.get(a.responsibleUserId) : undefined) ?? NOT_ASSIGNED,
        triggeredAt: a.triggeredAt.toISOString(),
        lastEvaluatedAt: a.lastEvaluatedAt.toISOString(),
        resolvedAt: a.resolvedAt?.toISOString() ?? null,
        resolutionReason: a.resolutionReason,
        version: a.version,
        readAt: own?.readAt?.toISOString() ?? null,
        snoozedUntil: ownSnoozeActive ? ownSnoozeUntil : null,
        snoozeReason: ownSnoozeActive ? (own?.snoozeReason ?? null) : null,
        snoozes,
        canSnooze: a.status === 'ACTIVE' && role !== null && roleCanSnooze(role),
      };
    });
  }
}
