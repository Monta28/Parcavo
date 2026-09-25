import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { Prisma } from '@parc-auto/db';
import { EXPENSE_CATEGORY_LABELS } from '@parc-auto/contracts';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, ConflictError, ErrorCodes, ForbiddenActionError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import { type Page, pageOf, resolveSort, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import { assertCivilDate, compareCivil, endOfLocalDay, formatCivilDate, fromDbDate, localDate, toDbDate } from '../../domain/civil-date.js';
import {
  type ExpenseCategoryKey,
  type ExpenseKindKey,
  type LedgerBucket,
  MONEY_DECIMALS,
  UNALLOCATED_EXPENSE_LABEL,
  UNALLOCATED_LINE_LABEL,
  amountRejection,
  defaultExcludedFromOperatingCost,
  isVehicleOptional,
  normalizeReference,
  signedAmount,
  summarizeLedger,
} from '../../domain/expense-ledger.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, type Tx } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { companyAt } from '../odometer/odometer-ingestion.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { SuppliersService } from '../suppliers/suppliers.service.js';
import type { CancelExpenseDto, CorrectExpenseDto, OperatingCostDto } from './dto/correct-expense.dto.js';
import type { CreateExpenseDto } from './dto/create-expense.dto.js';
import {
  EXPENSE_SORTS,
  type ExpenseBucketDto,
  type ExpenseFilters,
  type ExpenseStatusFilter,
  type ExpenseSummaryDto,
  type ExpenseViewDto,
  type ExpensesQueryDto,
  type ExpensesSummaryQueryDto,
} from './dto/expense-view.dto.js';
import { costsReadableWhere, incidentExpensesWhere } from './expense-links.js';

const expenseInclude = {
  vehicle: { select: { code: true, registration: true } },
  supplier: { select: { name: true } },
  replacedBy: { select: { id: true } },
} satisfies Prisma.ExpenseInclude;

type ExpenseRow = Prisma.ExpenseGetPayload<{ include: typeof expenseInclude }>;

/** Valeurs métier d'une dépense (saisie, correction, audit avant/après). */
interface ExpenseFields {
  vehicleId: string | null;
  occurredOn: string;
  category: ExpenseCategoryKey;
  supplierId: string | null;
  reference: string | null;
  amount: Decimal;
  attachmentId: string | null;
  notes: string | null;
  relatedIncidentId: string | null;
  relatedExpenseId: string | null;
  excludedFromOperatingCost: boolean;
}

interface OrgInfo {
  timezone: string;
  currency: string;
}

const COSTS_READ_MESSAGE = 'La consultation des coûts requiert la permission costs.read.';
const COSTS_WRITE_MESSAGE = 'La saisie des coûts requiert la permission costs.write.';
const VERSION_LABEL = 'enregistrement de dépense';

/**
 * Registre unique des dépenses (CDC 8.4 ; D-206, D-217, D-229 à D-233). Une dépense validée est
 * immuable : une correction crée une nouvelle version (l'ancienne passe REMPLACEE), une annulation
 * la retire de sa période d'origine, un avoir réduit le coût. La société imputée est celle qui gérait
 * le véhicule à la date de la dépense (jamais réimputée après un transfert). Les dépenses de synthèse
 * (plein, intervention) sont créées et corrigées par leur source ; elles apparaissent ici une seule
 * fois. Lecture réservée à costs.read, saisie à costs.write, correction et annulation au chef ; toute
 * opération sur une dépense existante (réponse = la dépense) exige aussi costs.read.
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly suppliers: SuppliersService,
    private readonly attachments: AttachmentsService,
    private readonly settings: SettingsService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ---------------------------------------------------------------------------
  // Lecture
  // ---------------------------------------------------------------------------

  async list(ctx: RequestContext, query: ExpensesQueryDto): Promise<Page<ExpenseViewDto>> {
    const where = await this.filterWhere(ctx, query, query.status ?? 'VALIDEE');
    const sort = resolveSort(query.sort, EXPENSE_SORTS, 'occurredOn');
    const direction = query.sort ? query.order : 'desc';
    const orderBy: Prisma.ExpenseOrderByWithRelationInput[] = [sort === 'amount' ? { amount: direction } : sort === 'createdAt' ? { createdAt: direction } : { occurredOn: direction }, { createdAt: direction }, { id: direction }];
    const [rows, total] = await Promise.all([
      this.prisma.client.expense.findMany({ where, include: expenseInclude, orderBy, ...skipTake(query) }),
      this.prisma.client.expense.count({ where }),
    ]);
    return pageOf(await this.views(ctx, rows), total, query);
  }

  async get(ctx: RequestContext, id: string): Promise<ExpenseViewDto> {
    const row = await this.loadRow(ctx, id);
    this.access.requirePermission(ctx, row.companyId, 'costs.read', COSTS_READ_MESSAGE);
    return (await this.views(ctx, [row]))[0] as ExpenseViewDto;
  }

  /**
   * Totaux exacts du registre sur la période et le périmètre : dépenses validées uniquement (annulées
   * et remplacées exclues), par catégorie, ligne « Non ventilé » pour les dépenses sans véhicule,
   * dépenses exclues du coût d'exploitation (achats de véhicules par défaut) présentées à part.
   */
  async summary(ctx: RequestContext, query: ExpensesSummaryQueryDto): Promise<ExpenseSummaryDto> {
    const where = await this.filterWhere(ctx, query, 'VALIDEE');
    const [rows, org] = await Promise.all([
      this.prisma.client.expense.findMany({ where, select: { category: true, kind: true, status: true, amount: true, vehicleId: true, excludedFromOperatingCost: true } }),
      this.orgInfo(ctx.organizationId),
    ]);
    const s = summarizeLedger(rows.map((r) => ({ ...r, amount: r.amount.toString() })));
    const bucket = (b: LedgerBucket): ExpenseBucketDto => ({ expenses: b.expenses.toFixed(MONEY_DECIMALS), credits: b.credits.toFixed(MONEY_DECIMALS), net: b.net.toFixed(MONEY_DECIMALS), count: b.count });
    const categories = (list: Array<{ category: ExpenseCategoryKey } & LedgerBucket>) => list.map((c) => ({ category: c.category, label: EXPENSE_CATEGORY_LABELS[c.category], ...bucket(c) }));
    return {
      currency: org.currency,
      companyId: query.companyId ?? null,
      vehicleId: query.vehicleId ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
      byCategory: categories(s.byCategory),
      operating: { label: 'Coût d’exploitation', ...bucket(s.operating) },
      unallocated: { label: UNALLOCATED_LINE_LABEL, ...bucket(s.unallocated) },
      excludedFromOperatingCost: { label: 'Hors coût d’exploitation (informatif)', ...bucket(s.excluded), byCategory: categories(s.excluded.byCategory) },
    };
  }

  // ---------------------------------------------------------------------------
  // Saisie
  // ---------------------------------------------------------------------------

  /**
   * Dépense manuelle ou avoir (8.4) : idempotent (clé liée à l'utilisateur, à l'organisation et à
   * l'opération), transaction sérialisable pour l'unicité de la référence fournisseur (D-232).
   */
  async create(ctx: RequestContext, dto: CreateExpenseDto, idempotencyKey: string): Promise<ExpenseViewDto> {
    this.access.requireStaff(ctx);
    const org = await this.orgInfo(ctx.organizationId);
    const kind: ExpenseKindKey = dto.kind ?? 'DEPENSE';
    const occurredOn = this.civilDate(dto.occurredOn, 'occurredOn');
    const target = await this.resolveTarget(ctx, { vehicleId: dto.vehicleId ?? null, companyId: dto.companyId ?? null, occurredOn, category: dto.category }, org.timezone);
    this.access.requirePermission(ctx, target.companyId, 'costs.write', COSTS_WRITE_MESSAGE);
    const body = { ...dto, idempotencyKey: undefined };
    const result = await this.idempotency.run({ organizationId: ctx.organizationId, userId: ctx.userId, operation: 'expense.create', key: idempotencyKey }, body, async () => {
      const vehiclePurchaseExcluded = await this.settings.get(ctx.organizationId, 'expenses.vehiclePurchaseExcludedByDefault');
      const fields: ExpenseFields = {
        vehicleId: target.vehicleId,
        occurredOn,
        category: dto.category,
        supplierId: dto.supplierId ?? null,
        reference: normalizeReference(dto.reference),
        amount: this.parseAmount(dto.amount),
        attachmentId: dto.attachmentId ?? null,
        notes: dto.notes?.trim() || null,
        relatedIncidentId: dto.relatedIncidentId ?? null,
        relatedExpenseId: dto.relatedExpenseId ?? null,
        excludedFromOperatingCost: dto.excludedFromOperatingCost ?? defaultExcludedFromOperatingCost(dto.category, vehiclePurchaseExcluded),
      };
      const duplicateConfirmed = await this.validateFields(ctx, org, target.companyId, kind, fields, { supplier: true, incident: true, related: true, attachment: true }, dto.confirmDuplicateAttachment === true, null);
      const id = await this.prisma.serializable(async (tx) => {
        if (fields.reference) await this.assertReferenceFree(tx, ctx.organizationId, target.companyId, fields.supplierId, fields.reference);
        if (fields.relatedExpenseId) await this.assertOriginStillActive(tx, fields.relatedExpenseId, false);
        const created = await tx.expense.create({ data: { organizationId: ctx.organizationId, companyId: target.companyId, kind, currency: org.currency, createdById: ctx.userId, ...this.data(fields) } });
        if (fields.attachmentId) await this.attachments.attach(ctx, tx, fields.attachmentId, 'DEPENSE', created.id, target.companyId);
        await this.audit.record(ctx, { action: kind === 'AVOIR' ? 'depense.avoir' : 'depense.creation', objectType: 'Expense', objectId: created.id, companyId: target.companyId, after: { kind, ...this.snapshot(fields), ...(duplicateConfirmed ? { duplicateAttachmentConfirmed: true } : {}) } }, tx);
        return created.id;
      });
      return { status: 201, body: await this.viewById(ctx, id), resourceId: id };
    });
    return result.body;
  }

  /**
   * Correction d'une dépense validée (D-229) : nouvelle dépense VALIDEE (replacesExpenseId), ancienne
   * REMPLACEE, même société, même nature, même source ; motif obligatoire ; chef ou administrateur
   * avec costs.write (et costs.read : la réponse montre la dépense) ; idempotente et versionnée. Une
   * dépense de synthèse se corrige par sa source (plein, intervention).
   */
  async correct(ctx: RequestContext, id: string, dto: CorrectExpenseDto, idempotencyKey: string): Promise<ExpenseViewDto> {
    const current = await this.loadRow(ctx, id);
    this.access.requireManager(ctx, current.companyId);
    this.requireCostsReadWrite(ctx, current.companyId);
    this.assertManual(current);
    const body = { ...dto, idempotencyKey: undefined, expenseId: id };
    // Idempotence (clé liée à l'utilisateur, à l'organisation et à l'opération) : une relance après une
    // réponse perdue rejoue la nouvelle version au lieu d'échouer sur la version devenue obsolète.
    const result = await this.idempotency.run({ organizationId: ctx.organizationId, userId: ctx.userId, operation: 'expense.correct', key: idempotencyKey }, body, async () => {
      this.assertValidated(current);
      assertExpectedVersion(current, dto.expectedVersion, VERSION_LABEL);
      const org = await this.orgInfo(ctx.organizationId);
      const before = fieldsOf(current);
      const occurredOn = dto.occurredOn ? this.civilDate(dto.occurredOn, 'occurredOn') : before.occurredOn;
      const vehicleId = dto.vehicleId !== undefined ? dto.vehicleId : before.vehicleId;
      const category = dto.category ?? before.category;
      const target = await this.resolveTarget(ctx, { vehicleId, companyId: vehicleId ? null : current.companyId, occurredOn, category }, org.timezone);
      if (target.companyId !== current.companyId) {
        throw new BusinessRuleError('SOCIETE_INCHANGEE', 'Une correction conserve la société imputée : à cette date, ce véhicule relevait d’une autre société. Annulez la dépense puis saisissez-la de nouveau.', { fieldErrors: { occurredOn: ['Société imputée différente à cette date.'] } });
      }
      const vehiclePurchaseExcluded = await this.settings.get(ctx.organizationId, 'expenses.vehiclePurchaseExcludedByDefault');
      const after: ExpenseFields = {
        vehicleId: target.vehicleId,
        occurredOn,
        category,
        supplierId: dto.supplierId !== undefined ? dto.supplierId : before.supplierId,
        reference: dto.reference !== undefined ? normalizeReference(dto.reference) : before.reference,
        amount: dto.amount !== undefined ? this.parseAmount(dto.amount) : before.amount,
        attachmentId: dto.attachmentId !== undefined ? dto.attachmentId : before.attachmentId,
        notes: dto.notes !== undefined ? dto.notes?.trim() || null : before.notes,
        relatedIncidentId: dto.relatedIncidentId !== undefined ? dto.relatedIncidentId : before.relatedIncidentId,
        relatedExpenseId: dto.relatedExpenseId !== undefined ? dto.relatedExpenseId : before.relatedExpenseId,
        excludedFromOperatingCost: dto.excludedFromOperatingCost ?? (category !== before.category ? defaultExcludedFromOperatingCost(category, vehiclePurchaseExcluded) : before.excludedFromOperatingCost),
      };
      const beforeSnapshot = this.snapshot(before);
      const afterSnapshot = this.snapshot(after);
      if (JSON.stringify(beforeSnapshot) === JSON.stringify(afterSnapshot)) throw new BusinessRuleError('CORRECTION_SANS_EFFET', 'La correction ne modifie aucune valeur de la dépense.');
      const duplicateConfirmed = await this.validateFields(
        ctx,
        org,
        current.companyId,
        current.kind,
        after,
        { supplier: after.supplierId !== before.supplierId, incident: after.relatedIncidentId !== before.relatedIncidentId || after.vehicleId !== before.vehicleId, related: after.relatedExpenseId !== before.relatedExpenseId, attachment: after.attachmentId !== before.attachmentId },
        dto.confirmDuplicateAttachment === true,
        current.id,
      );
      const newId = await this.prisma.serializable(async (tx) => {
        const replaced = await tx.expense.updateMany({ where: { id, version: dto.expectedVersion, status: 'VALIDEE' }, data: { status: 'REMPLACEE', version: { increment: 1 } } });
        if (replaced.count !== 1) throw new ConflictError(ErrorCodes.VERSION_OBSOLETE, 'La dépense a été modifiée entre-temps : rechargez puis réessayez.');
        if (after.reference) await this.assertReferenceFree(tx, ctx.organizationId, current.companyId, after.supplierId, after.reference);
        // Un avoir conserve son rattachement à une version antérieure (chaîne de corrections), jamais à une dépense annulée.
        if (after.relatedExpenseId) await this.assertOriginStillActive(tx, after.relatedExpenseId, after.relatedExpenseId === before.relatedExpenseId);
        const created = await tx.expense.create({
          data: { organizationId: ctx.organizationId, companyId: current.companyId, kind: current.kind, currency: current.currency, sourceType: current.sourceType, sourceId: current.sourceId, replacesExpenseId: current.id, createdById: ctx.userId, ...this.data(after) },
        });
        if (after.attachmentId && after.attachmentId !== before.attachmentId) await this.attachments.attach(ctx, tx, after.attachmentId, 'DEPENSE', created.id, current.companyId);
        await this.audit.record(ctx, { action: 'depense.correction', objectType: 'Expense', objectId: current.id, companyId: current.companyId, reason: dto.reason.trim(), before: beforeSnapshot, after: { ...afterSnapshot, newExpenseId: created.id, ...(duplicateConfirmed ? { duplicateAttachmentConfirmed: true } : {}) } }, tx);
        return created.id;
      });
      return { status: 201, body: await this.viewById(ctx, newId), resourceId: newId };
    });
    return result.body;
  }

  /** Annulation motivée (D-229) : statut ANNULEE, le coût disparaît de sa période d'origine. */
  async cancel(ctx: RequestContext, id: string, dto: CancelExpenseDto): Promise<ExpenseViewDto> {
    const current = await this.loadRow(ctx, id);
    this.access.requireManager(ctx, current.companyId);
    this.requireCostsReadWrite(ctx, current.companyId);
    this.assertManual(current);
    this.assertValidated(current);
    assertExpectedVersion(current, dto.expectedVersion, VERSION_LABEL);
    await this.prisma.serializable(async (tx) => {
      // Avoirs rattachés à cette dépense ou à l'une de ses versions antérieures (chaîne de corrections).
      const versions = [id];
      for (let previous = current.replacesExpenseId; previous !== null; ) {
        versions.push(previous);
        previous = (await tx.expense.findUnique({ where: { id: previous }, select: { replacesExpenseId: true } }))?.replacesExpenseId ?? null;
      }
      const credits = current.kind === 'DEPENSE' ? await tx.expense.findMany({ where: { relatedExpenseId: { in: versions }, kind: 'AVOIR', status: 'VALIDEE' }, select: { id: true } }) : [];
      if (credits.length > 0) throw new ConflictError('AVOIRS_LIES', 'Des avoirs validés se rattachent à cette dépense : annulez-les d’abord.', { creditExpenseIds: credits.map((c) => c.id) });
      const cancelled = await tx.expense.updateMany({
        where: { id, version: dto.expectedVersion, status: 'VALIDEE' },
        data: { status: 'ANNULEE', cancelledAt: this.clock.now(), cancelledById: ctx.userId, cancelReason: dto.reason.trim(), version: { increment: 1 } },
      });
      if (cancelled.count !== 1) throw new ConflictError(ErrorCodes.VERSION_OBSOLETE, 'La dépense a été modifiée entre-temps : rechargez puis réessayez.');
      await this.audit.record(ctx, { action: 'depense.annulation', objectType: 'Expense', objectId: id, companyId: current.companyId, reason: dto.reason.trim(), before: { status: 'VALIDEE', kind: current.kind, ...this.snapshot(fieldsOf(current)) }, after: { status: 'ANNULEE' } }, tx);
    });
    return this.viewById(ctx, id);
  }

  /**
   * Inclusion ou exclusion du coût d'exploitation (D-233) : titulaire de costs.write, audité. La réponse
   * étant la dépense elle-même, costs.read est aussi exigé : sans lui, la bascule (même sans effet)
   * servirait à lire un montant que la consultation refuse (8.4, R-8.4-12).
   */
  async setOperatingCost(ctx: RequestContext, id: string, dto: OperatingCostDto): Promise<ExpenseViewDto> {
    const current = await this.loadRow(ctx, id);
    this.requireCostsReadWrite(ctx, current.companyId);
    this.assertValidated(current);
    assertExpectedVersion(current, dto.expectedVersion, VERSION_LABEL);
    if (current.excludedFromOperatingCost === dto.excludedFromOperatingCost) return this.viewById(ctx, id);
    await this.prisma.transaction(async (tx) => {
      const updated = await tx.expense.updateMany({ where: { id, version: dto.expectedVersion, status: 'VALIDEE' }, data: { excludedFromOperatingCost: dto.excludedFromOperatingCost, version: { increment: 1 } } });
      if (updated.count !== 1) throw new ConflictError(ErrorCodes.VERSION_OBSOLETE, 'La dépense a été modifiée entre-temps : rechargez puis réessayez.');
      await this.audit.record(ctx, { action: 'depense.cout_exploitation', objectType: 'Expense', objectId: id, companyId: current.companyId, reason: dto.reason?.trim() || null, before: { excludedFromOperatingCost: current.excludedFromOperatingCost }, after: { excludedFromOperatingCost: dto.excludedFromOperatingCost } }, tx);
    });
    return this.viewById(ctx, id);
  }

  // ---------------------------------------------------------------------------
  // Périmètre et règles
  // ---------------------------------------------------------------------------

  /** Périmètre de lecture des coûts : sociétés visibles où l'utilisateur détient costs.read. */
  private readScope(ctx: RequestContext, requestedCompanyId: string | undefined): Prisma.ExpenseWhereInput {
    this.access.requireStaff(ctx);
    if (requestedCompanyId) {
      this.access.requirePermission(ctx, requestedCompanyId, 'costs.read', COSTS_READ_MESSAGE);
      return { organizationId: ctx.organizationId, companyId: requestedCompanyId };
    }
    if (!this.access.hasPermissionAnywhere(ctx, 'costs.read')) throw new ForbiddenActionError(COSTS_READ_MESSAGE, { permission: 'costs.read' });
    return costsReadableWhere(ctx, this.access);
  }

  /** Opération sur une dépense existante dont la réponse montre le contenu : saisie ET consultation des coûts. */
  private requireCostsReadWrite(ctx: RequestContext, companyId: string): void {
    this.access.requirePermission(ctx, companyId, 'costs.write', COSTS_WRITE_MESSAGE);
    this.access.requirePermission(ctx, companyId, 'costs.read', COSTS_READ_MESSAGE);
  }

  private async filterWhere(ctx: RequestContext, f: ExpenseFilters, status: ExpenseStatusFilter): Promise<Prisma.ExpenseWhereInput> {
    const scope = this.readScope(ctx, f.companyId);
    if (f.from) this.civilDate(f.from, 'from');
    if (f.to) this.civilDate(f.to, 'to');
    if (f.from && f.to && compareCivil(f.from, f.to) > 0) throw new BusinessRuleError('PERIODE_INVALIDE', 'La date de début est postérieure à la date de fin.', { fieldErrors: { to: ['Fin avant le début.'] } });
    let incident: Prisma.ExpenseWhereInput = {};
    if (f.relatedIncidentId) {
      const interventions = await this.prisma.client.intervention.findMany({ where: { organizationId: ctx.organizationId, incidentId: f.relatedIncidentId }, select: { id: true } });
      incident = incidentExpensesWhere(f.relatedIncidentId, interventions.map((i) => i.id));
    }
    const q = f.q?.trim();
    return {
      AND: [
        scope,
        status === 'TOUS' ? {} : { status },
        f.vehicleId ? { vehicleId: f.vehicleId } : {},
        f.unallocated === 'true' ? { vehicleId: null } : f.unallocated === 'false' ? { vehicleId: { not: null } } : {},
        f.category ? { category: f.category } : {},
        f.supplierId ? { supplierId: f.supplierId } : {},
        f.from ? { occurredOn: { gte: toDbDate(f.from) as Date } } : {},
        f.to ? { occurredOn: { lte: toDbDate(f.to) as Date } } : {},
        f.kind ? { kind: f.kind } : {},
        f.sourceType === 'MANUELLE' ? { sourceType: null } : f.sourceType ? { sourceType: f.sourceType } : {},
        incident,
        q ? { OR: [{ reference: { contains: q, mode: 'insensitive' } }, { notes: { contains: q, mode: 'insensitive' } }, { supplier: { name: { contains: q, mode: 'insensitive' } } }] } : {},
      ],
    };
  }

  /** Dépense de l'organisation, dans une société visible (sinon 404, sans révéler son existence). */
  private async loadRow(ctx: RequestContext, id: string): Promise<ExpenseRow> {
    const row = await this.prisma.client.expense.findFirst({ where: { id, organizationId: ctx.organizationId }, include: expenseInclude });
    if (!row || ctx.isDriverOnly || !this.access.canReadCompany(ctx, row.companyId)) throw new NotFoundOrOutOfScopeError('Dépense');
    return row;
  }

  /**
   * Société imputée (8.4, D-231) : avec un véhicule, la société qui le gérait à la date de la dépense
   * (historique des transferts, fin du jour civil local) ; sans véhicule (D-230), la société indiquée,
   * réservée aux catégories assurance, taxes, location et autre.
   */
  private async resolveTarget(ctx: RequestContext, input: { vehicleId: string | null; companyId: string | null; occurredOn: string; category: ExpenseCategoryKey }, timezone: string): Promise<{ companyId: string; vehicleId: string | null }> {
    if (input.vehicleId) {
      const vehicle = await this.prisma.client.vehicle.findFirst({ where: { id: input.vehicleId, organizationId: ctx.organizationId }, select: { id: true, companyId: true } });
      if (!vehicle || ctx.isDriverOnly) throw new NotFoundOrOutOfScopeError('Véhicule');
      // Règle unique « société du véhicule à une date » (avant le premier historique : société d'origine).
      const companyId = await companyAt(this.prisma.client, vehicle.id, endOfLocalDay(input.occurredOn, timezone), vehicle.companyId);
      if (!this.access.canReadCompany(ctx, companyId)) {
        if (this.access.canReadCompany(ctx, vehicle.companyId)) {
          throw new BusinessRuleError('PERIODE_HORS_PERIMETRE', `Au ${formatCivilDate(input.occurredOn)}, ce véhicule relevait d’une autre société : la dépense lui est imputée et seul un utilisateur habilité sur cette société peut la saisir.`, { fieldErrors: { occurredOn: ['Date antérieure au transfert du véhicule dans votre société.'] } });
        }
        throw new NotFoundOrOutOfScopeError('Véhicule');
      }
      if (input.companyId && input.companyId !== companyId) {
        throw new BusinessRuleError('SOCIETE_HISTORIQUE', 'La dépense est imputée à la société qui gérait le véhicule à cette date, pas à la société indiquée.', { fieldErrors: { companyId: ['Société différente de la société gestionnaire à cette date.'] } });
      }
      return { companyId, vehicleId: vehicle.id };
    }
    if (!isVehicleOptional(input.category)) {
      throw new BusinessRuleError('VEHICULE_REQUIS', 'Seules les catégories assurance, taxes, location et autre admettent une dépense sans véhicule.', { fieldErrors: { vehicleId: ['Véhicule obligatoire pour cette catégorie.'] } });
    }
    if (!input.companyId) throw new BusinessRuleError('SOCIETE_REQUISE', 'Indiquez la société d’une dépense sans véhicule.', { fieldErrors: { companyId: ['Société obligatoire sans véhicule.'] } });
    const company = await this.prisma.client.company.findFirst({ where: { id: input.companyId, organizationId: ctx.organizationId }, select: { id: true } });
    if (!company || !this.access.canReadCompany(ctx, company.id)) throw new NotFoundOrOutOfScopeError('Société');
    return { companyId: company.id, vehicleId: null };
  }

  /**
   * Contrôles de saisie (hors unicité de référence, vérifiée dans la transaction) : date non future,
   * fournisseur actif de la société, incident du même véhicule, avoir rattaché à une dépense validée
   * de la même société, justificatif déjà utilisé (avertissement à confirmer, D-232 niveau 3).
   * Renvoie vrai si un justificatif en double a été explicitement confirmé.
   */
  private async validateFields(
    ctx: RequestContext,
    org: OrgInfo,
    companyId: string,
    kind: ExpenseKindKey,
    f: ExpenseFields,
    check: { supplier: boolean; incident: boolean; related: boolean; attachment: boolean },
    confirmDuplicateAttachment: boolean,
    replacingExpenseId: string | null,
  ): Promise<boolean> {
    const today = localDate(this.clock.now(), org.timezone);
    if (compareCivil(f.occurredOn, today) > 0) throw new BusinessRuleError('DATE_FUTURE', 'La date de la dépense ne peut pas être postérieure à aujourd’hui.', { fieldErrors: { occurredOn: ['Date future refusée.'] } });
    if (f.relatedExpenseId && kind !== 'AVOIR') throw new BusinessRuleError('AVOIR_SEULEMENT', 'Seul un avoir se rattache à une dépense d’origine.', { fieldErrors: { relatedExpenseId: ['Réservé aux avoirs.'] } });
    if (check.supplier && f.supplierId) await this.suppliers.requireUsable(ctx, f.supplierId, companyId);
    if (check.incident && f.relatedIncidentId) {
      const incident = await this.prisma.client.incident.findFirst({ where: { id: f.relatedIncidentId, organizationId: ctx.organizationId }, select: { companyId: true, vehicleId: true } });
      if (!incident || !this.access.canReadCompany(ctx, incident.companyId)) throw new NotFoundOrOutOfScopeError('Incident');
      if (incident.vehicleId !== f.vehicleId) throw new BusinessRuleError('INCIDENT_AUTRE_VEHICULE', 'L’incident lié doit concerner le véhicule de la dépense.', { fieldErrors: { relatedIncidentId: ['Incident d’un autre véhicule.'] } });
    }
    if (check.related && f.relatedExpenseId) {
      const origin = await this.prisma.client.expense.findFirst({ where: { id: f.relatedExpenseId, organizationId: ctx.organizationId }, select: { companyId: true, kind: true, status: true } });
      if (!origin || !this.access.canReadCompany(ctx, origin.companyId)) throw new NotFoundOrOutOfScopeError('Dépense d’origine');
      if (origin.companyId !== companyId) throw new BusinessRuleError('AVOIR_AUTRE_SOCIETE', 'Un avoir se rattache à une dépense de la même société.', { fieldErrors: { relatedExpenseId: ['Dépense d’une autre société.'] } });
      if (origin.kind !== 'DEPENSE') throw new BusinessRuleError('AVOIR_SUR_AVOIR', 'Un avoir se rattache à une dépense, pas à un autre avoir.', { fieldErrors: { relatedExpenseId: ['Avoir non admis.'] } });
      if (origin.status !== 'VALIDEE') throw new BusinessRuleError('DEPENSE_ORIGINE_INACTIVE', 'La dépense d’origine est annulée ou remplacée : rattachez l’avoir à la version en vigueur.', { fieldErrors: { relatedExpenseId: ['Dépense non validée.'] } });
    }
    if (check.attachment && f.attachmentId) return this.checkDuplicateAttachment(ctx, f.attachmentId, companyId, confirmDuplicateAttachment, replacingExpenseId);
    return false;
  }

  /** Niveau 3 de D-232 : un justificatif identique (sha256) déjà rattaché à une dépense ou à un plein actif de la société. */
  private async checkDuplicateAttachment(ctx: RequestContext, attachmentId: string, companyId: string, confirmed: boolean, replacingExpenseId: string | null): Promise<boolean> {
    const attachment = await this.prisma.client.attachment.findFirst({ where: { id: attachmentId, organizationId: ctx.organizationId, deletedAt: null }, select: { sha256: true, companyId: true } });
    if (!attachment || (attachment.companyId && !this.access.canReadCompany(ctx, attachment.companyId))) throw new NotFoundOrOutOfScopeError('Pièce jointe');
    const twins = await this.prisma.client.attachment.findMany({ where: { organizationId: ctx.organizationId, sha256: attachment.sha256, deletedAt: null, id: { not: attachmentId } }, select: { id: true } });
    if (twins.length === 0) return false;
    const twinIds = twins.map((t) => t.id);
    const [expenses, fuelEntries] = await Promise.all([
      this.prisma.client.expense.findMany({ where: { organizationId: ctx.organizationId, companyId, status: 'VALIDEE', attachmentId: { in: twinIds }, ...(replacingExpenseId ? { id: { not: replacingExpenseId } } : {}) }, select: { id: true } }),
      this.prisma.client.fuelEntry.findMany({ where: { organizationId: ctx.organizationId, companyId, status: { in: ['SOUMIS', 'VALIDE'] }, ticketAttachmentId: { in: twinIds } }, select: { id: true } }),
    ]);
    if (expenses.length === 0 && fuelEntries.length === 0) return false;
    if (!confirmed) {
      throw new ConflictError('JUSTIFICATIF_DEJA_UTILISE', 'Ce justificatif (fichier identique) est déjà rattaché à une dépense ou à un plein de la société. Vérifiez qu’il ne s’agit pas d’une double saisie, puis confirmez pour enregistrer quand même.', {
        expenseIds: expenses.map((e) => e.id),
        fuelEntryIds: fuelEntries.map((e) => e.id),
      });
    }
    return true;
  }

  /**
   * Unicité de la référence d'une dépense saisie (D-232 niveau 2) : même société, même fournisseur,
   * même référence sans tenir compte de la casse, parmi les dépenses validées sans source. Appelé
   * dans une transaction sérialisable : deux saisies concurrentes ne peuvent pas toutes deux réussir.
   */
  private async assertReferenceFree(tx: Tx, organizationId: string, companyId: string, supplierId: string | null, reference: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Expense"
      WHERE "organizationId" = ${organizationId}::uuid
        AND "companyId" = ${companyId}::uuid
        AND "supplierId" IS NOT DISTINCT FROM ${supplierId}::uuid
        AND "sourceType" IS NULL
        AND "status" = 'VALIDEE'
        AND lower("reference") = lower(${reference})
      LIMIT 1`;
    const existing = rows[0];
    if (existing) {
      throw new ConflictError('DEPENSE_REFERENCE_EXISTANTE', `Une dépense validée porte déjà la référence « ${reference} » pour ce fournisseur dans cette société.`, { existingExpenseId: existing.id });
    }
  }

  /**
   * Relecture, dans la transaction sérialisable, de la dépense d'origine d'un avoir : une annulation
   * concurrente (qui vérifie l'absence d'avoirs validés) et le rattachement d'un avoir ne peuvent pas
   * réussir tous deux. Une version REMPLACEE n'est admise que pour un rattachement inchangé.
   */
  private async assertOriginStillActive(tx: Tx, relatedExpenseId: string, allowReplaced: boolean): Promise<void> {
    const origin = await tx.expense.findUnique({ where: { id: relatedExpenseId }, select: { status: true } });
    if (origin?.status === 'VALIDEE' || (allowReplaced && origin?.status === 'REMPLACEE')) return;
    throw new BusinessRuleError('DEPENSE_ORIGINE_INACTIVE', 'La dépense d’origine est annulée ou remplacée : rattachez l’avoir à la version en vigueur.', { fieldErrors: { relatedExpenseId: ['Dépense non validée.'] } });
  }

  private assertManual(row: ExpenseRow): void {
    if (row.sourceType === 'PLEIN') {
      throw new BusinessRuleError('CORRECTION_PAR_LA_SOURCE', 'Cette dépense est la synthèse d’un plein : corrigez ou annulez le plein depuis le module carburant, qui remplace la dépense dans la même opération.', { details: { sourceType: row.sourceType, sourceId: row.sourceId } });
    }
    if (row.sourceType === 'INTERVENTION') {
      throw new BusinessRuleError('CORRECTION_PAR_LA_SOURCE', 'Cette dépense est la synthèse d’une intervention : rouvrez l’intervention (chef de parc) pour corriger son coût.', { details: { sourceType: row.sourceType, sourceId: row.sourceId } });
    }
  }

  private assertValidated(row: ExpenseRow): void {
    if (row.status === 'REMPLACEE') throw new ConflictError('ETAT_INVALIDE', 'Cette dépense a déjà été corrigée : travaillez sur la version en vigueur.', { replacedByExpenseId: row.replacedBy?.id ?? null });
    if (row.status === 'ANNULEE') throw new ConflictError('ETAT_INVALIDE', 'Cette dépense est annulée.');
  }

  private civilDate(value: string, field: string): string {
    try {
      return assertCivilDate(value);
    } catch {
      throw new BusinessRuleError('DATE_INVALIDE', 'Date inexistante.', { fieldErrors: { [field]: ['Date inexistante (AAAA-MM-JJ).'] } });
    }
  }

  private parseAmount(input: string): Decimal {
    const rejection = amountRejection(input);
    if (rejection) throw new BusinessRuleError('MONTANT_INVALIDE', rejection, { fieldErrors: { amount: [rejection] } });
    return new Decimal(input);
  }

  private data(f: ExpenseFields) {
    return {
      vehicleId: f.vehicleId,
      occurredOn: toDbDate(f.occurredOn) as Date,
      category: f.category,
      supplierId: f.supplierId,
      reference: f.reference,
      amount: f.amount.toFixed(MONEY_DECIMALS),
      attachmentId: f.attachmentId,
      notes: f.notes,
      relatedIncidentId: f.relatedIncidentId,
      relatedExpenseId: f.relatedExpenseId,
      excludedFromOperatingCost: f.excludedFromOperatingCost,
    } satisfies Partial<Prisma.ExpenseUncheckedCreateInput>;
  }

  private snapshot(f: ExpenseFields): Record<string, string | boolean | null> {
    return {
      vehicleId: f.vehicleId,
      occurredOn: f.occurredOn,
      category: f.category,
      supplierId: f.supplierId,
      reference: f.reference,
      amount: f.amount.toFixed(MONEY_DECIMALS),
      attachmentId: f.attachmentId,
      notes: f.notes,
      relatedIncidentId: f.relatedIncidentId,
      relatedExpenseId: f.relatedExpenseId,
      excludedFromOperatingCost: f.excludedFromOperatingCost,
    };
  }

  private async orgInfo(organizationId: string): Promise<OrgInfo> {
    return this.prisma.client.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true, currency: true } });
  }

  // ---------------------------------------------------------------------------
  // Vues
  // ---------------------------------------------------------------------------

  private async viewById(ctx: RequestContext, id: string): Promise<ExpenseViewDto> {
    const row = await this.prisma.client.expense.findUniqueOrThrow({ where: { id }, include: expenseInclude });
    return (await this.views(ctx, [row]))[0] as ExpenseViewDto;
  }

  private async views(ctx: RequestContext, rows: ExpenseRow[]): Promise<ExpenseViewDto[]> {
    const incidentIds = [...new Set(rows.map((r) => r.relatedIncidentId).filter((x): x is string => x !== null))];
    const incidents = incidentIds.length > 0 ? await this.prisma.client.incident.findMany({ where: { id: { in: incidentIds }, organizationId: ctx.organizationId }, select: { id: true, reference: true, companyId: true } }) : [];
    // La référence d'un incident d'une société hors périmètre (véhicule transféré depuis) n'est pas révélée.
    const references = new Map(incidents.filter((i) => this.access.canReadCompany(ctx, i.companyId)).map((i) => [i.id, i.reference]));
    return rows.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      vehicleId: r.vehicleId,
      vehicleCode: r.vehicle?.code ?? null,
      vehicleRegistration: r.vehicle?.registration ?? null,
      allocationLabel: r.vehicle ? `${r.vehicle.code} — ${r.vehicle.registration}` : UNALLOCATED_EXPENSE_LABEL,
      unallocated: r.vehicleId === null,
      occurredOn: fromDbDate(r.occurredOn) as string,
      category: r.category,
      categoryLabel: EXPENSE_CATEGORY_LABELS[r.category],
      kind: r.kind,
      supplierId: r.supplierId,
      supplierName: r.supplier?.name ?? null,
      reference: r.reference,
      amount: r.amount.toFixed(MONEY_DECIMALS),
      signedAmount: signedAmount(r.kind, r.amount.toString()).toFixed(MONEY_DECIMALS),
      currency: r.currency,
      attachmentId: r.attachmentId,
      relatedIncidentId: r.relatedIncidentId,
      relatedIncidentReference: r.relatedIncidentId ? (references.get(r.relatedIncidentId) ?? null) : null,
      relatedExpenseId: r.relatedExpenseId,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      status: r.status,
      replacesExpenseId: r.replacesExpenseId,
      replacedByExpenseId: r.replacedBy?.id ?? null,
      cancelledAt: r.cancelledAt?.toISOString() ?? null,
      cancelReason: r.cancelReason,
      excludedFromOperatingCost: r.excludedFromOperatingCost,
      notes: r.notes,
      createdAt: r.createdAt.toISOString(),
      createdById: r.createdById,
      version: r.version,
    }));
  }
}

function fieldsOf(row: ExpenseRow): ExpenseFields {
  return {
    vehicleId: row.vehicleId,
    occurredOn: fromDbDate(row.occurredOn) as string,
    category: row.category,
    supplierId: row.supplierId,
    reference: row.reference,
    amount: new Decimal(row.amount.toString()),
    attachmentId: row.attachmentId,
    notes: row.notes,
    relatedIncidentId: row.relatedIncidentId,
    relatedExpenseId: row.relatedExpenseId,
    excludedFromOperatingCost: row.excludedFromOperatingCost,
  };
}
