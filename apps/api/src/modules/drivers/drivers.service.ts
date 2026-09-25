import { Injectable } from '@nestjs/common';
import type { Driver, DriverPermit, Prisma } from '@parc-auto/db';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, ConflictError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import { type Page, pageOf, resolveSort, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import { AuditService } from '../../infra/audit.service.js';
import { closeAssignmentsOnDriverDeactivation } from '../assignments/assignment-exit.js';
import { lockDriver } from '../odometer/odometer-ingestion.service.js';
import { PrismaService, isUniqueViolation, type Tx } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import type { CreateDriverDto, DriverSummaryDto, DriverViewDto, DriversQueryDto, PermitViewDto, UpdateDriverDto, UpsertPermitDto } from './dto/drivers.dto.js';

type DriverWithPermits = Driver & { permits: DriverPermit[]; usages: Array<{ id: string }> };

function civilDate(value: string | undefined): Date | null {
  if (!value) return null;
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new BusinessRuleError('DATE_INVALIDE', 'Date civile attendue au format AAAA-MM-JJ.');
  return new Date(`${day}T00:00:00.000Z`);
}

function dateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/** Fiches conducteurs (CDC 3.3) : cloisonnées par société, données personnelles minimales. */
@Injectable()
export class DriversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly attachments: AttachmentsService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async list(ctx: RequestContext, query: DriversQueryDto): Promise<Page<DriverViewDto>> {
    this.access.requireStaff(ctx);
    const where: Prisma.DriverWhereInput = {
      ...this.access.companyWhere(ctx, query.companyId),
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? { OR: [{ code: { contains: query.q, mode: 'insensitive' } }, { lastName: { contains: query.q, mode: 'insensitive' } }, { firstName: { contains: query.q, mode: 'insensitive' } }] }
        : {}),
    };
    const sort = resolveSort(query.sort, ['lastName', 'code', 'createdAt'] as const, 'lastName');
    const [items, total] = await Promise.all([
      this.prisma.client.driver.findMany({ where, ...skipTake(query), orderBy: [{ [sort]: query.order }, { firstName: 'asc' }, { id: 'asc' }], include: this.include() }),
      this.prisma.client.driver.count({ where }),
    ]);
    return pageOf(items.map((d) => this.view(d)), total, query);
  }

  /** Liste réduite des conducteurs actifs d'une société (formulaires de remise/réservation). */
  async summaries(ctx: RequestContext, companyId: string): Promise<DriverSummaryDto[]> {
    this.access.requireStaff(ctx);
    this.access.assertCompanyReadable(ctx, companyId);
    const items = await this.prisma.client.driver.findMany({ where: { organizationId: ctx.organizationId, companyId, status: 'ACTIF' }, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }] });
    return items.map((d) => ({ id: d.id, companyId: d.companyId, code: d.code, firstName: d.firstName, lastName: d.lastName, status: d.status }));
  }

  async get(ctx: RequestContext, id: string): Promise<DriverViewDto> {
    const driver = await this.load(ctx, id);
    // Un conducteur ne consulte que sa propre fiche (T03) ; le personnel consulte son périmètre.
    if (ctx.isDriverOnly && ctx.driverId !== driver.id) throw new NotFoundOrOutOfScopeError('Conducteur');
    return this.view(driver);
  }

  async create(ctx: RequestContext, dto: CreateDriverDto): Promise<DriverViewDto> {
    this.access.requireOperational(ctx, dto.companyId);
    await this.assertSiteAndDepartment(ctx, dto.companyId, dto.siteId ?? null, dto.departmentId ?? null);
    try {
      const created = await this.prisma.client.$transaction((tx) => this.insertInTx(tx, ctx, dto, { active: true }));
      return this.view(created);
    } catch (error) {
      throw this.mapUnique(error);
    }
  }

  /** Traduit une violation d'unicité du code conducteur en conflit métier lisible. */
  mapUnique(error: unknown): unknown {
    if (isUniqueViolation(error)) return new ConflictError('CODE_CONDUCTEUR_EXISTANT', 'Ce code conducteur existe déjà dans l’organisation.');
    return error;
  }

  /**
   * Écriture d'un nouveau conducteur dans une transaction existante (formulaire ou import, 12.1).
   * Un conducteur importé « inactif » est créé désactivé ; périmètre et références sont contrôlés par
   * l'appelant, les violations d'unicité remontent telles quelles.
   */
  async insertInTx(tx: Tx, ctx: RequestContext, dto: CreateDriverDto, options: { active: boolean; reason?: string }) {
    const d = await tx.driver.create({
      data: {
        organizationId: ctx.organizationId,
        companyId: dto.companyId,
        code: dto.code,
        firstName: dto.firstName.trim(),
        lastName: dto.lastName.trim(),
        phone: dto.phone ?? null,
        email: dto.email?.toLowerCase() ?? null,
        siteId: dto.siteId ?? null,
        departmentId: dto.departmentId ?? null,
        notes: dto.notes ?? null,
        status: options.active ? 'ACTIF' : 'INACTIF',
        deactivatedAt: options.active ? null : this.clock.now(),
        createdById: ctx.userId,
      },
      include: this.include(),
    });
    await this.audit.record(ctx, { action: 'conducteur.creation', objectType: 'Driver', objectId: d.id, companyId: d.companyId, reason: options.reason ?? null, after: this.view(d) }, tx);
    return d;
  }

  async update(ctx: RequestContext, id: string, dto: UpdateDriverDto): Promise<DriverViewDto> {
    const current = await this.load(ctx, id);
    this.access.requireOperational(ctx, current.companyId);
    assertExpectedVersion(current, dto.expectedVersion, 'conducteur');
    await this.assertSiteAndDepartment(ctx, current.companyId, dto.siteId ?? null, dto.departmentId ?? null);
    const updated = await this.prisma.client.$transaction(async (tx) => {
      const d = await tx.driver.update({
        where: { id, version: dto.expectedVersion },
        data: {
          ...(dto.firstName !== undefined ? { firstName: dto.firstName.trim() } : {}),
          ...(dto.lastName !== undefined ? { lastName: dto.lastName.trim() } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.email !== undefined ? { email: dto.email?.toLowerCase() ?? null } : {}),
          ...(dto.siteId !== undefined ? { siteId: dto.siteId } : {}),
          ...(dto.departmentId !== undefined ? { departmentId: dto.departmentId } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          version: { increment: 1 },
        },
        include: this.include(),
      });
      await this.audit.record(ctx, { action: 'conducteur.modification', objectType: 'Driver', objectId: id, companyId: d.companyId, before: this.view(current), after: this.view(d) }, tx);
      return d;
    });
    return this.view(updated);
  }

  /** Désactivation : refusée tant qu'une utilisation ouverte existe (CDC 3.3). */
  /**
   * Désactivation (CDC 3.3, D-131), sous verrou du conducteur : refusée avec une utilisation EN_COURS ;
   * les réservations confirmées futures doivent être annulées explicitement (sinon 409 avec leur liste) ;
   * l'affectation habituelle en cours est clôturée à la date de désactivation, une affectation à venir retirée.
   */
  async deactivate(ctx: RequestContext, id: string, reason: string, expectedVersion: number, cancelFutureReservations = false): Promise<DriverViewDto> {
    const current = await this.load(ctx, id);
    this.access.requireManager(ctx, current.companyId);
    const now = this.clock.now();
    const updated = await this.prisma.serializable(async (tx) => {
      await lockDriver(tx, id);
      const locked = await tx.driver.findUniqueOrThrow({ where: { id }, select: { version: true, status: true } });
      assertExpectedVersion(locked, expectedVersion, 'conducteur');
      if (locked.status === 'INACTIF') throw new ConflictError('DEJA_INACTIF', 'Ce conducteur est déjà inactif.');
      const openUsage = await tx.vehicleUsage.findFirst({ where: { driverId: id, status: 'EN_COURS' }, select: { id: true } });
      if (openUsage) {
        throw new ConflictError('UTILISATION_OUVERTE', 'Ce conducteur a une utilisation en cours : enregistrez d’abord la restitution, toujours possible.', { usageId: openUsage.id });
      }
      const future = await tx.reservation.findMany({ where: { driverId: id, status: 'CONFIRMEE', endAt: { gt: now } }, orderBy: { startAt: 'asc' }, select: { id: true, startAt: true, endAt: true, vehicle: { select: { code: true } } } });
      if (future.length > 0 && !cancelFutureReservations) {
        throw new ConflictError('RESERVATIONS_FUTURES', 'Ce conducteur a des réservations confirmées à venir : confirmez leur annulation pour le désactiver.', {
          reservations: future.map((r) => ({ id: r.id, vehicleCode: r.vehicle.code, startAt: r.startAt.toISOString(), endAt: r.endAt.toISOString() })),
        });
      }
      const d = await tx.driver.update({ where: { id, version: expectedVersion }, data: { status: 'INACTIF', deactivatedAt: now, version: { increment: 1 } }, include: this.include() });
      for (const r of future) {
        await tx.reservation.update({ where: { id: r.id }, data: { status: 'ANNULEE', cancelledAt: now, cancelledById: ctx.userId, cancelReason: `conducteur désactivé : ${reason}`, version: { increment: 1 } } });
        await this.audit.record(ctx, { action: 'reservation.annulation', objectType: 'Reservation', objectId: r.id, companyId: d.companyId, reason: `conducteur désactivé : ${reason}` }, tx);
      }
      const assignments = await closeAssignmentsOnDriverDeactivation(tx, id, now, `conducteur désactivé : ${reason}`, ctx.userId);
      for (const a of assignments.closed) {
        await this.audit.record(ctx, { action: 'responsable_habituel.fin', objectType: 'VehicleResponsibleAssignment', objectId: a.id, companyId: a.companyId, reason: `conducteur désactivé : ${reason}`, before: { endsAt: a.endsAt }, after: { endsAt: now } }, tx);
      }
      for (const a of assignments.withdrawn) {
        await this.audit.record(ctx, { action: 'responsable_habituel.retrait', objectType: 'VehicleResponsibleAssignment', objectId: a.id, companyId: a.companyId, reason: `conducteur désactivé : ${reason}`, before: { vehicleId: a.vehicleId, startsAt: a.startsAt, endsAt: a.endsAt } }, tx);
      }
      await this.audit.record(ctx, { action: 'conducteur.desactivation', objectType: 'Driver', objectId: id, companyId: d.companyId, reason, after: { reservationsAnnulees: future.length, affectationsCloturees: assignments.closed.length, affectationsRetirees: assignments.withdrawn.length } }, tx);
      return d;
    });
    return this.view(updated);
  }


  async reactivate(ctx: RequestContext, id: string, expectedVersion: number): Promise<DriverViewDto> {
    const current = await this.load(ctx, id);
    this.access.requireManager(ctx, current.companyId);
    assertExpectedVersion(current, expectedVersion, 'conducteur');
    const updated = await this.prisma.client.$transaction(async (tx) => {
      const d = await tx.driver.update({ where: { id, version: expectedVersion }, data: { status: 'ACTIF', deactivatedAt: null, version: { increment: 1 } }, include: this.include() });
      await this.audit.record(ctx, { action: 'conducteur.reactivation', objectType: 'Driver', objectId: id, companyId: d.companyId }, tx);
      return d;
    });
    return this.view(updated);
  }

  async upsertPermit(ctx: RequestContext, driverId: string, dto: UpsertPermitDto): Promise<PermitViewDto> {
    const driver = await this.load(ctx, driverId);
    this.access.requireOperational(ctx, driver.companyId);
    const issuedOn = civilDate(dto.issuedOn);
    const expiresOn = civilDate(dto.expiresOn);
    if (issuedOn && expiresOn && issuedOn > expiresOn) throw new BusinessRuleError('DATES_PERMIS', 'La date d’expiration précède la date de délivrance.', { fieldErrors: { expiresOn: ['Doit suivre la date de délivrance.'] } });
    const permit = await this.prisma.client.$transaction(async (tx) => {
      const existing = await tx.driverPermit.findFirst({ where: { driverId } });
      const data = { number: dto.number.trim(), categories: dto.categories.map((c) => c.trim().toUpperCase()), issuedOn, expiresOn };
      const saved = existing
        ? await tx.driverPermit.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 } } })
        : await tx.driverPermit.create({ data: { ...data, organizationId: ctx.organizationId, driverId, createdById: ctx.userId } });
      if (dto.attachmentId) {
        await this.attachments.attach(ctx, tx, dto.attachmentId, 'PERMIS', saved.id, driver.companyId);
        await tx.driverPermit.update({ where: { id: saved.id }, data: { attachmentId: dto.attachmentId } });
      }
      await this.audit.record(ctx, { action: existing ? 'permis.modification' : 'permis.creation', objectType: 'DriverPermit', objectId: saved.id, companyId: driver.companyId, before: existing ? permitView(existing) : undefined, after: permitView({ ...saved, attachmentId: dto.attachmentId ?? saved.attachmentId }) }, tx);
      return tx.driverPermit.findUniqueOrThrow({ where: { id: saved.id } });
    });
    return permitView(permit);
  }

  /** Décision de périmètre pour les autres modules : conducteur visible ou 404. */
  async load(ctx: RequestContext, id: string): Promise<DriverWithPermits> {
    const d = await this.prisma.client.driver.findFirst({ where: { id, organizationId: ctx.organizationId }, include: this.include() });
    if (!d) throw new NotFoundOrOutOfScopeError('Conducteur');
    if (!ctx.isDriverOnly) this.access.assertCompanyReadable(ctx, d.companyId);
    return d;
  }

  /** Même contrôle que load (404 hors organisation ou hors périmètre), en une lecture sans permis ni utilisations. */
  async assertReadable(ctx: RequestContext, id: string): Promise<void> {
    const d = await this.prisma.client.driver.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { companyId: true } });
    if (!d) throw new NotFoundOrOutOfScopeError('Conducteur');
    if (!ctx.isDriverOnly) this.access.assertCompanyReadable(ctx, d.companyId);
  }

  private async assertSiteAndDepartment(ctx: RequestContext, companyId: string, siteId: string | null, departmentId: string | null): Promise<void> {
    if (siteId) {
      const site = await this.prisma.client.site.findFirst({ where: { id: siteId, companyId, organizationId: ctx.organizationId } });
      if (!site) throw new NotFoundOrOutOfScopeError('Site');
    }
    if (departmentId) {
      const dep = await this.prisma.client.department.findFirst({ where: { id: departmentId, companyId, organizationId: ctx.organizationId } });
      if (!dep) throw new NotFoundOrOutOfScopeError('Service');
    }
  }

  private include() {
    return { permits: true, usages: { where: { status: 'EN_COURS' as const }, select: { id: true } } } as const;
  }

  view(d: DriverWithPermits): DriverViewDto {
    return {
      id: d.id,
      companyId: d.companyId,
      code: d.code,
      firstName: d.firstName,
      lastName: d.lastName,
      phone: d.phone,
      email: d.email,
      status: d.status,
      siteId: d.siteId,
      departmentId: d.departmentId,
      userId: d.userId,
      notes: d.notes,
      permits: d.permits.map(permitView),
      currentUsageId: d.usages[0]?.id ?? null,
      createdAt: d.createdAt.toISOString(),
      version: d.version,
    };
  }
}

export function permitView(p: DriverPermit): PermitViewDto {
  return { id: p.id, number: p.number, categories: p.categories, issuedOn: dateOnly(p.issuedOn), expiresOn: dateOnly(p.expiresOn), attachmentId: p.attachmentId };
}
