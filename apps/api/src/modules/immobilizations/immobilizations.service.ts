import { Injectable } from '@nestjs/common';
import type { ImmobilizationCauseKind, Prisma } from '@parc-auto/db';
import { AfterCommit } from '../../common/after-commit.js';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, ConflictError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import { type Page, pageOf, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import { CAUSE_DURATIONS_NOTE, immobilizationDurations } from '../../domain/immobilization-duration.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, isConstraintViolation, isUniqueViolation, type Tx } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { AlertsService } from '../alerts/alerts.service.js';
import { lockVehicle } from '../odometer/odometer-ingestion.service.js';
import { SuppliersService } from '../suppliers/suppliers.service.js';
import { VehiclesService } from '../vehicles/vehicles.service.js';
import type { AddCauseDto, CreateImmobilizationDto, EndCauseDto, ImmobilizationViewDto, ImmobilizationsQueryDto, UpdateImmobilizationDto } from './dto/immobilizations.dto.js';

const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const immobilizationInclude = {
  vehicle: { select: { code: true, registration: true } },
  site: { select: { name: true } },
  garageSupplier: { select: { name: true } },
  causes: {
    orderBy: { startedAt: 'asc' },
    include: { incident: { select: { reference: true } }, intervention: { select: { reference: true } } },
  },
} satisfies Prisma.ImmobilizationInclude;

type ImmobilizationRow = Prisma.ImmobilizationGetPayload<{ include: typeof immobilizationInclude }>;

/** Lieu reçu d'un formulaire : undefined = non fourni ; null = effacé (modification). */
export interface PlaceInput {
  siteId?: string | null;
  garageSupplierId?: string | null;
  locationLabel?: string | null;
}

interface ValidatedPlace {
  siteId: string | null;
  garageSupplierId: string | null;
  locationLabel: string | null;
  /** Libellé du lieu pour la localisation du véhicule (garage : « Garage <nom> »). */
  placeLabel: string | null;
}

export interface OpenCauseInput {
  vehicle: { id: string; companyId: string; code: string };
  kind: ImmobilizationCauseKind;
  reason: string;
  incidentId?: string | null;
  interventionId?: string | null;
  startedAt: Date;
  expectedEndAt?: Date | null;
  place?: PlaceInput;
  /**
   * Ajout de cause sur une immobilisation désignée (POST /immobilizations/:id/causes) : elle doit être
   * l'immobilisation ACTIVE du véhicule et à la version attendue, relues sous verrou dans la transaction.
   */
  target?: { immobilizationId: string; expectedVersion: number };
}

export interface OpenCauseResult {
  immobilizationId: string;
  causeId: string;
  /** Vrai si une nouvelle immobilisation a été ouverte ; faux si la cause complète l'immobilisation active. */
  created: boolean;
  /** Lieu fourni appliqué à l'immobilisation (création, ou remplacement explicite sur l'immobilisation active). */
  placeApplied: boolean;
  /** Fin prévue fournie appliquée à l'immobilisation (même règle). */
  expectedEndApplied: boolean;
}

/**
 * Immobilisations (CDC 7.4, D-220) : une seule immobilisation ACTIVE par véhicule, qui regroupe les
 * causes simultanées ; une même source n'a qu'une cause ouverte ; la fin de la dernière cause termine
 * l'immobilisation dans la même transaction ; la disponibilité n'est rétablie qu'ensuite. Pendant une
 * utilisation, les deux événements sont conservés, le chef est prévenu et le retour reste possible (4.5).
 */
@Injectable()
export class ImmobilizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly vehicles: VehiclesService,
    private readonly suppliers: SuppliersService,
    private readonly alerts: AlertsService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async list(ctx: RequestContext, query: ImmobilizationsQueryDto): Promise<Page<ImmobilizationViewDto>> {
    this.access.requireStaff(ctx);
    const where: Prisma.ImmobilizationWhereInput = {
      ...this.access.companyWhere(ctx, query.companyId),
      ...(query.vehicleId ? { vehicleId: query.vehicleId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.client.immobilization.findMany({ where, include: immobilizationInclude, ...skipTake(query), orderBy: [{ status: 'asc' }, { startedAt: 'desc' }] }),
      this.prisma.client.immobilization.count({ where }),
    ]);
    return pageOf(await this.views(items), total, query);
  }

  async get(ctx: RequestContext, id: string): Promise<ImmobilizationViewDto> {
    const [view] = await this.views([await this.load(ctx, id)]);
    if (!view) throw new NotFoundOrOutOfScopeError('Immobilisation');
    return view;
  }

  async create(ctx: RequestContext, dto: CreateImmobilizationDto): Promise<ImmobilizationViewDto> {
    const vehicle = await this.vehicles.load(ctx, dto.vehicleId);
    this.access.requireOperational(ctx, vehicle.companyId);
    if (vehicle.lifecycleStatus === 'CEDE' || vehicle.lifecycleStatus === 'ARCHIVE') throw new BusinessRuleError('VEHICULE_INACTIF', 'Un véhicule cédé ou archivé ne peut pas être immobilisé.');
    const kind = await this.resolveKind(ctx, vehicle.id, dto.incidentId, dto.interventionId);
    const startedAt = this.startDate(dto.startedAt);
    const after = new AfterCommit();
    const id = await this.prisma.serializable(async (tx) => {
      const r = await this.openCause(tx, ctx, { vehicle, kind, reason: dto.reason, incidentId: dto.incidentId ?? null, interventionId: dto.interventionId ?? null, startedAt, expectedEndAt: dto.expectedEndAt ? new Date(dto.expectedEndAt) : null, place: dto }, after);
      return r.immobilizationId;
    });
    await after.run();
    return this.get(ctx, id);
  }

  async addCause(ctx: RequestContext, id: string, dto: AddCauseDto): Promise<ImmobilizationViewDto> {
    const current = await this.load(ctx, id);
    this.access.requireOperational(ctx, current.companyId);
    assertExpectedVersion(current, dto.expectedVersion, 'immobilisation');
    if (current.status !== 'ACTIVE') throw new ConflictError('ETAT_INVALIDE', 'Cette immobilisation est terminée : créez-en une nouvelle.');
    const kind = await this.resolveKind(ctx, current.vehicleId, dto.incidentId, dto.interventionId);
    const startedAt = this.startDate(dto.startedAt);
    const after = new AfterCommit();
    await this.prisma.serializable(async (tx) => {
      await this.openCause(tx, ctx, { vehicle: { id: current.vehicleId, companyId: current.companyId, code: current.vehicle.code }, kind, reason: dto.reason, incidentId: dto.incidentId ?? null, interventionId: dto.interventionId ?? null, startedAt, target: { immobilizationId: id, expectedVersion: dto.expectedVersion } }, after);
    });
    await after.run();
    return this.get(ctx, id);
  }

  async endCause(ctx: RequestContext, id: string, causeId: string, dto: EndCauseDto): Promise<ImmobilizationViewDto> {
    const current = await this.load(ctx, id);
    this.access.requireOperational(ctx, current.companyId);
    assertExpectedVersion(current, dto.expectedVersion, 'immobilisation');
    const cause = current.causes.find((c) => c.id === causeId);
    if (!cause) throw new NotFoundOrOutOfScopeError('Cause d’immobilisation');
    if (cause.endedAt) throw new ConflictError('CAUSE_DEJA_TERMINEE', 'Cette cause est déjà terminée.');
    const endedAt = this.endDate(dto.endedAt, cause.startedAt);
    const after = new AfterCommit();
    await this.prisma.serializable(async (tx) => {
      await lockVehicle(tx, current.vehicleId);
      await this.assertVersionInTx(tx, current.id, dto.expectedVersion);
      await this.closeCauses(tx, ctx, current.id, [causeId], endedAt, dto.reason, after);
    });
    await after.run();
    return this.get(ctx, id);
  }

  /** Fin de l'immobilisation : termine toutes les causes ouvertes (7.4 : remise en disponibilité). */
  async end(ctx: RequestContext, id: string, dto: EndCauseDto): Promise<ImmobilizationViewDto> {
    const current = await this.load(ctx, id);
    this.access.requireOperational(ctx, current.companyId);
    assertExpectedVersion(current, dto.expectedVersion, 'immobilisation');
    if (current.status !== 'ACTIVE') throw new ConflictError('ETAT_INVALIDE', 'Cette immobilisation est déjà terminée.');
    const open = current.causes.filter((c) => !c.endedAt);
    const latestStart = open.reduce((max, c) => (c.startedAt > max ? c.startedAt : max), current.startedAt);
    const endedAt = this.endDate(dto.endedAt, latestStart);
    const after = new AfterCommit();
    await this.prisma.serializable(async (tx) => {
      await lockVehicle(tx, current.vehicleId);
      // Version inchangée depuis la lecture : aucune cause n'a été ajoutée ou terminée entre-temps.
      await this.assertVersionInTx(tx, current.id, dto.expectedVersion);
      await this.closeCauses(tx, ctx, current.id, open.map((c) => c.id), endedAt, dto.reason, after);
    });
    await after.run();
    return this.get(ctx, id);
  }

  async update(ctx: RequestContext, id: string, dto: UpdateImmobilizationDto): Promise<ImmobilizationViewDto> {
    const current = await this.load(ctx, id);
    this.access.requireOperational(ctx, current.companyId);
    assertExpectedVersion(current, dto.expectedVersion, 'immobilisation');
    if (current.status !== 'ACTIVE') throw new ConflictError('ETAT_INVALIDE', 'Une immobilisation terminée ne se modifie pas.');
    const place = await this.validatePlace(ctx, current.companyId, dto, current);
    const expectedEndAt = dto.expectedEndAt ? new Date(dto.expectedEndAt) : null;
    if (expectedEndAt) this.assertExpectedEnd(expectedEndAt, current.startedAt);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.immobilization.update({
        where: { id, version: dto.expectedVersion },
        data: {
          ...(dto.expectedEndAt !== undefined ? { expectedEndAt } : {}),
          ...(place ? { siteId: place.siteId, garageSupplierId: place.garageSupplierId, locationLabel: place.locationLabel } : {}),
          version: { increment: 1 },
        },
      });
      await this.audit.record(ctx, { action: 'immobilisation.modification', objectType: 'Immobilization', objectId: id, companyId: current.companyId, before: { expectedEndAt: current.expectedEndAt, siteId: current.siteId, garageSupplierId: current.garageSupplierId, locationLabel: current.locationLabel }, after: dto }, tx);
    });
    return this.get(ctx, id);
  }

  // ---------------------------------------------------------------------------
  // Opérations transactionnelles réutilisées par les interventions et les incidents
  // ---------------------------------------------------------------------------

  /**
   * Ouvre une cause : rattachée à l'immobilisation active du véhicule, ou dans une nouvelle
   * immobilisation. Le véhicule est verrouillé. Une même source ne peut avoir deux causes ouvertes.
   * Lieu et fin prévue fournis ne sont jamais ignorés : ils initialisent la nouvelle immobilisation ou
   * remplacent explicitement ceux de l'immobilisation active (valeurs avant/après auditées).
   */
  async openCause(tx: Tx, ctx: RequestContext, input: OpenCauseInput, after: AfterCommit): Promise<OpenCauseResult> {
    await lockVehicle(tx, input.vehicle.id);
    const existing = await tx.immobilization.findFirst({ where: { vehicleId: input.vehicle.id, status: 'ACTIVE' } });
    if (input.target) {
      // Immobilisation terminée entre-temps : la cause ne rejoint jamais silencieusement une autre immobilisation.
      if (!existing || existing.id !== input.target.immobilizationId) throw new ConflictError('ETAT_INVALIDE', 'Cette immobilisation est terminée : créez-en une nouvelle.');
      assertExpectedVersion(existing, input.target.expectedVersion, 'immobilisation');
    }
    const validated = input.place ? await this.validatePlace(ctx, input.vehicle.companyId, input.place, existing ?? undefined) : null;
    // Ouverture de cause : seul un lieu renseigné s'applique (des champs vides n'effacent pas le lieu enregistré).
    const place = validated && (validated.siteId || validated.garageSupplierId || validated.locationLabel) ? validated : null;
    const expectedEndAt = input.expectedEndAt ?? null;
    if (expectedEndAt) this.assertExpectedEnd(expectedEndAt, existing && existing.startedAt < input.startedAt ? existing.startedAt : input.startedAt);
    let immobilization = existing;
    const created = !existing;
    try {
      if (!immobilization) {
        immobilization = await tx.immobilization.create({
          data: {
            organizationId: ctx.organizationId,
            companyId: input.vehicle.companyId,
            vehicleId: input.vehicle.id,
            startedAt: input.startedAt,
            expectedEndAt,
            ...(place ? { siteId: place.siteId, garageSupplierId: place.garageSupplierId, locationLabel: place.locationLabel } : {}),
            createdById: ctx.userId,
          },
        });
      } else {
        // Cause rétroactive : l'immobilisation commence au plus tôt de ses causes (sans chevauchement).
        immobilization = await tx.immobilization.update({
          where: { id: immobilization.id },
          data: {
            ...(input.startedAt < immobilization.startedAt ? { startedAt: input.startedAt } : {}),
            ...(place ? { siteId: place.siteId, garageSupplierId: place.garageSupplierId, locationLabel: place.locationLabel } : {}),
            ...(expectedEndAt ? { expectedEndAt } : {}),
            version: { increment: 1 },
          },
        });
      }
      const cause = await tx.immobilizationCause.create({
        data: {
          organizationId: ctx.organizationId,
          immobilizationId: immobilization.id,
          kind: input.kind,
          reason: input.reason.trim(),
          incidentId: input.incidentId ?? null,
          interventionId: input.interventionId ?? null,
          startedAt: input.startedAt,
          createdById: ctx.userId,
        },
      });
      const placeMoved = place !== null && (!existing || existing.siteId !== place.siteId || existing.garageSupplierId !== place.garageSupplierId || existing.locationLabel !== place.locationLabel);
      if (place && placeMoved && (place.siteId || place.placeLabel)) {
        await this.vehicles.recordLocation(tx, ctx, input.vehicle, { siteId: place.siteId, placeLabel: place.siteId ? null : place.placeLabel, observedAt: input.startedAt, context: 'GARAGE' });
      }
      const placeChange = place && existing ? { before: { siteId: existing.siteId, garageSupplierId: existing.garageSupplierId, locationLabel: existing.locationLabel }, after: { siteId: place.siteId, garageSupplierId: place.garageSupplierId, locationLabel: place.locationLabel } } : null;
      const expectedEndChange = expectedEndAt && existing ? { before: existing.expectedEndAt?.toISOString() ?? null, after: expectedEndAt.toISOString() } : null;
      await this.audit.record(
        ctx,
        {
          action: created ? 'immobilisation.debut' : 'immobilisation.cause_ajoutee',
          objectType: 'Immobilization',
          objectId: immobilization.id,
          companyId: input.vehicle.companyId,
          reason: input.reason,
          ...(existing ? { before: { expectedEndAt: existing.expectedEndAt?.toISOString() ?? null, siteId: existing.siteId, garageSupplierId: existing.garageSupplierId, locationLabel: existing.locationLabel } } : {}),
          after: { causeId: cause.id, kind: input.kind, incidentId: input.incidentId, interventionId: input.interventionId, startedAt: input.startedAt.toISOString(), placeChange, expectedEndChange },
        },
        tx,
      );
      const immobilizationId = immobilization.id;
      after.add('immobilisation → alertes', () => this.signalConflicts(immobilizationId));
      return { immobilizationId, causeId: cause.id, created, placeApplied: place !== null, expectedEndApplied: expectedEndAt !== null };
    } catch (error) {
      if (isUniqueViolation(error, 'immobilization_cause_one_open_per_incident') || isUniqueViolation(error, 'immobilization_cause_one_open_per_intervention')) {
        throw new ConflictError('CAUSE_EXISTANTE', 'Une cause ouverte existe déjà pour cette source.');
      }
      if (isConstraintViolation(error, 'immobilization_no_overlap')) {
        throw new ConflictError('IMMOBILISATION_CHEVAUCHEMENT', 'La période chevauche une immobilisation déjà enregistrée pour ce véhicule.');
      }
      throw error;
    }
  }

  /** Termine les causes ouvertes liées à une source (intervention ou incident) ; renvoie leur nombre. */
  async endCausesForSource(tx: Tx, ctx: RequestContext, source: { interventionId?: string; incidentId?: string }, endedAt: Date, reason: string, after: AfterCommit): Promise<number> {
    const causes = await tx.immobilizationCause.findMany({ where: { organizationId: ctx.organizationId, endedAt: null, ...(source.interventionId ? { interventionId: source.interventionId } : { incidentId: source.incidentId }) }, include: { immobilization: { select: { vehicleId: true } } } });
    const byImmobilization = new Map<string, string[]>();
    for (const c of causes) {
      if (endedAt < c.startedAt) throw new BusinessRuleError('FIN_AVANT_DEBUT', 'La fin de la cause d’immobilisation précède son début.');
      byImmobilization.set(c.immobilizationId, [...(byImmobilization.get(c.immobilizationId) ?? []), c.id]);
    }
    for (const [immobilizationId, ids] of byImmobilization) {
      const vehicleId = causes.find((c) => c.immobilizationId === immobilizationId)?.immobilization.vehicleId;
      if (vehicleId) await lockVehicle(tx, vehicleId);
      await this.closeCauses(tx, ctx, immobilizationId, ids, endedAt, reason, after);
    }
    return causes.length;
  }

  private async closeCauses(tx: Tx, ctx: RequestContext, immobilizationId: string, causeIds: string[], endedAt: Date, reason: string, after: AfterCommit): Promise<void> {
    if (causeIds.length === 0) return;
    await tx.immobilizationCause.updateMany({ where: { id: { in: causeIds }, endedAt: null }, data: { endedAt, endedById: ctx.userId, endReason: reason.trim() } });
    const remaining = await tx.immobilizationCause.count({ where: { immobilizationId, endedAt: null } });
    const immobilization = await tx.immobilization.findUniqueOrThrow({ where: { id: immobilizationId } });
    if (remaining === 0) {
      const last = await tx.immobilizationCause.aggregate({ where: { immobilizationId }, _max: { endedAt: true } });
      const finalEnd = last._max.endedAt ?? endedAt;
      try {
        await tx.immobilization.update({ where: { id: immobilizationId }, data: { status: 'TERMINEE', endedAt: finalEnd, endedById: ctx.userId, version: { increment: 1 } } });
      } catch (error) {
        if (isConstraintViolation(error, 'immobilization_no_overlap')) throw new ConflictError('IMMOBILISATION_CHEVAUCHEMENT', 'La période chevauche une autre immobilisation du véhicule.');
        throw error;
      }
      await this.audit.record(ctx, { action: 'immobilisation.fin', objectType: 'Immobilization', objectId: immobilizationId, companyId: immobilization.companyId, reason, after: { endedAt: finalEnd.toISOString(), causes: causeIds } }, tx);
      after.add('fin d’immobilisation → alertes', () => this.resolveConflicts(immobilizationId, immobilization.vehicleId, immobilization.organizationId));
    } else {
      await tx.immobilization.update({ where: { id: immobilizationId }, data: { version: { increment: 1 } } });
      await this.audit.record(ctx, { action: 'immobilisation.cause_terminee', objectType: 'Immobilization', objectId: immobilizationId, companyId: immobilization.companyId, reason, after: { endedAt: endedAt.toISOString(), causes: causeIds, remaining } }, tx);
    }
  }

  /**
   * Utilisation en cours et réservations des prochaines 24 h pendant une immobilisation active :
   * le chef est prévenu (4.5), les réservations sont signalées compromises. Idempotent.
   */
  async signalConflicts(immobilizationId: string): Promise<void> {
    const immo = await this.prisma.client.immobilization.findUniqueOrThrow({ where: { id: immobilizationId }, include: { vehicle: { select: { code: true } } } });
    if (immo.status !== 'ACTIVE') return;
    const usage = await this.prisma.client.vehicleUsage.findFirst({ where: { vehicleId: immo.vehicleId, status: 'EN_COURS' }, include: { driver: { select: { firstName: true, lastName: true } } } });
    if (usage) {
      await this.alerts.raise({
        organizationId: immo.organizationId,
        companyId: usage.companyId,
        type: 'IMMOBILISATION_PENDANT_UTILISATION',
        severity: 'URGENT',
        objectType: 'VehicleUsage',
        objectId: usage.id,
        vehicleId: immo.vehicleId,
        occurrenceKey: immo.id,
        title: `Immobilisation pendant une utilisation — ${immo.vehicle.code}`,
        message: `Le véhicule est immobilisé alors que ${usage.driver.firstName} ${usage.driver.lastName} l’utilise. L’utilisation reste ouverte ; enregistrez la restitution.`,
        condition: { immobilizationId: immo.id, usageId: usage.id },
        actionPath: `/utilisations/${usage.id}`,
      });
    }
    const now = this.clock.now();
    const horizon = new Date(now.getTime() + 24 * 3_600_000);
    const reservations = await this.prisma.client.reservation.findMany({
      where: { vehicleId: immo.vehicleId, status: 'CONFIRMEE', endAt: { gt: now }, startAt: { lte: horizon } },
      include: { driver: { select: { firstName: true, lastName: true } } },
    });
    for (const r of reservations) {
      await this.alerts.raise({
        organizationId: r.organizationId,
        companyId: r.companyId,
        type: 'RESERVATION_COMPROMISE',
        severity: r.startAt <= now ? 'CRITIQUE' : 'URGENT',
        objectType: 'Reservation',
        objectId: r.id,
        vehicleId: r.vehicleId,
        occurrenceKey: `immobilisation:${immo.id}`,
        title: `Réservation compromise — ${immo.vehicle.code}`,
        message: `La réservation de ${r.driver.firstName} ${r.driver.lastName} (${r.startAt.toISOString()}) est compromise : le véhicule est immobilisé.`,
        condition: { immobilizationId: immo.id, reservationId: r.id, reservationStartAt: r.startAt.toISOString() },
        actionPath: `/planning?reservation=${r.id}`,
      });
    }
  }

  /** Rattrapage : réévalue toutes les immobilisations actives (réservations entrant dans l'horizon). */
  async evaluateActive(organizationId?: string): Promise<number> {
    const active = await this.prisma.client.immobilization.findMany({ where: { status: 'ACTIVE', ...(organizationId ? { organizationId } : {}) }, select: { id: true } });
    for (const a of active) await this.signalConflicts(a.id);
    return active.length;
  }

  private async resolveConflicts(immobilizationId: string, vehicleId: string, organizationId: string): Promise<void> {
    const alerts = await this.prisma.client.alert.findMany({
      where: { organizationId, vehicleId, status: 'ACTIVE', type: { in: ['IMMOBILISATION_PENDANT_UTILISATION', 'RESERVATION_COMPROMISE'] }, condition: { path: ['immobilizationId'], equals: immobilizationId } },
      select: { id: true },
    });
    if (alerts.length) await this.prisma.client.alert.updateMany({ where: { id: { in: alerts.map((a) => a.id) } }, data: { status: 'RESOLUE', resolvedAt: this.clock.now(), resolutionReason: 'fin d’immobilisation' } });
  }

  // ---------------------------------------------------------------------------

  async load(ctx: RequestContext, id: string): Promise<ImmobilizationRow> {
    const row = await this.prisma.client.immobilization.findFirst({ where: { id, organizationId: ctx.organizationId }, include: immobilizationInclude });
    if (!row || ctx.isDriverOnly || !this.access.canReadCompany(ctx, row.companyId)) throw new NotFoundOrOutOfScopeError('Immobilisation');
    return row;
  }

  private async resolveKind(ctx: RequestContext, vehicleId: string, incidentId?: string, interventionId?: string): Promise<ImmobilizationCauseKind> {
    if (incidentId && interventionId) throw new BusinessRuleError('SOURCE_UNIQUE', 'Une cause a une seule source : incident ou intervention.');
    if (incidentId) {
      const incident = await this.prisma.client.incident.findFirst({ where: { id: incidentId, organizationId: ctx.organizationId, vehicleId } });
      if (!incident || !this.access.canReadCompany(ctx, incident.companyId)) throw new NotFoundOrOutOfScopeError('Incident');
      return 'INCIDENT';
    }
    if (interventionId) {
      const intervention = await this.prisma.client.intervention.findFirst({ where: { id: interventionId, organizationId: ctx.organizationId, vehicleId } });
      if (!intervention || !this.access.canReadCompany(ctx, intervention.companyId)) throw new NotFoundOrOutOfScopeError('Intervention');
      if (intervention.status === 'TERMINEE' || intervention.status === 'ANNULEE') throw new BusinessRuleError('INTERVENTION_CLOSE', 'L’intervention est terminée ou annulée.');
      return 'INTERVENTION';
    }
    return 'AUTRE';
  }

  /**
   * Lieu d'immobilisation (7.4) : site, garage et lieu libre mutuellement exclusifs. Site : site ACTIF de
   * la société. Garage : fournisseur ACTIF de catégorie GARAGE de la même société (archivé : 422
   * FOURNISSEUR_ARCHIVE). Un site ou un garage inchangé par rapport à `current` reste accepté (historique).
   * Renvoie null si aucun champ de lieu n'est fourni.
   */
  private async validatePlace(ctx: RequestContext, companyId: string, place: PlaceInput, current?: { siteId: string | null; garageSupplierId: string | null }): Promise<ValidatedPlace | null> {
    if (place.siteId === undefined && place.garageSupplierId === undefined && place.locationLabel === undefined) return null;
    const siteId = place.siteId || null;
    const garageSupplierId = place.garageSupplierId || null;
    const locationLabel = place.locationLabel?.trim() || null;
    const chosen = { siteId, garageSupplierId, locationLabel };
    const filled = (Object.keys(chosen) as Array<keyof typeof chosen>).filter((k) => chosen[k] !== null);
    if (filled.length > 1) {
      const message = 'Un seul lieu : un site, un garage ou un lieu libre.';
      throw new BusinessRuleError('LIEU_EXCLUSIF', 'Indiquez un seul lieu d’immobilisation : un site, un garage ou un lieu libre.', { fieldErrors: Object.fromEntries(filled.map((k) => [k, [message]])) });
    }
    if (siteId && siteId !== current?.siteId) {
      const site = await this.prisma.client.site.findFirst({ where: { id: siteId, organizationId: ctx.organizationId, companyId, status: 'ACTIF' } });
      if (!site) throw new NotFoundOrOutOfScopeError('Site');
    }
    let placeLabel = locationLabel;
    if (garageSupplierId) {
      const garage =
        garageSupplierId === current?.garageSupplierId
          ? await this.prisma.client.supplier.findFirstOrThrow({ where: { id: garageSupplierId }, select: { name: true, category: true } })
          : await this.suppliers.requireUsable(ctx, garageSupplierId, companyId, 'garageSupplierId');
      if (garage.category !== 'GARAGE') {
        throw new BusinessRuleError('FOURNISSEUR_NON_GARAGE', `« ${garage.name} » n’est pas un garage : choisissez un fournisseur de catégorie Garage.`, { fieldErrors: { garageSupplierId: ['Fournisseur qui n’est pas un garage.'] } });
      }
      placeLabel = `Garage ${garage.name}`;
    }
    return { ...chosen, placeLabel };
  }

  /** Verrou optimiste relu dans la transaction (après le verrou du véhicule) : 409 VERSION_OBSOLETE. */
  private async assertVersionInTx(tx: Tx, id: string, expectedVersion: number): Promise<void> {
    const fresh = await tx.immobilization.findUniqueOrThrow({ where: { id }, select: { version: true } });
    assertExpectedVersion(fresh, expectedVersion, 'immobilisation');
  }

  /** Fin prévue postérieure au début de l'immobilisation. */
  private assertExpectedEnd(expectedEndAt: Date, startedAt: Date): void {
    if (expectedEndAt <= startedAt) {
      throw new BusinessRuleError('FIN_PREVUE_AVANT_DEBUT', 'La fin prévue doit être postérieure au début de l’immobilisation.', { fieldErrors: { expectedEndAt: ['Fin prévue antérieure ou égale au début.'] } });
    }
  }

  private startDate(value: string | undefined): Date {
    const now = this.clock.now();
    const startedAt = value ? new Date(value) : now;
    if (startedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
      throw new BusinessRuleError('DEBUT_FUTUR', 'Une immobilisation ne commence pas dans le futur : planifiez plutôt une intervention.', { fieldErrors: { startedAt: ['Date future refusée.'] } });
    }
    return startedAt;
  }

  private endDate(value: string | undefined, notBefore: Date): Date {
    const now = this.clock.now();
    const endedAt = value ? new Date(value) : now;
    if (endedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) throw new BusinessRuleError('FIN_FUTURE', 'La fin réelle ne peut pas être dans le futur.', { fieldErrors: { endedAt: ['Date future refusée.'] } });
    if (endedAt < notBefore) throw new BusinessRuleError('FIN_AVANT_DEBUT', 'La fin précède le début de la cause.', { fieldErrors: { endedAt: ['Fin antérieure au début.'] } });
    return endedAt;
  }

  /** Vues en lot (liste sans requête par ligne) : utilisations en cours chargées en une requête. */
  private async views(rows: readonly ImmobilizationRow[]): Promise<ImmobilizationViewDto[]> {
    const now = this.clock.now();
    const activeVehicleIds = [...new Set(rows.filter((i) => i.status === 'ACTIVE').map((i) => i.vehicleId))];
    const openUsages = activeVehicleIds.length ? await this.prisma.client.vehicleUsage.findMany({ where: { vehicleId: { in: activeVehicleIds }, status: 'EN_COURS' }, select: { id: true, vehicleId: true } }) : [];
    return rows.map((i) => {
      // Durées (D-219) : total = union des causes ; durée propre de chaque cause ; une décimale.
      const durations = immobilizationDurations(i.causes, now, { start: i.startedAt, end: i.endedAt });
      const byCause = new Map(durations.causes.map((c) => [c.id, c]));
      return {
        id: i.id,
        companyId: i.companyId,
        vehicleId: i.vehicleId,
        vehicleCode: i.vehicle.code,
        vehicleRegistration: i.vehicle.registration,
        status: i.status,
        startedAt: i.startedAt.toISOString(),
        expectedEndAt: i.expectedEndAt?.toISOString() ?? null,
        endedAt: i.endedAt?.toISOString() ?? null,
        siteId: i.siteId,
        siteName: i.site?.name ?? null,
        garageSupplierId: i.garageSupplierId,
        garageName: i.garageSupplier?.name ?? null,
        locationLabel: i.locationLabel,
        durationHours: durations.total.hours.toNumber(),
        durationDays: durations.total.days.toNumber(),
        causesOverlap: durations.causesOverlap,
        causeDurationsNote: CAUSE_DURATIONS_NOTE,
        openUsageId: i.status === 'ACTIVE' ? (openUsages.find((u) => u.vehicleId === i.vehicleId)?.id ?? null) : null,
        causes: i.causes.map((c) => ({
          id: c.id,
          kind: c.kind,
          reason: c.reason,
          incidentId: c.incidentId,
          incidentReference: c.incident?.reference ?? null,
          interventionId: c.interventionId,
          interventionReference: c.intervention?.reference ?? null,
          startedAt: c.startedAt.toISOString(),
          endedAt: c.endedAt?.toISOString() ?? null,
          endReason: c.endReason,
          durationHours: byCause.get(c.id)?.hours.toNumber() ?? 0,
          durationDays: byCause.get(c.id)?.days.toNumber() ?? 0,
        })),
        version: i.version,
      };
    });
  }
}
