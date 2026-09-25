import { Injectable } from '@nestjs/common';
import { RESERVATION_STATUS_LABELS } from '@parc-auto/contracts';
import type { Prisma, Reservation, VehicleUsage } from '@parc-auto/db';
import { DateTime } from 'luxon';
import { AfterCommit } from '../../common/after-commit.js';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, ConflictError, ErrorCodes, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { organizationTimezone } from '../../common/request-memo.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import { type Page, pageOf, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import { formatLocalDateTime } from '../../domain/civil-date.js';
import { type ReturnRegularizationBlock, conversionWindow, isInConversionWindow, isInReturnRegularizationWindow, isReturnLate, lateReturnCutoff, occupancyEnd, pickReservationToConvert, returnRegularizationBlock } from '../../domain/usage-rules.js';
import { returnDueBefore } from '../../domain/return-delay.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, isUniqueViolation, type Tx } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { AlertsService } from '../alerts/alerts.service.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { DriversService } from '../drivers/drivers.service.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { OdometerIngestionService, lockDriver, lockDriverForWrite, lockVehicle, lockVehicleForWrite } from '../odometer/odometer-ingestion.service.js';
import { READING_SETTINGS, parseKm } from '../odometer/odometer.service.js';
import { recomputeUsageDistance } from '../odometer/usage-distance.js';
import { SettingsService } from '../settings/settings.service.js';
import { VehiclesService } from '../vehicles/vehicles.service.js';
import { DepartureChecksService, VEHICLE_NOT_ACTIVE, type DepartureBlocker } from './departure-checks.service.js';
import type { CheckoutDto, CheckoutPreviewDto, ExtendUsageDto, RegularizeReturnReadingDto, ReturnDto, UsageViewDto, UsagesQueryDto } from './dto/usages.dto.js';
import { currentTelematicsHint } from '../telemetry/telematics-hint.js';

const usageInclude = {
  vehicle: { select: { code: true, registration: true } },
  driver: { select: { firstName: true, lastName: true } },
  checkoutReading: { select: { id: true, physicalKm: true, cumulativeKm: true, status: true, observedAt: true } },
  returnReading: { select: { id: true, physicalKm: true, cumulativeKm: true, status: true, observedAt: true } },
  reservation: { select: { id: true } },
  locationReports: { select: { context: true, placeLabel: true, site: { select: { name: true } } } },
  // Incidents de l'utilisation : celui ouvert par la restitution est identifié dans views(), quel que soit
  // son type actuel (un dommage peut être requalifié ensuite, il reste l'incident ouvert au retour).
  incidents: { select: { id: true, reference: true, occurredAt: true, createdById: true }, orderBy: { createdAt: 'asc' } },
} as const;

type UsageRow = Prisma.VehicleUsageGetPayload<{ include: typeof usageInclude }>;

const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const LATE_TOLERANCE_KEY = 'usage.lateReturnToleranceMinutes';

type ConflictingReservation = { id: string; startAt: string; endAt: string; driverName: string };
/** Réservation convertible, lue sous verrou (colonnes utiles à la conversion). */
type ConvertibleReservation = Pick<Reservation, 'id' | 'companyId' | 'vehicleId' | 'driverId' | 'status' | 'startAt' | 'endAt' | 'version'>;

/**
 * Verrou de la ligne d'utilisation (SELECT … FOR UPDATE), pris après le véhicule puis le conducteur
 * (ordre constant, D-138), puis relecture : statut et version sont contrôlés sur l'état verrouillé.
 * En READ COMMITTED (restitution, D-016), la relecture suit le verrou et voit la dernière version validée ;
 * en isolation sérialisable (prolongation, régularisation), une ligne modifiée par une transaction
 * concurrente validée lève un conflit de sérialisation, repris par PrismaService.serializable.
 */
async function lockUsage(tx: Tx, usageId: string): Promise<VehicleUsage> {
  await tx.$queryRaw`SELECT id FROM "VehicleUsage" WHERE id = ${usageId}::uuid FOR UPDATE`;
  return tx.vehicleUsage.findUniqueOrThrow({ where: { id: usageId } });
}

/**
 * Utilisations réelles (CDC 4.3 à 4.5) : remise et restitution transactionnelles, idempotentes, avec
 * verrous de ligne dans un ordre constant et contraintes en base (une seule utilisation ouverte par
 * véhicule et par conducteur). Aucune clôture par simple modification de statut.
 */
@Injectable()
export class UsagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly vehicles: VehiclesService,
    private readonly drivers: DriversService,
    private readonly checks: DepartureChecksService,
    private readonly ingestion: OdometerIngestionService,
    private readonly attachments: AttachmentsService,
    private readonly settings: SettingsService,
    private readonly alerts: AlertsService,
    private readonly incidents: IncidentsService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ---------------------------------------------------------------------------
  // Remise
  // ---------------------------------------------------------------------------

  async preview(ctx: RequestContext, vehicleId: string, driverId: string, at: string | undefined, expectedReturnAt: string | undefined): Promise<CheckoutPreviewDto> {
    const vehicle = await this.vehicles.load(ctx, vehicleId);
    this.access.requireOperational(ctx, vehicle.companyId);
    await this.drivers.load(ctx, driverId);
    const when = at ? new Date(at) : this.clock.now();
    const timezone = await this.timezone(ctx.organizationId);
    return this.prisma.client.$transaction(async (tx) => {
      const [v, d] = await Promise.all([tx.vehicle.findUniqueOrThrow({ where: { id: vehicleId } }), tx.driver.findUniqueOrThrow({ where: { id: driverId } })]);
      const blockers = await this.checks.check(tx, v, d, when, { timezone });
      const last = await tx.odometerReading.findFirst({ where: { vehicleId, status: 'ACCEPTE' }, orderBy: [{ observedAt: 'desc' }, { enteredAt: 'desc' }] });
      const telematicsHint = await currentTelematicsHint(tx, vehicleId);
      // Occupation réelle (D-140) : [départ, max(retour prévu, maintenant)[, comme à la remise.
      const conflicts = expectedReturnAt ? await this.conflictingReservations(tx, vehicleId, driverId, when, occupancyEnd(new Date(expectedReturnAt), this.clock.now())) : [];
      const checklistItems = await this.settings.get(ctx.organizationId, 'usage.checklistItems', vehicle.companyId, tx);
      return {
        blockers,
        lastReading: last ? { physicalKm: last.physicalKm?.toFixed(3) ?? null, observedAt: last.observedAt.toISOString() } : null,
        telematicsHint,
        checklistItems: checklistItems,
        conflictingReservations: conflicts,
      };
    });
  }

  async checkout(ctx: RequestContext, dto: CheckoutDto, idempotencyKey: string): Promise<UsageViewDto> {
    const vehicle = await this.vehicles.loadRef(ctx, dto.vehicleId);
    this.access.requireOperational(ctx, vehicle.companyId);
    await this.drivers.assertReadable(ctx, dto.driverId);
    const checkedOutAt = new Date(dto.checkedOutAt);
    const expectedReturnAt = new Date(dto.expectedReturnAt);
    this.validateTimes(checkedOutAt, expectedReturnAt);
    if (!dto.reading && !dto.readingException) {
      throw new BusinessRuleError('RELEVE_REQUIS', 'Le relevé du compteur est obligatoire pour valider le départ.', { fieldErrors: { 'reading.physicalKm': ['Relevé requis.'] } });
    }
    if (dto.reading && dto.readingException) throw new BusinessRuleError('RELEVE_OU_EXCEPTION', 'Fournissez soit un relevé, soit une exception motivée, pas les deux.');
    if (dto.readingException) {
      this.access.requirePermission(ctx, vehicle.companyId, 'exceptions.override', 'Un départ sans relevé est une exception réservée au chef de parc ou à l’administrateur.');
    }
    const body = { ...dto, idempotencyKey: undefined };
    const result = await this.idempotency.run({ organizationId: ctx.organizationId, userId: ctx.userId, operation: 'usage.checkout', key: idempotencyKey }, body, async () => {
      const timezone = await this.timezone(ctx.organizationId);
      // Paramètres consultés par la remise, son relevé, ses recalculs dépendants et sa vue : une lecture.
      await this.settings.prefetch(ctx.organizationId, ['reservations.conversionEarlyMinutes', LATE_TOLERANCE_KEY, ...READING_SETTINGS], vehicle.companyId);
      // D-016 : READ COMMITTED sous verrous de ligne. Véhicule puis conducteur verrouillés (ordre constant, 13.3) :
      // toute écriture qui peut invalider un contrôle ci-dessous (utilisation, restitution, réservation confirmée,
      // immobilisation, relevé, cycle de vie, transfert) prend l'un de ces verrous ; chaque lecture qui suit voit donc
      // l'état validé le plus récent. Les lignes verrouillées reçoivent une nouvelle version : une transaction
      // sérialisable qui attendait le verrou est reprise au lieu de décider sur un instantané antérieur. Index uniques
      // partiels (une utilisation ouverte par véhicule et par conducteur) et unicité du relevé par instant : garde
      // finale, convertie en 409 métier.
      const { usageId, after } = await this.prisma
        .lockedReadCommitted(async (tx) => {
          const after = new AfterCommit();
          await lockVehicleForWrite(tx, dto.vehicleId);
          await lockDriverForWrite(tx, dto.driverId);
          const [v, d] = await Promise.all([tx.vehicle.findUniqueOrThrow({ where: { id: dto.vehicleId } }), tx.driver.findUniqueOrThrow({ where: { id: dto.driverId } })]);
          const blockers = await this.checks.check(tx, v, d, checkedOutAt, { timezone });
          this.enforceBlockers(ctx, v.companyId, blockers, dto.overrideReason);
          // D-140 / D-142 : réservation du même couple convertie si le départ est dans sa fenêtre.
          const reservation = await this.reservationToConvert(ctx, tx, v, d.id, checkedOutAt, dto.reservationId ?? null, timezone);
          // D-140 : l'occupation réelle [départ, max(retour prévu, maintenant)[ ne doit chevaucher aucune
          // réservation CONFIRMEE d'autrui (une remise saisie après coup occupe le véhicule jusqu'à maintenant).
          const conflicts = await this.conflictingReservations(tx, v.id, d.id, checkedOutAt, occupancyEnd(expectedReturnAt, this.clock.now()));
          if (conflicts.length > 0) {
            throw new ConflictError(ErrorCodes.RESERVATION_CONFLIT, 'Une réservation confirmée d’un autre conducteur ou d’un autre véhicule chevauche la période du départ au retour prévu (ou jusqu’à maintenant si ce retour est déjà passé) : modifiez ou annulez cette réservation, ou avancez le retour prévu.', { reservations: conflicts });
          }
          const override = blockers.some((b) => b.overridable);
          let usage: VehicleUsage;
          try {
            usage = await tx.vehicleUsage.create({
              data: {
                organizationId: ctx.organizationId,
                companyId: v.companyId,
                vehicleId: v.id,
                driverId: d.id,
                status: 'EN_COURS',
                purpose: dto.purpose.trim(),
                checkedOutAt,
                expectedReturnAt,
                checkoutWithoutReading: Boolean(dto.readingException),
                checkoutExceptionReason: dto.readingException?.reason ?? null,
                documentOverrideReason: override ? (dto.overrideReason ?? null) : null,
                documentOverrideById: override ? ctx.userId : null,
                checkoutFuelGauge: dto.fuelGauge ?? null,
                checkoutChecklist: (dto.checklist ?? []) as unknown as Prisma.InputJsonValue,
                checkoutNotes: dto.notes ?? null,
                checkoutConfirmedBy: dto.confirmedByName ?? null,
                distanceStatus: 'INDETERMINEE',
                checkedOutById: ctx.userId,
                createdById: ctx.userId,
              },
            });
          } catch (error) {
            throw mapUsageUniqueError(error);
          }
          if (dto.reading) {
            const ingested = await this.ingestion.ingest(
              tx,
              { organizationId: ctx.organizationId, vehicleId: v.id, origin: 'MANUAL', context: 'REMISE', measurementKind: 'COMPTEUR_AFFICHE', physicalKm: parseKm(dto.reading.physicalKm), observedAt: checkedOutAt, author: { kind: 'STAFF', userId: ctx.userId }, allowAutoInit: true },
              after,
            );
            if (ingested.outcome === 'EN_ATTENTE') {
              throw new BusinessRuleError('RELEVE_NON_ACCEPTE', `Le relevé doit être accepté pour valider le départ : ${ingested.anomaly?.reason ?? 'anomalie à vérifier'}`, { fieldErrors: { 'reading.physicalKm': [ingested.anomaly?.reason ?? 'Relevé non accepté.'] } });
            }
            // Seul un relevé existant rejoué (IDEMPOTENT) peut déjà être rattaché : un relevé créé par cette remise a un nouvel identifiant.
            if (ingested.outcome === 'IDEMPOTENT') {
              const linked = await tx.vehicleUsage.findFirst({ where: { OR: [{ checkoutReadingId: ingested.reading.id }, { returnReadingId: ingested.reading.id }] } });
              if (linked) throw new ConflictError('RELEVE_DEJA_UTILISE', 'Ce relevé est déjà rattaché à une autre remise ou restitution.');
            }
            await tx.vehicleUsage.update({ where: { id: usage.id }, data: { checkoutReadingId: ingested.reading.id, distanceStatus: 'NON_VALIDEE' } });
            if (dto.reading.attachmentId) {
              await this.attachments.attach(ctx, tx, dto.reading.attachmentId, 'RELEVE', ingested.reading.id, v.companyId);
              await tx.odometerReading.update({ where: { id: ingested.reading.id }, data: { attachmentId: dto.reading.attachmentId } });
            }
          }
          for (const photo of dto.photoAttachmentIds ?? []) await this.attachments.attach(ctx, tx, photo, 'UTILISATION', usage.id, v.companyId);
          // Lieu obligatoire (D-134) : rapport REMISE dans la même transaction, site contrôlé.
          await this.vehicles.recordLocation(tx, ctx, v, { siteId: dto.location.siteId ?? null, placeLabel: dto.location.placeLabel ?? null, observedAt: checkedOutAt, context: 'REMISE', usageId: usage.id });
          if (reservation) {
            await tx.reservation.update({ where: { id: reservation.id, version: reservation.version }, data: { status: 'CONVERTIE', convertedUsageId: usage.id, version: { increment: 1 } } });
            await this.audit.record(ctx, {
              action: 'reservation.conversion',
              objectType: 'Reservation',
              objectId: reservation.id,
              companyId: reservation.companyId,
              before: { status: reservation.status },
              after: { status: 'CONVERTIE', usageId: usage.id, checkedOutAt, explicit: Boolean(dto.reservationId) },
            }, tx);
          }
          await this.audit.record(ctx, {
            action: 'utilisation.remise',
            objectType: 'VehicleUsage',
            objectId: usage.id,
            companyId: v.companyId,
            reason: dto.readingException?.reason ?? dto.overrideReason ?? null,
            after: { vehicleId: v.id, driverId: d.id, checkedOutAt, expectedReturnAt, reading: dto.reading?.physicalKm ?? null, exception: Boolean(dto.readingException), overriddenBlockers: override ? blockers.map((b) => b.code) : [], reservationId: reservation?.id ?? null },
          }, tx);
          if (dto.readingException) {
            after.add('départ sans relevé → alerte persistante', async () => {
              await this.alerts.raise({
                organizationId: ctx.organizationId,
                companyId: v.companyId,
                type: 'DEPART_SANS_RELEVE',
                severity: 'URGENT',
                objectType: 'VehicleUsage',
                objectId: usage.id,
                vehicleId: v.id,
                occurrenceKey: 'depart',
                title: `Départ sans relevé — ${v.code}`,
                message: `Remise effectuée sans relevé du compteur (motif : ${dto.readingException?.reason ?? ''}). Distance indéterminée.`,
                condition: { usageId: usage.id, reason: dto.readingException?.reason },
                actionPath: `/utilisations/${usage.id}`,
              });
            });
          }
          return { usageId: usage.id, after };
        })
        .catch((error: unknown) => {
          throw mapUsageUniqueError(error);
        });
      await after.run();
      return { status: 201, body: await this.view(usageId), resourceId: usageId };
    });
    return result.body;
  }

  // ---------------------------------------------------------------------------
  // Restitution
  // ---------------------------------------------------------------------------

  async return(ctx: RequestContext, usageId: string, dto: ReturnDto, idempotencyKey: string): Promise<UsageViewDto> {
    const usage = await this.loadRef(ctx, usageId);
    this.access.requireOperational(ctx, usage.companyId);
    const returnedAt = new Date(dto.returnedAt);
    if (returnedAt.getTime() > this.clock.now().getTime() + FUTURE_TOLERANCE_MS) throw new BusinessRuleError('DATE_FUTURE', 'La date de retour ne peut pas être future.', { fieldErrors: { returnedAt: ['Date future refusée.'] } });
    if (returnedAt < usage.checkedOutAt) throw new BusinessRuleError('DATE_RETOUR', 'Le retour ne peut pas précéder la remise.', { fieldErrors: { returnedAt: ['Antérieur à la remise.'] } });
    if (!dto.reading && !dto.readingException) {
      throw new BusinessRuleError('RELEVE_REQUIS', 'Saisissez le relevé du compteur, ou constatez le retour sans relevé (chef ou administrateur) avec un motif.', { fieldErrors: { 'reading.physicalKm': ['Relevé requis.'] } });
    }
    if (dto.reading && dto.readingException) throw new BusinessRuleError('RELEVE_OU_EXCEPTION', 'Fournissez soit un relevé, soit un constat motivé, pas les deux.');
    if (dto.readingException) {
      this.access.requirePermission(ctx, usage.companyId, 'exceptions.override', 'Le constat de retour sans relevé est réservé au chef de parc ou à l’administrateur.');
    }
    const body = { ...dto, idempotencyKey: undefined };
    const result = await this.idempotency.run({ organizationId: ctx.organizationId, userId: ctx.userId, operation: `usage.return:${usageId}`, key: idempotencyKey }, body, async () => {
      const timezone = await this.timezone(ctx.organizationId);
      // Paramètres consultés par la restitution, son relevé, ses recalculs dépendants et sa vue : une lecture.
      await this.settings.prefetch(ctx.organizationId, [LATE_TOLERANCE_KEY, ...READING_SETTINGS], usage.companyId);
      // D-016 : READ COMMITTED sous verrous véhicule → conducteur → utilisation (13.3), lignes versionnées comme à
      // la remise ; statut et version relus sous verrou, relevé de retour par le service d'ingestion unique.
      const { after, damage } = await this.prisma.lockedReadCommitted(async (tx) => {
        const after = new AfterCommit();
        await lockVehicleForWrite(tx, usage.vehicleId);
        await lockDriverForWrite(tx, usage.driverId);
        // Statut et version relus sous verrou : deux retours concurrents ne produisent qu'une restitution.
        const fresh = await lockUsage(tx, usageId);
        if (fresh.status !== 'EN_COURS') throw new ConflictError('ETAT_INVALIDE', 'Cette utilisation est déjà terminée.');
        assertExpectedVersion(fresh, dto.expectedVersion, 'utilisation');
        const vehicle = await tx.vehicle.findUniqueOrThrow({ where: { id: fresh.vehicleId }, select: { id: true, companyId: true } });
        // Lieu obligatoire (D-134) : rapport RESTITUTION dans la même transaction, site contrôlé.
        await this.vehicles.recordLocation(tx, ctx, vehicle, { siteId: dto.location.siteId ?? null, placeLabel: dto.location.placeLabel ?? null, observedAt: returnedAt, context: 'RESTITUTION', usageId });
        let returnReadingId: string | null = null;
        let pendingReason: string | null = null;
        if (dto.reading) {
          const ingested = await this.ingestion.ingest(
            tx,
            { organizationId: ctx.organizationId, vehicleId: fresh.vehicleId, origin: 'MANUAL', context: 'RESTITUTION', measurementKind: 'COMPTEUR_AFFICHE', physicalKm: parseKm(dto.reading.physicalKm), observedAt: returnedAt, author: { kind: 'STAFF', userId: ctx.userId }, allowAutoInit: true },
            after,
          );
          // Seul un relevé existant rejoué (IDEMPOTENT) peut déjà être rattaché : un relevé créé par ce retour a un nouvel identifiant.
          if (ingested.outcome === 'IDEMPOTENT') {
            const linked = await tx.vehicleUsage.findFirst({ where: { id: { not: usageId }, OR: [{ checkoutReadingId: ingested.reading.id }, { returnReadingId: ingested.reading.id }] } });
            if (linked) throw new ConflictError('RELEVE_DEJA_UTILISE', 'Ce relevé est déjà rattaché à une autre utilisation.');
          }
          returnReadingId = ingested.reading.id;
          if (ingested.outcome === 'EN_ATTENTE') pendingReason = ingested.anomaly?.reason ?? 'relevé en attente de validation';
          if (dto.reading.attachmentId) {
            await this.attachments.attach(ctx, tx, dto.reading.attachmentId, 'RELEVE', ingested.reading.id, fresh.companyId);
            await tx.odometerReading.update({ where: { id: ingested.reading.id }, data: { attachmentId: dto.reading.attachmentId } });
          }
        }
        await tx.vehicleUsage.update({
          where: { id: usageId, version: fresh.version },
          data: {
            status: 'TERMINEE',
            returnedAt,
            returnReadingId,
            returnWithoutReading: Boolean(dto.readingException),
            returnExceptionReason: dto.readingException?.reason ?? null,
            returnFuelGauge: dto.fuelGauge ?? null,
            returnChecklist: (dto.checklist ?? []) as unknown as Prisma.InputJsonValue,
            returnNotes: dto.notes ?? null,
            returnConfirmedBy: dto.confirmedByName ?? null,
            returnedById: ctx.userId,
            version: { increment: 1 },
          },
        });
        const distance = await recomputeUsageDistance(tx, usageId);
        for (const photo of dto.photoAttachmentIds ?? []) await this.attachments.attach(ctx, tx, photo, 'UTILISATION', usageId, fresh.companyId);
        let damage: { id: string; reference: string } | null = null;
        if (dto.damageIncident) {
          // Le dommage constaté ouvre un incident DOMMAGE rattaché à l'utilisation ; le retour ne le clôture pas (4.4).
          const severity = dto.damageIncident.severity ?? 'MOYENNE';
          const incident = await this.incidents.insertInTx(tx, ctx, {
            companyId: fresh.companyId,
            vehicleId: fresh.vehicleId,
            driverId: fresh.driverId,
            usageId,
            type: 'DOMMAGE',
            severity,
            occurredAt: returnedAt,
            timezone,
            siteId: dto.location.siteId ?? null,
            locationLabel: dto.location.placeLabel ?? null,
            description: dto.damageIncident.description,
            followUpUserId: null,
            photoAttachmentIds: dto.damageIncident.photoAttachmentIds ?? [],
            audit: { usageId, source: 'restitution' },
          });
          damage = incident;
          const incidentId = incident.id;
          after.add('dommage à la restitution → alerte incident critique', () => this.incidents.syncCriticalAlert(incidentId));
        }
        await this.audit.record(ctx, {
          action: 'utilisation.restitution',
          objectType: 'VehicleUsage',
          objectId: usageId,
          companyId: fresh.companyId,
          reason: dto.readingException?.reason ?? null,
          after: { returnedAt, reading: dto.reading?.physicalKm ?? null, distanceStatus: distance.distanceStatus, distanceKm: distance.distanceKm, pendingReason, damageIncidentId: damage?.id ?? null },
        }, tx);
        after.add('restitution → alertes', async () => {
          const compromised = await this.prisma.client.alert.findMany({ where: { organizationId: ctx.organizationId, type: 'RESERVATION_COMPROMISE', status: 'ACTIVE', condition: { path: ['usageId'], equals: usageId } }, select: { id: true } });
          if (compromised.length) await this.prisma.client.alert.updateMany({ where: { id: { in: compromised.map((a) => a.id) } }, data: { status: 'RESOLUE', resolvedAt: this.clock.now(), resolutionReason: 'véhicule restitué' } });
          // Alertes de l'utilisation lues et écrites en lot (AlertsService.sync : mêmes règles que resolve / raise).
          await this.alerts.sync({
            resolutions: [
              { key: { organizationId: ctx.organizationId, type: 'RETOUR_DEPASSE', objectType: 'VehicleUsage', objectId: usageId }, reason: 'retour constaté' },
              { key: { organizationId: ctx.organizationId, type: 'DEPART_SANS_RELEVE', objectType: 'VehicleUsage', objectId: usageId }, reason: 'utilisation terminée' },
              { key: { organizationId: ctx.organizationId, type: 'IMMOBILISATION_PENDANT_UTILISATION', objectType: 'VehicleUsage', objectId: usageId }, reason: 'véhicule restitué' },
            ],
            raises: distance.distanceStatus === 'VALIDEE' ? [] : [{
              organizationId: ctx.organizationId,
              companyId: fresh.companyId,
              type: 'DISTANCE_NON_VALIDEE',
              severity: 'ATTENTION',
              objectType: 'VehicleUsage',
              objectId: usageId,
              vehicleId: fresh.vehicleId,
              occurrenceKey: 'retour',
              title: 'Distance non validée',
              message: dto.readingException ? `Retour constaté sans relevé (motif : ${dto.readingException.reason}).` : fresh.checkoutWithoutReading ? 'Départ sans relevé : distance indéterminée.' : `Relevé de retour à régulariser${pendingReason ? ` : ${pendingReason}` : ''}.`,
              condition: { usageId, distanceStatus: distance.distanceStatus },
              actionPath: `/utilisations/${usageId}`,
            }],
          });
        });
        return { after, damage };
      });
      await after.run();
      const view = await this.view(usageId);
      // L'incident créé par ce retour est renvoyé tel quel (identifiant et référence).
      return { status: 200, body: damage ? { ...view, damageIncident: damage } : view, resourceId: usageId };
    });
    return result.body;
  }

  /**
   * Régularisation du relevé de retour (CDC 4.4 : « distance non validée jusqu'à régularisation ») : après un
   * retour constaté sans relevé, ou dont le relevé a été rejeté, le chef rattache un relevé accepté — nouveau
   * relevé saisi a posteriori (service d'ingestion unique : chronologie, plausibilité) ou relevé accepté
   * existant du véhicule — observé entre le retour et la remise suivante. Transactionnelle (verrous véhicule →
   * conducteur → utilisation), idempotente (clé liée à l'utilisateur, à l'organisation et à l'utilisation),
   * versionnée et auditée ; la distance est recalculée et l'alerte DISTANCE_NON_VALIDEE résolue dans la même
   * transaction. Un relevé qui ne serait pas accepté (anomalie à valider) est refusé : rien n'est enregistré.
   */
  async regularizeReturnReading(ctx: RequestContext, usageId: string, dto: RegularizeReturnReadingDto, idempotencyKey: string): Promise<UsageViewDto> {
    const usage = await this.load(ctx, usageId);
    this.access.requireOperational(ctx, usage.companyId);
    this.access.requirePermission(ctx, usage.companyId, 'exceptions.override', 'La régularisation du relevé de retour est réservée au chef de parc ou à l’administrateur.');
    if (Boolean(dto.reading) === Boolean(dto.readingId)) {
      throw new BusinessRuleError('RELEVE_OU_EXISTANT', 'Indiquez soit un nouveau relevé, soit un relevé accepté existant.', { fieldErrors: { readingId: ['Un nouveau relevé ou un relevé existant, exclusivement.'] } });
    }
    const body = { ...dto, idempotencyKey: undefined };
    const result = await this.idempotency.run({ organizationId: ctx.organizationId, userId: ctx.userId, operation: `usage.return-reading:${usageId}`, key: idempotencyKey }, body, async () => {
      const after = await this.prisma.serializable(async (tx) => {
        const after = new AfterCommit();
        await lockVehicle(tx, usage.vehicleId);
        await lockDriver(tx, usage.driverId);
        const fresh = await lockUsage(tx, usageId);
        assertExpectedVersion(fresh, dto.expectedVersion, 'utilisation');
        const [checkout, current] = await Promise.all([
          fresh.checkoutReadingId ? tx.odometerReading.findUnique({ where: { id: fresh.checkoutReadingId }, select: { status: true } }) : null,
          fresh.returnReadingId ? tx.odometerReading.findUnique({ where: { id: fresh.returnReadingId }, select: { id: true, status: true, physicalKm: true } }) : null,
        ]);
        const block = returnRegularizationBlock({ status: fresh.status, checkoutWithoutReading: fresh.checkoutWithoutReading, checkoutReadingStatus: checkout?.status ?? null, returnReadingStatus: current?.status ?? null });
        if (block) throw regularizationError(block, current?.id ?? null);
        const returnedAt = fresh.returnedAt as Date;
        const now = this.clock.now();
        // Remise suivante du véhicule : borne de la période où le compteur n'a pas bougé depuis le retour.
        const next = await tx.vehicleUsage.findFirst({ where: { vehicleId: fresh.vehicleId, id: { not: fresh.id }, checkedOutAt: { gte: returnedAt } }, orderBy: { checkedOutAt: 'asc' }, select: { checkedOutAt: true } });
        const windowMessage = `Le relevé doit être observé entre le retour (${formatLocal(returnedAt, await this.timezone(ctx.organizationId))}) et la remise suivante du véhicule, jamais dans le futur.`;
        let reading: { id: string; physicalKm: Prisma.Decimal | null; observedAt: Date };
        let mode: 'NOUVEAU_RELEVE' | 'RELEVE_EXISTANT';
        if (dto.reading) {
          mode = 'NOUVEAU_RELEVE';
          const observedAt = dto.reading.observedAt ? new Date(dto.reading.observedAt) : returnedAt;
          if (!isInReturnRegularizationWindow(observedAt, returnedAt, next?.checkedOutAt ?? null, now)) {
            throw new BusinessRuleError('RELEVE_HORS_PERIODE', windowMessage, { fieldErrors: { 'reading.observedAt': [windowMessage] } });
          }
          const ingested = await this.ingestion.ingest(
            tx,
            { organizationId: ctx.organizationId, vehicleId: fresh.vehicleId, origin: 'MANUAL', context: 'RESTITUTION', measurementKind: 'COMPTEUR_AFFICHE', physicalKm: parseKm(dto.reading.physicalKm, 'reading.physicalKm'), observedAt, author: { kind: 'STAFF', userId: ctx.userId }, note: 'Régularisation du relevé de retour', allowAutoInit: false },
            after,
          );
          if (ingested.reading.status !== 'ACCEPTE') {
            const reason = ingested.anomaly?.reason ?? ingested.reading.statusReason ?? 'relevé à valider';
            throw new BusinessRuleError('RELEVE_NON_ACCEPTE', `Le relevé doit être accepté pour régulariser la distance : ${reason}`, { fieldErrors: { 'reading.physicalKm': [reason] } });
          }
          reading = ingested.reading;
          if (dto.reading.attachmentId) {
            await this.attachments.attach(ctx, tx, dto.reading.attachmentId, 'RELEVE', reading.id, fresh.companyId);
            await tx.odometerReading.update({ where: { id: reading.id }, data: { attachmentId: dto.reading.attachmentId } });
          }
        } else {
          mode = 'RELEVE_EXISTANT';
          const existing = await tx.odometerReading.findFirst({ where: { id: dto.readingId as string, organizationId: ctx.organizationId, vehicleId: fresh.vehicleId } });
          if (!existing || !this.access.canReadCompany(ctx, existing.companyId)) throw new NotFoundOrOutOfScopeError('Relevé');
          if (existing.status !== 'ACCEPTE' || existing.isEstimate || existing.measurementKind === 'DISTANCE_GPS') {
            throw new BusinessRuleError('RELEVE_NON_ACCEPTE', 'Seul un relevé de compteur accepté (hors estimation GPS) peut régulariser la distance.', { fieldErrors: { readingId: ['Relevé non accepté ou estimé.'] } });
          }
          if (!isInReturnRegularizationWindow(existing.observedAt, returnedAt, next?.checkedOutAt ?? null, now)) {
            throw new BusinessRuleError('RELEVE_HORS_PERIODE', windowMessage, { fieldErrors: { readingId: [windowMessage] } });
          }
          reading = existing;
        }
        const linked = await tx.vehicleUsage.findFirst({ where: { id: { not: usageId }, OR: [{ checkoutReadingId: reading.id }, { returnReadingId: reading.id }] }, select: { id: true } });
        if (linked) throw new ConflictError('RELEVE_DEJA_UTILISE', 'Ce relevé est déjà rattaché à une autre remise ou restitution.', { usageId: linked.id });
        await tx.vehicleUsage.update({ where: { id: usageId, version: fresh.version }, data: { returnReadingId: reading.id, version: { increment: 1 } } });
        const distance = await recomputeUsageDistance(tx, usageId);
        if (distance.distanceStatus !== 'VALIDEE') {
          throw new BusinessRuleError('DISTANCE_INVALIDE', 'Le relevé indiqué ne permet pas de valider la distance (inférieur au relevé de départ).', { fieldErrors: { [dto.reading ? 'reading.physicalKm' : 'readingId']: ['Inférieur au relevé de départ.'] } });
        }
        await this.alerts.resolve({ organizationId: ctx.organizationId, type: 'DISTANCE_NON_VALIDEE', objectType: 'VehicleUsage', objectId: usageId }, 'relevé de retour régularisé', tx);
        await this.audit.record(ctx, {
          action: 'utilisation.regularisation_releve_retour',
          objectType: 'VehicleUsage',
          objectId: usageId,
          companyId: fresh.companyId,
          reason: dto.reason,
          before: { returnReadingId: current?.id ?? null, returnReadingStatus: current?.status ?? null, returnWithoutReading: fresh.returnWithoutReading, distanceStatus: fresh.distanceStatus },
          after: { returnReadingId: reading.id, mode, physicalKm: reading.physicalKm?.toString() ?? null, observedAt: reading.observedAt, distanceStatus: distance.distanceStatus, distanceKm: distance.distanceKm },
        }, tx);
        return after;
      });
      await after.run();
      return { status: 200, body: await this.view(usageId), resourceId: usageId };
    });
    return result.body;
  }

  /**
   * Prolongation du retour prévu, motivée (D-135) : ne clôture rien et ne masque pas un retard passé.
   * Transaction sérialisable, verrous véhicule → conducteur → utilisation, version contrôlée sous verrou,
   * refus si le nouveau créneau chevauche la réservation CONFIRMEE d'autrui (D-138, D-140).
   */
  async extend(ctx: RequestContext, usageId: string, dto: ExtendUsageDto): Promise<UsageViewDto> {
    const usage = await this.load(ctx, usageId);
    this.access.requireOperational(ctx, usage.companyId);
    const next = new Date(dto.expectedReturnAt);
    await this.prisma.serializable(async (tx) => {
      await lockVehicle(tx, usage.vehicleId);
      await lockDriver(tx, usage.driverId);
      const fresh = await lockUsage(tx, usageId);
      if (fresh.status !== 'EN_COURS') throw new ConflictError('ETAT_INVALIDE', 'Utilisation déjà terminée : la prolongation est impossible.');
      assertExpectedVersion(fresh, dto.expectedVersion, 'utilisation');
      if (next <= fresh.checkedOutAt) throw new BusinessRuleError('DATE_RETOUR', 'Le retour prévu doit suivre la remise.', { fieldErrors: { expectedReturnAt: ['Doit suivre la remise.'] } });
      const now = this.clock.now();
      // Occupation réelle après prolongation : [remise, max(nouveau retour prévu, maintenant)[ (D-140).
      const conflicts = await this.conflictingReservations(tx, fresh.vehicleId, fresh.driverId, fresh.checkedOutAt, occupancyEnd(next, now));
      if (conflicts.length > 0) {
        throw new ConflictError(ErrorCodes.RESERVATION_CONFLIT, 'La prolongation chevauche une réservation confirmée d’un autre conducteur ou d’un autre véhicule : modifiez ou annulez cette réservation, ou choisissez une échéance antérieure.', { reservations: conflicts });
      }
      await tx.vehicleUsage.update({ where: { id: usageId, version: fresh.version }, data: { expectedReturnAt: next, version: { increment: 1 } } });
      await this.audit.record(ctx, { action: 'utilisation.prolongation', objectType: 'VehicleUsage', objectId: usageId, companyId: fresh.companyId, reason: dto.reason, before: { expectedReturnAt: fresh.expectedReturnAt }, after: { expectedReturnAt: next } }, tx);
      // D-135 : une échéance qui n'est plus dépassée (future, ou dans la tolérance) résout aussitôt l'alerte de retard.
      const tolerance = await this.settings.get(ctx.organizationId, LATE_TOLERANCE_KEY, fresh.companyId, tx);
      if (!isReturnLate({ status: fresh.status, expectedReturnAt: next }, now, tolerance)) {
        await this.alerts.resolve({ organizationId: ctx.organizationId, type: 'RETOUR_DEPASSE', objectType: 'VehicleUsage', objectId: usageId }, 'retour prévu prolongé', tx);
        // 4.5 : les réservations signalées compromises par ce retard ne le sont plus (aucune réservation
        // confirmée d'autrui ne chevauche la nouvelle occupation, contrôlé ci-dessus).
        const compromised = await tx.alert.findMany({ where: { organizationId: ctx.organizationId, type: 'RESERVATION_COMPROMISE', objectType: 'Reservation', occurrenceKey: usageId, status: 'ACTIVE' }, select: { objectId: true } });
        for (const a of compromised) {
          await this.alerts.resolve({ organizationId: ctx.organizationId, type: 'RESERVATION_COMPROMISE', objectType: 'Reservation', objectId: a.objectId, occurrenceKey: usageId }, 'retour prévu prolongé avant la réservation', tx);
        }
      }
    });
    return this.view(usageId);
  }

  // ---------------------------------------------------------------------------
  // Consultation
  // ---------------------------------------------------------------------------

  async list(ctx: RequestContext, query: UsagesQueryDto): Promise<Page<UsageViewDto>> {
    const now = this.clock.now();
    // Le périmètre (conducteur ou sociétés) est une clause séparée que les filtres ne peuvent pas remplacer.
    const scope: Prisma.VehicleUsageWhereInput = ctx.isDriverOnly ? { organizationId: ctx.organizationId, driverId: ctx.driverId ?? '00000000-0000-0000-0000-000000000000' } : { ...this.access.companyWhere(ctx, query.companyId) };
    const filters: Prisma.VehicleUsageWhereInput[] = [];
    if (query.vehicleId) filters.push({ vehicleId: query.vehicleId });
    if (query.driverId) filters.push({ driverId: query.driverId });
    if (query.status) filters.push({ status: query.status });
    // Retard : même borne que isLate et que l'alerte RETOUR_DEPASSE (tolérance par société, usage-rules).
    if (query.late === 'true') filters.push(await this.lateWhere(ctx.organizationId, now));
    // Retours attendus (D-269) : retour prévu au plus tard à la fin de la journée locale, retards compris.
    if (query.returnDue === 'true') filters.push({ status: 'EN_COURS', expectedReturnAt: { lte: returnDueBefore(now, await this.timezone(ctx.organizationId)) } });
    if (query.from) filters.push({ checkedOutAt: { gte: new Date(query.from) } });
    if (query.to) filters.push({ checkedOutAt: { lte: new Date(query.to) } });
    const where: Prisma.VehicleUsageWhereInput = { AND: [scope, ...filters] };
    const [items, total] = await Promise.all([
      this.prisma.client.vehicleUsage.findMany({ where, ...skipTake(query), orderBy: [{ status: 'asc' }, { checkedOutAt: 'desc' }], include: usageInclude }),
      this.prisma.client.vehicleUsage.count({ where }),
    ]);
    return pageOf(await this.views(items), total, query);
  }

  async get(ctx: RequestContext, id: string): Promise<UsageViewDto> {
    await this.load(ctx, id);
    return this.view(id);
  }

  async load(ctx: RequestContext, id: string): Promise<UsageRow> {
    const u = await this.prisma.client.vehicleUsage.findFirst({ where: { id, organizationId: ctx.organizationId }, include: usageInclude });
    this.assertUsageVisible(ctx, u);
    return u;
  }

  /** Même contrôle de visibilité que load, en une lecture sans les relations de la vue (mutations). */
  private async loadRef(ctx: RequestContext, id: string): Promise<Pick<VehicleUsage, 'id' | 'companyId' | 'vehicleId' | 'driverId' | 'checkedOutAt'>> {
    const u = await this.prisma.client.vehicleUsage.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { id: true, companyId: true, vehicleId: true, driverId: true, checkedOutAt: true } });
    this.assertUsageVisible(ctx, u);
    return u;
  }

  private assertUsageVisible<T extends { companyId: string; driverId: string }>(ctx: RequestContext, u: T | null): asserts u is T {
    if (!u) throw new NotFoundOrOutOfScopeError('Utilisation');
    if (ctx.isDriverOnly) {
      if (u.driverId !== ctx.driverId) throw new NotFoundOrOutOfScopeError('Utilisation');
    } else if (!this.access.canReadCompany(ctx, u.companyId)) {
      throw new NotFoundOrOutOfScopeError('Utilisation');
    }
  }

  // ---------------------------------------------------------------------------
  // Rattrapage : retours dépassés et réservations compromises (T07)
  // ---------------------------------------------------------------------------

  /** Évalue les retours dépassés et signale les réservations suivantes affectées. Idempotent (déduplication). */
  async evaluateLateReturns(organizationId?: string): Promise<{ late: number; compromised: number }> {
    const now = this.clock.now();
    const open = await this.prisma.client.vehicleUsage.findMany({
      where: { status: 'EN_COURS', ...(organizationId ? { organizationId } : {}) },
      include: { vehicle: { select: { code: true } }, driver: { select: { firstName: true, lastName: true } } },
    });
    let late = 0;
    let compromised = 0;
    const tolerances = new Map<string, number>();
    // Textes des alertes datés dans le fuseau du groupe (jamais un horodatage UTC brut).
    const timezones = new Map<string, string>();
    const timezoneOf = async (organizationId: string): Promise<string> => {
      let timezone = timezones.get(organizationId);
      if (timezone === undefined) {
        timezone = (await this.prisma.client.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } })).timezone;
        timezones.set(organizationId, timezone);
      }
      return timezone;
    };
    for (const u of open) {
      const toleranceKey = `${u.organizationId}:${u.companyId}`;
      let toleranceMin = tolerances.get(toleranceKey);
      if (toleranceMin === undefined) {
        toleranceMin = await this.settings.get(u.organizationId, LATE_TOLERANCE_KEY, u.companyId);
        tolerances.set(toleranceKey, toleranceMin);
      }
      if (!isReturnLate(u, now, toleranceMin)) {
        await this.alerts.resolve({ organizationId: u.organizationId, type: 'RETOUR_DEPASSE', objectType: 'VehicleUsage', objectId: u.id }, 'retour prévu non dépassé');
        continue;
      }
      late += 1;
      const hours = Math.floor((now.getTime() - u.expectedReturnAt.getTime()) / 3_600_000);
      const timezone = await timezoneOf(u.organizationId);
      await this.alerts.raise({
        organizationId: u.organizationId,
        companyId: u.companyId,
        type: 'RETOUR_DEPASSE',
        severity: hours >= 24 ? 'CRITIQUE' : 'URGENT',
        objectType: 'VehicleUsage',
        objectId: u.id,
        vehicleId: u.vehicleId,
        occurrenceKey: u.expectedReturnAt.toISOString(),
        title: `Retour dépassé — ${u.vehicle.code}`,
        message: `Retour prévu le ${formatLocalDateTime(u.expectedReturnAt, timezone, { sentence: true })} ; ${u.driver.firstName} ${u.driver.lastName} n’a pas encore restitué le véhicule. L’utilisation reste ouverte.`,
        condition: { usageId: u.id, expectedReturnAt: u.expectedReturnAt.toISOString(), lateHours: hours },
        actionPath: `/utilisations/${u.id}`,
      });
      // Une prolongation encore dépassée remplace l'occurrence précédente (une seule alerte active par utilisation).
      await this.alerts.resolveOtherOccurrences({ organizationId: u.organizationId, type: 'RETOUR_DEPASSE', objectType: 'VehicleUsage', objectId: u.id }, u.expectedReturnAt.toISOString(), 'retour prévu modifié');
      const horizon = new Date(now.getTime() + 24 * 3_600_000);
      const next = await this.prisma.client.reservation.findMany({
        where: { vehicleId: u.vehicleId, status: 'CONFIRMEE', endAt: { gt: now }, startAt: { lte: horizon } },
        include: { driver: { select: { firstName: true, lastName: true } } },
      });
      for (const r of next) {
        compromised += 1;
        await this.alerts.raise({
          organizationId: r.organizationId,
          companyId: r.companyId,
          type: 'RESERVATION_COMPROMISE',
          severity: r.startAt <= now ? 'CRITIQUE' : 'URGENT',
          objectType: 'Reservation',
          objectId: r.id,
          vehicleId: r.vehicleId,
          occurrenceKey: u.id,
          title: `Réservation compromise — ${u.vehicle.code}`,
          message: `La réservation de ${r.driver.firstName} ${r.driver.lastName} du ${formatLocalDateTime(r.startAt, timezone, { sentence: true })} est compromise : le véhicule n’est pas encore restitué.`,
          condition: { usageId: u.id, reservationId: r.id, reservationStartAt: r.startAt.toISOString() },
          actionPath: `/planning?reservation=${r.id}`,
        });
      }
    }
    return { late, compromised };
  }

  // ---------------------------------------------------------------------------

  private enforceBlockers(ctx: RequestContext, companyId: string, blockers: DepartureBlocker[], overrideReason: string | undefined): void {
    const hard = blockers.filter((b) => !b.overridable);
    if (hard.length > 0) {
      const concurrency = hard.find((b) => b.code === ErrorCodes.VEHICULE_DEJA_EN_UTILISATION || b.code === ErrorCodes.CONDUCTEUR_DEJA_EN_UTILISATION);
      if (concurrency) throw new ConflictError(concurrency.code, concurrency.message, { blockers: hard });
      // CDC 15.1 : un véhicule HORS_SERVICE, CEDE ou ARCHIVE est un conflit d'état (409), pas une saisie invalide.
      const inactive = hard.find((b) => b.code === VEHICLE_NOT_ACTIVE);
      if (inactive) throw new ConflictError(VEHICLE_NOT_ACTIVE, hard.map((b) => b.message).join(' '), { blockers: hard });
      throw new BusinessRuleError('DEPART_BLOQUE', hard.map((b) => b.message).join(' '), { details: { blockers: hard } });
    }
    const soft = blockers.filter((b) => b.overridable);
    if (soft.length > 0) {
      if (!overrideReason) throw new BusinessRuleError('DEPART_BLOQUE', `${soft.map((b) => b.message).join(' ')} Une dérogation motivée est nécessaire.`, { details: { blockers: soft, overridable: true } });
      this.access.requirePermission(ctx, companyId, 'exceptions.override', 'La dérogation requiert la permission exceptions.override.');
    }
  }

  /**
   * Réservations CONFIRMEE d'autrui (autre conducteur sur ce véhicule, ou ce conducteur sur un autre
   * véhicule) dont le créneau [début, fin[ chevauche [from, to[ (4.5, D-140). Une réservation du même
   * couple véhicule/conducteur n'entre pas en conflit : elle est convertible.
   */
  private async conflictingReservations(tx: Tx, vehicleId: string, driverId: string, from: Date, to: Date): Promise<ConflictingReservation[]> {
    const rows = await tx.reservation.findMany({
      where: { status: 'CONFIRMEE', startAt: { lt: to }, endAt: { gt: from }, OR: [{ vehicleId }, { driverId }], NOT: { vehicleId, driverId } },
      include: { driver: { select: { firstName: true, lastName: true } } },
      orderBy: { startAt: 'asc' },
    });
    return rows.map((r) => ({ id: r.id, startAt: r.startAt.toISOString(), endAt: r.endAt.toISOString(), driverName: `${r.driver.firstName} ${r.driver.lastName}` }));
  }

  /**
   * Réservation convertie par la remise (D-140, D-142). Explicite : confirmée, même couple et départ dans
   * [début − reservations.conversionEarlyMinutes, fin[, sinon refus explicite. Implicite : la réservation
   * CONFIRMEE du même couple dont la fenêtre contient le départ, s'il en existe une.
   */
  private async reservationToConvert(ctx: RequestContext, tx: Tx, vehicle: { id: string; companyId: string }, driverId: string, checkedOutAt: Date, reservationId: string | null, timezone: string): Promise<ConvertibleReservation | null> {
    const early = await this.settings.get(ctx.organizationId, 'reservations.conversionEarlyMinutes', vehicle.companyId, tx);
    // Réservations lues sous verrou de ligne (après véhicule et conducteur, 13.3) : une annulation ou une
    // non-présentation concurrente (qui verrouille la réservation) précède ou suit entièrement la conversion.
    if (!reservationId) {
      const candidates = await tx.$queryRaw<ConvertibleReservation[]>`
        SELECT "id", "companyId", "vehicleId", "driverId", "status"::text AS "status", "startAt", "endAt", "version" FROM "Reservation"
        WHERE "organizationId" = ${ctx.organizationId}::uuid AND "vehicleId" = ${vehicle.id}::uuid AND "driverId" = ${driverId}::uuid
          AND "status" = 'CONFIRMEE'::"ReservationStatus" AND "endAt" > ${checkedOutAt}::timestamptz
        ORDER BY "id" FOR UPDATE`;
      return pickReservationToConvert(candidates, checkedOutAt, early);
    }
    const [reservation] = await tx.$queryRaw<ConvertibleReservation[]>`
      SELECT "id", "companyId", "vehicleId", "driverId", "status"::text AS "status", "startAt", "endAt", "version" FROM "Reservation"
      WHERE "id" = ${reservationId}::uuid AND "organizationId" = ${ctx.organizationId}::uuid FOR UPDATE`;
    if (!reservation || !this.access.canReadCompany(ctx, reservation.companyId)) throw new NotFoundOrOutOfScopeError('Réservation');
    if (reservation.status !== 'CONFIRMEE') {
      throw new ConflictError('ETAT_INVALIDE', `Seule une réservation confirmée peut être convertie (statut actuel : ${RESERVATION_STATUS_LABELS[reservation.status].toLowerCase()}).`, { reservationId: reservation.id, status: reservation.status });
    }
    if (reservation.vehicleId !== vehicle.id || reservation.driverId !== driverId) {
      throw new BusinessRuleError('RESERVATION_DIFFERENTE', 'La réservation concerne un autre véhicule ou un autre conducteur : cette remise ne peut pas la convertir.', { fieldErrors: { reservationId: ['Autre véhicule ou autre conducteur.'] } });
    }
    if (!isInConversionWindow(reservation, checkedOutAt, early)) {
      const window = conversionWindow(reservation, early);
      throw new BusinessRuleError(
        'RESERVATION_HORS_FENETRE',
        `La remise du ${formatLocal(checkedOutAt, timezone)} est hors de la fenêtre de conversion de cette réservation : départ possible à partir du ${formatLocal(window.opensAt, timezone)} (${early} min avant le début prévu) et avant sa fin prévue, le ${formatLocal(window.closesAt, timezone)}.`,
        { fieldErrors: { reservationId: ['Remise hors de la fenêtre de conversion de la réservation.'] }, details: { reservationId: reservation.id, windowStart: window.opensAt.toISOString(), windowEnd: window.closesAt.toISOString(), conversionEarlyMinutes: early } },
      );
    }
    return reservation;
  }

  /** Tolérance de retard (usage.lateReturnToleranceMinutes) effective pour chaque société. */
  private async lateTolerances(organizationId: string, companyIds: readonly string[]): Promise<Map<string, number>> {
    const entries = await Promise.all([...new Set(companyIds)].map(async (companyId) => [companyId, await this.settings.get(organizationId, LATE_TOLERANCE_KEY, companyId)] as const));
    return new Map(entries);
  }

  /** Filtre SQL du retard : pour chaque société, retour prévu strictement antérieur à lateReturnCutoff(now, tolérance). */
  private async lateWhere(organizationId: string, now: Date): Promise<Prisma.VehicleUsageWhereInput> {
    const companies = await this.prisma.client.company.findMany({ where: { organizationId }, select: { id: true } });
    const tolerances = await this.lateTolerances(organizationId, companies.map((c) => c.id));
    const byTolerance = new Map<number, string[]>();
    for (const [companyId, tolerance] of tolerances) byTolerance.set(tolerance, [...(byTolerance.get(tolerance) ?? []), companyId]);
    return { status: 'EN_COURS', OR: [...byTolerance].map(([tolerance, companyIds]) => ({ companyId: { in: companyIds }, expectedReturnAt: { lt: lateReturnCutoff(now, tolerance) } })) };
  }

  private validateTimes(checkedOutAt: Date, expectedReturnAt: Date): void {
    if (checkedOutAt.getTime() > this.clock.now().getTime() + FUTURE_TOLERANCE_MS) throw new BusinessRuleError('DATE_FUTURE', 'La remise ne peut pas être datée dans le futur.', { fieldErrors: { checkedOutAt: ['Date future refusée.'] } });
    if (expectedReturnAt <= checkedOutAt) throw new BusinessRuleError('DATE_RETOUR', 'Le retour prévu doit suivre la remise.', { fieldErrors: { expectedReturnAt: ['Doit suivre la remise.'] } });
  }

  private async timezone(organizationId: string): Promise<string> {
    return organizationTimezone(this.prisma.client, organizationId);
  }

  async view(id: string): Promise<UsageViewDto> {
    const u = await this.prisma.client.vehicleUsage.findUniqueOrThrow({ where: { id }, include: usageInclude });
    return (await this.views([u]))[0] as UsageViewDto;
  }

  private async views(items: UsageRow[]): Promise<UsageViewDto[]> {
    const now = this.clock.now();
    const tolerances = items.length ? await this.lateTolerances((items[0] as UsageRow).organizationId, items.map((u) => u.companyId)) : new Map<string, number>();
    const userIds = [...new Set(items.flatMap((u) => [u.checkedOutById, u.returnedById]).filter((x): x is string => Boolean(x)))];
    const users = userIds.length ? await this.prisma.client.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true } }) : [];
    const photos = items.length ? await this.prisma.client.attachment.findMany({ where: { ownerType: 'UTILISATION', ownerId: { in: items.map((u) => u.id) }, deletedAt: null }, select: { id: true, ownerId: true } }) : [];
    const name = (id: string | null) => {
      const u = users.find((x) => x.id === id);
      return u ? `${u.firstName} ${u.lastName}` : null;
    };
    const readingView = (r: UsageRow['checkoutReading']) => (r ? { id: r.id, physicalKm: r.physicalKm?.toFixed(3) ?? null, cumulativeKm: r.cumulativeKm?.toFixed(3) ?? null, status: r.status, observedAt: r.observedAt.toISOString() } : null);
    // Incident ouvert par la restitution (créé en DOMMAGE) : même utilisation, daté du retour, créé par l'auteur
    // du retour. Aucune colonne ne porte ce lien en base : il est déduit de ces trois critères.
    const returnDamage = (u: UsageRow) => {
      const returnedAt = u.returnedAt;
      if (!returnedAt) return null;
      const incident = u.incidents.find((i) => i.occurredAt.getTime() === returnedAt.getTime() && i.createdById === u.returnedById);
      return incident ? { id: incident.id, reference: incident.reference } : null;
    };
    const place = (u: UsageRow, ctxName: 'REMISE' | 'RESTITUTION') => {
      const l = u.locationReports.find((x) => x.context === ctxName);
      return l ? (l.site?.name ?? l.placeLabel) : null;
    };
    return items.map((u) => ({
      id: u.id,
      companyId: u.companyId,
      vehicleId: u.vehicleId,
      vehicleCode: u.vehicle.code,
      vehicleRegistration: u.vehicle.registration,
      driverId: u.driverId,
      driverName: `${u.driver.firstName} ${u.driver.lastName}`,
      status: u.status,
      purpose: u.purpose,
      checkedOutAt: u.checkedOutAt.toISOString(),
      expectedReturnAt: u.expectedReturnAt.toISOString(),
      returnedAt: u.returnedAt?.toISOString() ?? null,
      isLate: isReturnLate(u, now, tolerances.get(u.companyId) as number),
      checkoutReading: readingView(u.checkoutReading),
      returnReading: readingView(u.returnReading),
      checkoutWithoutReading: u.checkoutWithoutReading,
      checkoutExceptionReason: u.checkoutExceptionReason,
      returnWithoutReading: u.returnWithoutReading,
      returnExceptionReason: u.returnExceptionReason,
      documentOverrideReason: u.documentOverrideReason,
      distanceStatus: u.distanceStatus,
      distanceKm: u.distanceKm?.toFixed(3) ?? null,
      checkoutFuelGauge: u.checkoutFuelGauge,
      returnFuelGauge: u.returnFuelGauge,
      checkoutChecklist: u.checkoutChecklist,
      returnChecklist: u.returnChecklist,
      checkoutNotes: u.checkoutNotes,
      returnNotes: u.returnNotes,
      checkoutConfirmedBy: u.checkoutConfirmedBy,
      returnConfirmedBy: u.returnConfirmedBy,
      reservationId: u.reservation?.id ?? null,
      checkoutLocation: place(u, 'REMISE'),
      returnLocation: place(u, 'RESTITUTION'),
      damageIncident: returnDamage(u),
      returnReadingRegularizable:
        returnRegularizationBlock({ status: u.status, checkoutWithoutReading: u.checkoutWithoutReading, checkoutReadingStatus: u.checkoutReading?.status ?? null, returnReadingStatus: u.returnReading?.status ?? null }) === null,
      photoAttachmentIds: photos.filter((p) => p.ownerId === u.id).map((p) => p.id),
      checkedOutByName: name(u.checkedOutById),
      returnedByName: name(u.returnedById),
      version: u.version,
    }));
  }
}

/** Date et heure locales de l'organisation pour les messages (jj/mm/aaaa à hh:mm). */
function formatLocal(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant, { zone: timezone }).setLocale('fr').toFormat("dd/MM/yyyy 'à' HH:mm");
}

/** Refus lisible d'une régularisation impossible (409 pour un état, 422 pour une règle métier). */
function regularizationError(block: ReturnRegularizationBlock, returnReadingId: string | null): Error {
  switch (block) {
    case 'NON_RESTITUEE':
      return new ConflictError('ETAT_INVALIDE', 'Le véhicule n’est pas encore restitué : saisissez le relevé lors de l’enregistrement du retour.');
    case 'DEJA_VALIDEE':
      return new ConflictError('ETAT_INVALIDE', 'Le relevé de retour est déjà accepté : la distance est validée.');
    case 'RELEVE_EN_ATTENTE':
      return new ConflictError('RELEVE_EN_ATTENTE', 'Le relevé de retour est en attente de validation : validez-le ou rejetez-le dans la file de validation avant toute régularisation.', { readingId: returnReadingId });
    case 'DEPART_SANS_RELEVE':
      return new BusinessRuleError('DEPART_SANS_RELEVE', 'Départ sans relevé accepté : la distance reste indéterminée et aucun relevé de retour ne peut la valider.');
  }
}

function mapUsageUniqueError(error: unknown): unknown {
  if (isUniqueViolation(error, 'usage_one_open_per_vehicle')) return new ConflictError(ErrorCodes.VEHICULE_DEJA_EN_UTILISATION, 'Le véhicule est déjà en utilisation.');
  if (isUniqueViolation(error, 'usage_one_open_per_driver')) return new ConflictError(ErrorCodes.CONDUCTEUR_DEJA_EN_UTILISATION, 'Le conducteur a déjà une utilisation en cours.');
  return error;
}
