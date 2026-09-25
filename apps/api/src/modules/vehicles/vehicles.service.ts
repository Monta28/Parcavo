import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma, Vehicle } from '@parc-auto/db';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, ConflictError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import { type Page, pageOf, resolveSort, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import { fromDbDate, localDate, toDbDate } from '../../domain/civil-date.js';
import { isDocumentTypeApplicable } from '../../domain/document-applicability.js';
import { computeDocumentStatus } from '../../domain/document-status.js';
import { computeFreshness } from '../../domain/freshness.js';
import { normalizeRegistration, normalizeVin } from '../../domain/registration.js';
import { currentAssignmentWhere } from '../../domain/responsible-assignment.js';
import { operationalStatus } from '../../domain/vehicle-status.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, isUniqueViolation, type Tx } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { closeAssignmentsOnVehicleExit } from '../assignments/assignment-exit.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { eventCompany } from './event-company.js';
import { lockVehicle } from '../odometer/odometer-ingestion.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { closeOpenMappingsForVehicle } from '../telemetry/telemetry-units.service.js';
import type { ChangeLifecycleDto, CreateLocationReportDto, CreateVehicleDto, LocationReportViewDto, QrResolveDto, UpdateVehicleDto, VehicleSynthesisDto, VehicleViewDto, VehiclesQueryDto } from './dto/vehicles.dto.js';
import { operationalStatusWhere, vehicleConditionClauses } from './vehicle-conditions.js';

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
      ...(query.vehicleId ? { id: query.vehicleId } : {}),
      ...(query.lifecycleStatus ? { lifecycleStatus: query.lifecycleStatus } : query.includeInactive === 'true' ? {} : { lifecycleStatus: { in: ['ACTIF', 'HORS_SERVICE'] } }),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.siteId ? { siteId: query.siteId } : {}),
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
    // Statut opérationnel : même partition que operationalStatus() et que le rapport d'inventaire
    // (operationalStatusWhere), combinée au filtre de cycle de vie sans le remplacer.
    const operational = query.operationalStatus ? [operationalStatusWhere(query.operationalStatus)] : [];
    // Filtres justificatifs du tableau de bord (D-269) : fraîcheur du kilométrage et documents bloquants.
    const conditions = [...operational, ...(await vehicleConditionClauses({ prisma: this.prisma, settings: this.settings }, ctx, query, operational.length > 0 ? { AND: [where, ...operational] } : where, this.clock.now()))];
    if (conditions.length > 0) where.AND = conditions;
    const sort = resolveSort(query.sort, ['code', 'registration', 'make', 'createdAt'] as const, 'code');
    const [items, total] = await Promise.all([
      this.prisma.client.vehicle.findMany({ where, ...skipTake(query), orderBy: [{ [sort]: query.order }, { id: 'asc' }], include: vehicleInclude }),
      this.prisma.client.vehicle.count({ where }),
    ]);
    return pageOf(items.map((v) => this.view(v)), total, query);
  }

  async get(ctx: RequestContext, id: string): Promise<VehicleViewDto> {
    return this.forViewer(ctx, this.view(await this.load(ctx, id)));
  }

  /**
   * Projection conducteur (CDC 2.3, D-116) : pour un compte uniquement conducteur, seules les informations
   * utiles à son utilisation restent (identité du véhicule, état, dernier relevé, dernière localisation sans
   * auteur) ; jamais le nom d'un autre conducteur, contrat, notes internes, coûts ni données de gestion.
   */
  private forViewer<T extends VehicleViewDto>(ctx: RequestContext, dto: T): T {
    if (!ctx.isDriverOnly) return dto;
    return {
      ...dto,
      vin: null,
      commissioningDate: null,
      departmentId: null,
      ownershipMode: null,
      contractSupplierId: null,
      contractEndDate: null,
      notes: null,
      currentUsage: dto.currentUsage && dto.currentUsage.driverId === ctx.driverId ? dto.currentUsage : null,
    };
  }

  async synthesis(ctx: RequestContext, id: string): Promise<VehicleSynthesisDto> {
    const v = await this.load(ctx, id);
    const now = this.clock.now();
    const [assignment, lastLocation, lastReading, segment, plans, docsVersions, docTypes, openIncidents, pendingReadings, photos] = await Promise.all([
      this.prisma.client.vehicleResponsibleAssignment.findFirst({ where: { vehicleId: id, ...currentAssignmentWhere(now) }, include: { driver: { select: { firstName: true, lastName: true } } }, orderBy: { startsAt: 'desc' } }),
      this.prisma.client.vehicleLocationReport.findFirst({ where: { vehicleId: id }, orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }], include: { site: { select: { name: true } } } }),
      this.prisma.client.odometerReading.findFirst({ where: { vehicleId: id, status: 'ACCEPTE' }, orderBy: [{ observedAt: 'desc' }, { enteredAt: 'desc' }] }),
      this.prisma.client.odometerSegment.findFirst({ where: { vehicleId: id, endedAt: null } }),
      this.prisma.client.vehicleMaintenancePlan.findMany({ where: { vehicleId: id, active: true }, include: { maintenanceType: { select: { label: true } } } }),
      this.prisma.client.documentVersion.findMany({ where: { vehicleId: id, archivedAt: null }, select: { id: true, documentTypeId: true, validTo: true, validFrom: true } }),
      this.prisma.client.documentType.findMany({ where: { organizationId: ctx.organizationId, ownerType: 'VEHICULE', status: 'ACTIF' }, select: { id: true, ownerType: true, required: true, blocksCheckout: true, hasExpiry: true, noticeDays: true, vehicleCategoryIds: true, companyIds: true } }),
      this.prisma.client.incident.count({ where: { vehicleId: id, status: { in: ['OUVERT', 'EN_TRAITEMENT'] } } }),
      this.prisma.client.odometerReading.count({ where: { vehicleId: id, status: 'EN_ATTENTE' } }),
      this.prisma.client.attachment.findMany({ where: { ownerType: 'VEHICULE', ownerId: id, deletedAt: null }, select: { id: true } }),
    ]);
    const staleAfterDays = await this.settings.get(ctx.organizationId, 'odometer.staleAfterDays', v.companyId);
    const freshness = computeFreshness(lastReading?.observedAt ?? null, now, staleAfterDays);
    // Dernière localisation déclarée par la société précédente d'un véhicule transféré : visible sans auteur
    // ni commentaire (D-123) ; l'auteur n'est jamais révélé hors de sa société.
    const lastLocationShown = lastLocation && !this.locationReportReadable(ctx, v, lastLocation.companyId) ? { ...lastLocation, createdById: null, comment: null } : lastLocation;
    const authorIds = [lastLocationShown?.createdById].filter((x): x is string => Boolean(x));
    const authors = authorIds.length ? await this.prisma.client.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, firstName: true, lastName: true } }) : [];
    // Conformité documentaire : règle unique de document-status.ts, au jour local du groupe (7.1).
    const org = await this.prisma.client.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } });
    const today = localDate(now, org.timezone);
    const compliance = { blocking: 0, missing: 0, expired: 0, expiringSoon: 0 };
    for (const type of docTypes) {
      if (!isDocumentTypeApplicable(type, { ownerType: 'VEHICULE', companyId: v.companyId, categoryId: v.categoryId })) continue;
      const versions = docsVersions.filter((d) => d.documentTypeId === type.id).map((d) => ({ id: d.id, validFrom: fromDbDate(d.validFrom), validTo: fromDbDate(d.validTo) }));
      const result = computeDocumentStatus(type, versions, today);
      if (result.status === 'MANQUANT') compliance.missing += 1;
      if (result.status === 'EXPIRE') compliance.expired += 1;
      if (result.status === 'A_RENOUVELER') compliance.expiringSoon += 1;
      if (result.blocksCheckout && (result.status === 'MANQUANT' || result.status === 'EXPIRE')) compliance.blocking += 1;
    }
    const synthesis: VehicleSynthesisDto = {
      ...this.view(v),
      responsible: assignment ? { assignmentId: assignment.id, driverId: assignment.driverId, driverName: `${assignment.driver.firstName} ${assignment.driver.lastName}`, since: assignment.startsAt.toISOString() } : null,
      lastLocation: lastLocationShown ? this.locationView(lastLocationShown, authors) : null,
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
    if (!ctx.isDriverOnly) return synthesis;
    // Conducteur (D-116) : ni responsable habituel d'autrui, ni plans, ni conformité interne, ni incidents
    // ou relevés d'autrui, ni photos de gestion, ni jeton QR ; localisation sans auteur ni commentaire.
    return {
      ...this.forViewer(ctx, synthesis),
      responsible: synthesis.responsible && synthesis.responsible.driverId === ctx.driverId ? synthesis.responsible : null,
      lastLocation: synthesis.lastLocation ? { ...synthesis.lastLocation, createdById: null, createdByName: null, comment: null } : null,
      upcomingMaintenance: [],
      documentCompliance: null,
      openIncidents: null,
      pendingReadings: null,
      photoAttachmentIds: [],
      qrToken: null,
    };
  }

  async create(ctx: RequestContext, dto: CreateVehicleDto): Promise<VehicleViewDto> {
    this.access.requireOperational(ctx, dto.companyId);
    await this.assertReferences(ctx, dto.companyId, dto.categoryId, dto.siteId ?? null, dto.departmentId ?? null, dto.contractSupplierId ?? null);
    const data = this.buildCreateData(ctx, dto);
    try {
      const created = await this.prisma.client.$transaction((tx) => this.insertInTx(tx, ctx, data, 'création du dossier'));
      return this.view(created);
    } catch (error) {
      throw this.mapUnique(error);
    }
  }

  /** Données d'un nouveau dossier (formulaire ou import) : immatriculation normalisée, VIN normalisé, jeton QR. */
  buildCreateData(ctx: RequestContext, dto: CreateVehicleDto): Prisma.VehicleUncheckedCreateInput {
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
    return data;
  }

  /**
   * Écriture d'un nouveau dossier dans une transaction existante (formulaire ou import, 12.1) :
   * fiche, historique de société et audit. Les contrôles de périmètre et de références sont faits par
   * l'appelant ; les violations d'unicité remontent telles quelles (voir mapUnique).
   */
  async insertInTx(tx: Tx, ctx: RequestContext, data: Prisma.VehicleUncheckedCreateInput, reason: string): Promise<VehicleRow> {
    const v = await tx.vehicle.create({ data, include: vehicleInclude });
    await tx.vehicleCompanyHistory.create({ data: { organizationId: ctx.organizationId, vehicleId: v.id, fromCompanyId: null, toCompanyId: v.companyId, effectiveAt: this.clock.now(), reason, createdById: ctx.userId } });
    await this.audit.record(ctx, { action: 'vehicule.creation', objectType: 'Vehicle', objectId: v.id, companyId: v.companyId, reason, after: this.view(v) }, tx);
    return v;
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
    const now = this.clock.now();
    const updated = await this.prisma.serializable(async (tx) => {
      // Verrou du véhicule, puis version et statut contrôlés sur l'état verrouillé (CDC 13.3).
      await lockVehicle(tx, id);
      const locked = await tx.vehicle.findUniqueOrThrow({ where: { id }, select: { version: true, lifecycleStatus: true } });
      assertExpectedVersion(locked, dto.expectedVersion, 'véhicule');
      if (locked.lifecycleStatus === target) throw new BusinessRuleError('STATUT_INCHANGE', 'Le véhicule est déjà dans ce statut.');
      if (locked.lifecycleStatus === 'ARCHIVE') throw new BusinessRuleError('VEHICULE_ARCHIVE', 'Un véhicule archivé ne change plus de statut.');
      if (target === 'CEDE' || target === 'ARCHIVE') await this.assertNoOpenOperations(tx, id, target);
      const v = await tx.vehicle.update({
        where: { id, version: locked.version },
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
        // Affectation habituelle : clôture de l'affectation en cours (même avec une fin future) et retrait des affectations à venir.
        const exitLabel = target === 'CEDE' ? 'cédé' : 'archivé';
        const assignments = await closeAssignmentsOnVehicleExit(tx, id, now, `véhicule ${exitLabel}`, ctx.userId);
        for (const a of assignments.closed) {
          await this.audit.record(ctx, { action: 'responsable_habituel.fin', objectType: 'VehicleResponsibleAssignment', objectId: a.id, companyId: a.companyId, reason: `véhicule ${exitLabel} : ${dto.reason}`, before: { endsAt: a.endsAt }, after: { endsAt: now } }, tx);
        }
        for (const a of assignments.withdrawn) {
          await this.audit.record(ctx, { action: 'responsable_habituel.retrait', objectType: 'VehicleResponsibleAssignment', objectId: a.id, companyId: a.companyId, reason: `véhicule ${exitLabel} : ${dto.reason}`, before: { driverId: a.driverId, startsAt: a.startsAt, endsAt: a.endsAt } }, tx);
        }
        await tx.vehicleMaintenancePlan.updateMany({ where: { vehicleId: id, active: true }, data: { active: false, deactivatedAt: now, deactivationReason: 'véhicule sorti du parc' } });
        // D-175 : l'association télématique ouverte est clôturée à la date de l'opération.
        await closeOpenMappingsForVehicle(tx, { organizationId: ctx.organizationId, vehicleId: id, at: now, reason: `Véhicule ${target === 'CEDE' ? 'cédé' : 'archivé'}.`, userId: ctx.userId });
      }
      await this.audit.record(ctx, { action: 'vehicule.cycle_de_vie', objectType: 'Vehicle', objectId: id, companyId: v.companyId, reason: dto.reason, before: { lifecycleStatus: locked.lifecycleStatus }, after: { lifecycleStatus: target } }, tx);
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
      // Société à la date d'observation (D-121).
      const companyId = await eventCompany(tx, this.access, ctx, v, observedAt, 'une localisation');
      const r = await tx.vehicleLocationReport.create({
        data: { organizationId: ctx.organizationId, companyId, vehicleId, siteId: dto.siteId ?? null, placeLabel: dto.placeLabel?.trim() ?? null, observedAt, comment: dto.comment ?? null, context: 'DECLARATION', createdById: ctx.userId },
        include: { site: { select: { name: true } } },
      });
      await this.audit.record(ctx, { action: 'vehicule.localisation_declaree', objectType: 'VehicleLocationReport', objectId: r.id, companyId, after: { vehicleId, siteId: r.siteId, placeLabel: r.placeLabel, observedAt } }, tx);
      return r;
    });
    return this.locationView(report, [{ id: ctx.userId, firstName: ctx.displayName, lastName: '' }]);
  }

  async listLocationReports(ctx: RequestContext, vehicleId: string, query: { page: number; pageSize: number }): Promise<Page<LocationReportViewDto>> {
    const v = await this.load(ctx, vehicleId);
    // Chaque déclaration garde sa société historique (2.4, D-123) : après un transfert, la société
    // destinataire ne voit pas l'historique (auteurs, commentaires) de la société d'origine, et inversement.
    const where: Prisma.VehicleLocationReportWhereInput = { vehicleId, ...(ctx.isAdmin ? {} : { companyId: ctx.isDriverOnly ? v.companyId : { in: [...ctx.visibleCompanyIds] } }) };
    const [items, total] = await Promise.all([
      this.prisma.client.vehicleLocationReport.findMany({ where, ...skipTake(query), orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }], include: { site: { select: { name: true } } } }),
      this.prisma.client.vehicleLocationReport.count({ where }),
    ]);
    const authorIds = [...new Set(items.map((i) => i.createdById).filter((x): x is string => Boolean(x)))];
    const authors = authorIds.length ? await this.prisma.client.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, firstName: true, lastName: true } }) : [];
    return pageOf(items.map((r) => this.locationView(r, authors)), total, query);
  }

  /**
   * Enregistre une localisation issue d'une remise, restitution ou entrée au garage (appel interne, dans la
   * transaction de l'opération). D-134 : soit un site ACTIF de la société du véhicule, soit un lieu libre de
   * 1 à 200 caractères, exclusivement. Rien n'est ignoré silencieusement : un lieu absent, double ou
   * invalide lève une erreur 422 et annule l'opération.
   */
  async recordLocation(tx: Tx, ctx: RequestContext, vehicle: { id: string; companyId: string }, input: { siteId?: string | null; placeLabel?: string | null; observedAt: Date; context: 'REMISE' | 'RESTITUTION' | 'GARAGE' | 'TRANSFERT'; usageId?: string | null; comment?: string | null }): Promise<void> {
    const siteId = input.siteId ?? null;
    const placeLabel = input.placeLabel === undefined || input.placeLabel === null ? null : input.placeLabel.trim();
    if (!siteId && !placeLabel) {
      throw new BusinessRuleError('LIEU_REQUIS', 'Le lieu est obligatoire : indiquez un site ou un lieu libre.', { fieldErrors: { 'location.placeLabel': ['Site ou lieu requis.'] } });
    }
    if (siteId && placeLabel !== null) {
      throw new BusinessRuleError('LIEU_EXCLUSIF', 'Indiquez soit un site, soit un lieu libre, pas les deux.', { fieldErrors: { 'location.siteId': ['Site ou lieu libre, pas les deux.'] } });
    }
    if (placeLabel !== null && (placeLabel.length === 0 || placeLabel.length > 200)) {
      throw new BusinessRuleError('LIEU_INVALIDE', 'Le lieu libre doit comporter de 1 à 200 caractères.', { fieldErrors: { 'location.placeLabel': ['De 1 à 200 caractères.'] } });
    }
    if (siteId) {
      const site = await tx.site.findFirst({ where: { id: siteId, organizationId: ctx.organizationId, companyId: vehicle.companyId }, select: { status: true } });
      if (!site) throw new BusinessRuleError('SITE_INVALIDE', 'Site introuvable pour la société du véhicule.', { fieldErrors: { 'location.siteId': ['Site introuvable pour la société du véhicule.'] } });
      if (site.status !== 'ACTIF') throw new BusinessRuleError('SITE_INVALIDE', 'Ce site est archivé : choisissez un site actif ou saisissez un lieu libre.', { fieldErrors: { 'location.siteId': ['Site archivé.'] } });
    }
    await tx.vehicleLocationReport.create({
      data: { organizationId: ctx.organizationId, companyId: vehicle.companyId, vehicleId: vehicle.id, siteId, placeLabel, observedAt: input.observedAt, comment: input.comment ?? null, context: input.context, usageId: input.usageId ?? null, createdById: ctx.userId },
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

  /**
   * Même contrôle de visibilité que load (404 hors organisation ou hors périmètre), sans les relations de la
   * fiche : une seule lecture pour le personnel, qui n'a besoin que de la société et du code (mutations).
   */
  async loadRef(ctx: RequestContext, id: string): Promise<{ id: string; organizationId: string; companyId: string; code: string }> {
    if (ctx.isDriverOnly) {
      const v = await this.load(ctx, id);
      return { id: v.id, organizationId: v.organizationId, companyId: v.companyId, code: v.code };
    }
    const v = await this.prisma.client.vehicle.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { id: true, organizationId: true, companyId: true, code: true } });
    if (!v) throw new NotFoundOrOutOfScopeError('Véhicule');
    this.access.assertCompanyReadable(ctx, v.companyId);
    return v;
  }

  private async assertVisible(ctx: RequestContext, v: VehicleRow): Promise<void> {
    if (ctx.isDriverOnly) {
      if (!ctx.driverId) throw new NotFoundOrOutOfScopeError('Véhicule');
      if (v.usages.some((u) => u.driverId === ctx.driverId)) return;
      // Responsable habituel EN_COURS uniquement (jamais une affectation à venir ou terminée).
      const responsible = await this.prisma.client.vehicleResponsibleAssignment.findFirst({ where: { vehicleId: v.id, driverId: ctx.driverId, ...currentAssignmentWhere(this.clock.now()) }, select: { id: true } });
      if (!responsible) throw new NotFoundOrOutOfScopeError('Véhicule');
      return;
    }
    this.access.assertCompanyReadable(ctx, v.companyId);
  }

  /**
   * Opérations ouvertes qui bloquent la cession ou l'archivage (CDC 3.2, D-129), lues dans la transaction
   * de l'appelant APRÈS le verrou du véhicule : une remise concurrente ne peut pas s'intercaler.
   * Pour l'archivage, un incident OUVERT ou EN_TRAITEMENT bloque aussi.
   */
  async assertNoOpenOperations(tx: Tx, vehicleId: string, target: 'CEDE' | 'ARCHIVE'): Promise<void> {
    const now = this.clock.now();
    const [usages, immobilizations, interventions, reservations, incidents] = await Promise.all([
      tx.vehicleUsage.count({ where: { vehicleId, status: 'EN_COURS' } }),
      tx.immobilization.count({ where: { vehicleId, status: 'ACTIVE' } }),
      tx.intervention.count({ where: { vehicleId, status: { in: ['BROUILLON', 'PLANIFIEE', 'EN_COURS'] } } }),
      tx.reservation.count({ where: { vehicleId, status: 'CONFIRMEE', endAt: { gt: now } } }),
      target === 'ARCHIVE' ? tx.incident.count({ where: { vehicleId, status: { in: ['OUVERT', 'EN_TRAITEMENT'] } } }) : Promise.resolve(0),
    ]);
    const blockers = { usages, immobilizations, interventions, reservations, incidents };
    if (usages + immobilizations + interventions + reservations + incidents > 0) {
      throw new BusinessRuleError('OPERATIONS_OUVERTES', 'Opération refusée : des utilisations, immobilisations, interventions, réservations futures ou incidents sont encore ouverts.', { details: blockers });
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

  /** Traduit une violation d'unicité (code, immatriculation, VIN) en conflit métier lisible. */
  mapUnique(error: unknown): unknown {
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

  /** Déclaration de localisation lisible avec son auteur : société de la déclaration dans le périmètre (société courante pour un conducteur). */
  private locationReportReadable(ctx: RequestContext, v: { companyId: string }, reportCompanyId: string): boolean {
    return ctx.isDriverOnly ? reportCompanyId === v.companyId : this.access.canReadCompany(ctx, reportCompanyId);
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
