import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { EnergyType, FuelEntry, OdometerReading, Prisma, VehicleLifecycle } from '@parc-auto/db';
import { AfterCommit } from '../../common/after-commit.js';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, ConflictError, ErrorCodes, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import { type Page, pageOf, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import { endOfLocalDay, formatLocalDateTime, localDate, startOfLocalDay, toDbDate } from '../../domain/civil-date.js';
import {
  CONSUMPTION_NATURE,
  CONSUMPTION_REASON_LABELS,
  CONSUMPTION_UNIT,
  ENTRY_ELIGIBILITY_LABELS,
  computeConsumption,
  entryEligibility,
  formatRatio,
  telemetrySignalOf,
  type ConsumptionEntry,
  type ConsumptionOdometer,
  type ConsumptionUnavailableReason,
  type TelemetrySignal,
} from '../../domain/consumption.js';
import { evaluateDriverSubmission, exceedsTankCapacity, isFuelEnergy, isInFuture, resolveFuelEnergy, type FuelEnergy } from '../../domain/fuel-rules.js';
import { checkAmountConsistency, toleranceOf } from '../../domain/money.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, isUniqueViolation, type Tx } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { OdometerIngestionService, companyAt, dec, lockVehicle } from '../odometer/odometer-ingestion.service.js';
import { currentAssignmentWhere } from '../../domain/responsible-assignment.js';
import { SettingsService } from '../settings/settings.service.js';
import { SuppliersService } from '../suppliers/suppliers.service.js';
import { VehiclesService } from '../vehicles/vehicles.service.js';
import { driverOwnWhere } from './fuel-visibility.js';
import type { ConsumptionQueryDto, ConsumptionReasonDto, ConsumptionViewDto, CreateFuelPurchaseGapDto, FuelPurchaseGapViewDto } from './dto/consumption.dto.js';
import type { CorrectFuelEntryDto, CreateFuelEntryDto } from './dto/create-fuel-entry.dto.js';
import type { FuelEntriesQueryDto, FuelEntryViewDto } from './dto/fuel-entry-view.dto.js';
import type { CancelFuelEntryDto, ConfirmCapacityDto, RejectFuelEntryDto, ValidateFuelEntryDto } from './dto/validate-fuel-entry.dto.js';

const readingSelect = { id: true, status: true, cumulativeKm: true, isEstimate: true, measurementKind: true, statusReason: true } satisfies Prisma.OdometerReadingSelect;

const entryInclude = {
  vehicle: { select: { code: true, registration: true } },
  driver: { select: { firstName: true, lastName: true } },
  supplier: { select: { name: true } },
  reading: { select: readingSelect },
} satisfies Prisma.FuelEntryInclude;

type EntryRow = Prisma.FuelEntryGetPayload<{ include: typeof entryInclude }>;
type ReadingPick = Prisma.OdometerReadingGetPayload<{ select: typeof readingSelect }>;

interface VehicleForFuel {
  id: string;
  companyId: string;
  energy: EnergyType | null;
  tankCapacityLiters: Prisma.Decimal | null;
  lifecycleStatus: VehicleLifecycle;
  disposedAt: Date | null;
  archivedAt: Date | null;
}

interface EntryValues {
  liters: Decimal;
  unitPrice: Decimal | null;
  total: Decimal;
}

interface EntryControls {
  amountMismatch: boolean;
  amountMismatchValue: Decimal | null;
  tankCapacityExceeded: boolean;
}

const vehicleSelect = { id: true, companyId: true, energy: true, tankCapacityLiters: true, lifecycleStatus: true, disposedAt: true, archivedAt: true } satisfies Prisma.VehicleSelect;

/**
 * Pleins et achats de carburant (CDC 8.2, 8.3 ; D-222 à D-229). Une saisie du personnel (costs.write) est
 * VALIDE avec sa dépense de synthèse dans la même transaction ; une soumission conducteur (SOUMIS) ne
 * produit ni dépense ni relevé accepté avant validation. Le relevé du ticket passe toujours par le
 * service d'ingestion unique (source MANUAL, contexte CARBURANT, observé à la date du plein).
 */
@Injectable()
export class FuelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly vehicles: VehiclesService,
    private readonly suppliers: SuppliersService,
    private readonly ingestion: OdometerIngestionService,
    private readonly attachments: AttachmentsService,
    private readonly settings: SettingsService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ---------------------------------------------------------------------------
  // Consultation
  // ---------------------------------------------------------------------------

  /** Personnel : pleins du périmètre ; conducteur : uniquement ses propres soumissions (2.3, D-226). */
  async list(ctx: RequestContext, query: FuelEntriesQueryDto): Promise<Page<FuelEntryViewDto>> {
    const scope: Prisma.FuelEntryWhereInput = ctx.isDriverOnly ? driverOwnWhere(ctx) : this.access.companyWhere(ctx, query.companyId);
    const timezone = query.from || query.to ? await this.timezone(ctx.organizationId) : null;
    const where: Prisma.FuelEntryWhereInput = {
      AND: [
        scope,
        query.vehicleId ? { vehicleId: query.vehicleId } : {},
        query.driverId ? { driverId: query.driverId } : {},
        query.status ? { status: query.status } : {},
        query.amountMismatch ? { amountMismatch: query.amountMismatch === 'true' } : {},
        query.from && timezone ? { filledAt: { gte: startOfLocalDay(query.from, timezone) } } : {},
        query.to && timezone ? { filledAt: { lte: endOfLocalDay(query.to, timezone) } } : {},
      ],
    };
    const [items, total] = await Promise.all([
      this.prisma.client.fuelEntry.findMany({ where, include: entryInclude, ...skipTake(query), orderBy: [{ filledAt: 'desc' }, { createdAt: 'desc' }] }),
      this.prisma.client.fuelEntry.count({ where }),
    ]);
    return pageOf(await this.views(ctx, items), total, query);
  }

  async get(ctx: RequestContext, id: string): Promise<FuelEntryViewDto> {
    const row = await this.load(ctx, id);
    return (await this.views(ctx, [row]))[0] as FuelEntryViewDto;
  }

  // ---------------------------------------------------------------------------
  // Saisie et soumission
  // ---------------------------------------------------------------------------

  /**
   * Saisie directe (OPERATEUR, CHEF, ADMIN avec costs.write) : plein VALIDE et dépense unique, même
   * transaction. Compte conducteur : soumission SOUMIS sur le véhicule d'une de ses utilisations (D-226),
   * ticket obligatoire, relevé proposé laissé EN_ATTENTE. Idempotent (même clé : réponse rejouée).
   */
  async create(ctx: RequestContext, dto: CreateFuelEntryDto, idempotencyKey: string): Promise<FuelEntryViewDto> {
    const isDriver = ctx.isDriverOnly;
    // Périmètre vérifié avant tout : un véhicule hors droits est introuvable (404), y compris en rejeu.
    const vehicle = isDriver ? await this.loadVehicleForDriver(ctx, dto.vehicleId) : await this.vehicles.load(ctx, dto.vehicleId);
    const filledAt = new Date(dto.filledAt);
    // Société au fait générateur : société gestionnaire du véhicule à la date du plein (D-231).
    const companyId = await companyAt(this.prisma.client, vehicle.id, filledAt, vehicle.companyId);
    if (!isDriver) {
      this.access.requireOperational(ctx, companyId);
      this.access.requirePermission(ctx, companyId, 'costs.write', 'La saisie d’un plein requiert la permission costs.write.');
    }
    const body = { ...dto, idempotencyKey: undefined };

    // Les contrôles datés (date, fenêtre conducteur) s'exécutent sous la clé : un rejeu renvoie la réponse initiale.
    const result = await this.idempotency.run({ organizationId: ctx.organizationId, userId: ctx.userId, operation: 'plein.saisie', key: idempotencyKey }, body, async () => {
      const now = this.clock.now();
      // Conducteur : le périmètre D-226 est tranché AVANT toute règle qui dépend du véhicule (énergie,
      // cession, ticket, date) ; un véhicule hors droits reste introuvable (404), sans révéler ses attributs.
      const driverId = isDriver ? await this.assertDriverMaySubmit(ctx, vehicle, filledAt, now) : dto.driverId ? await this.requireDriver(ctx, dto.driverId) : null;
      if (isInFuture(filledAt, now)) throw new BusinessRuleError('DATE_FUTURE', 'La date du plein ne peut pas être dans le futur.', { fieldErrors: { filledAt: ['Date future refusée.'] } });
      this.assertVehicleUsableAt(vehicle, filledAt);
      const energy = this.resolveEnergy(vehicle.energy, dto.energy ?? null);
      if (isDriver && !dto.ticketAttachmentId) {
        throw new BusinessRuleError('TICKET_REQUIS', 'La photo du ticket est obligatoire pour soumettre un plein.', { fieldErrors: { ticketAttachmentId: ['Photo du ticket requise.'] } });
      }
      if (dto.supplierId) await this.suppliers.requireUsable(ctx, dto.supplierId, companyId);
      const values: EntryValues = { liters: new Decimal(dto.liters), unitPrice: dto.unitPrice ? new Decimal(dto.unitPrice) : null, total: new Decimal(dto.totalAmount) };
      const physicalKm = dto.odometerKm !== undefined ? new Decimal(dto.odometerKm) : null;
      const timezone = await this.timezone(ctx.organizationId);
      const controls = await this.controls(ctx.organizationId, companyId, vehicle.tankCapacityLiters, values);
      const { entryId, after } = await this.prisma.serializable(async (tx) => {
        const after = new AfterCommit();
        await lockVehicle(tx, vehicle.id);
        if ((await companyAt(tx, vehicle.id, filledAt, vehicle.companyId)) !== companyId) {
          throw new ConflictError(ErrorCodes.CONCURRENCE, 'Le véhicule a changé de société entre-temps : rechargez puis réessayez.');
        }
        const reading = physicalKm ? await this.ingestReading(tx, ctx, { vehicleId: vehicle.id, filledAt, physicalKm, isDriver, timezone }, after) : null;
        const decidedAt = this.clock.now();
        const entry = await tx.fuelEntry.create({
          data: {
            organizationId: ctx.organizationId,
            companyId,
            vehicleId: vehicle.id,
            driverId,
            supplierId: dto.supplierId ?? null,
            filledAt,
            liters: values.liters.toString(),
            unitPrice: values.unitPrice?.toString() ?? null,
            totalAmount: values.total.toString(),
            energy,
            isFullTank: dto.isFullTank,
            declaredPhysicalKm: physicalKm?.toString() ?? null,
            readingId: reading?.id ?? null,
            ticketAttachmentId: dto.ticketAttachmentId ?? null,
            status: isDriver ? 'SOUMIS' : 'VALIDE',
            amountMismatch: controls.amountMismatch,
            amountMismatchValue: controls.amountMismatchValue?.toString() ?? null,
            tankCapacityExceeded: controls.tankCapacityExceeded,
            submittedById: isDriver ? ctx.userId : null,
            decidedAt: isDriver ? null : decidedAt,
            decidedById: isDriver ? null : ctx.userId,
            notes: dto.notes?.trim() || null,
            createdById: ctx.userId,
          },
        });
        if (dto.ticketAttachmentId) await this.attachments.attach(ctx, tx, dto.ticketAttachmentId, 'PLEIN', entry.id, companyId);
        const expenseId = isDriver ? null : await this.createExpense(tx, ctx, entry, timezone, null, null);
        await this.audit.record(ctx, {
          action: isDriver ? 'plein.soumission' : 'plein.saisie',
          objectType: 'FuelEntry',
          objectId: entry.id,
          companyId,
          after: { vehicleId: vehicle.id, filledAt: filledAt.toISOString(), liters: values.liters.toString(), totalAmount: values.total.toString(), unitPrice: values.unitPrice?.toString() ?? null, energy, isFullTank: dto.isFullTank, status: entry.status, readingId: reading?.id ?? null, readingStatus: reading?.status ?? null, amountMismatch: controls.amountMismatch, tankCapacityExceeded: controls.tankCapacityExceeded, expenseId },
        }, tx);
        return { entryId: entry.id, after };
      });
      await after.run();
      return { status: 201, body: await this.get(ctx, entryId), resourceId: entryId };
    });
    return result.body;
  }

  // ---------------------------------------------------------------------------
  // Décisions
  // ---------------------------------------------------------------------------

  /**
   * Validation d'une soumission (D-222, T24) : VALIDE + dépense unique, même transaction. Même clé et même
   * corps : réponse rejouée ; autre clé : 409 DEJA_VALIDE. Un écart de montant exige une confirmation.
   * Le relevé proposé reste soumis à readings.approve, indépendamment du coût.
   */
  async validate(ctx: RequestContext, id: string, dto: ValidateFuelEntryDto, idempotencyKey: string): Promise<FuelEntryViewDto> {
    const current = await this.load(ctx, id);
    this.access.requireOperational(ctx, current.companyId);
    this.access.requirePermission(ctx, current.companyId, 'costs.write', 'La validation d’un plein requiert la permission costs.write.');
    const body = { ...dto, idempotencyKey: undefined, fuelEntryId: id };
    const result = await this.idempotency.run({ organizationId: ctx.organizationId, userId: ctx.userId, operation: 'plein.validation', key: idempotencyKey }, body, async () => {
      if (dto.supplierId) await this.suppliers.requireUsable(ctx, dto.supplierId, current.companyId);
      const timezone = await this.timezone(ctx.organizationId);
      await this.prisma.serializable(async (tx) => {
        await lockVehicle(tx, current.vehicleId);
        const fresh = await tx.fuelEntry.findUniqueOrThrow({ where: { id } });
        if (fresh.status === 'VALIDE') throw new ConflictError('DEJA_VALIDE', 'Ce plein est déjà validé : sa dépense existe déjà.');
        if (fresh.status !== 'SOUMIS') throw new ConflictError('ETAT_INVALIDE', 'Seule une soumission en attente peut être validée.');
        assertExpectedVersion(fresh, dto.expectedVersion, 'plein');
        if (fresh.amountMismatch && dto.confirmAmountMismatch !== true) {
          throw new BusinessRuleError('CONFIRMATION_ECART_REQUISE', 'Un écart entre litres × prix unitaire et total est signalé : confirmez explicitement la validation.', { fieldErrors: { confirmAmountMismatch: ['Confirmation requise.'] } });
        }
        await this.guardedUpdate(tx, id, dto.expectedVersion, { status: 'VALIDE', supplierId: dto.supplierId ?? fresh.supplierId, decidedAt: this.clock.now(), decidedById: ctx.userId });
        const validated = await tx.fuelEntry.findUniqueOrThrow({ where: { id } });
        const expenseId = await this.createExpense(tx, ctx, validated, timezone, null, null);
        await this.audit.record(ctx, { action: 'plein.validation', objectType: 'FuelEntry', objectId: id, companyId: fresh.companyId, before: { status: 'SOUMIS' }, after: { status: 'VALIDE', expenseId, amountMismatchConfirmed: fresh.amountMismatch, supplierId: validated.supplierId } }, tx);
      });
      return { status: 200, body: await this.get(ctx, id), resourceId: id };
    });
    return result.body;
  }

  /** Rejet motivé d'une soumission (D-222) : aucun coût, motif visible par le conducteur. */
  async reject(ctx: RequestContext, id: string, dto: RejectFuelEntryDto): Promise<FuelEntryViewDto> {
    const current = await this.load(ctx, id);
    this.access.requireOperational(ctx, current.companyId);
    this.access.requirePermission(ctx, current.companyId, 'costs.write', 'Le rejet d’un plein requiert la permission costs.write.');
    await this.prisma.serializable(async (tx) => {
      const fresh = await tx.fuelEntry.findUniqueOrThrow({ where: { id } });
      if (fresh.status !== 'SOUMIS') throw new ConflictError('ETAT_INVALIDE', 'Seule une soumission en attente peut être rejetée.');
      assertExpectedVersion(fresh, dto.expectedVersion, 'plein');
      await this.guardedUpdate(tx, id, dto.expectedVersion, { status: 'REJETE', decidedAt: this.clock.now(), decidedById: ctx.userId, decisionReason: dto.reason.trim() });
      await this.audit.record(ctx, { action: 'plein.rejet', objectType: 'FuelEntry', objectId: id, companyId: fresh.companyId, reason: dto.reason.trim(), before: { status: 'SOUMIS' }, after: { status: 'REJETE' } }, tx);
    });
    return this.get(ctx, id);
  }

  /**
   * Annulation (D-222, D-229) : retrait de sa soumission par le conducteur tant qu'elle est SOUMIS ;
   * annulation motivée d'un plein VALIDE par le chef ou l'administrateur (costs.write), dépense liée
   * annulée de façon traçable dans la même transaction.
   */
  async cancel(ctx: RequestContext, id: string, dto: CancelFuelEntryDto): Promise<FuelEntryViewDto> {
    const current = await this.load(ctx, id);
    const reason = dto.reason?.trim() || null;
    if (ctx.isDriverOnly) {
      await this.prisma.serializable(async (tx) => {
        const fresh = await tx.fuelEntry.findUniqueOrThrow({ where: { id } });
        if (fresh.status !== 'SOUMIS') throw new ConflictError('ETAT_INVALIDE', 'Seule une soumission encore en attente peut être retirée.');
        assertExpectedVersion(fresh, dto.expectedVersion, 'plein');
        await this.guardedUpdate(tx, id, dto.expectedVersion, { status: 'ANNULE', decidedAt: this.clock.now(), decidedById: ctx.userId, decisionReason: reason });
        await this.audit.record(ctx, { action: 'plein.retrait', objectType: 'FuelEntry', objectId: id, companyId: fresh.companyId, reason, before: { status: 'SOUMIS' }, after: { status: 'ANNULE' } }, tx);
      });
      return this.get(ctx, id);
    }
    this.access.requireManager(ctx, current.companyId);
    this.access.requirePermission(ctx, current.companyId, 'costs.write', 'L’annulation d’un plein validé requiert la permission costs.write.');
    if (current.status === 'SOUMIS') throw new ConflictError('ETAT_INVALIDE', 'Une soumission en attente se rejette avec un motif : utilisez le rejet.');
    if (!reason) throw new BusinessRuleError('MOTIF_REQUIS', 'Le motif de l’annulation est obligatoire.', { fieldErrors: { reason: ['Motif requis.'] } });
    await this.prisma.serializable(async (tx) => {
      await lockVehicle(tx, current.vehicleId);
      const fresh = await tx.fuelEntry.findUniqueOrThrow({ where: { id } });
      if (fresh.status !== 'VALIDE') throw new ConflictError('ETAT_INVALIDE', 'Seul un plein validé peut être annulé.');
      assertExpectedVersion(fresh, dto.expectedVersion, 'plein');
      const now = this.clock.now();
      await this.guardedUpdate(tx, id, dto.expectedVersion, { status: 'ANNULE', decidedAt: now, decidedById: ctx.userId, decisionReason: reason });
      const expense = await tx.expense.findFirst({ where: { sourceType: 'PLEIN', sourceId: id, status: 'VALIDEE' } });
      if (expense) {
        await tx.expense.update({ where: { id: expense.id }, data: { status: 'ANNULEE', cancelledAt: now, cancelledById: ctx.userId, cancelReason: `Annulation du plein : ${reason}`, version: { increment: 1 } } });
      }
      await this.audit.record(ctx, { action: 'plein.annulation', objectType: 'FuelEntry', objectId: id, companyId: fresh.companyId, reason, before: { status: 'VALIDE', expenseId: expense?.id ?? null }, after: { status: 'ANNULE', expenseStatus: expense ? 'ANNULEE' : null } }, tx);
    });
    return this.get(ctx, id);
  }

  /**
   * Correction d'un plein validé (D-222, D-229) : nouvelle ligne VALIDE (replacesFuelEntryId), l'ancienne
   * passe REMPLACE ; l'ancienne dépense passe REMPLACEE et une nouvelle dépense VALIDEE la remplace
   * (replacesExpenseId), même société et même date ; motif, audit avant/après, une seule transaction.
   */
  async correct(ctx: RequestContext, id: string, dto: CorrectFuelEntryDto, idempotencyKey: string): Promise<FuelEntryViewDto> {
    const current = await this.load(ctx, id);
    this.access.requireManager(ctx, current.companyId);
    this.access.requirePermission(ctx, current.companyId, 'costs.write', 'La correction d’un plein validé requiert la permission costs.write.');
    const reason = dto.reason.trim();
    const body = { ...dto, idempotencyKey: undefined, fuelEntryId: id };
    const result = await this.idempotency.run({ organizationId: ctx.organizationId, userId: ctx.userId, operation: 'plein.correction', key: idempotencyKey }, body, async () => {
      if (dto.supplierId) await this.suppliers.requireUsable(ctx, dto.supplierId, current.companyId);
      if (dto.driverId) await this.requireDriver(ctx, dto.driverId);
      const timezone = await this.timezone(ctx.organizationId);
      const newId = await this.prisma.serializable(async (tx) => {
        await lockVehicle(tx, current.vehicleId);
        const fresh = await tx.fuelEntry.findUniqueOrThrow({ where: { id } });
        if (fresh.status === 'REMPLACE') throw new ConflictError('DEJA_CORRIGE', 'Ce plein a déjà été corrigé : corrigez sa version courante.');
        if (fresh.status !== 'VALIDE') throw new ConflictError('ETAT_INVALIDE', 'Seul un plein validé se corrige ; une soumission se valide ou se rejette.');
        assertExpectedVersion(fresh, dto.expectedVersion, 'plein');
        const vehicle = await tx.vehicle.findUniqueOrThrow({ where: { id: fresh.vehicleId }, select: vehicleSelect });
        const values: EntryValues = {
          liters: dto.liters ? new Decimal(dto.liters) : dec(fresh.liters),
          unitPrice: dto.unitPrice === undefined ? (fresh.unitPrice ? dec(fresh.unitPrice) : null) : dto.unitPrice === null ? null : new Decimal(dto.unitPrice),
          total: dto.totalAmount ? new Decimal(dto.totalAmount) : dec(fresh.totalAmount),
        };
        const energy = dto.energy !== undefined ? this.resolveEnergy(vehicle.energy, dto.energy) : fresh.energy;
        const isFullTank = dto.isFullTank ?? fresh.isFullTank;
        const supplierId = dto.supplierId === undefined ? fresh.supplierId : dto.supplierId;
        const driverId = dto.driverId === undefined ? fresh.driverId : dto.driverId;
        const notes = dto.notes === undefined ? fresh.notes : dto.notes?.trim() || null;
        const ticketAttachmentId = dto.ticketAttachmentId ?? fresh.ticketAttachmentId;
        const unchanged =
          values.liters.eq(dec(fresh.liters)) &&
          values.total.eq(dec(fresh.totalAmount)) &&
          (values.unitPrice === null ? fresh.unitPrice === null : fresh.unitPrice !== null && values.unitPrice.eq(dec(fresh.unitPrice))) &&
          energy === fresh.energy &&
          isFullTank === fresh.isFullTank &&
          supplierId === fresh.supplierId &&
          driverId === fresh.driverId &&
          notes === fresh.notes &&
          ticketAttachmentId === fresh.ticketAttachmentId;
        if (unchanged) throw new BusinessRuleError('AUCUNE_MODIFICATION', 'La correction ne modifie aucune valeur du plein.');
        const controls = await this.controls(ctx.organizationId, fresh.companyId, vehicle.tankCapacityLiters, values, tx);
        // Une confirmation de capacité reste valable si les litres confirmés sont inchangés.
        const keepConfirmation = controls.tankCapacityExceeded && fresh.capacityConfirmedAt !== null && values.liters.eq(dec(fresh.liters));
        const oldExpense = await tx.expense.findFirst({ where: { sourceType: 'PLEIN', sourceId: id, status: 'VALIDEE' } });
        if (!oldExpense) throw new ConflictError('DEPENSE_INTROUVABLE', 'Aucune dépense active n’est liée à ce plein validé : incohérence à signaler à l’administrateur, aucune correction n’est appliquée.');
        const now = this.clock.now();
        await this.guardedUpdate(tx, id, dto.expectedVersion, { status: 'REMPLACE', decidedAt: now, decidedById: ctx.userId, decisionReason: reason });
        const replacement = await tx.fuelEntry.create({
          data: {
            organizationId: ctx.organizationId,
            companyId: fresh.companyId,
            vehicleId: fresh.vehicleId,
            driverId,
            supplierId,
            filledAt: fresh.filledAt,
            liters: values.liters.toString(),
            unitPrice: values.unitPrice?.toString() ?? null,
            totalAmount: values.total.toString(),
            energy,
            isFullTank,
            declaredPhysicalKm: fresh.declaredPhysicalKm,
            readingId: fresh.readingId,
            ticketAttachmentId,
            status: 'VALIDE',
            amountMismatch: controls.amountMismatch,
            amountMismatchValue: controls.amountMismatchValue?.toString() ?? null,
            tankCapacityExceeded: controls.tankCapacityExceeded,
            capacityConfirmedAt: keepConfirmation ? fresh.capacityConfirmedAt : null,
            capacityConfirmedById: keepConfirmation ? fresh.capacityConfirmedById : null,
            replacesFuelEntryId: id,
            submittedById: fresh.submittedById,
            decidedAt: now,
            decidedById: ctx.userId,
            notes,
            createdById: ctx.userId,
          },
        });
        if (dto.ticketAttachmentId && dto.ticketAttachmentId !== fresh.ticketAttachmentId) {
          await this.attachments.attach(ctx, tx, dto.ticketAttachmentId, 'PLEIN', replacement.id, fresh.companyId);
        }
        await tx.expense.update({ where: { id: oldExpense.id }, data: { status: 'REMPLACEE', version: { increment: 1 } } });
        const newExpenseId = await this.createExpense(tx, ctx, replacement, timezone, oldExpense.id, reason);
        await this.audit.record(ctx, {
          action: 'plein.correction',
          objectType: 'FuelEntry',
          objectId: id,
          companyId: fresh.companyId,
          reason,
          before: { fuelEntryId: id, liters: fresh.liters.toString(), unitPrice: fresh.unitPrice?.toString() ?? null, totalAmount: fresh.totalAmount.toString(), energy: fresh.energy, isFullTank: fresh.isFullTank, supplierId: fresh.supplierId, driverId: fresh.driverId, expenseId: oldExpense.id },
          after: { fuelEntryId: replacement.id, liters: values.liters.toString(), unitPrice: values.unitPrice?.toString() ?? null, totalAmount: values.total.toString(), energy, isFullTank, supplierId, driverId, expenseId: newExpenseId, amountMismatch: controls.amountMismatch, tankCapacityExceeded: controls.tankCapacityExceeded },
        }, tx);
        return replacement.id;
      });
      return { status: 200, body: await this.get(ctx, newId), resourceId: newId };
    });
    return result.body;
  }

  /** Confirmation par le chef d'un dépassement de capacité (D-225) : le plein redevient admissible. */
  async confirmCapacity(ctx: RequestContext, id: string, dto: ConfirmCapacityDto): Promise<FuelEntryViewDto> {
    const current = await this.load(ctx, id);
    this.access.requireManager(ctx, current.companyId);
    await this.prisma.serializable(async (tx) => {
      const fresh = await tx.fuelEntry.findUniqueOrThrow({ where: { id } });
      if (!fresh.tankCapacityExceeded) throw new ConflictError('SANS_DEPASSEMENT', 'Aucun dépassement de capacité n’est signalé sur ce plein.');
      if (fresh.capacityConfirmedAt) throw new ConflictError('DEJA_CONFIRME', 'Le dépassement de capacité est déjà confirmé.');
      if (fresh.status !== 'SOUMIS' && fresh.status !== 'VALIDE') throw new ConflictError('ETAT_INVALIDE', 'Ce plein n’est plus actif.');
      assertExpectedVersion(fresh, dto.expectedVersion, 'plein');
      await this.guardedUpdate(tx, id, dto.expectedVersion, { capacityConfirmedAt: this.clock.now(), capacityConfirmedById: ctx.userId });
      await this.audit.record(ctx, { action: 'plein.confirmation_capacite', objectType: 'FuelEntry', objectId: id, companyId: fresh.companyId, after: { liters: fresh.liters.toString() } }, tx);
    });
    return this.get(ctx, id);
  }

  // ---------------------------------------------------------------------------
  // Consommation (8.3) et périodes d'achats incomplets (D-227)
  // ---------------------------------------------------------------------------

  /** Consommation d'un véhicule sur une période : intervalles retenus et exclus, N/D motivé. */
  async consumption(ctx: RequestContext, vehicleId: string, query: ConsumptionQueryDto): Promise<ConsumptionViewDto> {
    this.access.requireStaff(ctx);
    const vehicle = await this.vehicles.load(ctx, vehicleId);
    if (query.from && query.to && query.from > query.to) {
      throw new BusinessRuleError('PERIODE_INVALIDE', 'La fin de période précède son début.', { fieldErrors: { to: ['Fin avant le début.'] } });
    }
    const timezone = await this.timezone(ctx.organizationId);
    const from = query.from ? startOfLocalDay(query.from, timezone) : null;
    const to = query.to ? endOfLocalDay(query.to, timezone) : null;
    // Seul l'historique des sociétés lisibles est exploité (2.3) : jamais les saisies d'une autre société.
    const scope = this.access.companyWhere(ctx);
    const [rows, gaps, events] = await Promise.all([
      this.prisma.client.fuelEntry.findMany({
        where: { ...scope, vehicleId: vehicle.id, status: { in: ['SOUMIS', 'VALIDE'] }, ...(to ? { filledAt: { lte: to } } : {}) },
        select: { id: true, vehicleId: true, filledAt: true, createdAt: true, status: true, energy: true, isFullTank: true, liters: true, tankCapacityExceeded: true, capacityConfirmedAt: true, reading: { select: readingSelect } },
      }),
      this.prisma.client.fuelPurchaseGap.findMany({ where: { ...scope, vehicleId: vehicle.id }, select: { startsAt: true, endsAt: true } }),
      this.prisma.client.fuelEvent.findMany({ where: { ...scope, vehicleId: vehicle.id, type: { in: ['REMPLISSAGE_DETECTE', 'ECART_TICKET'] } }, select: { type: true, detectedAt: true, fuelEntryId: true, status: true, qualification: true } }),
    ]);
    const odometers = await this.resolveOdometers(rows);
    const entries: ConsumptionEntry[] = [];
    for (const r of rows) {
      if (!isFuelEnergy(r.energy)) continue;
      entries.push({
        id: r.id,
        filledAt: r.filledAt,
        createdAt: r.createdAt,
        status: r.status === 'VALIDE' ? 'VALIDE' : 'SOUMIS',
        energy: r.energy,
        isFullTank: r.isFullTank,
        liters: dec(r.liters),
        odometer: odometers.get(r.id) ?? null,
        tankCapacityExceeded: r.tankCapacityExceeded,
        capacityConfirmed: r.capacityConfirmedAt !== null,
      });
    }
    const signals = events.map((e) => telemetrySignalOf(e)).filter((s): s is TelemetrySignal => s !== null);
    const result = computeConsumption({ entries, gaps, signals, period: { from, to } });
    return {
      vehicleId: vehicle.id,
      from: query.from ?? null,
      to: query.to ?? null,
      unit: CONSUMPTION_UNIT,
      nature: CONSUMPTION_NATURE,
      available: result.available,
      reasons: reasonViews(result.reasons),
      totals: result.totals.map((t) => ({
        energy: t.energy,
        available: t.available,
        liters: t.liters?.toFixed(3) ?? null,
        distanceKm: t.distanceKm?.toFixed(3) ?? null,
        litersPer100Km: t.ratio ? formatRatio(t.ratio, 1) : null,
        litersPer100KmExact: t.ratio?.toFixed() ?? null,
        reasons: reasonViews(t.reasons),
        retainedIntervals: t.retainedCount,
        excludedIntervals: t.excludedCount,
      })),
      intervals: result.intervals.map((i) => ({
        energy: i.energy,
        startFuelEntryId: i.startEntryId,
        endFuelEntryId: i.endEntryId,
        startFilledAt: i.startAt?.toISOString() ?? null,
        endFilledAt: i.endAt.toISOString(),
        startKm: i.startKm?.toFixed(3) ?? null,
        endKm: i.endKm?.toFixed(3) ?? null,
        distanceKm: i.distanceKm?.toFixed(3) ?? null,
        liters: i.liters.toFixed(3),
        fuelEntryIds: i.entryIds,
        retained: i.retained,
        litersPer100Km: i.ratio ? formatRatio(i.ratio, 1) : null,
        litersPer100KmExact: i.ratio?.toFixed() ?? null,
        reasons: reasonViews(i.reasons),
      })),
    };
  }

  async listPurchaseGaps(ctx: RequestContext, vehicleId: string): Promise<FuelPurchaseGapViewDto[]> {
    this.access.requireStaff(ctx);
    const vehicle = await this.vehicles.load(ctx, vehicleId);
    const gaps = await this.prisma.client.fuelPurchaseGap.findMany({ where: { ...this.access.companyWhere(ctx), vehicleId: vehicle.id }, orderBy: { startsAt: 'desc' } });
    return gaps.map(gapView);
  }

  /** Déclaration motivée d'une période « achats incomplets » par le chef ou l'administrateur (D-227). */
  async createPurchaseGap(ctx: RequestContext, vehicleId: string, dto: CreateFuelPurchaseGapDto): Promise<FuelPurchaseGapViewDto> {
    this.access.requireStaff(ctx);
    const vehicle = await this.vehicles.load(ctx, vehicleId);
    this.access.requireManager(ctx, vehicle.companyId);
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (endsAt.getTime() <= startsAt.getTime()) throw new BusinessRuleError('PERIODE_INVALIDE', 'La fin de la période doit suivre son début.', { fieldErrors: { endsAt: ['Fin antérieure ou égale au début.'] } });
    if (isInFuture(startsAt, this.clock.now())) throw new BusinessRuleError('DATE_FUTURE', 'La période ne peut pas commencer dans le futur.', { fieldErrors: { startsAt: ['Date future refusée.'] } });
    const reason = dto.reason.trim();
    const gap = await this.prisma.transaction(async (tx) => {
      const created = await tx.fuelPurchaseGap.create({ data: { organizationId: ctx.organizationId, companyId: vehicle.companyId, vehicleId: vehicle.id, startsAt, endsAt, reason, createdById: ctx.userId, createdAt: this.clock.now() } });
      await this.audit.record(ctx, { action: 'plein.periode_achats_incomplets', objectType: 'FuelPurchaseGap', objectId: created.id, companyId: vehicle.companyId, reason, after: { vehicleId: vehicle.id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() } }, tx);
      return created;
    });
    return gapView(gap);
  }

  // ---------------------------------------------------------------------------

  /**
   * Plein visible : personnel du périmètre, ou conducteur pour ses propres soumissions (soumises par son
   * compte et à son nom) ; un plein saisi par le personnel, même à son nom, reste invisible (2.3 : pas de
   * facture) ; sinon 404.
   */
  async load(ctx: RequestContext, id: string): Promise<EntryRow> {
    const where: Prisma.FuelEntryWhereInput = ctx.isDriverOnly ? { AND: [{ id }, driverOwnWhere(ctx)] } : { id, organizationId: ctx.organizationId };
    const row = await this.prisma.client.fuelEntry.findFirst({ where, include: entryInclude });
    if (!row) throw new NotFoundOrOutOfScopeError('Plein');
    if (!ctx.isDriverOnly && !this.access.canReadCompany(ctx, row.companyId)) throw new NotFoundOrOutOfScopeError('Plein');
    return row;
  }

  private async loadVehicleForDriver(ctx: RequestContext, vehicleId: string): Promise<VehicleForFuel> {
    const vehicle = await this.prisma.client.vehicle.findFirst({ where: { id: vehicleId, organizationId: ctx.organizationId }, select: vehicleSelect });
    if (!vehicle || !ctx.driverId) throw new NotFoundOrOutOfScopeError('Véhicule');
    return vehicle;
  }

  /** D-226 : utilisation en cours ou terminée récemment, ticket dans la fenêtre de l'utilisation. */
  private async assertDriverMaySubmit(ctx: RequestContext, vehicle: VehicleForFuel, filledAt: Date, now: Date): Promise<string> {
    const driverId = ctx.driverId;
    if (!driverId) throw new NotFoundOrOutOfScopeError('Véhicule');
    const [lateSubmissionDays, allowHabitual, usages, responsible] = await Promise.all([
      this.settings.get(ctx.organizationId, 'fuel.driverLateSubmissionDays', vehicle.companyId),
      this.settings.get(ctx.organizationId, 'drivers.allowHabitualVehicleSubmissions'),
      this.prisma.client.vehicleUsage.findMany({ where: { organizationId: ctx.organizationId, vehicleId: vehicle.id, driverId }, select: { status: true, checkedOutAt: true, returnedAt: true } }),
      // Responsable habituel EN COURS (règle unique) ; ne compte que si l'organisation l'autorise (D-268).
      this.prisma.client.vehicleResponsibleAssignment.findFirst({ where: { vehicleId: vehicle.id, driverId, ...currentAssignmentWhere(now) }, select: { id: true } }),
    ]);
    const decision = evaluateDriverSubmission({ filledAt, now, lateSubmissionDays, usages, responsibleForVehicle: allowHabitual === true && responsible !== null });
    if (!decision.allowed) {
      if (decision.reason === 'HORS_DROITS') throw new NotFoundOrOutOfScopeError('Véhicule');
      throw new BusinessRuleError('HORS_UTILISATION', 'Ce ticket ne correspond à aucune de vos utilisations de ce véhicule (de la remise − 1 h à la restitution + 1 h).', { fieldErrors: { filledAt: ['Date hors de vos utilisations du véhicule.'] } });
    }
    return driverId;
  }

  private async requireDriver(ctx: RequestContext, driverId: string): Promise<string> {
    const driver = await this.prisma.client.driver.findFirst({ where: { id: driverId, organizationId: ctx.organizationId }, select: { id: true, companyId: true } });
    if (!driver || !this.access.canReadCompany(ctx, driver.companyId)) throw new NotFoundOrOutOfScopeError('Conducteur');
    return driver.id;
  }

  private assertVehicleUsableAt(vehicle: VehicleForFuel, filledAt: Date): void {
    if (vehicle.lifecycleStatus !== 'CEDE' && vehicle.lifecycleStatus !== 'ARCHIVE') return;
    const end = vehicle.disposedAt ?? vehicle.archivedAt;
    if (end === null || filledAt.getTime() >= end.getTime()) {
      throw new BusinessRuleError('VEHICULE_INACTIF', 'Le véhicule était cédé ou archivé à la date du plein.', { fieldErrors: { filledAt: ['Véhicule cédé ou archivé à cette date.'] } });
    }
  }

  private resolveEnergy(vehicleEnergy: EnergyType | null, requested: FuelEnergy | null): FuelEnergy {
    const r = resolveFuelEnergy(vehicleEnergy, requested);
    if (!r.ok) throw new BusinessRuleError(r.code, r.message, { fieldErrors: { energy: [r.message] } });
    return r.energy;
  }

  /** Contrôles non bloquants : écart de montant (D-224) et capacité du réservoir (D-225). */
  private async controls(organizationId: string, companyId: string, tankCapacityLiters: Prisma.Decimal | null, values: EntryValues, tx?: Tx): Promise<EntryControls> {
    const [absoluteTnd, ratio] = await Promise.all([
      this.settings.get(organizationId, 'fuel.amountToleranceTnd', companyId, tx),
      this.settings.get(organizationId, 'fuel.amountToleranceRatio', companyId, tx),
    ]);
    const amount = checkAmountConsistency({ liters: values.liters, unitPrice: values.unitPrice, total: values.total, tolerance: toleranceOf(absoluteTnd, ratio) });
    return {
      amountMismatch: amount.mismatch,
      amountMismatchValue: amount.reportedGap,
      tankCapacityExceeded: exceedsTankCapacity(values.liters, tankCapacityLiters ? dec(tankCapacityLiters) : null),
    };
  }

  /** Relevé du ticket via le service d'ingestion unique (MANUAL, CARBURANT, observé à filledAt). */
  private async ingestReading(tx: Tx, ctx: RequestContext, input: { vehicleId: string; filledAt: Date; physicalKm: Decimal; isDriver: boolean; timezone: string }, after: AfterCommit): Promise<OdometerReading> {
    try {
      const result = await this.ingestion.ingest(
        tx,
        {
          organizationId: ctx.organizationId,
          vehicleId: input.vehicleId,
          origin: 'MANUAL',
          context: 'CARBURANT',
          measurementKind: 'COMPTEUR_AFFICHE',
          physicalKm: input.physicalKm,
          observedAt: input.filledAt,
          author: input.isDriver ? { kind: 'DRIVER', userId: ctx.userId } : { kind: 'STAFF', userId: ctx.userId },
          note: `Relevé du plein du ${formatLocalDateTime(input.filledAt, input.timezone, { sentence: true })}`,
          allowAutoInit: true,
        },
        after,
      );
      return result.reading;
    } catch (error) {
      // Erreur attachée au champ du formulaire de plein.
      if (error instanceof BusinessRuleError) throw new BusinessRuleError(error.code, error.message, { fieldErrors: { odometerKm: [error.message] }, ...(error.details ? { details: error.details } : {}) });
      throw error;
    }
  }

  /** Dépense de synthèse unique du plein (8.4, T24) : l'index partiel expense_one_active_per_source l'impose. */
  private async createExpense(tx: Tx, ctx: RequestContext, entry: FuelEntry, timezone: string, replacesExpenseId: string | null, correctionReason: string | null): Promise<string> {
    const label = `Plein de ${entry.liters.toFixed(3)} L (${entry.energy})`;
    try {
      const expense = await tx.expense.create({
        data: {
          organizationId: ctx.organizationId,
          companyId: entry.companyId,
          vehicleId: entry.vehicleId,
          occurredOn: toDbDate(localDate(entry.filledAt, timezone)) as Date,
          category: 'CARBURANT',
          supplierId: entry.supplierId,
          amount: entry.totalAmount,
          attachmentId: entry.ticketAttachmentId,
          sourceType: 'PLEIN',
          sourceId: entry.id,
          replacesExpenseId,
          notes: correctionReason ? `${label} — correction : ${correctionReason}` : label,
          createdById: ctx.userId,
        },
      });
      return expense.id;
    } catch (error) {
      if (isUniqueViolation(error, 'expense_one_active_per_source')) throw new ConflictError('DEPENSE_EXISTANTE', 'Une dépense existe déjà pour ce plein.');
      throw error;
    }
  }

  private async guardedUpdate(tx: Tx, id: string, expectedVersion: number, data: Prisma.FuelEntryUncheckedUpdateManyInput): Promise<void> {
    const res = await tx.fuelEntry.updateMany({ where: { id, version: expectedVersion }, data: { ...data, version: { increment: 1 } } });
    if (res.count !== 1) throw new ConflictError(ErrorCodes.VERSION_OBSOLETE, 'Le plein a été modifié entre-temps : rechargez puis réessayez.');
  }

  private async timezone(organizationId: string): Promise<string> {
    const org = await this.prisma.client.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } });
    return org.timezone;
  }

  /**
   * Relevé retenu pour chaque plein : le relevé lié s'il est accepté, sinon un relevé accepté (non
   * estimé) du véhicule observé exactement à filledAt — régularisation (D-222).
   */
  private async resolveOdometers(rows: ReadonlyArray<{ id: string; vehicleId: string; filledAt: Date; reading: ReadingPick | null }>): Promise<Map<string, ConsumptionOdometer | null>> {
    const pending = rows.filter((r) => r.reading?.status !== 'ACCEPTE');
    const regularized = pending.length
      ? await this.prisma.client.odometerReading.findMany({
          where: { status: 'ACCEPTE', isEstimate: false, measurementKind: { not: 'DISTANCE_GPS' }, OR: pending.map((r) => ({ vehicleId: r.vehicleId, observedAt: r.filledAt })) },
          select: { vehicleId: true, observedAt: true, cumulativeKm: true },
        })
      : [];
    const out = new Map<string, ConsumptionOdometer | null>();
    for (const r of rows) {
      if (r.reading?.status === 'ACCEPTE') {
        out.set(r.id, { status: 'ACCEPTE', cumulativeKm: r.reading.cumulativeKm ? dec(r.reading.cumulativeKm) : null, isEstimate: r.reading.isEstimate || r.reading.measurementKind === 'DISTANCE_GPS' });
        continue;
      }
      const match = regularized.find((x) => x.vehicleId === r.vehicleId && x.observedAt.getTime() === r.filledAt.getTime());
      if (match) out.set(r.id, { status: 'ACCEPTE', cumulativeKm: match.cumulativeKm ? dec(match.cumulativeKm) : null, isEstimate: false });
      else out.set(r.id, r.reading ? { status: r.reading.status, cumulativeKm: null, isEstimate: r.reading.isEstimate } : null);
    }
    return out;
  }

  /**
   * Vue d'un plein. Montants visibles avec costs.read pour le personnel ; le conducteur voit ses propres
   * valeurs saisies, jamais la dépense générée (2.3, D-226).
   */
  private async views(ctx: RequestContext, rows: EntryRow[]): Promise<FuelEntryViewDto[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [expenses, replacements, odometers] = await Promise.all([
      this.prisma.client.expense.findMany({ where: { sourceType: 'PLEIN', sourceId: { in: ids }, status: 'VALIDEE' }, select: { id: true, sourceId: true } }),
      this.prisma.client.fuelEntry.findMany({ where: { replacesFuelEntryId: { in: ids } }, select: { id: true, replacesFuelEntryId: true } }),
      this.resolveOdometers(rows),
    ]);
    return rows.map((r) => {
      const isDriver = ctx.isDriverOnly;
      const canSeeCosts = !isDriver && this.access.hasPermission(ctx, r.companyId, 'costs.read');
      const showAmounts = isDriver || canSeeCosts;
      const eligibility = entryEligibility({ status: r.status, odometer: odometers.get(r.id) ?? null, tankCapacityExceeded: r.tankCapacityExceeded, capacityConfirmed: r.capacityConfirmedAt !== null });
      return {
        id: r.id,
        companyId: r.companyId,
        vehicleId: r.vehicleId,
        vehicleCode: r.vehicle.code,
        vehicleRegistration: r.vehicle.registration,
        driverId: r.driverId,
        driverName: r.driver ? `${r.driver.firstName} ${r.driver.lastName}` : null,
        supplierId: r.supplierId,
        supplierName: r.supplier?.name ?? null,
        filledAt: r.filledAt.toISOString(),
        liters: r.liters.toFixed(3),
        unitPrice: showAmounts ? (r.unitPrice?.toFixed(3) ?? null) : null,
        totalAmount: showAmounts ? r.totalAmount.toFixed(3) : null,
        energy: r.energy,
        isFullTank: r.isFullTank,
        declaredPhysicalKm: r.declaredPhysicalKm?.toString() ?? null,
        readingId: r.readingId,
        readingStatus: r.reading?.status ?? null,
        readingStatusReason: r.reading?.statusReason ?? null,
        consumptionEligibility: eligibility,
        consumptionEligibilityLabel: ENTRY_ELIGIBILITY_LABELS[eligibility],
        ticketAttachmentId: r.ticketAttachmentId,
        status: r.status,
        amountMismatch: r.amountMismatch,
        amountMismatchValue: showAmounts ? (r.amountMismatchValue?.toFixed(3) ?? null) : null,
        tankCapacityExceeded: r.tankCapacityExceeded,
        capacityConfirmedAt: r.capacityConfirmedAt?.toISOString() ?? null,
        replacesFuelEntryId: r.replacesFuelEntryId,
        replacedByFuelEntryId: replacements.find((x) => x.replacesFuelEntryId === r.id)?.id ?? null,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        decisionReason: r.decisionReason,
        notes: r.notes,
        expenseId: canSeeCosts ? (expenses.find((e) => e.sourceId === r.id)?.id ?? null) : null,
        createdAt: r.createdAt.toISOString(),
        version: r.version,
      };
    });
  }
}

function reasonViews(codes: readonly ConsumptionUnavailableReason[]): ConsumptionReasonDto[] {
  return codes.map((code) => ({ code, label: CONSUMPTION_REASON_LABELS[code] }));
}

function gapView(g: { id: string; vehicleId: string; companyId: string; startsAt: Date; endsAt: Date; reason: string; createdById: string | null; createdAt: Date }): FuelPurchaseGapViewDto {
  return { id: g.id, vehicleId: g.vehicleId, companyId: g.companyId, startsAt: g.startsAt.toISOString(), endsAt: g.endsAt.toISOString(), reason: g.reason, createdById: g.createdById, createdAt: g.createdAt.toISOString() };
}
