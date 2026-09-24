import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma, Vehicle } from '@parc-auto/db';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, ConflictError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import { type Page, pageOf, resolveSort, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import { fromDbDate, localDate, toDbDate } from '../../domain/civil-date.js';
import { computeDocumentStatus } from '../../domain/document-status.js';
import { computeFreshness } from '../../domain/freshness.js';
import { normalizeRegistration, normalizeVin } from '../../domain/registration.js';
import { operationalStatus } from '../../domain/vehicle-status.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, isUniqueViolation, type Tx } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type { ChangeLifecycleDto, CreateLocationReportDto, CreateVehicleDto, LocationReportViewDto, QrResolveDto, UpdateVehicleDto, VehicleSynthesisDto, VehicleViewDto, VehiclesQueryDto } from './dto/vehicles.dto.js';

const vehicleInclude = {
  company: { select: { code: true } },
  category: { select: { label: true } },
  usages: { where: { status: 'EN_COURS' as const }, select: { id: true, driverId: true, checkedOutAt: true, expectedReturnAt: true, driver: { select: { firstName: true, lastName: true } } } },
  immobilizations: { where: { status: 'ACTIVE' as const }, select: { id: true } },
} as const;

type VehicleRow = Prisma.VehicleGetPayload<{ include: typeof vehicleInclude }>;

const PLAN_URGENCY: Record<string, number> = { EN_RETARD: 0, A_FAIRE: 1, A_PREVOIR: 2, INCOMPLET: 3, A_JOUR: 4 };

/**
 * Dossiers véhicules (CDC 3.1, 3.2, 3.4). Le périmètre est appliqué à chaque requête ; un véhicule hors
 * périmètre est introuvable (404). Un conducteur ne voit que le véhicule de son utilisation en cours
 * ou dont il est responsable habituel.
 */
@Injectable()
export class VehiclesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly attachments: AttachmentsService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  async list(ctx: RequestContext, query: VehiclesQueryDto): Promise<Page<VehicleViewDto>> {
    this.access.requireStaff(ctx);
    const where: Prisma.VehicleWhereInput = {
      ...this.access.companyWhere(ctx, query.companyId),
      ...(query.lifecycleStatus ? { lifecycleStatus: query.lifecycleStatus } : query.includeInactive === 'true' ? {} : { lifecycleStatus: { in: ['ACTIF', 'HORS_SERVICE'] } }),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.siteId ? { siteId: query.siteId } : {}),
      ...(query.operationalStatus === 'IMMOBILISE' ? { lifecycleStatus: 'ACTIF', immobilizations: { some: { status: 'ACTIVE' } } } : {}),
      ...(query.operationalStatus === 'EN_UTILISATION' ? { lifecycleStatus: 'ACTIF', immobilizations: { none: { status: 'ACTIVE' } }, usages: { some: { status: 'EN_COURS' } } } : {}),
      ...(query.operationalStatus === 'DISPONIBLE' ? { lifecycleStatus: 'ACTIF', immobilizations: { none: { status: 'ACTIVE' } }, usages: { none: { status: 'EN_COURS' } } } : {}),
      ...(query.q
        ? {
            OR: [
              { code: { contains: query.q, mode: 'insensitive' } },
              { registrationNormalized: { contains: normalizeRegistration(query.q) } },
              { make: { contains: query.q, mode: 'insensitive' } },
              { model: { contains: query.q, mode: 'insensitive' } },
              { vin: { contains: query.q.toUpperCase() } },
            ],
          }
        : {}),
    };
    const sort = resolveSort(query.sort, ['code', 'registration', 'make', 'createdAt'] as const, 'code');
    const [items, total] = await Promise.all([
      this.prisma.client.vehicle.findMany({ where, ...skipTake(query), orderBy: { [sort]: query.order }, include: vehicleInclude }),
      this.prisma.client.vehicle.count({ where }),
    ]);
    return pageOf(items.map((v) => this.view(v)), total, query);
  }

  async get(ctx: RequestContext, id: string): Promise<VehicleViewDto> {
    return this.view(await this.load(ctx, id));
  }

  async synthesis(ctx: RequestContext, id: string): Promise<VehicleSynthesisDto> {
    const v = await this.load(ctx, id);
    const now = this.clock.now();
    const [assignment, lastLocation, lastReading, segment, plans, docsVersions, docTypes, openIncidents, pendingReadings, photos] = await Promise.all([
      this.prisma.client.vehicleResponsibleAssignment.findFirst({ where: { vehicleId: id, startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] }, include: { driver: { select: { firstName: true, lastName: true } } }, orderBy: { startsAt: 'desc' } }),
      this.prisma.client.vehicleLocationReport.findFirst({ where: { vehicleId: id }, orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }], include: { site: { select: { name: true } } } }),
      this.prisma.client.odometerReading.findFirst({ where: { vehicleId: id, status: 'ACCEPTE' }, orderBy: [{ observedAt: 'desc' }, { enteredAt: 'desc' }] }),
      this.prisma.client.odometerSegment.findFirst({ where: { vehicleId: id, endedAt: null } }),
      this.prisma.client.vehicleMaintenancePlan.findMany({ where: { vehicleId: id, active: true }, include: { maintenanceType: { select: { label: true } } } }),
      this.prisma.client.documentVersion.findMany({ where: { vehicleId: id, archivedAt: null }, select: { id: true, documentTypeId: true, validTo: true, validFrom: true } }),
      this.prisma.client.documentType.findMany({ where: { organizationId: ctx.organizationId, ownerType: 'VEHICULE', status: 'ACTIF' }, select: { id: true, required: true, blocksCheckout: true, hasExpiry: true, noticeDays: true } }),
      this.prisma.client.incident.count({ where: { vehicleId: id, status: { in: ['OUVERT', 'EN_TRAITEMENT'] } } }),
      this.prisma.client.odometerReading.count({ where: { vehicleId: id, status: 'EN_ATTENTE' } }),
      this.prisma.client.attachment.findMany({ where: { ownerType: 'VEHICULE', ownerId: id, deletedAt: null }, select: { id: true } }),
    ]);
    const staleAfterDays = await this.settings.get(ctx.organizationId, 'odometer.staleAfterDays', v.companyId);
    const freshness = computeFreshness(lastReading?.observedAt ?? null, now, staleAfterDays);
    const authorIds = [lastLocation?.createdById].filter((x): x is string => Boolean(x));
    const authors = authorIds.length ? await this.prisma.client.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, firstName: true, lastName: true } }) : [];
    // Conformité documentaire : règle unique de document-status.ts, au jour local du groupe (7.1).
    const org = await this.prisma.client.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } });
    const today = localDate(now, org.timezone);
    const compliance = { blocking: 0, missing: 0, expired: 0, expiringSoon: 0 };
    for (const type of docTypes) {
      const versions = docsVersions.filter((d) => d.documentTypeId === type.id).map((d) => ({ id: d.id, validFrom: fromDbDate(d.validFrom), validTo: fromDbDate(d.validTo) }));
      const result = computeDocumentStatus(type, versions, today);
      if (result.status === 'MANQUANT') compliance.missing += 1;
      if (result.status === 'EXPIRE') compliance.expired += 1;
      if (result.status === 'A_RENOUVELER') compliance.expiringSoon += 1;
      if (result.blocksCheckout && (result.status === 'MANQUANT' || result.status === 'EXPIRE')) compliance.blocking += 1;
    }
    return {
      ...this.view(v),
      responsible: assignment ? { assignmentId: assignment.id, driverId: assignment.driverId, driverName: `${assignment.driver.firstName} ${assignment.driver.lastName}`, since: assignment.startsAt.toISOString() } : null,
      lastLocation: lastLocation ? this.locationView(lastLocation, authors) : null,
      odometer: lastReading
        ? {
            readingId: lastReading.id,
            physicalKm: lastReading.physicalKm?.toFixed(3) ?? null,
            cumulativeKm: lastReading.cumulativeKm?.toFixed(3) ?? null,
            cumulativeKnown: segment?.cumulativeKnown ?? true,
            isEstimate: lastReading.isEstimate,
            measurementKind: lastReading.measurementKind,
            source: lastReading.source,
            observedAt: lastReading.observedAt.toISOString(),
            freshness: freshness.status,
            ageDays: freshness.ageDays,
          }
        : null,
      freshness: freshness.status,
      upcomingMaintenance: plans
        .sort((a, b) => (PLAN_URGENCY[a.computedStatus] ?? 9) - (PLAN_URGENCY[b.computedStatus] ?? 9))
        .slice(0, 5)
        .map((p) => ({ planId: p.id, maintenanceTypeLabel: p.maintenanceType.label, status: p.computedStatus, nextDueKm: p.nextDueKm?.toFixed(3) ?? null, nextDueDate: fromDbDate(p.nextDueDate) })),
      documentCompliance: compliance,
      openIncidents,
      pendingReadings,
      photoAttachmentIds: photos.map((p) => p.id),
      qrToken: v.qrToken,
    };
  }

  async create(ctx: RequestContext, dto: CreateVehicleDto): Promise<VehicleViewDto> {
    this.access.requireOperational(ctx, dto.companyId);
    await this.assertReferences(ctx, dto.companyId, dto.categoryId, dto.siteId ?? null, dto.departmentId ?? null, dto.contractSupplierId ?? null);
    const registration = dto.registration.trim();
    const data: Prisma.VehicleUncheckedCreateInput = {
      organizationId: ctx.organizationId,
      companyId: dto.companyId,
      code: dto.code,
      registration,
      registrationNormalized: normalizeRegistration(registration),
      provisionalRegistration: dto.provisionalRegistration ?? false,
      vin: normalizeVin(dto.vin),
      make: dto.make.trim(),
      model: dto.model.trim(),
      categoryId: dto.categoryId,
      lifecycleStatus: dto.lifecycleStatus ?? 'ACTIF',
      year: dto.year ?? null,
      commissioningDate: toDbDate(dto.commissioningDate?.slice(0, 10)),
      energy: dto.energy ?? null,
      tankCapacityLiters: dto.tankCapacityLiters ?? null,
      siteId: dto.siteId ?? null,
      departmentId: dto.departmentId ?? null,
      ownershipMode: dto.ownershipMode ?? null,
      contractSupplierId: dto.contractSupplierId ?? null,
      contractEndDate: toDbDate(dto.contractEndDate?.slice(0, 10)),
      notes: dto.notes ?? null,
      qrToken: randomUUID(),
      createdById: ctx.userId,
    };
    if (data.registrationNormalized.length === 0) throw new BusinessRuleError('IMMATRICULATION_VIDE', 'L’immatriculation ne peut pas être vide après normalisation.', { fieldErrors: { registration: ['Valeur invalide.'] } });
    try {
      const created = await this.prisma.client.$transaction(async (tx) => {
        const v = await tx.vehicle.create({ data, include: vehicleInclude });
        await tx.vehicleCompanyHistory.create({ data: { organizationId: ctx.organizationId, vehicleId: v.id, fromCompanyId: null, toCompanyId: v.companyId, effectiveAt: this.clock.now(), reason: 'création du dossier', createdById: ctx.userId } });
        await this.audit.record(ctx, { action: 'vehicule.creation', objectType: 'Vehicle', objectId: v.id, companyId: v.companyId, after: this.view(v) }, tx);
        return v;
      });
      return this.view(created);
    } catch (error) {
      throw this.mapUnique(error);
    }
  }

  async update(ctx: RequestContext, id: string, dto: UpdateVehicleDto): Promise<VehicleViewDto> {
    const current = await this.load(ctx, id);
    this.access.requireOperational(ctx, current.companyId);
    assertExpectedVersion(current, dto.expectedVersion, 'véhicule');
    if (current.lifecycleStatus === 'ARCHIVE' || current.lifecycleStatus === 'CEDE') {
      throw new BusinessRuleError('VEHICULE_CLOS', 'Un véhicule cédé ou archivé n’est plus modifiable.');
    }
    await this.assertReferences(ctx, current.companyId, dto.categoryId ?? current.categoryId, dto.siteId ?? null, dto.departmentId ?? null, dto.contractSupplierId ?? null);
    const registration = dto.registration?.trim();
    const data: Prisma.VehicleUncheckedUpdateInput = {
      ...(registration !== undefined ? { registration, registrationNormalized: normalizeRegistration(registration) } : {}),
      ...(dto.provisionalRegistration !== undefined ? { provisionalRegistration: dto.provisionalRegistration } : {}),
      ...(dto.make !== undefined ? { make: dto.make.trim() } : {}),
      ...(dto.model !== undefined ? { model: dto.model.trim() } : {}),
      ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
      ...(dto.vin !== undefined ? { vin: normalizeVin(dto.vin) } : {}),
      ...(dto.year !== undefined ? { year: dto.year } : {}),
      ...(dto.commissioningDate !== undefined ? { commissioningDate: toDbDate(dto.commissioningDate?.slice(0, 10)) } : {}),
      ...(dto.energy !== undefined ? { energy: dto.energy } : {}),
      ...(dto.tankCapacityLiters !== undefined ? { tankCapacityLiters: dto.tankCapacityLiters } : {}),
      ...(dto.siteId !== undefined ? { siteId: dto.siteId } : {}),
      ...(dto.departmentId !== undefined ? { departmentId: dto.departmentId } : {}),
      ...(dto.ownershipMode !== undefined ? { ownershipMode: dto.ownershipMode } : {}),
      ...(dto.contractSupplierId !== undefined ? { contractSupplierId: dto.contractSupplierId } : {}),
      ...(dto.contractEndDate !== undefined ? { contractEndDate: toDbDate(dto.contractEndDate?.slice(0, 10)) } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      version: { increment: 1 },
    };
    try {
      const updated = await this.prisma.client.$transaction(async (tx) => {
        const v = await tx.vehicle.update({ where: { id, version: dto.expectedVersion }, data, include: vehicleInclude });
        await this.audit.record(ctx, { action: 'vehicule.modification', objectType: 'Vehicle', objectId: id, companyId: v.companyId, before: this.view(current), after: this.view(v) }, tx);
        return v;
      });
      return this.view(updated);
    } catch (error) {
      throw this.mapUnique(error);
    }
  }

  /**
   * Cycle de vie (CDC 3.2) : archivage et cession refusés tant que des opérations sont ouvertes.
   * Un passage HORS_SERVICE n'efface jamais une utilisation ouverte (elle reste visible).
   */
  async changeLifecycle(ctx: RequestContext, id: string, dto: ChangeLifecycleDto): Promise<VehicleViewDto> {
    const current = await this.load(ctx, id);
    this.access.requireManager(ctx, current.companyId);
    assertExpectedVersion(current, dto.expectedVersion, 'véhicule');
    const target = dto.lifecycleStatus;
    if (current.lifecycleStatus === target) throw new BusinessRuleError('STATUT_INCHANGE', 'Le véhicule est déjà dans ce statut.');
    if (current.lifecycleStatus === 'ARCHIVE') throw new BusinessRuleError('VEHICULE_ARCHIVE', 'Un véhicule archivé ne change plus de statut.');
    if (target === 'CEDE' || target === 'ARCHIVE') {
      await this.assertNoOpenOperations(id);
    }
    const now = this.clock.now();
    const updated = await this.prisma.client.$transaction(async (tx) => {
      const v = await tx.vehicle.update({
        where: { id, version: dto.expectedVersion },
        data: {
          lifecycleStatus: target,
          ...(target === 'ARCHIVE' ? { archivedAt: now } : {}),
          ...(target === 'CEDE' ? { disposedAt: now } : {}),
          ...(target === 'ACTIF' ? { archivedAt: null, disposedAt: null } : {}),
          version: { increment: 1 },
        },
        include: vehicleInclude,
      });
      if (target === 'CEDE' || target === 'ARCHIVE') {
        await tx.vehicleResponsibleAssignment.updateMany({ where: { vehicleId: id, endsAt: null }, data: { endsAt: now, endReason: `véhicule ${target === 'CEDE' ? 'cédé' : 'archivé'}`, endedById: ctx.userId } });
        await tx.vehicleMaintenancePlan.updateMany({ where: { vehicleId: id, active: true }, data: { active: false, deactivatedAt: now, deactivationReason: 'véhicule sorti du parc' } });
      }
      await this.audit.record(ctx, { action: 'vehicule.cycle_de_vie', objectType: 'Vehicle', objectId: id, companyId: v.companyId, reason: dto.reason, before: { lifecycleStatus: current.lifecycleStatus }, after: { lifecycleStatus: target } }, tx);
      return v;
    });
    return this.view(updated);
  }

  async addLocationReport(ctx: RequestContext, vehicleId: string, dto: CreateLocationReportDto): Promise<LocationReportViewDto> {
    const v = await this.load(ctx, vehicleId);
    if (ctx.isDriverOnly) {
      if (!v.usages.some((u) => u.driverId === ctx.driverId)) throw new NotFoundOrOutOfScopeError('Véhicule');
    } else {
      this.access.requireOperational(ctx, v.companyId);
    }
    if (!dto.siteId && !dto.placeLabel?.trim()) throw new BusinessRuleError('LIEU_REQUIS', 'Indiquez un site ou un lieu libre.', { fieldErrors: { placeLabel: ['Site ou lieu requis.'] } });
    const observedAt = new Date(dto.observedAt);
    if (observedAt.getTime() > this.clock.now().getTime() + 60_000) throw new BusinessRuleError('DATE_FUTURE', 'La date d’observation ne peut pas être future.', { fieldErrors: { observedAt: ['Date future refusée.'] } });
    if (dto.siteId) {
      const site = await this.prisma.client.site.findFirst({ where: { id: dto.siteId, organizationId: ctx.organizationId, companyId: v.companyId } });
      if (!site) throw new NotFoundOrOutOfScopeError('Site');
    }
    const report = await this.prisma.client.$transaction(async (tx) => {
      const r = await tx.vehicleLocationReport.create({
        data: { organizationId: ctx.organizationId, companyId: v.companyId, vehicleId, siteId: dto.siteId ?? null, placeLabel: dto.placeLabel?.trim() ?? null, observedAt, comment: dto.comment ?? null, context: 'DECLARATION', createdById: ctx.userId },
        include: { site: { select: { name: true } } },
      });
      await this.audit.record(ctx, { action: 'vehicule.localisation_declaree', objectType: 'VehicleLocationReport', objectId: r.id, companyId: v.companyId, after: { vehicleId, siteId: r.siteId, placeLabel: r.placeLabel, observedAt } }, tx);
      return r;
    });
    return this.locationView(report, [{ id: ctx.userId, firstName: ctx.displayName, lastName: '' }]);
  }

  async listLocationReports(ctx: RequestContext, vehicleId: string, query: { page: number; pageSize: number }): Promise<Page<LocationReportViewDto>> {
    await this.load(ctx, vehicleId);
    const where = { vehicleId };
    const [items, total] = await Promise.all([
      this.prisma.client.vehicleLocationReport.findMany({ where, ...skipTake(query), orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }], include: { site: { select: { name: true } } } }),
      this.prisma.client.vehicleLocationReport.count({ where }),
    ]);
    const authorIds = [...new Set(items.map((i) => i.createdById).filter((x): x is string => Boolean(x)))];
    const authors = authorIds.length ? await this.prisma.client.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, firstName: true, lastName: true } }) : [];
    return pageOf(items.map((r) => this.locationView(r, authors)), total, query);
  }

  /** Enregistre une localisation issue d'une remise, restitution ou entrée au garage (appel interne). */
  async recordLocation(tx: Tx, ctx: RequestContext, vehicle: { id: string; companyId: string }, input: { siteId?: string | null; placeLabel?: string | null; observedAt: Date; context: 'REMISE' | 'RESTITUTION' | 'GARAGE' | 'TRANSFERT'; usageId?: string | null; comment?: string | null }): Promise<void> {
    if (!input.siteId && !input.placeLabel) return;
    await tx.vehicleLocationReport.create({
      data: { organizationId: ctx.organizationId, companyId: vehicle.companyId, vehicleId: vehicle.id, siteId: input.siteId ?? null, placeLabel: input.placeLabel ?? null, observedAt: input.observedAt, comment: input.comment ?? null, context: input.context, usageId: input.usageId ?? null, createdById: ctx.userId },
    });
  }

  async attachPhoto(ctx: RequestContext, vehicleId: string, attachmentId: string): Promise<{ attachmentId: string }> {
    const v = await this.load(ctx, vehicleId);
    this.access.requireOperational(ctx, v.companyId);
    await this.prisma.client.$transaction(async (tx) => {
      const att = await this.attachments.attach(ctx, tx, attachmentId, 'VEHICULE', vehicleId, v.companyId);
      if (!att.mimeType.startsWith('image/')) throw new BusinessRuleError('PHOTO_ATTENDUE', 'Une photo JPEG ou PNG est attendue.');
      await this.audit.record(ctx, { action: 'vehicule.photo_ajoutee', objectType: 'Vehicle', objectId: vehicleId, companyId: v.companyId, after: { attachmentId } }, tx);
    });
    return { attachmentId };
  }

  /** QR interne (CDC 10.3) : identifiant opaque, résolu après authentification et dans le périmètre. */
  async resolveQr(ctx: RequestContext, token: string): Promise<QrResolveDto> {
    const v = await this.prisma.client.vehicle.findFirst({ where: { qrToken: token, organizationId: ctx.organizationId }, include: vehicleInclude });
    if (!v) throw new NotFoundOrOutOfScopeError('Véhicule');
    await this.assertVisible(ctx, v);
    return { vehicleId: v.id, code: v.code, registration: v.registration };
  }

  async regenerateQr(ctx: RequestContext, vehicleId: string): Promise<{ qrToken: string }> {
    const v = await this.load(ctx, vehicleId);
    this.access.requireManager(ctx, v.companyId);
    const qrToken = randomUUID();
    await this.prisma.client.$transaction(async (tx) => {
      await tx.vehicle.update({ where: { id: vehicleId }, data: { qrToken, version: { increment: 1 } } });
      await this.audit.record(ctx, { action: 'vehicule.qr_regenere', objectType: 'Vehicle', objectId: vehicleId, companyId: v.companyId }, tx);
    });
    return { qrToken };
  }

  /** Charge un véhicule visible ou lève 404 ; pour un conducteur : véhicule en cours d'utilisation ou dont il est responsable. */
  async load(ctx: RequestContext, id: string): Promise<VehicleRow> {
    const v = await this.prisma.client.vehicle.findFirst({ where: { id, organizationId: ctx.organizationId }, include: vehicleInclude });
    if (!v) throw new NotFoundOrOutOfScopeError('Véhicule');
    await this.assertVisible(ctx, v);
    return v;
  }

  private async assertVisible(ctx: RequestContext, v: VehicleRow): Promise<void> {
    if (ctx.isDriverOnly) {
      if (!ctx.driverId) throw new NotFoundOrOutOfScopeError('Véhicule');
      if (v.usages.some((u) => u.driverId === ctx.driverId)) return;
      const responsible = await this.prisma.client.vehicleResponsibleAssignment.findFirst({ where: { vehicleId: v.id, driverId: ctx.driverId, endsAt: null } });
      if (!responsible) throw new NotFoundOrOutOfScopeError('Véhicule');
      return;
    }
    this.access.assertCompanyReadable(ctx, v.companyId);
  }

  async assertNoOpenOperations(vehicleId: string): Promise<void> {
    const now = this.clock.now();
    const [usages, immobilizations, interventions, reservations] = await Promise.all([
      this.prisma.client.vehicleUsage.count({ where: { vehicleId, status: 'EN_COURS' } }),
      this.prisma.client.immobilization.count({ where: { vehicleId, status: 'ACTIVE' } }),
      this.prisma.client.intervention.count({ where: { vehicleId, status: { in: ['BROUILLON', 'PLANIFIEE', 'EN_COURS'] } } }),
      this.prisma.client.reservation.count({ where: { vehicleId, status: 'CONFIRMEE', endAt: { gt: now } } }),
    ]);
    const blockers = { usages, immobilizations, interventions, reservations };
    if (usages + immobilizations + interventions + reservations > 0) {
      throw new BusinessRuleError('OPERATIONS_OUVERTES', 'Opération refusée : des utilisations, immobilisations, interventions ou réservations futures sont encore ouvertes.', { details: blockers });
    }
  }

  private async assertReferences(ctx: RequestContext, companyId: string, categoryId: string, siteId: string | null, departmentId: string | null, supplierId: string | null): Promise<void> {
    const category = await this.prisma.client.vehicleCategory.findFirst({ where: { id: categoryId, organizationId: ctx.organizationId, status: 'ACTIF' } });
    if (!category) throw new NotFoundOrOutOfScopeError('Catégorie');
    if (siteId) {
      const site = await this.prisma.client.site.findFirst({ where: { id: siteId, companyId, organizationId: ctx.organizationId } });
      if (!site) throw new NotFoundOrOutOfScopeError('Site');
    }
    if (departmentId) {
      const dep = await this.prisma.client.department.findFirst({ where: { id: departmentId, companyId, organizationId: ctx.organizationId } });
      if (!dep) throw new NotFoundOrOutOfScopeError('Service');
    }
    if (supplierId) {
      const supplier = await this.prisma.client.supplier.findFirst({ where: { id: supplierId, companyId, organizationId: ctx.organizationId } });
      if (!supplier) throw new NotFoundOrOutOfScopeError('Fournisseur');
    }
  }

  private mapUnique(error: unknown): unknown {
    if (isUniqueViolation(error, 'code')) return new ConflictError('CODE_VEHICULE_EXISTANT', 'Ce code interne existe déjà dans l’organisation.');
    if (isUniqueViolation(error, 'registrationNormalized')) return new ConflictError('IMMATRICULATION_EXISTANTE', 'Cette immatriculation existe déjà (comparaison normalisée).');
    if (isUniqueViolation(error, 'vin')) return new ConflictError('VIN_EXISTANT', 'Ce VIN est déjà enregistré.');
    if (isUniqueViolation(error)) return new ConflictError('DOUBLON_VEHICULE', 'Un véhicule identique existe déjà.');
    return error;
  }

  view(v: VehicleRow): VehicleViewDto {
    const usage = v.usages[0];
    return {
      id: v.id,
      companyId: v.companyId,
      companyCode: v.company.code,
      code: v.code,
      registration: v.registration,
      provisionalRegistration: v.provisionalRegistration,
      make: v.make,
      model: v.model,
      categoryId: v.categoryId,
      categoryLabel: v.category.label,
      lifecycleStatus: v.lifecycleStatus,
      operationalStatus: operationalStatus({ lifecycle: v.lifecycleStatus, hasActiveImmobilization: v.immobilizations.length > 0, hasOpenUsage: v.usages.length > 0 }),
      vin: v.vin,
      year: v.year,
      commissioningDate: fromDbDate(v.commissioningDate),
      energy: v.energy,
      tankCapacityLiters: v.tankCapacityLiters?.toFixed(3) ?? null,
      siteId: v.siteId,
      departmentId: v.departmentId,
      ownershipMode: v.ownershipMode,
      contractSupplierId: v.contractSupplierId,
      contractEndDate: fromDbDate(v.contractEndDate),
      notes: v.notes,
      currentUsage: usage ? { id: usage.id, driverId: usage.driverId, driverName: `${usage.driver.firstName} ${usage.driver.lastName}`, checkedOutAt: usage.checkedOutAt.toISOString(), expectedReturnAt: usage.expectedReturnAt.toISOString() } : null,
      activeImmobilizationId: v.immobilizations[0]?.id ?? null,
      createdAt: v.createdAt.toISOString(),
      version: v.version,
    };
  }

  private locationView(r: { id: string; siteId: string | null; site: { name: string } | null; placeLabel: string | null; observedAt: Date; comment: string | null; context: string; createdById: string | null; createdAt: Date }, authors: Array<{ id: string; firstName: string; lastName: string }>): LocationReportViewDto {
    const author = authors.find((a) => a.id === r.createdById);
    return {
      id: r.id,
      siteId: r.siteId,
      siteName: r.site?.name ?? null,
      placeLabel: r.placeLabel,
      observedAt: r.observedAt.toISOString(),
      comment: r.comment,
      context: r.context,
      createdById: r.createdById,
      createdByName: author ? `${author.firstName} ${author.lastName}`.trim() : null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}

export type { Vehicle };
