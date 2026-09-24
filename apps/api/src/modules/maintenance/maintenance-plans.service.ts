import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { PlanStatus, Prisma, VehicleMaintenancePlan } from '@parc-auto/db';
import type { AfterCommit } from '../../common/after-commit.js';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, ConflictError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import { type Page, pageOf, resolveSort, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import { type CivilDate, fromDbDate, localDate, startOfLocalDay, toDbDate } from '../../domain/civil-date.js';
import { computeFreshness } from '../../domain/freshness.js';
import {
  comparePlansForSort,
  computeNextDue,
  computePlanStatus,
  defaultNotices,
  truncatedKm,
  validateIntervals,
  type ComputedPlanSort,
  type IntervalsError,
  type PlanIntervals,
  type StatusResult,
} from '../../domain/maintenance-schedule.js';
import { normalizeRegistration } from '../../domain/registration.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, isRetryable, isUniqueViolation, type Tx } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { OPERATIONAL_ROLES } from '../access-control/permissions.js';
import { AlertsService } from '../alerts/alerts.service.js';
import { OdometerEventsService } from '../odometer/odometer-events.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { VehiclesService } from '../vehicles/vehicles.service.js';
import { PLAN_SORTS, type CreatePlanDto, type DeactivatePlanDto, type IntervalsDto, type PlanBaseDto, type PlanSort, type PlanViewDto, type PlansQueryDto, type ReactivatePlanDto, type UpdatePlanDto } from './dto/maintenance.dto.js';

const planInclude = { maintenanceType: { select: { label: true, status: true } }, vehicle: { select: { code: true, companyId: true, lifecycleStatus: true } } } satisfies Prisma.VehicleMaintenancePlanInclude;
type PlanRow = Prisma.VehicleMaintenancePlanGetPayload<{ include: typeof planInclude }>;
/** Forme minimale acceptée par la vue (le rapport d'échéances fournit ses propres inclusions). */
type PlanViewSource = VehicleMaintenancePlan & { maintenanceType: { label: string }; vehicle: { code: string } };

/** Champs d'un plan nécessaires à l'évaluation de son statut (intervalles, relevés admis, rattachements). */
type PlanCore = Pick<VehicleMaintenancePlan, 'id' | 'organizationId' | 'companyId' | 'vehicleId' | 'acceptedSources' | 'intervalKm' | 'intervalMonths' | 'intervalDays' | 'noticeKm' | 'noticeDays'>;


const SEVERITY: Record<PlanStatus, 'INFO' | 'ATTENTION' | 'URGENT' | 'CRITIQUE'> = { A_PREVOIR: 'ATTENTION', A_FAIRE: 'URGENT', EN_RETARD: 'CRITIQUE', A_JOUR: 'INFO', INCOMPLET: 'ATTENTION' };
const STATUS_LABEL: Record<PlanStatus, string> = { A_PREVOIR: 'à prévoir', A_FAIRE: 'à faire', EN_RETARD: 'en retard', A_JOUR: 'à jour', INCOMPLET: 'incomplet' };
const URGENT_STATUSES: PlanStatus[] = ['A_FAIRE', 'EN_RETARD'];
const COMPUTED_SORTS: readonly PlanSort[] = ['urgence', 'resteKm', 'resteJours'];
/** Taille des lots de rafraîchissement à la lecture. */
const REFRESH_BATCH = 500;

type KmSource = 'ESTIME_GPS' | 'COMPTEUR_CAN' | 'COMPTEUR_AFFICHE';

interface CurrentReading {
  cumulativeKm: Decimal | null;
  isEstimate: boolean;
  measurementKind: string;
  observedAt: Date;
}

/**
 * Données d'évaluation chargées en lot pour un ensemble de plans (aucune requête par plan) : fuseau de
 * l'organisation, dernier relevé accepté par véhicule (tous relevés, et manuel/CAN seulement), cumul
 * connu du segment ouvert et seuil de fraîcheur par société.
 */
interface EvaluationContext {
  now: Date;
  timezones: Map<string, string>;
  readings: Map<string, { all: CurrentReading | null; physical: CurrentReading | null }>;
  cumulativeKnown: Map<string, boolean>;
  staleDays: Map<string, number>;
}

interface LiveStatus extends StatusResult {
  currentKm: Decimal | null;
  currentKmSource: KmSource | null;
  currentKmObservedAt: Date | null;
}

export interface PlanEvaluation extends StatusResult {
  nextDueKm: Decimal | null;
  nextDueDate: string | null;
  baseKm: Decimal | null;
  baseDate: string | null;
  baseTaskId: string | null;
  currentKm: Decimal | null;
  /** Nature du kilométrage retenu : ESTIME_GPS, COMPTEUR_CAN ou COMPTEUR_AFFICHE (D-179). */
  currentKmSource: KmSource | null;
  currentKmObservedAt: Date | null;
}

/**
 * Plans d'entretien véhicule/opération (CDC 6.1, 6.2) : échéances et statuts matérialisés, recalculés
 * après chaque relevé accepté, chaque clôture d'intervention, par le rattrapage périodique et, à la
 * lecture, pour les plans dont le statut date d'avant le jour local courant ; toujours recalculables
 * depuis les opérations validées (maintenance-schedule.ts). Le statut filtré, trié et affiché est
 * toujours la valeur matérialisée (une seule source).
 */
@Injectable()
export class MaintenancePlansService implements OnModuleInit {
  private readonly logger = new Logger(MaintenancePlansService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly vehicles: VehiclesService,
    private readonly settings: SettingsService,
    private readonly alerts: AlertsService,
    private readonly events: OdometerEventsService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    // Un relevé accepté (manuel, import ou télématique) recalcule les échéances du véhicule (T15, T42).
    this.events.onAccepted('entretien', async (event) => {
      await this.recomputeVehicle(event.vehicleId);
    });
    // Correction d'un relevé accepté (5.3, 13.3) : échéances et alertes recalculées dans la transaction de correction.
    this.events.onDependentsInTx('entretien', async (tx, event, after) => {
      await this.recomputeVehicleInTx(tx, event.vehicleId, after);
    });
  }

  // ---------------------------------------------------------------------------
  // Lecture
  // ---------------------------------------------------------------------------

  async list(ctx: RequestContext, query: PlansQueryDto): Promise<Page<PlanViewDto>> {
    this.access.requireStaff(ctx);
    const q = query.q?.trim();
    const registration = q ? normalizeRegistration(q) : '';
    const scope: Prisma.VehicleMaintenancePlanWhereInput = {
      ...this.access.companyWhere(ctx, query.companyId),
      ...(query.vehicleId ? { vehicleId: query.vehicleId } : {}),
      ...(q
        ? {
            OR: [
              { vehicle: { code: { contains: q, mode: 'insensitive' } } },
              ...(registration ? [{ vehicle: { registrationNormalized: { contains: registration } } }] : []),
              { maintenanceType: { label: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    // Les échéances en date changent avec le jour local : statut matérialisé à jour avant de filtrer.
    const timezone = await this.timezone(ctx.organizationId);
    await this.refreshStale(scope, timezone);
    const statusFilters: Prisma.VehicleMaintenancePlanWhereInput[] = [];
    if (query.status) statusFilters.push({ computedStatus: query.status });
    if (query.urgent === 'true') statusFilters.push({ computedStatus: { in: URGENT_STATUSES } });
    const where: Prisma.VehicleMaintenancePlanWhereInput = {
      ...scope,
      ...(query.includeInactive === 'true' ? {} : { active: true }),
      ...(statusFilters.length > 0 ? { AND: statusFilters } : {}),
    };
    const sort = resolveSort(query.sort, PLAN_SORTS, 'echeance');
    const order = query.order === 'desc' ? 'desc' : 'asc';
    const known = new Map([[ctx.organizationId, timezone]]);

    if ((COMPUTED_SORTS as readonly string[]).includes(sort)) {
      // Tri sur des restes calculés : projection légère de tous les plans filtrés, restes évalués en lot
      // par la règle unique (computePlanStatus), puis chargement de la seule page.
      const all = await this.prisma.client.vehicleMaintenancePlan.findMany({
        where,
        select: { id: true, organizationId: true, companyId: true, vehicleId: true, acceptedSources: true, intervalKm: true, intervalMonths: true, intervalDays: true, noticeKm: true, noticeDays: true, nextDueKm: true, nextDueDate: true, computedStatus: true },
      });
      const context = await this.loadContext(undefined, all, known);
      const entries = all.map((p) => {
        const live = this.liveStatus(p, materializedDue(p), context);
        return { id: p.id, status: p.computedStatus, remainingKm: live.remainingKm, remainingDays: live.remainingDays };
      });
      entries.sort((a, b) => comparePlansForSort(sort as ComputedPlanSort, order, a, b));
      const { skip, take } = skipTake(query);
      const pageIds = entries.slice(skip, skip + take).map((e) => e.id);
      const rows = pageIds.length > 0 ? await this.prisma.client.vehicleMaintenancePlan.findMany({ where: { id: { in: pageIds } }, include: planInclude }) : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered = pageIds.map((id) => byId.get(id)).filter((r): r is PlanRow => r !== undefined);
      const names = await this.responsibleNames(undefined, ctx.organizationId, ordered);
      return pageOf(ordered.map((p) => this.toView(p, context, names)), entries.length, query);
    }

    const [items, total] = await Promise.all([
      this.prisma.client.vehicleMaintenancePlan.findMany({ where, ...skipTake(query), orderBy: storedOrder(sort, order), include: planInclude }),
      this.prisma.client.vehicleMaintenancePlan.count({ where }),
    ]);
    const [context, names] = await Promise.all([this.loadContext(undefined, items, known), this.responsibleNames(undefined, ctx.organizationId, items)]);
    return pageOf(items.map((p) => this.toView(p, context, names)), total, query);
  }

  async get(ctx: RequestContext, id: string): Promise<PlanViewDto> {
    return this.view(await this.loadFresh(ctx, id));
  }

  // ---------------------------------------------------------------------------
  // Écriture
  // ---------------------------------------------------------------------------

  async create(ctx: RequestContext, dto: CreatePlanDto): Promise<PlanViewDto> {
    const vehicle = await this.vehicles.load(ctx, dto.vehicleId);
    this.access.requireManager(ctx, vehicle.companyId);
    try {
      const id = await this.prisma.client.$transaction((tx) => this.createInTx(tx, ctx, { id: vehicle.id, companyId: vehicle.companyId }, dto));
      await this.syncAlerts(id);
      return this.get(ctx, id);
    } catch (error) {
      if (isUniqueViolation(error, 'maintenance_plan_one_active_per_type')) throw new ConflictError('PLAN_EXISTANT', 'Un plan actif existe déjà pour ce véhicule et cette opération.');
      throw error;
    }
  }

  /**
   * Création d'un plan dans une transaction existante (formulaire ou import de bases, 12.2, D-279) :
   * intervalles, base et responsable validés, échéance matérialisée, audit. Les alertes sont
   * synchronisées par l'appelant après validation (syncAlerts). Aucune intervention ni dépense n'est créée.
   */
  async createInTx(tx: Tx, ctx: RequestContext, vehicle: { id: string; companyId: string }, dto: Omit<CreatePlanDto, 'vehicleId'>): Promise<string> {
    const type = await tx.maintenanceType.findFirst({ where: { id: dto.maintenanceTypeId, organizationId: ctx.organizationId, status: 'ACTIF' } });
    if (!type) throw new NotFoundOrOutOfScopeError('Type d’opération');
    const existing = await tx.vehicleMaintenancePlan.findFirst({ where: { vehicleId: vehicle.id, maintenanceTypeId: type.id, active: true }, select: { id: true } });
    if (existing) throw new ConflictError('PLAN_EXISTANT', 'Un plan actif existe déjà pour ce véhicule et cette opération.');
    await this.assertResponsible(tx, ctx.organizationId, dto.responsibleUserId ?? null, vehicle.companyId);
    const intervals = await this.intervals(ctx.organizationId, vehicle.companyId, dto);
    const base = validateBase(dto.base, intervals);
    const plan = await tx.vehicleMaintenancePlan.create({
      data: {
        organizationId: ctx.organizationId,
        companyId: vehicle.companyId,
        vehicleId: vehicle.id,
        maintenanceTypeId: type.id,
        intervalKm: intervals.intervalKm?.toString() ?? null,
        intervalMonths: intervals.intervalMonths,
        intervalDays: intervals.intervalDays,
        noticeKm: intervals.noticeKm?.toString() ?? null,
        noticeDays: intervals.noticeDays,
        baseMode: base.baseMode,
        initialBaseKm: base.baseKm,
        initialBaseDate: toDbDate(base.baseDate),
        initialNextDueKm: base.nextDueKm,
        initialNextDueDate: toDbDate(base.nextDueDate),
        acceptedSources: dto.acceptedSources ?? 'TOUTES',
        responsibleUserId: dto.responsibleUserId ?? null,
        createdById: ctx.userId,
      },
    });
    await this.recomputePlan(tx, plan.id);
    await this.audit.record(ctx, { action: 'plan_entretien.creation', objectType: 'VehicleMaintenancePlan', objectId: plan.id, companyId: vehicle.companyId, after: { maintenanceType: type.code, ...dto } }, tx);
    return plan.id;
  }

  /**
   * Modification d'un plan : affecte les échéances futures, jamais les travaux historiques. Avec
   * preview=true, renvoie l'impact calculé sans rien enregistrer (17.1).
   */
  async update(ctx: RequestContext, id: string, dto: UpdatePlanDto): Promise<PlanViewDto & { preview: boolean; before?: PlanViewDto }> {
    // État « avant » (prévisualisation, audit) : statut matérialisé du jour local, comme la liste et la fiche.
    const plan = await this.loadFresh(ctx, id);
    this.access.requireManager(ctx, plan.companyId);
    assertExpectedVersion(plan, dto.expectedVersion, 'plan');
    if (!plan.active) throw new ConflictError('ETAT_INVALIDE', 'Plan désactivé.');
    // Un responsable inchangé n'est pas revérifié : modifier les intervalles reste possible.
    if (dto.responsibleUserId !== undefined && dto.responsibleUserId !== plan.responsibleUserId) await this.assertResponsible(undefined, ctx.organizationId, dto.responsibleUserId, plan.companyId);
    const merged: IntervalsDto = {
      intervalKm: dto.intervalKm !== undefined ? dto.intervalKm : (plan.intervalKm?.toString() ?? null),
      intervalMonths: dto.intervalMonths !== undefined ? dto.intervalMonths : plan.intervalMonths,
      intervalDays: dto.intervalDays !== undefined ? dto.intervalDays : plan.intervalDays,
      noticeKm: dto.noticeKm !== undefined ? dto.noticeKm : (plan.noticeKm?.toString() ?? null),
      noticeDays: dto.noticeDays !== undefined ? dto.noticeDays : plan.noticeDays,
    };
    const intervals = await this.intervals(ctx.organizationId, plan.companyId, merged);
    const base = dto.base ? validateBase(dto.base, intervals) : null;
    const before = await this.view(plan);
    const data: Prisma.VehicleMaintenancePlanUncheckedUpdateInput = {
      intervalKm: intervals.intervalKm?.toString() ?? null,
      intervalMonths: intervals.intervalMonths,
      intervalDays: intervals.intervalDays,
      noticeKm: intervals.noticeKm?.toString() ?? null,
      noticeDays: intervals.noticeDays,
      ...(dto.acceptedSources ? { acceptedSources: dto.acceptedSources } : {}),
      ...(dto.responsibleUserId !== undefined ? { responsibleUserId: dto.responsibleUserId } : {}),
      ...(base ? { baseMode: base.baseMode, initialBaseKm: base.baseKm, initialBaseDate: toDbDate(base.baseDate), initialNextDueKm: base.nextDueKm, initialNextDueDate: toDbDate(base.nextDueDate) } : {}),
    };
    if (dto.preview) {
      // Calcul dans une transaction annulée : aucun effet persistant.
      const previewView = await this.prisma.client
        .$transaction(async (tx) => {
          await tx.vehicleMaintenancePlan.update({ where: { id }, data });
          await this.recomputePlan(tx, id);
          const updated = await tx.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id }, include: planInclude });
          const v = await this.view(updated, tx);
          throw new PreviewRollback(v);
        })
        .catch((error: unknown) => {
          if (error instanceof PreviewRollback) return error.view;
          throw error;
        });
      return { ...previewView, preview: true, before };
    }
    await this.prisma.client.$transaction(async (tx) => {
      await tx.vehicleMaintenancePlan.update({ where: { id, version: dto.expectedVersion }, data: { ...data, version: { increment: 1 } } });
      await this.recomputePlan(tx, id);
      await this.audit.record(ctx, { action: 'plan_entretien.modification', objectType: 'VehicleMaintenancePlan', objectId: id, companyId: plan.companyId, reason: dto.reason, before, after: { ...merged, base: dto.base, responsibleUserId: dto.responsibleUserId } }, tx);
    });
    await this.syncAlerts(id);
    return { ...(await this.get(ctx, id)), preview: false };
  }

  async deactivate(ctx: RequestContext, id: string, dto: DeactivatePlanDto): Promise<PlanViewDto> {
    const plan = await this.load(ctx, id);
    this.access.requireManager(ctx, plan.companyId);
    assertExpectedVersion(plan, dto.expectedVersion, 'plan');
    if (!plan.active) throw new ConflictError('ETAT_INVALIDE', 'Ce plan est déjà désactivé.');
    await this.prisma.client.$transaction(async (tx) => {
      // Condition active=true en plus de la version : une désactivation concurrente échoue (409).
      await tx.vehicleMaintenancePlan.update({ where: { id, version: dto.expectedVersion, active: true }, data: { active: false, deactivatedAt: this.clock.now(), deactivationReason: dto.reason.trim(), version: { increment: 1 } } });
      await this.audit.record(ctx, { action: 'plan_entretien.desactivation', objectType: 'VehicleMaintenancePlan', objectId: id, companyId: plan.companyId, reason: dto.reason }, tx);
    });
    await this.syncAlerts(id);
    return this.get(ctx, id);
  }

  /**
   * Réactivation motivée d'un plan désactivé (chef de parc ou administrateur) : refusée si un autre plan
   * actif suit déjà cette opération sur ce véhicule, si l'opération est archivée au catalogue ou si le
   * véhicule est cédé ou archivé. Échéance et statut sont recalculés depuis les opérations validées.
   */
  async reactivate(ctx: RequestContext, id: string, dto: ReactivatePlanDto): Promise<PlanViewDto> {
    const plan = await this.load(ctx, id);
    this.access.requireManager(ctx, plan.companyId);
    assertExpectedVersion(plan, dto.expectedVersion, 'plan');
    if (plan.active) throw new ConflictError('ETAT_INVALIDE', 'Ce plan est déjà actif.');
    if (plan.maintenanceType.status !== 'ACTIF') throw new BusinessRuleError('TYPE_ARCHIVE', `L’opération « ${plan.maintenanceType.label} » est archivée au catalogue : réactivez-la d’abord.`);
    if (plan.vehicle.lifecycleStatus === 'CEDE' || plan.vehicle.lifecycleStatus === 'ARCHIVE') throw new BusinessRuleError('VEHICULE_INACTIF', `Le véhicule ${plan.vehicle.code} est cédé ou archivé.`);
    const other = await this.prisma.client.vehicleMaintenancePlan.findFirst({ where: { vehicleId: plan.vehicleId, maintenanceTypeId: plan.maintenanceTypeId, active: true }, select: { id: true } });
    if (other) throw new ConflictError('PLAN_EXISTANT', 'Un autre plan actif suit déjà cette opération sur ce véhicule.', { planId: other.id });
    try {
      await this.prisma.client.$transaction(async (tx) => {
        await tx.vehicleMaintenancePlan.update({ where: { id, version: dto.expectedVersion, active: false }, data: { active: true, deactivatedAt: null, deactivationReason: null, version: { increment: 1 } } });
        await this.recomputePlan(tx, id);
        await this.audit.record(ctx, { action: 'plan_entretien.reactivation', objectType: 'VehicleMaintenancePlan', objectId: id, companyId: plan.companyId, reason: dto.reason, before: { active: false, deactivationReason: plan.deactivationReason } }, tx);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'maintenance_plan_one_active_per_type')) throw new ConflictError('PLAN_EXISTANT', 'Un autre plan actif suit déjà cette opération sur ce véhicule.');
      throw error;
    }
    await this.syncAlerts(id);
    return this.get(ctx, id);
  }

  // ---------------------------------------------------------------------------
  // Recalcul (matérialisation) et alertes
  // ---------------------------------------------------------------------------

  /** Évalue un plan depuis les opérations validées et le compteur courant admissible (tx absente : hors transaction). */
  async evaluate(tx: Tx | undefined, plan: VehicleMaintenancePlan): Promise<PlanEvaluation> {
    return (await this.evaluateMany(tx, [plan])).get(plan.id) as PlanEvaluation;
  }

  /**
   * Évaluation en lot : une requête pour les opérations réalisées de tous les plans, une pour les
   * relevés courants de tous les véhicules, une pour les segments, une par société pour la fraîcheur.
   */
  async evaluateMany(tx: Tx | undefined, plans: readonly VehicleMaintenancePlan[]): Promise<Map<string, PlanEvaluation>> {
    const out = new Map<string, PlanEvaluation>();
    if (plans.length === 0) return out;
    const db = tx ?? this.prisma.client;
    const vehicleIds = [...new Set(plans.map((p) => p.vehicleId))];
    const [context, tasks] = await Promise.all([
      this.loadContext(tx, plans),
      // Opérations effectivement terminées de ce type sur ce véhicule (liées au plan, à un plan antérieur
      // du même type, ou saisies sans plan) : seules elles mettent à jour la base (6.4).
      db.interventionTask.findMany({
        where: {
          completed: true,
          intervention: { status: 'TERMINEE', vehicleId: { in: vehicleIds } },
          OR: [{ planId: { in: plans.map((p) => p.id) } }, { maintenanceTypeId: { in: [...new Set(plans.map((p) => p.maintenanceTypeId))] } }],
        },
        select: { id: true, planId: true, maintenanceTypeId: true, intervention: { select: { vehicleId: true, performedOn: true, performedKm: true } } },
      }),
    ]);
    const tasksByVehicle = new Map<string, typeof tasks>();
    for (const t of tasks) {
      const list = tasksByVehicle.get(t.intervention.vehicleId) ?? [];
      list.push(t);
      tasksByVehicle.set(t.intervention.vehicleId, list);
    }
    for (const plan of plans) {
      const timezone = context.timezones.get(plan.organizationId) as string;
      const operations = (tasksByVehicle.get(plan.vehicleId) ?? []).filter((t) => t.planId === plan.id || t.maintenanceTypeId === plan.maintenanceTypeId);
      const due = computeNextDue(planIntervals(plan), {
        mode: plan.baseMode,
        initialDueSince: localDate(plan.createdAt, timezone),
        initialBaseKm: dec(plan.initialBaseKm),
        initialBaseDate: fromDbDate(plan.initialBaseDate),
        initialNextDueKm: dec(plan.initialNextDueKm),
        initialNextDueDate: fromDbDate(plan.initialNextDueDate),
        operations: operations.map((t) => ({ taskId: t.id, date: fromDbDate(t.intervention.performedOn), km: dec(t.intervention.performedKm) })),
      });
      const live = this.liveStatus(plan, { nextDueKm: due.nextDueKm, nextDueDate: due.nextDueDate }, context);
      out.set(plan.id, {
        ...live,
        nextDueKm: due.nextDueKm,
        nextDueDate: due.nextDueDate,
        baseKm: due.base?.km ?? null,
        baseDate: due.base?.date ?? null,
        baseTaskId: due.base?.taskId ?? null,
      });
    }
    return out;
  }

  async recomputePlan(tx: Tx, planId: string): Promise<PlanEvaluation> {
    const plan = await tx.vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: planId } });
    const evaluations = await this.evaluateMany(tx, [plan]);
    await this.materialize(tx, [plan], evaluations, { force: true });
    return evaluations.get(planId) as PlanEvaluation;
  }

  /** Matérialise plusieurs plans dans la transaction ; renvoie ceux dont l'échéance ou le statut a changé. */
  async recomputePlans(tx: Tx, plans: readonly VehicleMaintenancePlan[]): Promise<string[]> {
    return this.materialize(tx, plans, await this.evaluateMany(tx, plans), { force: false });
  }

  async recomputeVehicle(vehicleId: string): Promise<void> {
    const plans = await this.prisma.client.vehicleMaintenancePlan.findMany({ where: { vehicleId, active: true }, select: { id: true } });
    for (const p of plans) {
      await this.prisma.client.$transaction((tx) => this.recomputePlan(tx, p.id));
      await this.syncAlerts(p.id);
    }
  }

  /**
   * Recalcul transactionnel des plans actifs d'un véhicule (correction d'un relevé accepté, CDC 5.3 et 13.3) :
   * plans verrouillés dans l'ordre des identifiants, échéances et statuts matérialisés, alertes d'échéance
   * synchronisées dans la même transaction ; les notifications partent après validation (after).
   */
  async recomputeVehicleInTx(tx: Tx, vehicleId: string, after: AfterCommit): Promise<string[]> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "VehicleMaintenancePlan" WHERE "vehicleId" = ${vehicleId}::uuid AND "active" = true ORDER BY "id" FOR UPDATE`;
    if (locked.length === 0) return [];
    const plans = await tx.vehicleMaintenancePlan.findMany({ where: { id: { in: locked.map((l) => l.id) } }, orderBy: { id: 'asc' } });
    await this.materialize(tx, plans, await this.evaluateMany(tx, plans), { force: true });
    for (const plan of plans) await this.syncAlerts(plan.id, tx, after);
    return plans.map((plan) => plan.id);
  }

  /** Rattrapage (15 min) : transitions temporelles et événements manqués. Idempotent. */
  async recomputeAll(organizationId?: string): Promise<number> {
    const plans = await this.prisma.client.vehicleMaintenancePlan.findMany({ where: { active: true, ...(organizationId ? { organizationId } : {}) }, select: { id: true } });
    for (const p of plans) {
      try {
        await this.prisma.client.$transaction((tx) => this.recomputePlan(tx, p.id));
        await this.syncAlerts(p.id);
      } catch (error) {
        this.logger.error(`Recalcul du plan ${p.id} en échec : ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return plans.length;
  }

  /**
   * Alertes d'échéance : une occurrence par échéance, gravité évolutive, résolution quand la condition cesse.
   * Avec `tx`, les alertes sont écrites dans la transaction de l'appelant (clôture d'intervention, 6.4) et
   * les notifications partent après validation via `after`.
   */
  async syncAlerts(planId: string, tx?: Tx, after?: AfterCommit): Promise<void> {
    const plan = await (tx ?? this.prisma.client).vehicleMaintenancePlan.findUniqueOrThrow({ where: { id: planId }, include: { maintenanceType: { select: { label: true } }, vehicle: { select: { code: true, lifecycleStatus: true } } } });
    const key = { organizationId: plan.organizationId, type: 'ENTRETIEN_ECHEANCE' as const, objectType: 'VehicleMaintenancePlan', objectId: plan.id };
    const incompleteKey = { ...key, type: 'ENTRETIEN_PLAN_INCOMPLET' as const };
    if (!plan.active || plan.vehicle.lifecycleStatus !== 'ACTIF') {
      // D-171 : statuts calculés et affichés, mais aucune alerte pour un véhicule hors service, cédé ou archivé.
      const reason = !plan.active ? 'plan désactivé' : plan.vehicle.lifecycleStatus === 'HORS_SERVICE' ? 'véhicule hors service' : 'véhicule cédé ou archivé';
      await this.alerts.resolve(key, reason, tx);
      await this.alerts.resolve(incompleteKey, reason, tx);
      return;
    }
    const status = plan.computedStatus;
    if (status === 'INCOMPLET') {
      await this.alerts.resolve(key, 'plan incomplet', tx);
      await this.alerts.raise({ ...incompleteKey, companyId: plan.companyId, severity: 'ATTENTION', vehicleId: plan.vehicleId, occurrenceKey: 'incomplet', title: `Plan d’entretien incomplet — ${plan.vehicle.code}`, message: `${plan.maintenanceType.label} : base ou kilométrage manquant, échéance non calculable.`, condition: { planId: plan.id }, actionPath: `/entretiens?plan=${plan.id}`, responsibleUserId: plan.responsibleUserId }, tx, after);
      return;
    }
    await this.alerts.resolve(incompleteKey, 'plan complété', tx);
    // Clé d'occurrence (identifiant technique, inchangé) ; les textes affichent des km tronqués (13.1).
    const occurrenceKey = `echeance:${plan.nextDueKm?.toFixed(0) ?? '-'}:${fromDbDate(plan.nextDueDate) ?? '-'}`;
    await this.alerts.resolveOtherOccurrences(key, occurrenceKey, 'nouvelle échéance (entretien réalisé ou plan modifié)', tx);
    if (status === 'A_JOUR') {
      await this.alerts.resolve(key, 'échéance non atteinte', tx);
      return;
    }
    const dueKm = truncatedKm(dec(plan.nextDueKm));
    const dueDate = fromDbDate(plan.nextDueDate);
    await this.alerts.raise({
      ...key,
      companyId: plan.companyId,
      severity: SEVERITY[status],
      vehicleId: plan.vehicleId,
      occurrenceKey,
      title: `Entretien ${STATUS_LABEL[status]} — ${plan.vehicle.code}`,
      message: `${plan.maintenanceType.label} : échéance ${dueKm ? `${dueKm} km` : ''}${dueKm && dueDate ? ' / ' : ''}${dueDate ?? ''} — ${STATUS_LABEL[status]}.`,
      condition: { planId: plan.id, status, nextDueKm: plan.nextDueKm?.toString() ?? null, nextDueDate: dueDate },
      actionPath: `/entretiens?plan=${plan.id}`,
      responsibleUserId: plan.responsibleUserId,
    }, tx, after);
  }

  // ---------------------------------------------------------------------------

  async load(ctx: RequestContext, id: string): Promise<PlanRow> {
    const p = await this.prisma.client.vehicleMaintenancePlan.findFirst({ where: { id, organizationId: ctx.organizationId }, include: planInclude });
    if (!p || !this.access.canReadCompany(ctx, p.companyId) || ctx.isDriverOnly) throw new NotFoundOrOutOfScopeError('Plan d’entretien');
    return p;
  }

  /**
   * Plan dont le statut matérialisé date du jour local courant : un plan actif calculé avant est
   * d'abord rafraîchi (refreshStale), sans changer sa version. Sert à tout affichage d'un plan.
   */
  private async loadFresh(ctx: RequestContext, id: string): Promise<PlanRow> {
    const plan = await this.load(ctx, id);
    if (!plan.active) return plan;
    const timezone = await this.timezone(ctx.organizationId);
    return (await this.refreshStale({ id: plan.id, organizationId: ctx.organizationId }, timezone)) ? this.load(ctx, id) : plan;
  }

  /** Préavis par défaut paramétrés (maintenance.noticeKm / noticeDays) pour une société, ou le groupe. */
  async noticeDefaults(organizationId: string, companyId: string | null): Promise<{ noticeKm: number; noticeDays: number }> {
    const [noticeKm, noticeDays] = await Promise.all([this.settings.get(organizationId, 'maintenance.noticeKm', companyId ?? undefined), this.settings.get(organizationId, 'maintenance.noticeDays', companyId ?? undefined)]);
    return { noticeKm, noticeDays };
  }

  /**
   * Intervalles résolus (6.1, D-197) avec préavis par défaut pour le seul composant présent, et erreurs
   * de validation par champ (clés préfixées, ex. « items.2.noticeKm » pour une ligne de modèle).
   */
  resolveIntervals(dto: IntervalsDto, defaultsValue: { noticeKm: number; noticeDays: number }, fieldPrefix = ''): { intervals: PlanIntervals; errors: IntervalsError[]; fieldErrors: Record<string, string[]> } {
    const intervalKm = dto.intervalKm ? new Decimal(dto.intervalKm) : null;
    const intervalMonths = dto.intervalMonths ?? null;
    const intervalDays = dto.intervalDays ?? null;
    const defaults = defaultNotices({ intervalKm, intervalMonths, intervalDays }, defaultsValue);
    const intervals: PlanIntervals = {
      intervalKm,
      intervalMonths,
      intervalDays,
      noticeKm: intervalKm ? (dto.noticeKm ? new Decimal(dto.noticeKm) : defaults.noticeKm) : null,
      noticeDays: intervalMonths || intervalDays ? (dto.noticeDays ?? defaults.noticeDays) : null,
    };
    const errors = validateIntervals(intervals);
    return { intervals, errors, fieldErrors: intervalFieldErrors(errors, fieldPrefix) };
  }

  /** Intervalles validés (6.1, D-197) ; 422 avec les erreurs par champ sinon. */
  async intervals(organizationId: string, companyId: string | null, dto: IntervalsDto): Promise<PlanIntervals> {
    const r = this.resolveIntervals(dto, await this.noticeDefaults(organizationId, companyId));
    if (r.errors.length > 0) throw new BusinessRuleError(r.errors[0] as string, INTERVAL_MESSAGES[r.errors[0] as IntervalsError], { fieldErrors: r.fieldErrors });
    return r.intervals;
  }

  /**
   * Responsable d'un plan (6.1) : compte ACTIF de l'organisation, administrateur groupe ou habilité
   * (administrateur, chef de parc, opérateur) sur la société du plan. Même réponse dans tous les cas
   * de refus : l'existence d'un compte hors périmètre n'est pas révélée.
   */
  async assertResponsible(tx: Tx | undefined, organizationId: string, userId: string | null, companyId: string): Promise<void> {
    if (!userId) return;
    const membership = await (tx ?? this.prisma.client).membership.findFirst({
      where: { userId, organizationId, user: { organizationId, status: 'ACTIF' }, OR: [{ companyId: null, role: 'ADMIN' }, { companyId, role: { in: [...OPERATIONAL_ROLES] } }] },
      select: { id: true },
    });
    if (!membership) {
      throw new BusinessRuleError('RESPONSABLE_INVALIDE', 'Le responsable doit être un compte actif habilité (administrateur, chef de parc ou opérateur) sur la société du plan.', {
        fieldErrors: { responsibleUserId: ['Compte inconnu, désactivé ou sans habilitation sur la société du plan.'] },
      });
    }
  }

  /** Vue d'un plan : échéances et statut matérialisés, restes et avertissements évalués au présent. */
  async view(p: PlanViewSource, tx?: Tx): Promise<PlanViewDto> {
    const [context, names] = await Promise.all([this.loadContext(tx, [p]), this.responsibleNames(tx, p.organizationId, [p])]);
    return this.toView(p, context, names);
  }

  /** Vues d'un lot de plans d'une même organisation : contexte d'évaluation chargé une seule fois. */
  async views(rows: readonly PlanViewSource[], tx?: Tx): Promise<PlanViewDto[]> {
    if (rows.length === 0) return [];
    const [context, names] = await Promise.all([this.loadContext(tx, rows), this.responsibleNames(tx, (rows[0] as PlanViewSource).organizationId, rows)]);
    return rows.map((p) => this.toView(p, context, names));
  }

  /**
   * Statut matérialisé des plans actifs de ces véhicules ramené au jour local courant (comme la liste),
   * avant un calcul d'impact « avant/après ».
   */
  async refreshForVehicles(organizationId: string, vehicleIds: readonly string[]): Promise<void> {
    if (vehicleIds.length === 0) return;
    await this.refreshScope(organizationId, { vehicleId: { in: [...vehicleIds] } });
  }

  /** Même rafraîchissement pour un périmètre de plans (calendrier des échéances) ; renvoie le fuseau. */
  async refreshScope(organizationId: string, scope: Prisma.VehicleMaintenancePlanWhereInput): Promise<string> {
    const timezone = await this.timezone(organizationId);
    await this.refreshStale({ AND: [scope, { organizationId }] }, timezone);
    return timezone;
  }

  // ---------------------------------------------------------------------------
  // Internes
  // ---------------------------------------------------------------------------

  private async timezone(organizationId: string): Promise<string> {
    const org = await this.prisma.client.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } });
    return org.timezone;
  }

  /**
   * Rafraîchit la matérialisation des plans actifs du périmètre calculés avant le début du jour local
   * courant (transitions de date sans événement, D-200). Les lignes sont verrouillées dans l'ordre des
   * identifiants et la condition est réévaluée après verrouillage : deux lectures concurrentes ne
   * recalculent pas deux fois le même plan. Renvoie vrai si au moins un plan a été recalculé.
   */
  private async refreshStale(scope: Prisma.VehicleMaintenancePlanWhereInput, timezone: string): Promise<boolean> {
    const now = this.clock.now();
    const dayStart = startOfLocalDay(localDate(now, timezone), timezone);
    const stale = await this.prisma.client.vehicleMaintenancePlan.findMany({
      where: { AND: [scope, { active: true }, { OR: [{ statusComputedAt: null }, { statusComputedAt: { lt: dayStart } }] }] },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    if (stale.length === 0) return false;
    const changed: string[] = [];
    // Lots bornés : transactions courtes et nombre de paramètres maîtrisé.
    for (let i = 0; i < stale.length; i += REFRESH_BATCH) {
      const ids = stale.slice(i, i + REFRESH_BATCH).map((s) => s.id);
      for (let attempt = 0; ; attempt += 1) {
        try {
          changed.push(
            ...(await this.prisma.client.$transaction(
              async (tx) => {
                const locked = await tx.$queryRaw<Array<{ id: string }>>`
                  SELECT "id" FROM "VehicleMaintenancePlan"
                  WHERE "id" = ANY(${ids}::uuid[]) AND "active" = true AND ("statusComputedAt" IS NULL OR "statusComputedAt" < ${dayStart})
                  ORDER BY "id" FOR UPDATE`;
                if (locked.length === 0) return [];
                const plans = await tx.vehicleMaintenancePlan.findMany({ where: { id: { in: locked.map((l) => l.id) } } });
                return this.recomputePlans(tx, plans);
              },
              { maxWait: 5_000, timeout: 60_000 },
            )),
          );
          break;
        } catch (error) {
          // Interblocage ou conflit avec une écriture concurrente (clôture, relevé) : nouvelle tentative bornée.
          if (isRetryable(error) && attempt < 2) continue;
          throw error;
        }
      }
    }
    for (const planId of changed) {
      try {
        await this.syncAlerts(planId);
      } catch (error) {
        // Une synchronisation concurrente (relevé, rattrapage) a pu créer la même occurrence : le statut
        // matérialisé reste juste, le rattrapage périodique réaligne les alertes.
        this.logger.warn(`Alertes du plan ${planId} non synchronisées à la lecture : ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return true;
  }

  /**
   * Écrit les valeurs matérialisées. Les plans dont rien ne change reçoivent seulement leur horodatage
   * de calcul, en une requête ; les autres sont mis à jour un par un. Le statut d'un plan désactivé
   * reste figé. Renvoie les plans dont l'échéance ou le statut a changé.
   */
  private async materialize(tx: Tx, plans: readonly VehicleMaintenancePlan[], evaluations: Map<string, PlanEvaluation>, options: { force: boolean }): Promise<string[]> {
    const now = this.clock.now();
    const unchanged: string[] = [];
    const changed: string[] = [];
    for (const plan of plans) {
      const e = evaluations.get(plan.id) as PlanEvaluation;
      const data = {
        baseKm: e.baseKm?.toString() ?? null,
        baseDate: e.baseDate,
        baseTaskId: e.baseTaskId,
        nextDueKm: e.nextDueKm?.toString() ?? null,
        nextDueDate: e.nextDueDate,
        computedStatus: plan.active ? e.status : plan.computedStatus,
      };
      const same =
        sameDecimal(plan.baseKm, data.baseKm) &&
        fromDbDate(plan.baseDate) === data.baseDate &&
        plan.baseTaskId === data.baseTaskId &&
        sameDecimal(plan.nextDueKm, data.nextDueKm) &&
        fromDbDate(plan.nextDueDate) === data.nextDueDate &&
        plan.computedStatus === data.computedStatus;
      if (same && !options.force) {
        unchanged.push(plan.id);
        continue;
      }
      await tx.vehicleMaintenancePlan.update({ where: { id: plan.id }, data: { ...data, baseDate: toDbDate(data.baseDate), nextDueDate: toDbDate(data.nextDueDate), statusComputedAt: now } });
      if (!same) changed.push(plan.id);
    }
    if (unchanged.length > 0) await tx.vehicleMaintenancePlan.updateMany({ where: { id: { in: unchanged } }, data: { statusComputedAt: now } });
    return changed;
  }

  private async loadContext(tx: Tx | undefined, plans: ReadonlyArray<Pick<PlanCore, 'organizationId' | 'companyId' | 'vehicleId'>>, knownTimezones?: Map<string, string>): Promise<EvaluationContext> {
    const db = tx ?? this.prisma.client;
    const context: EvaluationContext = { now: this.clock.now(), timezones: new Map(knownTimezones), readings: new Map(), cumulativeKnown: new Map(), staleDays: new Map() };
    if (plans.length === 0) return context;
    const vehicleIds = [...new Set(plans.map((p) => p.vehicleId))];
    const missingOrgs = [...new Set(plans.map((p) => p.organizationId))].filter((id) => !context.timezones.has(id));
    const companies = [...new Map(plans.map((p) => [`${p.organizationId}:${p.companyId}`, p] as const)).values()];
    const [orgs, readings, segments, staleDays] = await Promise.all([
      missingOrgs.length > 0 ? db.organization.findMany({ where: { id: { in: missingOrgs } }, select: { id: true, timezone: true } }) : Promise.resolve([]),
      // Dernier relevé accepté par véhicule : tous relevés, et relevés manuels ou CAN seulement (5.6).
      db.$queryRaw<Array<{ vehicleId: string; allKm: unknown; allEstimate: boolean | null; allKind: string | null; allObservedAt: Date | null; physicalKm: unknown; physicalKind: string | null; physicalObservedAt: Date | null }>>`
        SELECT v."id" AS "vehicleId",
               a."cumulativeKm" AS "allKm", a."isEstimate" AS "allEstimate", a."measurementKind"::text AS "allKind", a."observedAt" AS "allObservedAt",
               m."cumulativeKm" AS "physicalKm", m."measurementKind"::text AS "physicalKind", m."observedAt" AS "physicalObservedAt"
        FROM unnest(${vehicleIds}::uuid[]) AS v("id")
        LEFT JOIN LATERAL (
          SELECT r."cumulativeKm", r."isEstimate", r."measurementKind", r."observedAt" FROM "OdometerReading" r
          WHERE r."vehicleId" = v."id" AND r."status" = 'ACCEPTE'
          ORDER BY r."observedAt" DESC, r."enteredAt" DESC LIMIT 1
        ) a ON true
        LEFT JOIN LATERAL (
          SELECT r."cumulativeKm", r."measurementKind", r."observedAt" FROM "OdometerReading" r
          WHERE r."vehicleId" = v."id" AND r."status" = 'ACCEPTE' AND r."isEstimate" = false AND r."measurementKind" IN ('COMPTEUR_AFFICHE', 'COMPTEUR_CAN')
          ORDER BY r."observedAt" DESC, r."enteredAt" DESC LIMIT 1
        ) m ON true`,
      db.odometerSegment.findMany({ where: { vehicleId: { in: vehicleIds }, endedAt: null }, select: { vehicleId: true, cumulativeKnown: true } }),
      Promise.all(companies.map(async (p) => [`${p.organizationId}:${p.companyId}`, await this.settings.get(p.organizationId, 'odometer.staleAfterDays', p.companyId, tx)] as const)),
    ]);
    for (const o of orgs) context.timezones.set(o.id, o.timezone);
    for (const r of readings) {
      context.readings.set(r.vehicleId, {
        all: r.allObservedAt ? { cumulativeKm: decOf(r.allKm), isEstimate: r.allEstimate === true, measurementKind: r.allKind ?? 'COMPTEUR_AFFICHE', observedAt: r.allObservedAt } : null,
        physical: r.physicalObservedAt ? { cumulativeKm: decOf(r.physicalKm), isEstimate: false, measurementKind: r.physicalKind ?? 'COMPTEUR_AFFICHE', observedAt: r.physicalObservedAt } : null,
      });
    }
    for (const s of segments) context.cumulativeKnown.set(s.vehicleId, s.cumulativeKnown);
    for (const [key, days] of staleDays) context.staleDays.set(key, days);
    return context;
  }

  /** Statut au présent (règle unique computePlanStatus) pour une échéance donnée. */
  private liveStatus(plan: PlanCore, due: { nextDueKm: Decimal | null; nextDueDate: CivilDate | null }, context: EvaluationContext): LiveStatus {
    const timezone = context.timezones.get(plan.organizationId) as string;
    const readings = context.readings.get(plan.vehicleId);
    const current = (plan.acceptedSources === 'MANUEL_OU_CAN' ? readings?.physical : readings?.all) ?? null;
    const staleDays = context.staleDays.get(`${plan.organizationId}:${plan.companyId}`) as number;
    const freshness = computeFreshness(current?.observedAt ?? null, context.now, staleDays);
    const status = computePlanStatus({
      intervals: planIntervals(plan),
      nextDueKm: due.nextDueKm,
      nextDueDate: due.nextDueDate,
      currentKm: current?.cumulativeKm ?? null,
      today: localDate(context.now, timezone),
      cumulativeKnown: context.cumulativeKnown.get(plan.vehicleId) ?? true,
      kmStale: freshness.status === 'A_ACTUALISER',
    });
    return {
      ...status,
      currentKm: current?.cumulativeKm ?? null,
      currentKmSource: current ? (current.isEstimate ? 'ESTIME_GPS' : current.measurementKind === 'COMPTEUR_CAN' ? 'COMPTEUR_CAN' : 'COMPTEUR_AFFICHE') : null,
      currentKmObservedAt: current?.observedAt ?? null,
    };
  }

  private async responsibleNames(tx: Tx | undefined, organizationId: string, plans: ReadonlyArray<{ responsibleUserId: string | null }>): Promise<Map<string, string>> {
    const ids = [...new Set(plans.map((p) => p.responsibleUserId).filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const users = await (tx ?? this.prisma.client).user.findMany({ where: { id: { in: ids }, organizationId }, select: { id: true, firstName: true, lastName: true } });
    return new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
  }

  private toView(p: PlanViewSource, context: EvaluationContext, names: Map<string, string>): PlanViewDto {
    const due = materializedDue(p);
    const live = this.liveStatus(p, due, context);
    return {
      id: p.id,
      companyId: p.companyId,
      vehicleId: p.vehicleId,
      vehicleCode: p.vehicle.code,
      maintenanceTypeId: p.maintenanceTypeId,
      maintenanceTypeLabel: p.maintenanceType.label,
      intervalKm: truncatedKm(dec(p.intervalKm)),
      intervalMonths: p.intervalMonths,
      intervalDays: p.intervalDays,
      noticeKm: truncatedKm(dec(p.noticeKm)),
      noticeDays: p.noticeDays,
      // Mode de la base retenue (baseKm, baseDate) : une opération réalisée prend le relais de la base
      // déclarée (6.4) ; un plan créé sans base n'est plus présenté « sans base » une fois entretenu.
      baseMode: p.baseTaskId ? 'DERNIERE_OPERATION' : p.baseMode,
      baseKm: truncatedKm(dec(p.baseKm)),
      baseDate: fromDbDate(p.baseDate),
      nextDueKm: truncatedKm(due.nextDueKm),
      nextDueDate: due.nextDueDate,
      // Statut matérialisé : la même valeur sert au filtre, au tri et à l'affichage.
      status: p.computedStatus,
      kmStatus: live.kmStatus,
      dateStatus: live.dateStatus,
      remainingKm: truncatedKm(live.remainingKm),
      remainingDays: live.remainingDays,
      currentKm: truncatedKm(live.currentKm),
      warnings: live.warnings,
      currentKmSource: live.currentKmSource,
      currentKmObservedAt: live.currentKmObservedAt?.toISOString() ?? null,
      templateId: p.templateId,
      acceptedSources: p.acceptedSources,
      active: p.active,
      responsibleUserId: p.responsibleUserId,
      responsibleUserName: p.responsibleUserId ? (names.get(p.responsibleUserId) ?? null) : null,
      deactivationReason: p.deactivationReason,
      version: p.version,
    };
  }
}

const INTERVAL_MESSAGES: Record<IntervalsError, string> = {
  INTERVALLE_REQUIS: 'Un plan comporte un intervalle en km, un intervalle en mois/jours, ou les deux.',
  INTERVALLE_TEMPS: 'Choisissez un intervalle en mois ou en jours, pas les deux.',
  INTERVALLE_INVALIDE: 'L’intervalle en km doit être positif.',
  PREAVIS_INVALIDE: 'Le préavis ne peut pas être négatif.',
  PREAVIS_KM_TROP_GRAND: 'Le préavis en km doit être inférieur à l’intervalle en km.',
  PREAVIS_JOURS_TROP_GRAND: 'Le préavis en jours doit être inférieur à la durée de l’intervalle (un mois compte 28 jours).',
};

export function intervalMessage(error: IntervalsError): string {
  return INTERVAL_MESSAGES[error];
}

function intervalFieldErrors(errors: IntervalsError[], prefix: string): Record<string, string[]> {
  const fields: Record<IntervalsError, string> = { INTERVALLE_REQUIS: 'intervalKm', INTERVALLE_TEMPS: 'intervalDays', INTERVALLE_INVALIDE: 'intervalKm', PREAVIS_INVALIDE: 'noticeKm', PREAVIS_KM_TROP_GRAND: 'noticeKm', PREAVIS_JOURS_TROP_GRAND: 'noticeDays' };
  const out: Record<string, string[]> = {};
  for (const e of errors) (out[`${prefix}${fields[e]}`] ??= []).push(INTERVAL_MESSAGES[e]);
  return out;
}

class PreviewRollback extends Error {
  constructor(readonly view: PlanViewDto) {
    super('prévisualisation');
  }
}

/** Tri sur colonnes stockées (en base) ; identifiant en dernier recours pour une pagination stable. */
function storedOrder(sort: PlanSort, order: 'asc' | 'desc'): Prisma.VehicleMaintenancePlanOrderByWithRelationInput[] {
  if (sort === 'vehicule') return [{ vehicle: { code: order } }, { maintenanceType: { label: 'asc' } }, { id: 'asc' }];
  if (sort === 'operation') return [{ maintenanceType: { label: order } }, { vehicle: { code: 'asc' } }, { id: 'asc' }];
  return [{ nextDueDate: { sort: order, nulls: 'last' } }, { nextDueKm: { sort: order, nulls: 'last' } }, { id: 'asc' }];
}

function dec(value: { toString(): string } | null | undefined): Decimal | null {
  return value === null || value === undefined ? null : new Decimal(value.toString());
}

/** Valeur numérique d'une requête brute (Decimal de l'adaptateur, chaîne ou nombre). */
function decOf(value: unknown): Decimal | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return new Decimal(value);
  return new Decimal((value as { toString(): string }).toString());
}

function sameDecimal(stored: { toString(): string } | null, next: string | null): boolean {
  if (stored === null || next === null) return stored === null && next === null;
  return new Decimal(stored.toString()).eq(next);
}

function materializedDue(p: Pick<VehicleMaintenancePlan, 'nextDueKm' | 'nextDueDate'>): { nextDueKm: Decimal | null; nextDueDate: CivilDate | null } {
  return { nextDueKm: dec(p.nextDueKm), nextDueDate: fromDbDate(p.nextDueDate) };
}

export function planIntervals(plan: Pick<VehicleMaintenancePlan, 'intervalKm' | 'intervalMonths' | 'intervalDays' | 'noticeKm' | 'noticeDays'>): PlanIntervals {
  return {
    intervalKm: dec(plan.intervalKm),
    intervalMonths: plan.intervalMonths,
    intervalDays: plan.intervalDays,
    noticeKm: dec(plan.noticeKm),
    noticeDays: plan.noticeDays,
  };
}

function validateBase(base: PlanBaseDto, intervals: PlanIntervals): { baseMode: PlanBaseDto['baseMode']; baseKm: string | null; baseDate: string | null; nextDueKm: string | null; nextDueDate: string | null } {
  const day = (v: string | undefined) => (v ? v.slice(0, 10) : null);
  if (base.baseMode === 'DERNIERE_OPERATION' || base.baseMode === 'BASE_TECHNIQUE') {
    if (intervals.intervalKm && !base.baseKm) throw new BusinessRuleError('BASE_KM_REQUISE', 'Indiquez le kilométrage cumulé de la base.', { fieldErrors: { 'base.baseKm': ['Requis pour un intervalle en km.'] } });
    if ((intervals.intervalMonths || intervals.intervalDays) && !base.baseDate) throw new BusinessRuleError('BASE_DATE_REQUISE', 'Indiquez la date de la base.', { fieldErrors: { 'base.baseDate': ['Requise pour un intervalle en temps.'] } });
    return { baseMode: base.baseMode, baseKm: base.baseKm ?? null, baseDate: day(base.baseDate), nextDueKm: null, nextDueDate: null };
  }
  if (base.baseMode === 'ECHEANCE_INITIALE') {
    if (!base.nextDueKm && !base.nextDueDate) throw new BusinessRuleError('ECHEANCE_REQUISE', 'Indiquez la prochaine échéance initiale (km et/ou date).');
    return { baseMode: base.baseMode, baseKm: null, baseDate: null, nextDueKm: base.nextDueKm ?? null, nextDueDate: day(base.nextDueDate) };
  }
  return { baseMode: 'AUCUNE', baseKm: null, baseDate: null, nextDueKm: null, nextDueDate: null };
}
