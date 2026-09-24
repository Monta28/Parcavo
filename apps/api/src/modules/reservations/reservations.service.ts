import { Injectable } from '@nestjs/common';
import type { Driver, Prisma, Reservation, Vehicle } from '@parc-auto/db';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, ConflictError, ErrorCodes, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import { type Page, pageOf, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import {
  canDeclareNoShow,
  immobilizationSlot,
  interventionReservationOverlaps,
  interventionSlot,
  isInterventionLate,
  noShowAllowedFrom,
  reservationEditScope,
  type Slot,
  slotViolation,
  slotsOverlap,
  truncateToMinute,
} from '../../domain/reservation-rules.js';
import { isReturnLate, occupancyEnd } from '../../domain/usage-rules.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, isConstraintViolation, type Tx } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { AlertsService } from '../alerts/alerts.service.js';
import { DriversService } from '../drivers/drivers.service.js';
import { lockDriver, lockVehicle } from '../odometer/odometer-ingestion.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { DepartureChecksService, VEHICLE_NOT_ACTIVE } from '../usages/departure-checks.service.js';
import { VehiclesService } from '../vehicles/vehicles.service.js';
import type { CreateReservationDto, PlanningItemDto, PlanningQueryDto, PlanningResponseDto, PlanningWarningDto, ReservationViewDto, ReservationsQueryDto, UpdateReservationDto } from './dto/reservations.dto.js';

const include = { vehicle: { select: { code: true, registration: true } }, driver: { select: { firstName: true, lastName: true } } } as const;
type Row = Prisma.ReservationGetPayload<{ include: typeof include }>;

const INTERVENTION_KIND_LABELS: Record<string, string> = { PREVENTIF: 'préventive', CORRECTIF: 'corrective' };
const INTERVENTION_STATUS_TEXT: Record<string, string> = { PLANIFIEE: 'planifiée', EN_COURS: 'en cours' };

/**
 * Réservations (CDC 4.2, 4.5 ; D-137, D-140, D-141) : créneaux [début, fin[ tronqués à la minute,
 * chevauchements CONFIRMEE refusés en base (contrainte d'exclusion) par véhicule et par conducteur,
 * occupation réelle et immobilisations contrôlées sous verrou, habilitations, conducteur actif et
 * blocages connus. Modification, annulation et non-présentation vérifient la version dans la
 * transaction, après verrouillage, et conservent auteur, date et motif (colonnes et audit).
 */
@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly vehicles: VehiclesService,
    private readonly drivers: DriversService,
    private readonly checks: DepartureChecksService,
    private readonly alerts: AlertsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async create(ctx: RequestContext, dto: CreateReservationDto): Promise<ReservationViewDto> {
    const vehicle = await this.vehicles.load(ctx, dto.vehicleId);
    this.access.requireOperational(ctx, vehicle.companyId);
    await this.drivers.load(ctx, dto.driverId);
    const startAt = truncateToMinute(new Date(dto.startAt));
    const endAt = truncateToMinute(new Date(dto.endAt));
    this.assertSlot(startAt, endAt, this.clock.now(), true);
    const id = await this.prisma
      .serializable(async (tx) => {
        await lockParties(tx, [dto.vehicleId], [dto.driverId]);
        // Société toujours déduite du véhicule verrouillé (jamais fournie par le client, 15.3) ; l'habilitation
        // est recontrôlée sur cette société si un transfert l'a changée depuis la lecture hors transaction.
        const v = await this.confirmChecks(ctx, tx, dto.vehicleId, dto.driverId, startAt, endAt, dto.overrideReason);
        if (v.companyId !== vehicle.companyId) this.access.requireOperational(ctx, v.companyId);
        if (dto.siteId) {
          const site = await tx.site.findFirst({ where: { id: dto.siteId, organizationId: ctx.organizationId, companyId: v.companyId } });
          if (!site) throw new NotFoundOrOutOfScopeError('Site');
        }
        const r = await tx.reservation.create({
          data: {
            organizationId: ctx.organizationId,
            companyId: v.companyId,
            vehicleId: dto.vehicleId,
            driverId: dto.driverId,
            startAt,
            endAt,
            purpose: dto.purpose.trim(),
            destination: dto.destination ?? null,
            siteId: dto.siteId ?? null,
            comment: dto.comment ?? null,
            status: 'CONFIRMEE',
            createdById: ctx.userId,
          },
        });
        await this.audit.record(ctx, { action: 'reservation.creation', objectType: 'Reservation', objectId: r.id, companyId: r.companyId, reason: dto.overrideReason ?? null, after: { vehicleId: r.vehicleId, driverId: r.driverId, startAt, endAt, overrideReason: dto.overrideReason ?? null } }, tx);
        return r.id;
      })
      .catch((error: unknown) => {
        throw mapOverlap(error);
      });
    return this.view(id);
  }

  /**
   * Modification (D-137) : réservation CONFIRMEE, motif obligatoire, version vérifiée après verrouillage
   * des véhicules et conducteurs d'origine et de destination (ordre constant). Avant le début prévu :
   * véhicule, conducteur, créneau et informations, avec les contrôles complets de la création ; ensuite,
   * seule la fin prévue reste modifiable (422 sinon).
   */
  async update(ctx: RequestContext, id: string, dto: UpdateReservationDto): Promise<ReservationViewDto> {
    const reason = requireMotive(dto.reason);
    const current = await this.load(ctx, id);
    this.access.requireOperational(ctx, current.companyId);
    const targetVehicleId = dto.vehicleId ?? current.vehicleId;
    const targetDriverId = dto.driverId ?? current.driverId;
    if (targetVehicleId !== current.vehicleId) {
      const target = await this.vehicles.load(ctx, targetVehicleId);
      this.access.requireOperational(ctx, target.companyId);
    }
    if (targetDriverId !== current.driverId) await this.drivers.load(ctx, targetDriverId);
    await this.prisma
      .serializable(async (tx) => {
        await lockParties(tx, [current.vehicleId, targetVehicleId], [current.driverId, targetDriverId]);
        const fresh = await lockReservation(tx, id);
        assertExpectedVersion(fresh, dto.expectedVersion, 'réservation');
        if (fresh.status !== 'CONFIRMEE') throw new ConflictError('ETAT_INVALIDE', 'Seule une réservation confirmée peut être modifiée.');
        const now = this.clock.now();
        const next = {
          vehicleId: dto.vehicleId ?? fresh.vehicleId,
          driverId: dto.driverId ?? fresh.driverId,
          startAt: dto.startAt ? truncateToMinute(new Date(dto.startAt)) : fresh.startAt,
          endAt: dto.endAt ? truncateToMinute(new Date(dto.endAt)) : fresh.endAt,
          purpose: dto.purpose !== undefined ? dto.purpose.trim() : fresh.purpose,
          destination: dto.destination !== undefined ? dto.destination : fresh.destination,
          siteId: dto.siteId !== undefined ? dto.siteId : fresh.siteId,
          comment: dto.comment !== undefined ? dto.comment : fresh.comment,
        };
        const changed = {
          vehicleId: next.vehicleId !== fresh.vehicleId,
          driverId: next.driverId !== fresh.driverId,
          startAt: next.startAt.getTime() !== fresh.startAt.getTime(),
          endAt: next.endAt.getTime() !== fresh.endAt.getTime(),
          purpose: next.purpose !== fresh.purpose,
          destination: next.destination !== fresh.destination,
          siteId: next.siteId !== fresh.siteId,
          comment: next.comment !== fresh.comment,
        };
        const changedFields = (Object.keys(changed) as Array<keyof typeof changed>).filter((k) => changed[k]);
        if (changedFields.length === 0) throw new BusinessRuleError('AUCUNE_MODIFICATION', 'Aucune modification à enregistrer.');
        if (reservationEditScope(fresh.startAt, now) === 'FIN_SEULEMENT') {
          const locked = changedFields.filter((k) => k !== 'endAt');
          if (locked.length > 0) {
            throw new BusinessRuleError('RESERVATION_COMMENCEE', 'Le début prévu est passé : seule la fin prévue peut encore être modifiée.', {
              fieldErrors: Object.fromEntries(locked.map((k) => [k, ['Non modifiable après le début prévu.']])),
              details: { fields: locked },
            });
          }
        }
        this.assertSlot(next.startAt, next.endAt, now, changed.startAt);
        // Contrôles complets dès que l'occupation peut s'étendre : autre véhicule, autre conducteur, début
        // déplacé ou fin repoussée. Raccourcir la fin ne crée aucun conflit.
        let companyId = fresh.companyId;
        const recheck = changed.vehicleId || changed.driverId || changed.startAt || next.endAt.getTime() > fresh.endAt.getTime();
        if (recheck) {
          const v = await this.confirmChecks(ctx, tx, next.vehicleId, next.driverId, next.startAt, next.endAt, dto.overrideReason);
          if (v.companyId !== fresh.companyId) this.access.requireOperational(ctx, v.companyId);
          companyId = v.companyId;
        }
        if (next.siteId && (changed.siteId || companyId !== fresh.companyId)) {
          const site = await tx.site.findFirst({ where: { id: next.siteId, organizationId: ctx.organizationId } });
          if (!site || (changed.siteId && !this.access.canReadCompany(ctx, site.companyId))) throw new NotFoundOrOutOfScopeError('Site');
          if (site.companyId !== companyId) {
            throw new BusinessRuleError('SITE_AUTRE_SOCIETE', 'Le site de destination doit appartenir à la société du véhicule : choisissez un site de cette société ou retirez-le.', { fieldErrors: { siteId: ['Site d’une autre société.'] } });
          }
        }
        await tx.reservation.update({
          where: { id, version: dto.expectedVersion },
          data: { ...next, companyId, version: { increment: 1 } },
        });
        const before = Object.fromEntries(changedFields.map((k) => [k, fresh[k]]));
        const after = Object.fromEntries(changedFields.map((k) => [k, next[k]]));
        await this.audit.record(
          ctx,
          { action: 'reservation.modification', objectType: 'Reservation', objectId: id, companyId, reason, before, after: { ...after, ...(recheck && dto.overrideReason ? { overrideReason: dto.overrideReason } : {}) } },
          tx,
        );
        // L'alerte « réservation compromise » visait l'ancien véhicule : elle cesse avec le changement de véhicule.
        if (changed.vehicleId) await this.alerts.resolve({ organizationId: ctx.organizationId, type: 'RESERVATION_COMPROMISE', objectType: 'Reservation', objectId: id }, 'réservation déplacée sur un autre véhicule', tx);
      })
      .catch((error: unknown) => {
        throw mapOverlap(error);
      });
    return this.view(id);
  }

  async cancel(ctx: RequestContext, id: string, motive: string, expectedVersion: number): Promise<ReservationViewDto> {
    const reason = requireMotive(motive);
    const current = await this.load(ctx, id);
    this.access.requireOperational(ctx, current.companyId);
    await this.prisma.transaction(async (tx) => {
      const fresh = await lockReservation(tx, id);
      assertExpectedVersion(fresh, expectedVersion, 'réservation');
      if (fresh.status !== 'CONFIRMEE') throw new ConflictError('ETAT_INVALIDE', 'Seule une réservation confirmée peut être annulée.');
      await tx.reservation.update({ where: { id, version: expectedVersion }, data: { status: 'ANNULEE', cancelledAt: this.clock.now(), cancelledById: ctx.userId, cancelReason: reason, version: { increment: 1 } } });
      await this.audit.record(ctx, { action: 'reservation.annulation', objectType: 'Reservation', objectId: id, companyId: fresh.companyId, reason, before: { status: 'CONFIRMEE' }, after: { status: 'ANNULEE' } }, tx);
      await this.alerts.resolve({ organizationId: ctx.organizationId, type: 'RESERVATION_COMPROMISE', objectType: 'Reservation', objectId: id }, 'réservation annulée', tx);
    });
    return this.view(id);
  }

  /**
   * Non-présentation constatée par le chef ou l'opérateur (D-137) : à partir du début prévu +
   * reservations.noShowGraceMinutes, avec motif ; auteur (cancelledById, faute de colonne dédiée) et date
   * (noShowAt) conservés, créneau libéré, alerte « réservation compromise » résolue.
   */
  async markNoShow(ctx: RequestContext, id: string, motive: string, expectedVersion: number): Promise<ReservationViewDto> {
    const reason = requireMotive(motive);
    const current = await this.load(ctx, id);
    this.access.requireOperational(ctx, current.companyId);
    await this.prisma.transaction(async (tx) => {
      const fresh = await lockReservation(tx, id);
      assertExpectedVersion(fresh, expectedVersion, 'réservation');
      if (fresh.status !== 'CONFIRMEE') throw new ConflictError('ETAT_INVALIDE', 'Seule une réservation confirmée peut être déclarée non honorée.');
      const now = this.clock.now();
      const grace = await this.settings.get(ctx.organizationId, 'reservations.noShowGraceMinutes', fresh.companyId, tx);
      if (!canDeclareNoShow(fresh.startAt, now, grace)) {
        const allowedFrom = noShowAllowedFrom(fresh.startAt, grace);
        const timezone = (await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } })).timezone;
        throw new BusinessRuleError('TROP_TOT', `La non-présentation ne peut être constatée qu’à partir du ${formatLocal(allowedFrom, timezone)} (début prévu + ${grace} min).`, { details: { allowedFrom: allowedFrom.toISOString(), graceMinutes: grace } });
      }
      await tx.reservation.update({ where: { id, version: expectedVersion }, data: { status: 'NON_HONOREE', noShowAt: now, cancelledById: ctx.userId, cancelReason: reason, version: { increment: 1 } } });
      await this.audit.record(ctx, { action: 'reservation.non_honoree', objectType: 'Reservation', objectId: id, companyId: fresh.companyId, reason, before: { status: 'CONFIRMEE' }, after: { status: 'NON_HONOREE', noShowAt: now } }, tx);
      await this.alerts.resolve({ organizationId: ctx.organizationId, type: 'RESERVATION_COMPROMISE', objectType: 'Reservation', objectId: id }, 'réservation non honorée', tx);
    });
    return this.view(id);
  }

  /**
   * Rattrapage (D-137) : une réservation confirmée non convertie à sa fin passe NON_HONOREE (acteur
   * système). Mise à jour conditionnelle : une conversion, une annulation ou une prolongation concurrente
   * l'emporte ; relancer ne change rien (idempotent).
   */
  async expireUnconverted(organizationId?: string): Promise<number> {
    const now = this.clock.now();
    const stale = await this.prisma.client.reservation.findMany({ where: { status: 'CONFIRMEE', endAt: { lte: now }, ...(organizationId ? { organizationId } : {}) }, select: { id: true, organizationId: true, companyId: true } });
    let expired = 0;
    for (const r of stale) {
      const done = await this.prisma.transaction(async (tx) => {
        const res = await tx.reservation.updateMany({ where: { id: r.id, status: 'CONFIRMEE', endAt: { lte: now } }, data: { status: 'NON_HONOREE', noShowAt: now, cancelReason: 'Fin prévue dépassée sans remise.', version: { increment: 1 } } });
        if (res.count === 0) return false;
        await this.audit.recordSystem(r.organizationId, { action: 'reservation.non_honoree', objectType: 'Reservation', objectId: r.id, companyId: r.companyId, reason: 'fin prévue dépassée sans remise' }, tx);
        await this.alerts.resolve({ organizationId: r.organizationId, type: 'RESERVATION_COMPROMISE', objectType: 'Reservation', objectId: r.id }, 'réservation expirée', tx);
        return true;
      });
      if (done) expired += 1;
    }
    return expired;
  }

  async list(ctx: RequestContext, query: ReservationsQueryDto): Promise<Page<ReservationViewDto>> {
    let where: Prisma.ReservationWhereInput = ctx.isDriverOnly ? { organizationId: ctx.organizationId, driverId: ctx.driverId ?? '00000000-0000-0000-0000-000000000000' } : { ...this.access.companyWhere(ctx, query.companyId) };
    if (query.vehicleId) where = { ...where, vehicleId: query.vehicleId };
    if (query.driverId && !ctx.isDriverOnly) where = { ...where, driverId: query.driverId };
    if (query.status) where = { ...where, status: query.status };
    if (query.from) where = { ...where, endAt: { gt: new Date(query.from) } };
    if (query.to) where = { ...where, startAt: { lt: new Date(query.to) } };
    const [items, total] = await Promise.all([
      this.prisma.client.reservation.findMany({ where, ...skipTake(query), orderBy: { startAt: query.order === 'desc' ? 'desc' : 'asc' }, include }),
      this.prisma.client.reservation.count({ where }),
    ]);
    return pageOf(await this.views(items), total, query);
  }

  async get(ctx: RequestContext, id: string): Promise<ReservationViewDto> {
    await this.load(ctx, id);
    return this.view(id);
  }

  /**
   * Planning (10.2) : réservations, utilisations, immobilisations et interventions planifiées ou en cours
   * qui chevauchent la fenêtre, chacune avec sa société ; avertissement (sans blocage, D-205) quand une
   * intervention chevauche une réservation confirmée du même véhicule.
   */
  async planning(ctx: RequestContext, query: PlanningQueryDto): Promise<PlanningResponseDto> {
    this.access.requireStaff(ctx);
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (to <= from || to.getTime() - from.getTime() > 93 * 24 * 3600 * 1000) throw new BusinessRuleError('FENETRE_INVALIDE', 'La fenêtre du planning doit être comprise entre 1 minute et 93 jours.');
    const scope = this.access.companyWhere(ctx, query.companyId);
    const vehicleFilter = query.vehicleId ? { vehicleId: query.vehicleId } : {};
    const now = this.clock.now();
    const window: Slot = { start: from, end: to };
    const [reservations, usages, immobilizations, interventions] = await Promise.all([
      this.prisma.client.reservation.findMany({ where: { ...scope, ...vehicleFilter, status: { in: ['CONFIRMEE', 'CONVERTIE'] }, startAt: { lt: to }, endAt: { gt: from } }, include, orderBy: { startAt: 'asc' } }),
      this.prisma.client.vehicleUsage.findMany({
        where: { ...scope, ...vehicleFilter, checkedOutAt: { lt: to }, OR: [{ status: 'EN_COURS' }, { returnedAt: { gt: from } }] },
        include: { vehicle: { select: { code: true } }, driver: { select: { firstName: true, lastName: true } } },
        orderBy: { checkedOutAt: 'asc' },
      }),
      this.prisma.client.immobilization.findMany({
        where: { ...scope, ...vehicleFilter, startedAt: { lt: to }, OR: [{ endedAt: null }, { endedAt: { gt: from } }] },
        include: { vehicle: { select: { code: true } }, causes: { where: { endedAt: null }, select: { reason: true } } },
        orderBy: { startedAt: 'asc' },
      }),
      this.prisma.client.intervention.findMany({
        where: {
          ...scope,
          ...vehicleFilter,
          OR: [
            { status: 'PLANIFIEE', plannedStartAt: { lt: to }, OR: [{ plannedEndAt: null }, { plannedEndAt: { gt: from } }] },
            { status: 'EN_COURS', OR: [{ startedAt: { lt: to } }, { startedAt: null, plannedStartAt: { lt: to } }] },
          ],
        },
        include: { vehicle: { select: { code: true } }, supplier: { select: { name: true } } },
        orderBy: [{ plannedStartAt: 'asc' }, { startedAt: 'asc' }],
      }),
    ]);
    const tolerance = new Map<string, number>();
    for (const companyId of new Set(usages.filter((u) => u.status === 'EN_COURS').map((u) => u.companyId))) {
      tolerance.set(companyId, await this.settings.get(ctx.organizationId, 'usage.lateReturnToleranceMinutes', companyId));
    }
    // Une intervention en cours occupe le véhicule même au-delà de sa fin prévue (comme une utilisation en retard).
    const placedInterventions = interventions
      .map((i) => ({ i, slot: interventionSlot(i) }))
      .filter((x): x is { i: (typeof interventions)[number]; slot: Slot } => x.slot !== null && (slotsOverlap(x.slot, window) || (x.i.status === 'EN_COURS' && x.slot.start < to)))
      .map((x) => ({ ...x, vehicleId: x.i.vehicleId }));
    const items: PlanningItemDto[] = [
      ...reservations.map((r) => ({ kind: 'RESERVATION' as const, id: r.id, companyId: r.companyId, vehicleId: r.vehicleId, vehicleCode: r.vehicle.code, driverName: `${r.driver.firstName} ${r.driver.lastName}`, startAt: r.startAt.toISOString(), endAt: r.endAt.toISOString(), status: r.status, label: r.purpose, isLate: false })),
      ...usages.map((u) => ({
        kind: 'UTILISATION' as const,
        id: u.id,
        companyId: u.companyId,
        vehicleId: u.vehicleId,
        vehicleCode: u.vehicle.code,
        driverName: `${u.driver.firstName} ${u.driver.lastName}`,
        startAt: u.checkedOutAt.toISOString(),
        endAt: (u.returnedAt ?? u.expectedReturnAt).toISOString(),
        status: u.status,
        label: u.purpose,
        isLate: isReturnLate(u, now, tolerance.get(u.companyId) ?? 0),
      })),
      ...immobilizations.map((i) => ({ kind: 'IMMOBILISATION' as const, id: i.id, companyId: i.companyId, vehicleId: i.vehicleId, vehicleCode: i.vehicle.code, driverName: null, startAt: i.startedAt.toISOString(), endAt: (i.endedAt ?? i.expectedEndAt)?.toISOString() ?? null, status: i.status, label: i.causes.map((c) => c.reason).join(' ; ') || 'Immobilisation', isLate: false })),
      ...placedInterventions.map(({ i, slot }) => ({
        kind: 'INTERVENTION' as const,
        id: i.id,
        companyId: i.companyId,
        vehicleId: i.vehicleId,
        vehicleCode: i.vehicle.code,
        driverName: null,
        startAt: slot.start.toISOString(),
        endAt: slot.end?.toISOString() ?? null,
        status: i.status,
        label: `${i.reference} · intervention ${INTERVENTION_KIND_LABELS[i.kind] ?? ''}${i.supplier ? ` — ${i.supplier.name}` : ''}`,
        isLate: isInterventionLate(i, now),
      })),
    ];
    const confirmed = reservations.map((r) => ({ r, vehicleId: r.vehicleId, status: r.status, slot: { start: r.startAt, end: r.endAt } }));
    const warnings: PlanningWarningDto[] = interventionReservationOverlaps(placedInterventions, confirmed).map(({ intervention: { i }, reservation: { r } }) => {
      const driverName = `${r.driver.firstName} ${r.driver.lastName}`;
      return {
        code: 'INTERVENTION_CHEVAUCHE_RESERVATION',
        message: `L’intervention ${i.reference} (${INTERVENTION_STATUS_TEXT[i.status] ?? i.status}) chevauche la réservation confirmée de ${driverName} sur ${r.vehicle.code} : déplacez l’une ou l’autre, ou prévenez le conducteur.`,
        vehicleId: r.vehicleId,
        vehicleCode: r.vehicle.code,
        companyId: r.companyId,
        interventionId: i.id,
        interventionReference: i.reference,
        reservationId: r.id,
        driverName,
      };
    });
    return { items, warnings };
  }

  /**
   * Contrôles de confirmation (4.2, 4.5, D-140, D-141), sous verrou véhicule puis conducteur : cycle de vie,
   * conducteur actif de la même société, permis et documents (dérogation motivée avec exceptions.override),
   * occupation réelle des utilisations en cours et immobilisation active sur le créneau.
   */
  private async confirmChecks(ctx: RequestContext, tx: Tx, vehicleId: string, driverId: string, startAt: Date, endAt: Date, overrideReason: string | undefined): Promise<Vehicle> {
    const [v, d]: [Vehicle, Driver] = await Promise.all([tx.vehicle.findUniqueOrThrow({ where: { id: vehicleId } }), tx.driver.findUniqueOrThrow({ where: { id: driverId } })]);
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } });
    const blockers = (await this.checks.check(tx, v, d, startAt, { timezone: org.timezone })).filter(
      // Occupation actuelle et immobilisation : contrôlées ci-dessous par recouvrement avec le créneau.
      (b) => b.code !== ErrorCodes.VEHICULE_DEJA_EN_UTILISATION && b.code !== ErrorCodes.CONDUCTEUR_DEJA_EN_UTILISATION && b.code !== 'VEHICULE_IMMOBILISE',
    );
    const hard = blockers.filter((b) => !b.overridable);
    // CDC 15.1 : véhicule HORS_SERVICE, CEDE ou ARCHIVE = conflit d'état (409), comme à la remise.
    if (hard.some((b) => b.code === VEHICLE_NOT_ACTIVE)) throw new ConflictError(VEHICLE_NOT_ACTIVE, hard.map((b) => b.message).join(' '), { blockers: hard });
    if (hard.length > 0) throw new BusinessRuleError('RESERVATION_BLOQUEE', hard.map((b) => b.message).join(' '), { details: { blockers: hard } });
    const soft = blockers.filter((b) => b.overridable);
    if (soft.length > 0) {
      if (!overrideReason) throw new BusinessRuleError('RESERVATION_BLOQUEE', `${soft.map((b) => b.message).join(' ')} Une dérogation motivée est nécessaire.`, { details: { blockers: soft, overridable: true } });
      this.access.requirePermission(ctx, v.companyId, 'exceptions.override', 'La dérogation requiert la permission exceptions.override.');
    }
    const now = this.clock.now();
    const slot: Slot = { start: startAt, end: endAt };
    // Occupation réelle (D-140) : utilisation EN_COURS sur [départ, max(retour prévu, maintenant)[ ; même code
    // RESERVATION_CONFLIT que le départ qui chevauche une réservation confirmée.
    const openUsages = await tx.vehicleUsage.findMany({ where: { status: 'EN_COURS', OR: [{ vehicleId }, { driverId }] } });
    const busy = openUsages.find((u) => slotsOverlap(slot, { start: u.checkedOutAt, end: occupancyEnd(u.expectedReturnAt, now) }));
    if (busy) {
      throw new ConflictError(ErrorCodes.RESERVATION_CONFLIT, busy.vehicleId === vehicleId ? 'Le véhicule est en utilisation sur cette période (jusqu’à son retour prévu, ou tant qu’il n’est pas restitué).' : 'Le conducteur a une utilisation en cours sur cette période.', { usageId: busy.id });
    }
    // Immobilisation active sans fin prévue, ou dont [début, fin prévue[ chevauche le créneau (D-141).
    const immobilization = await tx.immobilization.findFirst({ where: { vehicleId, status: 'ACTIVE' } });
    if (immobilization && slotsOverlap(slot, immobilizationSlot(immobilization.startedAt, immobilization.expectedEndAt, now))) {
      throw new ConflictError('VEHICULE_IMMOBILISE', 'Le véhicule est immobilisé sur cette période.', { immobilizationId: immobilization.id });
    }
    return v;
  }

  private assertSlot(startAt: Date, endAt: Date, now: Date, checkStart: boolean): void {
    const violation = slotViolation(startAt, endAt, now, { checkStart });
    if (violation) throw new BusinessRuleError(violation.code, violation.message, { fieldErrors: { [violation.field]: [violation.message] } });
  }

  async load(ctx: RequestContext, id: string): Promise<Reservation> {
    const r = await this.prisma.client.reservation.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!r) throw new NotFoundOrOutOfScopeError('Réservation');
    if (ctx.isDriverOnly ? r.driverId !== ctx.driverId : !this.access.canReadCompany(ctx, r.companyId)) throw new NotFoundOrOutOfScopeError('Réservation');
    return r;
  }

  private async view(id: string): Promise<ReservationViewDto> {
    const r = await this.prisma.client.reservation.findUniqueOrThrow({ where: { id }, include });
    return (await this.views([r]))[0] as ReservationViewDto;
  }

  private async views(items: Row[]): Promise<ReservationViewDto[]> {
    const ids = [...new Set(items.flatMap((i) => [i.createdById, i.cancelledById]).filter((x): x is string => Boolean(x)))];
    const users = ids.length ? await this.prisma.client.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } }) : [];
    const nameOf = (userId: string | null) => {
      const u = userId ? users.find((x) => x.id === userId) : undefined;
      return u ? `${u.firstName} ${u.lastName}` : null;
    };
    const grace = new Map<string, number>();
    for (const r of items) {
      const key = `${r.organizationId}:${r.companyId}`;
      if (r.status === 'CONFIRMEE' && !grace.has(key)) grace.set(key, await this.settings.get(r.organizationId, 'reservations.noShowGraceMinutes', r.companyId));
    }
    const now = this.clock.now();
    return items.map((r) => {
      const confirmed = r.status === 'CONFIRMEE';
      return {
        id: r.id,
        companyId: r.companyId,
        vehicleId: r.vehicleId,
        vehicleCode: r.vehicle.code,
        vehicleRegistration: r.vehicle.registration,
        driverId: r.driverId,
        driverName: `${r.driver.firstName} ${r.driver.lastName}`,
        startAt: r.startAt.toISOString(),
        endAt: r.endAt.toISOString(),
        purpose: r.purpose,
        destination: r.destination,
        siteId: r.siteId,
        comment: r.comment,
        status: r.status,
        convertedUsageId: r.convertedUsageId,
        cancelledAt: r.cancelledAt?.toISOString() ?? null,
        cancelReason: r.cancelReason,
        noShowAt: r.noShowAt?.toISOString() ?? null,
        closedByName: nameOf(r.cancelledById),
        editScope: confirmed ? reservationEditScope(r.startAt, now) : null,
        noShowAllowedFrom: confirmed ? noShowAllowedFrom(r.startAt, grace.get(`${r.organizationId}:${r.companyId}`) ?? 0).toISOString() : null,
        createdByName: nameOf(r.createdById),
        createdAt: r.createdAt.toISOString(),
        version: r.version,
      };
    });
  }
}

/** Verrous dans un ordre constant (13.3, D-138) : véhicules puis conducteurs, chacun trié par identifiant. */
async function lockParties(tx: Tx, vehicleIds: string[], driverIds: string[]): Promise<void> {
  for (const vehicleId of [...new Set(vehicleIds)].sort()) await lockVehicle(tx, vehicleId);
  for (const driverId of [...new Set(driverIds)].sort()) await lockDriver(tx, driverId);
}

/** Verrou de la réservation (après véhicules et conducteurs), puis lecture de sa version courante. */
async function lockReservation(tx: Tx, id: string): Promise<Reservation> {
  await tx.$queryRaw`SELECT id FROM "Reservation" WHERE id = ${id}::uuid FOR UPDATE`;
  return tx.reservation.findUniqueOrThrow({ where: { id } });
}

/** Motif obligatoire (4.2) : un texte blanc ne vaut pas motif. */
function requireMotive(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < 3) throw new BusinessRuleError('MOTIF_REQUIS', 'Indiquez un motif (3 caractères minimum).', { fieldErrors: { reason: ['Motif requis (3 caractères minimum).'] } });
  return trimmed;
}

function formatLocal(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: timezone }).format(date);
}

function mapOverlap(error: unknown): unknown {
  if (isConstraintViolation(error, 'reservation_no_overlap_vehicle')) return new ConflictError(ErrorCodes.RESERVATION_CHEVAUCHEMENT, 'Ce créneau chevauche une réservation confirmée du véhicule.');
  if (isConstraintViolation(error, 'reservation_no_overlap_driver')) return new ConflictError(ErrorCodes.RESERVATION_CHEVAUCHEMENT, 'Ce créneau chevauche une réservation confirmée du conducteur.');
  return error;
}
