import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { AttachmentOwnerType, Prisma } from '@parc-auto/db';
import { AfterCommit } from '../../common/after-commit.js';
import { Clock } from '../../common/clock.js';
import { roundMoney } from '../../common/decimal.js';
import { BusinessRuleError, ConflictError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import { type Page, pageOf, resolveSort, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import { compareCivil, diffDays, endOfLocalDay, fromDbDate, localDate, startOfLocalDay, toDbDate, type CivilDate } from '../../domain/civil-date.js';
import { checkPlannedDates, costLineAmount, resolveCost, statusAtCreation, type CostEntry, type InterventionCostStatusKey, type RuleViolation } from '../../domain/intervention-rules.js';
import { kmValue } from '../../domain/km-display.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, isUniqueViolation, type Tx } from '../../infra/prisma.service.js';
import { ReferenceService } from '../../infra/reference.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { OwnerAuthorizationService } from '../attachments/owner-authorization.service.js';
import { ImmobilizationsService } from '../immobilizations/immobilizations.service.js';
import { MaintenancePlansService } from '../maintenance/maintenance-plans.service.js';
import { OdometerIngestionService, lockVehicle } from '../odometer/odometer-ingestion.service.js';
import { parseKm } from '../odometer/odometer.service.js';
import { SuppliersService } from '../suppliers/suppliers.service.js';
import { VehiclesService } from '../vehicles/vehicles.service.js';
import {
  INTERVENTION_SORTS,
  type CompleteInterventionDto,
  type CostLineDto,
  type CreateInterventionDto,
  type InterventionAttachmentViewDto,
  type InterventionViewDto,
  type InterventionsQueryDto,
  type PlanInterventionDto,
  type ReasonDto,
  type RecordCostDto,
  type StartInterventionDto,
  type TaskInputDto,
  type UpdateInterventionDto,
} from './dto/interventions.dto.js';
import { assertIncidentAcceptsIntervention, assertIncidentAcceptsInterventionLocked } from './incident-link.js';

const OPEN_STATUSES = ['BROUILLON', 'PLANIFIEE', 'EN_COURS'] as const;
/** Écart toléré entre la date du relevé d'exécution et la date effective (D-207 : ± 1 jour local). */
const READING_WINDOW_DAYS = 1;

/** Tris sur une date facultative : dates absentes en dernier, quel que soit le sens. */
const NULLABLE_DATE_SORTS = new Set(['plannedStartAt', 'startedAt', 'performedOn', 'completedAt']);

const interventionInclude = {
  vehicle: { select: { code: true, registration: true } },
  supplier: { select: { name: true } },
  tasks: { orderBy: { createdAt: 'asc' }, include: { maintenanceType: { select: { label: true } } } },
  lines: { orderBy: { createdAt: 'asc' } },
  immobilizationCauses: { where: { endedAt: null }, select: { id: true } },
  // Relevé d'exécution : chargé avec la liste (une requête par lot, pas par intervention).
  performedReading: { select: { id: true, physicalKm: true, cumulativeKm: true, observedAt: true, source: true, measurementKind: true, context: true, status: true, isEstimate: true } },
} satisfies Prisma.InterventionInclude;

type InterventionRow = Prisma.InterventionGetPayload<{ include: typeof interventionInclude }>;

/** Données chargées en lot pour un ensemble d'interventions : dépense active et pièces jointes. */
interface ViewExtras {
  expenseIdBySource: Map<string, string>;
  attachmentsByOwner: Map<string, InterventionAttachmentViewDto[]>;
}

interface ComputedLine {
  taskId: string | null;
  kind: CostLineDto['kind'];
  label: string;
  quantity: Decimal;
  unitPrice: Decimal;
  amount: Decimal;
}

interface ResolvedTask {
  label: string;
  planId: string | null;
  maintenanceTypeId: string | null;
  notes: string | null;
}

/**
 * Interventions préventives et correctives (CDC 6.3, 6.4, 15.3). Statuts BROUILLON → PLANIFIEE →
 * EN_COURS → TERMINEE, saisie a posteriori directe, annulation motivée, réouverture réservée au chef.
 * La clôture est transactionnelle, idempotente et versionnée : travaux effectués, relevé validé
 * correspondant, bases et échéances des seuls plans réalisés, dépense unique et fin d'immobilisation.
 */
@Injectable()
export class InterventionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly vehicles: VehiclesService,
    private readonly suppliers: SuppliersService,
    private readonly plans: MaintenancePlansService,
    private readonly immobilizations: ImmobilizationsService,
    private readonly ingestion: OdometerIngestionService,
    private readonly attachments: AttachmentsService,
    private readonly ownerAuthorization: OwnerAuthorizationService,
    private readonly references: ReferenceService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /**
   * Liste (CDC 10.1, 15.1) : filtres validés, tri sur liste autorisée, période en dates civiles du
   * fuseau de l'organisation, historique d'un fournisseur. Dépenses et pièces jointes chargées en lot.
   */
  async list(ctx: RequestContext, query: InterventionsQueryDto): Promise<Page<InterventionViewDto>> {
    this.access.requireStaff(ctx);
    if (query.from && query.to && compareCivil(query.from, query.to) > 0) {
      throw new BusinessRuleError('PERIODE_INVALIDE', 'La date de début de période suit la date de fin.', { fieldErrors: { to: ['Date de fin antérieure au début.'] } });
    }
    const timezone = query.from || query.to ? await this.timezone(ctx) : null;
    const where: Prisma.InterventionWhereInput = {
      AND: [
        this.access.companyWhere(ctx, query.companyId),
        query.vehicleId ? { vehicleId: query.vehicleId } : {},
        query.supplierId ? { supplierId: query.supplierId } : {},
        query.status ? { status: query.status } : {},
        query.open === 'true' ? { status: { in: [...OPEN_STATUSES] } } : {},
        query.kind ? { kind: query.kind } : {},
        timezone ? this.periodWhere(query.from ?? null, query.to ?? null, timezone) : {},
        query.q ? { reference: { contains: query.q, mode: 'insensitive' } } : {},
      ],
    };
    const [items, total] = await Promise.all([
      this.prisma.client.intervention.findMany({ where, include: interventionInclude, ...skipTake(query), orderBy: this.orderBy(query) }),
      this.prisma.client.intervention.count({ where }),
    ]);
    return pageOf(await this.views(ctx, items), total, query);
  }

  async get(ctx: RequestContext, id: string): Promise<InterventionViewDto> {
    const [view] = await this.views(ctx, [await this.load(ctx, id)]);
    return view as InterventionViewDto;
  }

  async create(ctx: RequestContext, dto: CreateInterventionDto): Promise<InterventionViewDto> {
    const vehicle = await this.vehicles.load(ctx, dto.vehicleId);
    this.access.requireOperational(ctx, vehicle.companyId);
    if (vehicle.lifecycleStatus === 'CEDE' || vehicle.lifecycleStatus === 'ARCHIVE') throw new BusinessRuleError('VEHICULE_INACTIF', 'Le véhicule est cédé ou archivé.');
    if (dto.supplierId) await this.suppliers.requireUsable(ctx, dto.supplierId, vehicle.companyId);
    if (dto.incidentId) {
      const incident = await this.prisma.client.incident.findFirst({ where: { id: dto.incidentId, organizationId: ctx.organizationId, vehicleId: vehicle.id }, select: { companyId: true, status: true, reference: true } });
      if (!incident || !this.access.canReadCompany(ctx, incident.companyId)) throw new NotFoundOrOutOfScopeError('Incident');
      // Même contrôle d'état que POST /incidents/:id/intervention (fonction partagée).
      assertIncidentAcceptsIntervention(incident);
    }
    const plannedStartAt = dto.plannedStartAt ? new Date(dto.plannedStartAt) : null;
    const plannedEndAt = dto.plannedEndAt ? new Date(dto.plannedEndAt) : null;
    const status = statusAtCreation(plannedStartAt);
    this.assertRule(checkPlannedDates(status, plannedStartAt, plannedEndAt));
    const tasks = await this.resolveTasks(ctx, vehicle.id, dto.tasks);
    const now = this.clock.now();
    const timezone = await this.timezone(ctx);
    const id = await this.prisma.client.$transaction(async (tx) => {
      // État de l'incident relu sous verrou : une clôture validée depuis le contrôle initial est refusée.
      if (dto.incidentId) await assertIncidentAcceptsInterventionLocked(tx, dto.incidentId);
      const reference = await this.references.next(tx, ctx.organizationId, 'INT', Number(localDate(now, timezone).slice(0, 4)));
      const created = await tx.intervention.create({
        data: {
          organizationId: ctx.organizationId,
          companyId: vehicle.companyId,
          vehicleId: vehicle.id,
          reference,
          kind: dto.kind,
          status,
          supplierId: dto.supplierId ?? null,
          plannedStartAt,
          plannedEndAt,
          diagnosis: dto.diagnosis?.trim() || null,
          workDescription: dto.workDescription?.trim() || null,
          incidentId: dto.incidentId ?? null,
          isHistorical: dto.isHistorical ?? false,
          createdById: ctx.userId,
        },
      });
      if (tasks.length) await tx.interventionTask.createMany({ data: tasks.map((t) => ({ ...t, organizationId: ctx.organizationId, interventionId: created.id })) });
      await this.audit.record(ctx, { action: 'intervention.creation', objectType: 'Intervention', objectId: created.id, companyId: vehicle.companyId, after: { reference, kind: dto.kind, status: created.status, tasks } }, tx);
      return created.id;
    });
    return this.get(ctx, id);
  }

  /**
   * Modification des champs d'une intervention ouverte. Ne change jamais le statut (D-204) :
   * renseigner des dates prévues sur un BROUILLON le laisse BROUILLON — seule l'action « Planifier »
   * (POST :id/plan) le fait passer PLANIFIEE ; effacer le début prévu d'une PLANIFIEE est refusé
   * (422 DATE_PREVUE_REQUISE), faute de transition PLANIFIEE → BROUILLON : replanifier ou annuler.
   */
  async update(ctx: RequestContext, id: string, dto: UpdateInterventionDto): Promise<InterventionViewDto> {
    const current = await this.load(ctx, id);
    this.access.requireOperational(ctx, current.companyId);
    assertExpectedVersion(current, dto.expectedVersion, 'intervention');
    this.assertOpen(current.status);
    if (dto.supplierId) await this.suppliers.requireUsable(ctx, dto.supplierId, current.companyId);
    const nextStart = dto.plannedStartAt === undefined ? current.plannedStartAt : dto.plannedStartAt ? new Date(dto.plannedStartAt) : null;
    const nextEnd = dto.plannedEndAt === undefined ? current.plannedEndAt : dto.plannedEndAt ? new Date(dto.plannedEndAt) : null;
    this.assertRule(checkPlannedDates(current.status, nextStart, nextEnd));
    const tasks = dto.tasks ? await this.resolveTasks(ctx, current.vehicleId, dto.tasks) : null;
    await this.prisma.client.$transaction(async (tx) => {
      await tx.intervention.update({
        where: { id, version: dto.expectedVersion },
        data: {
          ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
          ...(dto.supplierId !== undefined ? { supplierId: dto.supplierId } : {}),
          ...(dto.plannedStartAt !== undefined ? { plannedStartAt: dto.plannedStartAt ? new Date(dto.plannedStartAt) : null } : {}),
          ...(dto.plannedEndAt !== undefined ? { plannedEndAt: dto.plannedEndAt ? new Date(dto.plannedEndAt) : null } : {}),
          ...(dto.diagnosis !== undefined ? { diagnosis: dto.diagnosis?.trim() || null } : {}),
          ...(dto.workDescription !== undefined ? { workDescription: dto.workDescription?.trim() || null } : {}),
          version: { increment: 1 },
        },
      });
      if (tasks) {
        await tx.interventionLine.updateMany({ where: { interventionId: id }, data: { taskId: null } });
        await tx.interventionTask.deleteMany({ where: { interventionId: id } });
        if (tasks.length) await tx.interventionTask.createMany({ data: tasks.map((t) => ({ ...t, organizationId: ctx.organizationId, interventionId: id })) });
      }
      await this.audit.record(ctx, { action: 'intervention.modification', objectType: 'Intervention', objectId: id, companyId: current.companyId, after: { ...dto, tasks } }, tx);
    });
    return this.get(ctx, id);
  }

  /** Planifier ne signifie pas exécuter (6.3) : seules les dates prévues sont enregistrées. */
  async plan(ctx: RequestContext, id: string, dto: PlanInterventionDto): Promise<InterventionViewDto> {
    const current = await this.load(ctx, id);
    this.access.requireOperational(ctx, current.companyId);
    assertExpectedVersion(current, dto.expectedVersion, 'intervention');
    if (current.status !== 'BROUILLON' && current.status !== 'PLANIFIEE') throw new ConflictError('ETAT_INVALIDE', 'Seule une intervention en brouillon ou planifiée peut être (re)planifiée.');
    this.assertRule(checkPlannedDates('PLANIFIEE', new Date(dto.plannedStartAt), dto.plannedEndAt ? new Date(dto.plannedEndAt) : null));
    await this.prisma.client.$transaction(async (tx) => {
      await tx.intervention.update({ where: { id, version: dto.expectedVersion }, data: { status: 'PLANIFIEE', plannedStartAt: new Date(dto.plannedStartAt), plannedEndAt: dto.plannedEndAt ? new Date(dto.plannedEndAt) : null, version: { increment: 1 } } });
      await this.audit.record(ctx, { action: 'intervention.planification', objectType: 'Intervention', objectId: id, companyId: current.companyId, after: dto }, tx);
    });
    return this.get(ctx, id);
  }

  async start(ctx: RequestContext, id: string, dto: StartInterventionDto): Promise<InterventionViewDto> {
    const current = await this.load(ctx, id);
    this.access.requireOperational(ctx, current.companyId);
    assertExpectedVersion(current, dto.expectedVersion, 'intervention');
    if (current.status !== 'BROUILLON' && current.status !== 'PLANIFIEE') throw new ConflictError('ETAT_INVALIDE', 'Seule une intervention en brouillon ou planifiée peut démarrer.');
    if (dto.immobilize && !dto.immobilizationReason) throw new BusinessRuleError('MOTIF_REQUIS', 'Indiquez le motif de l’immobilisation.', { fieldErrors: { immobilizationReason: ['Motif requis.'] } });
    const now = this.clock.now();
    const startedAt = dto.startedAt ? new Date(dto.startedAt) : now;
    if (startedAt.getTime() > now.getTime() + 5 * 60_000) throw new BusinessRuleError('DATE_FUTURE', 'Le début réel ne peut pas être dans le futur.', { fieldErrors: { startedAt: ['Date future refusée.'] } });
    const after = new AfterCommit();
    await this.prisma.serializable(async (tx) => {
      await tx.intervention.update({ where: { id, version: dto.expectedVersion }, data: { status: 'EN_COURS', startedAt, version: { increment: 1 } } });
      if (dto.immobilize && dto.immobilizationReason) {
        await this.immobilizations.openCause(tx, ctx, { vehicle: { id: current.vehicleId, companyId: current.companyId, code: current.vehicle.code }, kind: 'INTERVENTION', reason: dto.immobilizationReason, interventionId: id, startedAt }, after);
      }
      await this.audit.record(ctx, { action: 'intervention.demarrage', objectType: 'Intervention', objectId: id, companyId: current.companyId, after: { startedAt: startedAt.toISOString(), immobilize: dto.immobilize ?? false } }, tx);
    });
    await after.run();
    return this.get(ctx, id);
  }

  /**
   * Clôture (CDC 6.4, 15.3) : date effective et relevé validé correspondant quand un plan réalisé a
   * un intervalle en km ; seules les lignes réalisées mettent à jour leur propre plan ; dépense unique
   * par source (si le coût est connu, sinon saisie ultérieure D-206) ; alertes des plans réévaluées dans la
   * même transaction ; fournisseur et pièces jointes de la société de l'intervention ; tout ou rien.
   * Même clé et même corps : résultat initial ; autre clé : 409.
   */
  async complete(ctx: RequestContext, id: string, dto: CompleteInterventionDto, idempotencyKey: string): Promise<InterventionViewDto> {
    const current = await this.load(ctx, id);
    this.access.requirePermission(ctx, current.companyId, 'maintenance.complete', 'La clôture d’une intervention requiert la permission maintenance.complete.');
    const hasCost = Boolean(dto.lines?.length) || dto.totalAmount !== undefined;
    if (hasCost) this.access.requirePermission(ctx, current.companyId, 'costs.write', 'La saisie du coût requiert la permission costs.write.');
    const lines = this.computeLines(dto.lines ?? []);
    const cost = this.resolveCostOrThrow({ lineAmounts: lines.map((l) => l.amount), totalAmount: dto.totalAmount, noCost: dto.noCost === true, invoice: false, required: false });
    if (dto.acceptedReadingId && dto.newReading) throw new BusinessRuleError('RELEVE_UNIQUE', 'Indiquez un relevé existant ou un nouveau relevé, pas les deux.');
    const body = { ...dto, idempotencyKey: undefined, interventionId: id };
    const result = await this.idempotency.run({ organizationId: ctx.organizationId, userId: ctx.userId, operation: 'intervention.complete', key: idempotencyKey }, body, async () => {
      const timezone = await this.timezone(ctx);
      const { after } = await this.prisma.serializable(async (tx) => {
        const after = new AfterCommit();
        await lockVehicle(tx, current.vehicleId);
        const fresh = await tx.intervention.findUniqueOrThrow({ where: { id }, include: { tasks: { include: { plan: true, maintenanceType: { select: { label: true } } } } } });
        if (fresh.status === 'TERMINEE') throw new ConflictError('DEJA_TERMINEE', 'Cette intervention est déjà terminée.');
        if (fresh.status === 'ANNULEE') throw new ConflictError('ETAT_INVALIDE', 'Une intervention annulée ne peut pas être terminée.');
        assertExpectedVersion(fresh, dto.expectedVersion, 'intervention');
        const now = this.clock.now();
        const today = localDate(now, timezone);
        if (diffDays(today, dto.performedOn) > 0) throw new BusinessRuleError('DATE_FUTURE', 'La date effective ne peut pas être postérieure à aujourd’hui.', { fieldErrors: { performedOn: ['Date future refusée.'] } });
        const taskIds = new Set(fresh.tasks.map((t) => t.id));
        const done = [...new Set(dto.completedTaskIds)];
        if (done.length === 0) throw new BusinessRuleError('TRAVAUX_REQUIS', 'Indiquez au moins une ligne de travail réalisée.', { fieldErrors: { completedTaskIds: ['Au moins une ligne réalisée.'] } });
        for (const t of done) if (!taskIds.has(t)) throw new NotFoundOrOutOfScopeError('Ligne de travail');
        const doneTasks = fresh.tasks.filter((t) => done.includes(t.id));
        const kmRequired = doneTasks.some((t) => t.plan?.active && t.plan.intervalKm !== null);

        // Relevé d'exécution : physique, accepté, du même véhicule, à la date effective (± 1 jour).
        let reading: { id: string; cumulativeKm: Decimal | null } | null = null;
        if (dto.acceptedReadingId) {
          const r = await tx.odometerReading.findFirst({ where: { id: dto.acceptedReadingId, organizationId: ctx.organizationId } });
          if (!r || r.vehicleId !== fresh.vehicleId) throw new NotFoundOrOutOfScopeError('Relevé');
          if (r.status !== 'ACCEPTE') throw new BusinessRuleError('RELEVE_NON_VALIDE', 'Le relevé d’exécution doit être accepté.');
          if (r.isEstimate || r.measurementKind === 'DISTANCE_GPS') throw new BusinessRuleError('RELEVE_ESTIME', 'Une estimation GPS ne peut pas servir de base d’entretien : utilisez un relevé physique.');
          this.assertReadingDate(r.observedAt, timezone, dto.performedOn);
          reading = { id: r.id, cumulativeKm: r.cumulativeKm ? new Decimal(r.cumulativeKm.toString()) : null };
        } else if (dto.newReading) {
          const observedAt = new Date(dto.newReading.observedAt);
          this.assertReadingDate(observedAt, timezone, dto.performedOn);
          const ingested = await this.ingestion.ingest(
            tx,
            { organizationId: ctx.organizationId, vehicleId: fresh.vehicleId, origin: 'MANUAL', context: 'ENTRETIEN', measurementKind: 'COMPTEUR_AFFICHE', physicalKm: parseKm(dto.newReading.physicalKm), observedAt, author: { kind: 'STAFF', userId: ctx.userId }, attachmentId: dto.newReading.attachmentId ?? null, note: `Relevé d’exécution de l’intervention ${fresh.reference}` },
            after,
          );
          if (ingested.outcome === 'EN_ATTENTE') {
            throw new BusinessRuleError('RELEVE_EN_ATTENTE', `Le relevé d’exécution n’est pas accepté (${ingested.anomaly?.reason ?? 'contrôle en attente'}) : faites-le valider puis clôturez.`, { fieldErrors: { 'newReading.physicalKm': [ingested.anomaly?.reason ?? 'Relevé en attente.'] } });
          }
          // Photo du compteur : rattachée au relevé lui-même (propriétaire RELEVE = identifiant du relevé).
          if (dto.newReading.attachmentId) await this.attachments.attach(ctx, tx, dto.newReading.attachmentId, 'RELEVE', ingested.reading.id, fresh.companyId, { sameCompany: true });
          reading = { id: ingested.reading.id, cumulativeKm: ingested.reading.cumulativeKm ? new Decimal(ingested.reading.cumulativeKm.toString()) : null };
        } else if (kmRequired) {
          throw new BusinessRuleError('RELEVE_REQUIS', 'Un relevé validé correspondant est obligatoire : un plan réalisé utilise un intervalle en kilomètres.', { fieldErrors: { acceptedReadingId: ['Relevé requis.'] } });
        }
        if (kmRequired && !reading?.cumulativeKm) throw new BusinessRuleError('CUMUL_INCONNU', 'Le relevé d’exécution n’a pas de kilométrage cumulé exploitable.');

        const supplierId = dto.supplierId ?? fresh.supplierId;
        if (dto.supplierId) await this.suppliers.requireUsable(ctx, dto.supplierId, fresh.companyId);
        this.assertLineTasks(lines, taskIds);
        const { total, costStatus } = cost;

        await tx.interventionTask.updateMany({ where: { interventionId: id }, data: { completed: false } });
        await tx.interventionTask.updateMany({ where: { id: { in: done } }, data: { completed: true } });
        await tx.interventionLine.deleteMany({ where: { interventionId: id } });
        if (lines.length) await tx.interventionLine.createMany({ data: this.lineRows(ctx, id, lines) });
        await tx.intervention.update({
          where: { id, version: dto.expectedVersion },
          data: {
            status: 'TERMINEE',
            startedAt: fresh.startedAt ?? now,
            completedAt: now,
            performedOn: toDbDate(dto.performedOn),
            performedReadingId: reading?.id ?? null,
            performedKm: reading?.cumulativeKm?.toString() ?? null,
            supplierId,
            totalAmount: total?.toString() ?? null,
            costStatus,
            ...(dto.workDescription !== undefined ? { workDescription: dto.workDescription.trim() || null } : {}),
            version: { increment: 1 },
          },
        });
        if (costStatus === 'SAISI' && total) await this.createExpense(tx, ctx, { id, companyId: fresh.companyId, vehicleId: fresh.vehicleId, reference: fresh.reference, performedOn: dto.performedOn, supplierId, amount: total });
        // Pièces jointes : fichiers téléversés pour la société historique de l'intervention seulement (15.3).
        for (const attachmentId of dto.attachmentIds ?? []) await this.attachments.attach(ctx, tx, attachmentId, 'INTERVENTION', id, fresh.companyId, { sameCompany: true });
        if (dto.endImmobilization !== false) await this.immobilizations.endCausesForSource(tx, ctx, { interventionId: id }, now, `intervention ${fresh.reference} terminée`, after);
        // Recalcul des plans du véhicule depuis l'opération effective la plus récente (6.4, D-208).
        const vehiclePlans = await tx.vehicleMaintenancePlan.findMany({ where: { vehicleId: fresh.vehicleId, active: true }, select: { id: true } });
        for (const p of vehiclePlans) await this.plans.recomputePlan(tx, p.id);
        // Alertes des plans réévaluées dans la même transaction (6.4) ; notifications après validation.
        for (const p of vehiclePlans) await this.plans.syncAlerts(p.id, tx, after);
        await this.audit.record(ctx, {
          action: 'intervention.cloture',
          objectType: 'Intervention',
          objectId: id,
          companyId: fresh.companyId,
          after: { performedOn: dto.performedOn, readingId: reading?.id ?? null, performedKm: reading?.cumulativeKm?.toString() ?? null, completedTasks: doneTasks.map((t) => t.maintenanceType?.label ?? t.label), costStatus, total: total?.toString() ?? null },
        }, tx);
        return { after };
      });
      await after.run();
      return { status: 200, body: await this.get(ctx, id), resourceId: id };
    });
    return result.body;
  }

  /** Saisie du coût après clôture (facture reçue plus tard, D-206) : crée l'unique dépense de la source. */
  async recordCost(ctx: RequestContext, id: string, dto: RecordCostDto): Promise<InterventionViewDto> {
    const current = await this.load(ctx, id);
    this.access.requirePermission(ctx, current.companyId, 'costs.write', 'La saisie du coût requiert la permission costs.write.');
    assertExpectedVersion(current, dto.expectedVersion, 'intervention');
    if (current.status !== 'TERMINEE') throw new ConflictError('ETAT_INVALIDE', 'Le coût se saisit sur une intervention terminée.');
    if (current.costStatus !== 'A_SAISIR') throw new ConflictError('COUT_DEJA_SAISI', 'Le coût de cette intervention est déjà enregistré : corrigez la dépense depuis le registre.');
    const lines = this.computeLines(dto.lines ?? []);
    this.assertLineTasks(lines, new Set(current.tasks.map((t) => t.id)));
    // Une facture jointe à un total nul (« sans coût ») est refusée, jamais ignorée (D-206).
    const { total, costStatus } = this.resolveCostOrThrow({ lineAmounts: lines.map((l) => l.amount), totalAmount: dto.totalAmount, noCost: dto.noCost === true, invoice: Boolean(dto.invoiceAttachmentId), required: true });
    if (dto.supplierId) await this.suppliers.requireUsable(ctx, dto.supplierId, current.companyId);
    const supplierId = dto.supplierId ?? current.supplierId;
    await this.prisma.serializable(async (tx) => {
      // Les lignes de la saisie remplacent toujours les précédentes : total et lignes restent cohérents.
      await tx.interventionLine.deleteMany({ where: { interventionId: id } });
      if (lines.length) await tx.interventionLine.createMany({ data: this.lineRows(ctx, id, lines) });
      await tx.intervention.update({ where: { id, version: dto.expectedVersion }, data: { totalAmount: total?.toString() ?? null, costStatus, supplierId, version: { increment: 1 } } });
      if (costStatus === 'SAISI' && total) {
        const expenseId = await this.createExpense(tx, ctx, { id, companyId: current.companyId, vehicleId: current.vehicleId, reference: current.reference, performedOn: fromDbDate(current.performedOn) as string, supplierId, amount: total });
        if (dto.invoiceAttachmentId) {
          await this.attachments.attach(ctx, tx, dto.invoiceAttachmentId, 'DEPENSE', expenseId, current.companyId, { sameCompany: true });
          await tx.expense.update({ where: { id: expenseId }, data: { attachmentId: dto.invoiceAttachmentId } });
        }
      }
      await this.audit.record(ctx, { action: 'intervention.cout', objectType: 'Intervention', objectId: id, companyId: current.companyId, after: { costStatus, total: total?.toString() ?? null } }, tx);
    });
    return this.get(ctx, id);
  }

  async cancel(ctx: RequestContext, id: string, dto: ReasonDto): Promise<InterventionViewDto> {
    const current = await this.load(ctx, id);
    this.access.requireOperational(ctx, current.companyId);
    assertExpectedVersion(current, dto.expectedVersion, 'intervention');
    this.assertOpen(current.status);
    const after = new AfterCommit();
    await this.prisma.serializable(async (tx) => {
      const now = this.clock.now();
      await tx.intervention.update({ where: { id, version: dto.expectedVersion }, data: { status: 'ANNULEE', cancelledAt: now, cancelReason: dto.reason.trim(), version: { increment: 1 } } });
      if (dto.endImmobilization !== false) await this.immobilizations.endCausesForSource(tx, ctx, { interventionId: id }, now, `intervention ${current.reference} annulée`, after);
      await this.audit.record(ctx, { action: 'intervention.annulation', objectType: 'Intervention', objectId: id, companyId: current.companyId, reason: dto.reason }, tx);
    });
    await after.run();
    return this.get(ctx, id);
  }

  /**
   * Réouverture/correction (6.4, D-204) : chef ou administrateur, motivée et auditée. Dans la même
   * transaction : dépense annulée de façon traçable, bases des plans recalculées sans l'intervention.
   * Le coût repart « à saisir » : les lignes de coût sont annulées explicitement avec le total (valeurs
   * précédentes conservées dans l'audit, montant dans la dépense annulée) ; la fiche n'affiche jamais
   * de lignes sans total. Le coût se ressaisit à la nouvelle clôture ou par « Saisir le coût ».
   */
  async reopen(ctx: RequestContext, id: string, dto: ReasonDto): Promise<InterventionViewDto> {
    const current = await this.load(ctx, id);
    this.access.requireManager(ctx, current.companyId);
    this.access.requirePermission(ctx, current.companyId, 'maintenance.complete', 'La réouverture requiert la permission maintenance.complete.');
    assertExpectedVersion(current, dto.expectedVersion, 'intervention');
    if (current.status !== 'TERMINEE') throw new ConflictError('ETAT_INVALIDE', 'Seule une intervention terminée peut être rouverte.');
    const after = await this.prisma.serializable(async (tx) => {
      const after = new AfterCommit();
      await lockVehicle(tx, current.vehicleId);
      const now = this.clock.now();
      await tx.intervention.update({ where: { id, version: dto.expectedVersion }, data: { status: 'EN_COURS', completedAt: null, reopenedAt: now, reopenReason: dto.reason.trim(), costStatus: 'A_SAISIR', totalAmount: null, version: { increment: 1 } } });
      const cancelledLines = await tx.interventionLine.deleteMany({ where: { interventionId: id } });
      const expense = await tx.expense.findFirst({ where: { sourceType: 'INTERVENTION', sourceId: id, status: 'VALIDEE' } });
      if (expense) await tx.expense.update({ where: { id: expense.id }, data: { status: 'ANNULEE', cancelledAt: now, cancelledById: ctx.userId, cancelReason: `Réouverture de l’intervention ${current.reference} : ${dto.reason.trim()}`, version: { increment: 1 } } });
      const vehiclePlans = await tx.vehicleMaintenancePlan.findMany({ where: { vehicleId: current.vehicleId, active: true }, select: { id: true } });
      for (const p of vehiclePlans) await this.plans.recomputePlan(tx, p.id);
      for (const p of vehiclePlans) await this.plans.syncAlerts(p.id, tx, after);
      await this.audit.record(
        ctx,
        {
          action: 'intervention.reouverture',
          objectType: 'Intervention',
          objectId: id,
          companyId: current.companyId,
          reason: dto.reason,
          before: {
            costStatus: current.costStatus,
            total: current.totalAmount?.toFixed(3) ?? null,
            lines: current.lines.map((l) => ({ kind: l.kind, label: l.label, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toFixed(3), amount: l.amount.toFixed(3) })),
          },
          after: { costStatus: 'A_SAISIR', total: null, linesCancelled: cancelledLines.count, expenseCancelled: expense?.id ?? null },
        },
        tx,
      );
      return after;
    });
    await after.run();
    return this.get(ctx, id);
  }

  // ---------------------------------------------------------------------------

  async load(ctx: RequestContext, id: string): Promise<InterventionRow> {
    const row = await this.prisma.client.intervention.findFirst({ where: { id, organizationId: ctx.organizationId }, include: interventionInclude });
    if (!row || ctx.isDriverOnly || !this.access.canReadCompany(ctx, row.companyId)) throw new NotFoundOrOutOfScopeError('Intervention');
    return row;
  }

  private assertOpen(status: string): void {
    if (status === 'TERMINEE' || status === 'ANNULEE') throw new ConflictError('ETAT_INVALIDE', 'Intervention terminée ou annulée : utilisez la réouverture si une correction est nécessaire.');
  }

  /** Règle du domaine enfreinte → 422 avec l'erreur attachée au champ concerné. */
  private ruleError(violation: RuleViolation): BusinessRuleError {
    return new BusinessRuleError(violation.code, violation.message, violation.field ? { fieldErrors: { [violation.field]: [violation.message] } } : undefined);
  }

  private assertRule(violation: RuleViolation | null): void {
    if (violation) throw this.ruleError(violation);
  }

  /** Total et état du coût (règle unique du domaine, D-203, D-206) ; saisie incohérente → 422. */
  private resolveCostOrThrow(entry: CostEntry): { total: Decimal | null; costStatus: InterventionCostStatusKey } {
    const resolution = resolveCost(entry);
    if (!resolution.ok) throw this.ruleError(resolution.violation);
    return { total: resolution.total, costStatus: resolution.costStatus };
  }

  private async timezone(ctx: RequestContext): Promise<string> {
    const org = await this.prisma.client.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } });
    return org.timezone;
  }

  /**
   * Période en dates civiles du fuseau de l'organisation (D-256, D-257) sur la date de référence :
   * date effective (performedOn) si l'intervention est réalisée, sinon jour local du début réel,
   * sinon jour local du début prévu. Une intervention sans aucune de ces dates n'est pas datée.
   */
  private periodWhere(from: CivilDate | null, to: CivilDate | null, timezone: string): Prisma.InterventionWhereInput {
    const civil = { ...(from ? { gte: toDbDate(from) as Date } : {}), ...(to ? { lte: toDbDate(to) as Date } : {}) };
    const instants = { ...(from ? { gte: startOfLocalDay(from, timezone) } : {}), ...(to ? { lte: endOfLocalDay(to, timezone) } : {}) };
    return {
      OR: [{ performedOn: civil }, { performedOn: null, startedAt: instants }, { performedOn: null, startedAt: null, plannedStartAt: instants }],
    };
  }

  /** Tri demandé (liste autorisée), départagé par la référence puis l'identifiant pour une pagination stable. */
  private orderBy(query: InterventionsQueryDto): Prisma.InterventionOrderByWithRelationInput[] {
    if (!query.sort) return [{ createdAt: 'desc' }, { id: 'desc' }];
    const sort = resolveSort(query.sort, INTERVENTION_SORTS, 'createdAt');
    const dir = query.order;
    const primary: Prisma.InterventionOrderByWithRelationInput =
      sort === 'vehicleCode' ? { vehicle: { code: dir } } : NULLABLE_DATE_SORTS.has(sort) ? { [sort]: { sort: dir, nulls: 'last' } } : { [sort]: dir };
    return [primary, ...(sort === 'reference' ? [] : [{ reference: dir }]), { id: dir }];
  }

  private assertReadingDate(observedAt: Date, timezone: string, performedOn: string): void {
    const gap = Math.abs(diffDays(localDate(observedAt, timezone), performedOn));
    if (gap > READING_WINDOW_DAYS) {
      throw new BusinessRuleError('RELEVE_NON_CORRESPONDANT', `Le relevé doit être observé le jour de la réalisation (± ${READING_WINDOW_DAYS} jour).`, { fieldErrors: { acceptedReadingId: ['Relevé hors de la fenêtre de réalisation.'] } });
    }
  }

  /** Lignes de travail : plan du véhicule (actif), opération du catalogue, ou libellé libre. */
  private async resolveTasks(ctx: RequestContext, vehicleId: string, inputs: TaskInputDto[]): Promise<ResolvedTask[]> {
    const out: ResolvedTask[] = [];
    const planIds = new Set<string>();
    for (const t of inputs) {
      if (t.planId) {
        if (planIds.has(t.planId)) throw new BusinessRuleError('PLAN_EN_DOUBLE', 'Un plan ne figure qu’une fois dans une intervention.');
        planIds.add(t.planId);
        const plan = await this.prisma.client.vehicleMaintenancePlan.findFirst({ where: { id: t.planId, organizationId: ctx.organizationId, active: true }, include: { maintenanceType: { select: { label: true } } } });
        // Un plan d'un autre véhicule ou hors périmètre est refusé (15.3).
        if (!plan || plan.vehicleId !== vehicleId) throw new NotFoundOrOutOfScopeError('Plan d’entretien');
        out.push({ label: t.label?.trim() || plan.maintenanceType.label, planId: plan.id, maintenanceTypeId: plan.maintenanceTypeId, notes: t.notes?.trim() || null });
      } else if (t.maintenanceTypeId) {
        const type = await this.prisma.client.maintenanceType.findFirst({ where: { id: t.maintenanceTypeId, organizationId: ctx.organizationId, status: 'ACTIF' } });
        if (!type) throw new NotFoundOrOutOfScopeError('Type d’opération');
        const plan = await this.prisma.client.vehicleMaintenancePlan.findFirst({ where: { vehicleId, maintenanceTypeId: type.id, active: true }, select: { id: true } });
        if (plan && planIds.has(plan.id)) throw new BusinessRuleError('PLAN_EN_DOUBLE', 'Un plan ne figure qu’une fois dans une intervention.');
        if (plan) planIds.add(plan.id);
        out.push({ label: t.label?.trim() || type.label, planId: plan?.id ?? null, maintenanceTypeId: type.id, notes: t.notes?.trim() || null });
      } else {
        if (!t.label?.trim()) throw new BusinessRuleError('LIBELLE_REQUIS', 'Une ligne de travail sans plan ni opération du catalogue exige un libellé.', { fieldErrors: { tasks: ['Libellé requis.'] } });
        out.push({ label: t.label.trim(), planId: null, maintenanceTypeId: null, notes: t.notes?.trim() || null });
      }
    }
    return out;
  }

  private computeLines(inputs: CostLineDto[]): ComputedLine[] {
    return inputs.map((l) => {
      const quantity = new Decimal(l.quantity);
      const unitPrice = new Decimal(l.unitPrice);
      if (quantity.isNegative() || unitPrice.isNegative()) throw new BusinessRuleError('VALEUR_NEGATIVE', 'Quantités et prix unitaires positifs ou nuls.');
      return { taskId: l.taskId ?? null, kind: l.kind, label: l.label.trim(), quantity, unitPrice: roundMoney(unitPrice), amount: costLineAmount(quantity, unitPrice) };
    });
  }

  /** Une ligne de coût ne vise qu'une ligne de travail de la même intervention. */
  private assertLineTasks(lines: ComputedLine[], taskIds: Set<string>): void {
    for (const l of lines) if (l.taskId && !taskIds.has(l.taskId)) throw new NotFoundOrOutOfScopeError('Ligne de travail');
  }

  private lineRows(ctx: RequestContext, interventionId: string, lines: ComputedLine[]): Prisma.InterventionLineCreateManyInput[] {
    return lines.map((l) => ({ organizationId: ctx.organizationId, interventionId, taskId: l.taskId, kind: l.kind, label: l.label, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), amount: l.amount.toString() }));
  }

  /** Dépense unique par source (8.4, T24) : l'index partiel expense_one_active_per_source l'impose. */
  private async createExpense(tx: Tx, ctx: RequestContext, source: { id: string; companyId: string; vehicleId: string; reference: string; performedOn: string; supplierId: string | null; amount: Decimal }): Promise<string> {
    try {
      const expense = await tx.expense.create({
        data: {
          organizationId: ctx.organizationId,
          companyId: source.companyId,
          vehicleId: source.vehicleId,
          occurredOn: toDbDate(source.performedOn) as Date,
          category: 'ENTRETIEN_REPARATION',
          supplierId: source.supplierId,
          reference: source.reference,
          amount: source.amount.toString(),
          sourceType: 'INTERVENTION',
          sourceId: source.id,
          createdById: ctx.userId,
        },
      });
      return expense.id;
    } catch (error) {
      if (isUniqueViolation(error, 'expense_one_active_per_source')) throw new ConflictError('DEPENSE_EXISTANTE', 'Une dépense existe déjà pour cette intervention.');
      throw error;
    }
  }

  /**
   * Vues d'un lot d'interventions : dépense active et pièces jointes chargées en deux requêtes pour
   * tout le lot (aucune requête par intervention), relevé d'exécution inclus dans le chargement. Seules
   * les pièces que l'utilisateur peut télécharger sont exposées : même décision que
   * GET /attachments/:id/download (OwnerAuthorizationService), sans requête supplémentaire pour ces
   * propriétaires (INTERVENTION, DEPENSE, RELEVE).
   */
  private async views(ctx: RequestContext, rows: InterventionRow[]): Promise<InterventionViewDto[]> {
    if (rows.length === 0) return [];
    const extras = await this.loadViewExtras(ctx, rows);
    return rows.map((i) => this.view(ctx, i, extras));
  }

  private async loadViewExtras(ctx: RequestContext, rows: InterventionRow[]): Promise<ViewExtras> {
    const costIds = rows.filter((i) => this.access.hasPermission(ctx, i.companyId, 'costs.read')).map((i) => i.id);
    const expenses = costIds.length
      ? await this.prisma.client.expense.findMany({ where: { organizationId: ctx.organizationId, sourceType: 'INTERVENTION', sourceId: { in: costIds }, status: 'VALIDEE' }, select: { id: true, sourceId: true } })
      : [];
    const expenseIdBySource = new Map<string, string>();
    for (const e of expenses) if (e.sourceId) expenseIdBySource.set(e.sourceId, e.id);
    const readingIds = rows.map((i) => i.performedReadingId).filter((r): r is string => r !== null);
    const owners: Prisma.AttachmentWhereInput[] = [{ ownerType: 'INTERVENTION', ownerId: { in: rows.map((i) => i.id) } }];
    if (expenses.length) owners.push({ ownerType: 'DEPENSE', ownerId: { in: expenses.map((e) => e.id) } });
    if (readingIds.length) owners.push({ ownerType: 'RELEVE', ownerId: { in: readingIds } });
    const files = await this.prisma.client.attachment.findMany({
      where: { organizationId: ctx.organizationId, deletedAt: null, OR: owners },
      select: { id: true, companyId: true, ownerType: true, ownerId: true, originalName: true, mimeType: true, sizeBytes: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const kinds: Partial<Record<AttachmentOwnerType, InterventionAttachmentViewDto['kind']>> = { INTERVENTION: 'INTERVENTION', DEPENSE: 'FACTURE', RELEVE: 'RELEVE' };
    const attachmentsByOwner = new Map<string, InterventionAttachmentViewDto[]>();
    for (const f of files) {
      const kind = f.ownerType ? kinds[f.ownerType] : undefined;
      if (!f.ownerType || !kind || !f.ownerId) continue;
      if (!(await this.ownerAuthorization.canRead(ctx, f.ownerType, f.ownerId, f.companyId))) continue;
      const list = attachmentsByOwner.get(`${f.ownerType}:${f.ownerId}`) ?? [];
      list.push({ id: f.id, kind, originalName: f.originalName, mimeType: f.mimeType, sizeBytes: f.sizeBytes, downloadPath: `/api/v1/attachments/${f.id}/download` });
      attachmentsByOwner.set(`${f.ownerType}:${f.ownerId}`, list);
    }
    return { expenseIdBySource, attachmentsByOwner };
  }

  private view(ctx: RequestContext, i: InterventionRow, extras: ViewExtras): InterventionViewDto {
    const canSeeCosts = this.access.hasPermission(ctx, i.companyId, 'costs.read');
    const expenseId = canSeeCosts ? (extras.expenseIdBySource.get(i.id) ?? null) : null;
    const r = i.performedReading;
    const attachments = [
      ...(extras.attachmentsByOwner.get(`INTERVENTION:${i.id}`) ?? []),
      ...(r ? (extras.attachmentsByOwner.get(`RELEVE:${r.id}`) ?? []) : []),
      ...(expenseId ? (extras.attachmentsByOwner.get(`DEPENSE:${expenseId}`) ?? []) : []),
    ];
    return {
      id: i.id,
      reference: i.reference,
      companyId: i.companyId,
      vehicleId: i.vehicleId,
      vehicleCode: i.vehicle.code,
      vehicleRegistration: i.vehicle.registration,
      kind: i.kind,
      status: i.status,
      supplierId: i.supplierId,
      supplierName: i.supplier?.name ?? null,
      plannedStartAt: i.plannedStartAt?.toISOString() ?? null,
      plannedEndAt: i.plannedEndAt?.toISOString() ?? null,
      startedAt: i.startedAt?.toISOString() ?? null,
      completedAt: i.completedAt?.toISOString() ?? null,
      performedOn: fromDbDate(i.performedOn),
      performedReadingId: i.performedReadingId,
      performedKm: kmValue(i.performedKm),
      executionReading: r
        ? { id: r.id, physicalKm: kmValue(r.physicalKm), cumulativeKm: kmValue(r.cumulativeKm), observedAt: r.observedAt.toISOString(), source: r.source, measurementKind: r.measurementKind, context: r.context, status: r.status, isEstimate: r.isEstimate }
        : null,
      diagnosis: i.diagnosis,
      workDescription: i.workDescription,
      totalAmount: canSeeCosts ? (i.totalAmount?.toFixed(3) ?? null) : null,
      costStatus: i.costStatus,
      expenseId,
      incidentId: i.incidentId,
      isHistorical: i.isHistorical,
      cancelReason: i.cancelReason,
      reopenReason: i.reopenReason,
      tasks: i.tasks.map((t) => ({ id: t.id, label: t.label, planId: t.planId, maintenanceTypeId: t.maintenanceTypeId, maintenanceTypeLabel: t.maintenanceType?.label ?? null, completed: t.completed, notes: t.notes })),
      lines: canSeeCosts ? i.lines.map((l) => ({ id: l.id, taskId: l.taskId, kind: l.kind, label: l.label, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toFixed(3), amount: l.amount.toFixed(3) })) : [],
      attachments,
      openImmobilizationCauseId: i.immobilizationCauses[0]?.id ?? null,
      version: i.version,
    };
  }
}

