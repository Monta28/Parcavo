import { Injectable } from '@nestjs/common';
import type { AuditEvent, Prisma } from '@parc-auto/db';
import { sanitizeAuditValue } from '../../common/audit-redaction.js';
import { BusinessRuleError, ForbiddenActionError } from '../../common/errors.js';
import { type Page, pageOf, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import {
  assertCivilDate,
  compareCivil,
  endOfLocalDay,
  startOfLocalDay,
} from '../../domain/civil-date.js';
import { maskAuditCosts } from '../../domain/audit-cost-masking.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import {
  SYSTEM_ACTOR_LABEL,
  type AuditActionFacetDto,
  type AuditActorFacetDto,
  type AuditEventViewDto,
  type AuditObjectTypeFacetDto,
  type AuditQueryDto,
  type AuditScopeQueryDto,
} from './dto/audit.dto.js';

/** Auteur introuvable dans l'organisation (ne se produit pas : les comptes ne sont jamais supprimés). */
const UNKNOWN_USER_LABEL = 'Utilisateur inconnu';
const AUDIT_FORBIDDEN = 'Le journal d’audit est réservé à l’administrateur et au chef de parc.';

/**
 * Consultation du journal d'audit (CDC 16.1, 15.2 /audit ; D-109, D-309). Périmètre appliqué au point
 * d'accès : l'administrateur voit toute l'organisation ; le chef de parc ne lit que les événements
 * rattachés à l'une de ses sociétés de rôle CHEF_PARC (les événements sans société restent réservés à
 * l'administrateur) ; opérateur, lecteur et conducteur reçoivent 403. Les valeurs avant/après, déjà
 * expurgées à l'écriture, sont de nouveau filtrées à la lecture (clés sensibles, empreintes, jetons), et
 * leurs montants sont masqués pour un lecteur sans costs.read sur la société de l'événement (D-266).
 */
@Injectable()
export class AuditJournalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
  ) {}

  async list(ctx: RequestContext, query: AuditQueryDto): Promise<Page<AuditEventViewDto>> {
    const where = await this.where(ctx, query);
    const [rows, total] = await Promise.all([
      this.prisma.client.auditEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...skipTake(query),
      }),
      this.prisma.client.auditEvent.count({ where }),
    ]);
    const [names, companies] = await Promise.all([
      this.userNames(
        ctx,
        rows.map((r) => r.actorUserId),
      ),
      this.companyCodes(ctx),
    ]);
    return pageOf(
      rows.map((r) => this.view(ctx, r, names, companies)),
      total,
      query,
    );
  }

  /** Actions distinctes visibles (liste de valeurs du filtre « action »). */
  async actions(ctx: RequestContext, query: AuditScopeQueryDto): Promise<AuditActionFacetDto[]> {
    const where = await this.where(ctx, query);
    const groups = await this.prisma.client.auditEvent.groupBy({
      by: ['action'],
      where,
      _count: { _all: true },
      orderBy: { action: 'asc' },
    });
    return groups.map((g) => ({ action: g.action, count: g._count._all }));
  }

  /** Types d'objets distincts visibles (liste de valeurs du filtre « type d'objet »). */
  async objectTypes(
    ctx: RequestContext,
    query: AuditScopeQueryDto,
  ): Promise<AuditObjectTypeFacetDto[]> {
    const where = await this.where(ctx, query);
    const groups = await this.prisma.client.auditEvent.groupBy({
      by: ['objectType'],
      where,
      _count: { _all: true },
      orderBy: { objectType: 'asc' },
    });
    return groups.map((g) => ({ objectType: g.objectType, count: g._count._all }));
  }

  /** Acteurs distincts visibles, nom résolu (liste de valeurs du filtre « acteur »). */
  async actors(ctx: RequestContext, query: AuditScopeQueryDto): Promise<AuditActorFacetDto[]> {
    const where = await this.where(ctx, query);
    const groups = await this.prisma.client.auditEvent.groupBy({
      by: ['actorType', 'actorUserId'],
      where,
      _count: { _all: true },
    });
    const names = await this.userNames(
      ctx,
      groups.map((g) => g.actorUserId),
    );
    return groups
      .map((g) => ({
        actorType: g.actorType,
        actorUserId: g.actorUserId,
        actorName: actorName(g.actorType, g.actorUserId, names),
        count: g._count._all,
      }))
      .sort(
        (a, b) =>
          a.actorName.localeCompare(b.actorName, 'fr') ||
          (a.actorUserId ?? '').localeCompare(b.actorUserId ?? ''),
      );
  }

  // ---------------------------------------------------------------------------

  /** Filtre Prisma : périmètre serveur (jamais le client), puis filtres demandés. */
  private async where(
    ctx: RequestContext,
    query: AuditScopeQueryDto &
      Partial<
        Pick<AuditQueryDto, 'actorUserId' | 'actorType' | 'action' | 'objectType' | 'objectId'>
      >,
  ): Promise<Prisma.AuditEventWhereInput> {
    const and: Prisma.AuditEventWhereInput[] = [this.scope(ctx)];
    if (query.companyId) {
      this.assertCompanyAuditable(ctx, query.companyId);
      and.push({ companyId: query.companyId });
    }
    const period = await this.period(ctx, query.from, query.to);
    if (period) and.push({ createdAt: period });
    if (query.actorUserId) and.push({ actorUserId: query.actorUserId });
    if (query.actorType) and.push({ actorType: query.actorType });
    // Préfixe littéral : les jokers LIKE (« _ », « % ») et l'échappement ne sont pas interprétés.
    if (query.action)
      and.push({ action: { startsWith: query.action.trim().replace(/[\\%_]/g, '\\$&') } });
    if (query.objectType) and.push({ objectType: query.objectType.trim() });
    if (query.objectId) and.push({ objectId: query.objectId.trim() });
    return { AND: and };
  }

  private scope(ctx: RequestContext): Prisma.AuditEventWhereInput {
    if (ctx.isAdmin) return { organizationId: ctx.organizationId };
    const companies = this.chefCompanies(ctx);
    if (companies.length === 0) throw new ForbiddenActionError(AUDIT_FORBIDDEN);
    return { organizationId: ctx.organizationId, companyId: { in: [...companies] } };
  }

  private chefCompanies(ctx: RequestContext): readonly string[] {
    return ctx.isDriverOnly ? [] : this.access.companiesWithRole(ctx, ['CHEF_PARC']);
  }

  /** Société filtrée : invisible → 404 (sans révéler son existence) ; visible sans rôle de chef → 403. */
  private assertCompanyAuditable(ctx: RequestContext, companyId: string): void {
    if (ctx.isAdmin) return;
    this.access.assertCompanyReadable(ctx, companyId);
    if (!this.chefCompanies(ctx).includes(companyId))
      throw new ForbiddenActionError(AUDIT_FORBIDDEN);
  }

  /** Période en dates civiles incluses, converties en instants UTC dans le fuseau de l'organisation. */
  private async period(
    ctx: RequestContext,
    from: string | undefined,
    to: string | undefined,
  ): Promise<Prisma.DateTimeFilter | null> {
    if (!from && !to) return null;
    for (const [field, value] of [
      ['from', from],
      ['to', to],
    ] as const) {
      if (value === undefined) continue;
      try {
        assertCivilDate(value);
      } catch {
        throw new BusinessRuleError('PERIODE_INVALIDE', `Date invalide : ${value}.`, {
          fieldErrors: { [field]: ['Date inexistante.'] },
        });
      }
    }
    if (from && to && compareCivil(from, to) > 0) {
      throw new BusinessRuleError(
        'PERIODE_INVALIDE',
        'La date de début est postérieure à la date de fin.',
        { fieldErrors: { to: ['Doit être postérieure ou égale au début.'] } },
      );
    }
    const { timezone } = await this.prisma.client.organization.findUniqueOrThrow({
      where: { id: ctx.organizationId },
      select: { timezone: true },
    });
    return {
      ...(from ? { gte: startOfLocalDay(from, timezone) } : {}),
      ...(to ? { lte: endOfLocalDay(to, timezone) } : {}),
    };
  }

  private async userNames(
    ctx: RequestContext,
    ids: ReadonlyArray<string | null>,
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.client.user.findMany({
      where: { organizationId: ctx.organizationId, id: { in: unique } },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
  }

  private async companyCodes(ctx: RequestContext): Promise<Map<string, string>> {
    const companies = await this.prisma.client.company.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true, code: true },
    });
    return new Map(companies.map((c) => [c.id, c.code]));
  }

  /**
   * Montants lisibles seulement avec costs.read sur la société de l'événement (2.2, D-266) : un chef de parc
   * dont la permission a été retirée lit l'événement sans ses montants. Les événements sans société sont
   * réservés à l'administrateur.
   */
  private canReadCosts(ctx: RequestContext, companyId: string | null): boolean {
    if (ctx.isAdmin) return true;
    return companyId !== null && this.access.hasPermission(ctx, companyId, 'costs.read');
  }

  private view(
    ctx: RequestContext,
    r: AuditEvent,
    names: Map<string, string>,
    companies: Map<string, string>,
  ): AuditEventViewDto {
    const costs = this.canReadCosts(ctx, r.companyId);
    const values = (v: unknown): unknown =>
      costs ? sanitizeAuditValue(v) : maskAuditCosts(sanitizeAuditValue(v));
    return {
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      companyId: r.companyId,
      companyCode: r.companyId ? (companies.get(r.companyId) ?? null) : null,
      actorType: r.actorType,
      actorUserId: r.actorUserId,
      actorName: actorName(r.actorType, r.actorUserId, names),
      action: r.action,
      objectType: r.objectType,
      objectId: r.objectId,
      reason: r.reason === null ? null : (sanitizeAuditValue(r.reason) as string),
      before: values(r.before),
      after: values(r.after),
      requestId: r.requestId,
      ipAddress: r.ipAddress,
    };
  }
}

/** Nom affiché de l'acteur : l'utilisateur résolu, « Système » pour un traitement sans utilisateur. */
function actorName(
  actorType: string,
  actorUserId: string | null,
  names: Map<string, string>,
): string {
  if (actorType === 'UTILISATEUR' && actorUserId)
    return names.get(actorUserId) ?? UNKNOWN_USER_LABEL;
  return SYSTEM_ACTOR_LABEL;
}
