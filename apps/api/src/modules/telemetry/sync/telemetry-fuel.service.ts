import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { AlertType, FuelEvent, FuelEventType, FuelMeasureKind, Prisma } from '@parc-auto/db';
import { FUEL_EVENT_TYPE_LABELS, FUEL_MEASURE_KIND_LABELS } from '@parc-auto/contracts';
import { Clock } from '../../../common/clock.js';
import { BusinessRuleError, NotFoundOrOutOfScopeError } from '../../../common/errors.js';
import { assertExpectedVersion } from '../../../common/optimistic-lock.js';
import { type Page, pageOf, skipTake } from '../../../common/pagination.js';
import type { RequestContext } from '../../../common/request-context.js';
import { describeErrorSafely } from '../../../common/secret-redaction.js';
import { type FuelEpisode, type FuelPoint, detectFuelEpisodes, episodeDedupeKey, matchTicket } from '../../../domain/telemetry/fuel-events.js';
import { type VehicleFuelThresholdValues, applyVehicleFuelThresholds } from '../../../domain/telemetry/fuel-thresholds.js';
import { AuditService } from '../../../infra/audit.service.js';
import { PrismaService, isUniqueViolation } from '../../../infra/prisma.service.js';
import { AccessControlService } from '../../access-control/access-control.service.js';
import { AlertsService } from '../../alerts/alerts.service.js';
import { dec } from '../../odometer/odometer-ingestion.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { TelemetryProvidersService } from '../telemetry-providers.service.js';
import type { FuelEventViewDto, FuelEventsQueryDto, QualifyFuelEventDto } from './dto/telemetry-sync.dto.js';
import { type NormalizedFuelSample, downsampleFuel, fuelBucket } from './telemetry-samples.js';
import { type MappedUnit, type RunCounters, type RunScope, type SyncMapping, countError, countIssue, coveringMapping, vehicleActiveAt } from './telemetry-sync.types.js';

export const FUEL_EVENT_OBJECT = 'FuelEvent';
const ALERT_OCCURRENCE = 'a-qualifier';
/** Fenêtre de rapprochement tardif d'un remplissage sans ticket (ticket saisi après la détection). */
const REMATCH_DAYS = 7;
const DAY_MS = 86_400_000;

const ALERT_BY_EVENT: Readonly<Record<FuelEventType, AlertType>> = {
  BAISSE_ANORMALE: 'CARBURANT_BAISSE_ANORMALE',
  REMPLISSAGE_DETECTE: 'CARBURANT_REMPLISSAGE_DETECTE',
  ECART_TICKET: 'CARBURANT_ECART_TICKET',
};

const eventInclude = { vehicle: { select: { code: true, registration: true } } } satisfies Prisma.FuelEventInclude;
type EventRow = Prisma.FuelEventGetPayload<{ include: typeof eventInclude }>;

interface FuelPolicy {
  stepMinutes: number;
  drop: { liters: number; percent: number; windowMinutes: number };
  refill: { liters: number; percent: number; windowMinutes: number };
  ticket: { windowHours: number; toleranceLiters: number; tolerancePercent: number };
}

/**
 * Carburant télématique (CDC 8.5 ; D-234 à D-242) :
 *  - échantillons stockés au plus un par unité, nature et tranche de telemetry.fuelSampleStepMinutes
 *    (FuelLevelSample), sous une association confirmée couvrant l'instant et pour les natures retenues ;
 *  - détection sur les échantillons bruts du lot, complétés des échantillons stockés pour la continuité
 *    (detectFuelEpisodes : baisse anormale moteur coupé sur sonde, remplissage) ; chaque épisode devient
 *    au plus un FuelEvent (clé episodeDedupeKey, T36) ;
 *  - remplissage rapproché des pleins saisis (matchTicket) : rapproché → qualifié JUSTIFIE
 *    automatiquement (audit) ; sans ticket → REMPLISSAGE_DETECTE à qualifier ; litres hors tolérance →
 *    ECART_TICKET à qualifier ; baisse anormale → BAISSE_ANORMALE à qualifier ; alertes CARBURANT_* ;
 *  - aucune dépense, responsabilité ni retenue n'est jamais créée : seul le chef qualifie.
 */
@Injectable()
export class TelemetryFuelService {
  private readonly logger = new Logger('TelemetrieCarburant');

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly providers: TelemetryProvidersService,
    private readonly settings: SettingsService,
    private readonly alerts: AlertsService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------------------------------
  // Ingestion (worker ou synchronisation manuelle)
  // ------------------------------------------------------------------------------------------

  async process(scope: RunScope, units: ReadonlyMap<string, MappedUnit>, samples: readonly NormalizedFuelSample[], counters: RunCounters): Promise<void> {
    if (samples.length === 0) return;
    const policy = await this.policy(scope.organizationId, scope.companyId);
    const byUnit = new Map<string, NormalizedFuelSample[]>();
    for (const s of samples) byUnit.set(s.unitExternalId, [...(byUnit.get(s.unitExternalId) ?? []), s]);
    for (const [externalId, unitSamples] of byUnit) {
      const unit = units.get(externalId);
      if (!unit) continue;
      try {
        await this.processUnit(scope, unit, unitSamples, policy, counters);
      } catch (error) {
        countError(counters, `erreur technique carburant : ${describeErrorSafely(error, [], 160)}`);
        this.logger.error(`Ingestion carburant de l’unité ${unit.unitId} en échec : ${describeErrorSafely(error)}`);
      }
    }
  }

  private async processUnit(scope: RunScope, unit: MappedUnit, unitSamples: NormalizedFuelSample[], policy: FuelPolicy, counters: RunCounters): Promise<void> {
    // Couverture : association confirmée à l'instant, nature retenue par le chef, véhicule actif.
    const accepted: Array<{ sample: NormalizedFuelSample; mapping: SyncMapping }> = [];
    for (const sample of unitSamples) {
      const mapping = coveringMapping(unit.mappings, sample.observedAt);
      if (!mapping) countIssue(counters, 'échantillon carburant hors période d’association (ignoré)');
      else if (!mapping.fuelKinds.includes(sample.kind)) countIssue(counters, `nature carburant ${sample.kind} non retenue pour l’association (ignorée)`);
      else if (!vehicleActiveAt(mapping.vehicle, sample.observedAt)) countIssue(counters, 'véhicule non actif à la date d’observation (échantillon carburant ignoré)');
      else accepted.push({ sample, mapping });
    }
    if (accepted.length === 0) return;

    const byKind = new Map<FuelMeasureKind, Array<{ sample: NormalizedFuelSample; mapping: SyncMapping }>>();
    for (const a of accepted) byKind.set(a.sample.kind, [...(byKind.get(a.sample.kind) ?? []), a]);
    for (const [kind, items] of byKind) {
      await this.storeSamples(scope, unit, kind, items, policy, counters);
      // Détection par véhicule (une unité peut changer de véhicule entre deux associations).
      const byVehicle = new Map<string, Array<{ sample: NormalizedFuelSample; mapping: SyncMapping }>>();
      for (const i of items) byVehicle.set(i.mapping.vehicleId, [...(byVehicle.get(i.mapping.vehicleId) ?? []), i]);
      for (const vehicleItems of byVehicle.values()) await this.detect(scope, unit, kind, vehicleItems, policy, counters);
    }
    const latest = accepted.reduce((a, b) => (b.sample.observedAt.getTime() > a.sample.observedAt.getTime() ? b : a)).sample;
    const current = await this.prisma.client.telemetryUnitState.findUnique({ where: { unitId: unit.unitId }, select: { lastFuelObservedAt: true } });
    if (!current?.lastFuelObservedAt || latest.observedAt.getTime() >= current.lastFuelObservedAt.getTime()) {
      const data = { lastFuelValue: (latest.liters ?? latest.percent)?.toString() ?? null, lastFuelKind: latest.kind, lastFuelObservedAt: latest.observedAt, lastReceivedAt: scope.now };
      await this.prisma.client.telemetryUnitState.upsert({
        where: { unitId: unit.unitId },
        create: { unitId: unit.unitId, organizationId: scope.organizationId, providerId: scope.provider.id, ...data },
        update: data,
      });
    }
  }

  /** Au plus un échantillon par tranche (le dernier reçu de la tranche) ; tranche déjà stockée = doublon. */
  private async storeSamples(scope: RunScope, unit: MappedUnit, kind: FuelMeasureKind, items: Array<{ sample: NormalizedFuelSample; mapping: SyncMapping }>, policy: FuelPolicy, counters: RunCounters): Promise<void> {
    const kept = downsampleFuel(items.map((i) => ({ ...i, observedAt: i.sample.observedAt })), policy.stepMinutes);
    counters.duplicatesIgnored += items.length - kept.length;
    const stepMs = Math.max(1, policy.stepMinutes) * 60_000;
    const first = kept[0];
    const lastKept = kept.at(-1);
    if (!first || !lastKept) return;
    const stored = await this.prisma.client.fuelLevelSample.findMany({
      where: { unitId: unit.unitId, kind, observedAt: { gte: new Date(first.bucket * stepMs), lt: new Date((lastKept.bucket + 1) * stepMs) } },
      select: { observedAt: true },
    });
    const storedBuckets = new Set(stored.map((s) => fuelBucket(s.observedAt, policy.stepMinutes)));
    const fresh = kept.filter((k) => !storedBuckets.has(k.bucket));
    counters.duplicatesIgnored += kept.length - fresh.length;
    if (fresh.length === 0) return;
    const created = await this.prisma.client.fuelLevelSample.createMany({
      data: fresh.map(({ sample: { sample, mapping } }) => ({
        organizationId: scope.organizationId,
        unitId: unit.unitId,
        vehicleId: mapping.vehicleId,
        observedAt: sample.observedAt,
        kind,
        liters: sample.liters?.toString() ?? null,
        percent: sample.percent?.toString() ?? null,
        engineOn: sample.engineOn,
        speedKmh: sample.speedKmh?.toString() ?? null,
        receivedAt: scope.now,
      })),
      skipDuplicates: true,
    });
    counters.fuelSamples += created.count;
  }

  /**
   * Détection sur les échantillons bruts du lot et les échantillons stockés qui les précèdent (médianes et
   * fenêtres continues d'un run à l'autre) ; seuls les épisodes touchant le lot sont examinés.
   */
  private async detect(scope: RunScope, unit: MappedUnit, kind: FuelMeasureKind, items: Array<{ sample: NormalizedFuelSample; mapping: SyncMapping }>, companyPolicy: FuelPolicy, counters: RunCounters): Promise<void> {
    if (kind === 'CONSOMMATION_CAN') return;
    const sorted = [...items].sort((a, b) => a.sample.observedAt.getTime() - b.sample.observedAt.getTime());
    const firstNew = (sorted[0] as (typeof sorted)[number]).sample.observedAt;
    const lastNew = (sorted.at(-1) as (typeof sorted)[number]).sample.observedAt;
    const mapping = (sorted.at(-1) as (typeof sorted)[number]).mapping;
    const vehicleId = mapping.vehicleId;
    // Seuils du véhicule s'il en a (D-238, D-240 : groupe > société > véhicule), sinon ceux de la société.
    const policy = applyVehicleFuelThresholds(companyPolicy, await this.vehicleThresholds(vehicleId));
    const lookbackMs = (2 * Math.max(policy.drop.windowMinutes, policy.refill.windowMinutes) + 3 * Math.max(1, policy.stepMinutes)) * 60_000;
    const stored = await this.prisma.client.fuelLevelSample.findMany({
      where: { vehicleId, kind, observedAt: { gte: new Date(firstNew.getTime() - lookbackMs), lte: new Date(lastNew.getTime() + lookbackMs) } },
      orderBy: { observedAt: 'asc' },
    });
    const points = new Map<number, FuelPoint>();
    for (const s of stored) points.set(s.observedAt.getTime(), { observedAt: s.observedAt, liters: s.liters ? dec(s.liters) : null, percent: s.percent ? dec(s.percent) : null, engineOn: s.engineOn, speedKmh: s.speedKmh ? dec(s.speedKmh) : null });
    for (const { sample } of sorted) points.set(sample.observedAt.getTime(), { observedAt: sample.observedAt, liters: sample.liters, percent: sample.percent, engineOn: sample.engineOn, speedKmh: sample.speedKmh });
    const capacity = mapping.vehicle.tankCapacityLiters ? dec(mapping.vehicle.tankCapacityLiters) : null;
    const detection = detectFuelEpisodes([...points.values()], kind, { drop: policy.drop, refill: policy.refill, capacityLiters: capacity });
    if (detection.dropDetectionUnavailable) countIssue(counters, 'baisse anormale non évaluable : contact ou vitesse non fournis par la sonde');
    for (const episode of detection.episodes) {
      if (episode.endAt.getTime() < firstNew.getTime()) continue;
      try {
        const created = await this.recordEpisode(scope, unit, mapping, kind, episode, policy);
        if (created) counters.fuelEventsCreated += 1;
        else counters.duplicatesIgnored += 1;
      } catch (error) {
        countError(counters, `événement carburant non enregistré : ${describeErrorSafely(error, [], 160)}`);
        this.logger.error(`Événement carburant (véhicule ${vehicleId}) en échec : ${describeErrorSafely(error)}`);
      }
    }
  }

  /** Un épisode = au plus un événement (clé stable) ; renvoie faux si l'épisode était déjà connu. */
  private async recordEpisode(scope: RunScope, unit: MappedUnit, mapping: SyncMapping, kind: FuelMeasureKind, episode: FuelEpisode, policy: FuelPolicy): Promise<boolean> {
    const dedupeKey = episodeDedupeKey(mapping.vehicleId, episode.type, episode.startAt);
    if (await this.prisma.client.fuelEvent.findUnique({ where: { organizationId_dedupeKey: { organizationId: scope.organizationId, dedupeKey } }, select: { id: true } })) return false;
    const detectedAt = episode.endAt;
    let type: FuelEventType = episode.type;
    let fuelEntryId: string | null = null;
    let autoJustified = false;
    let match: Record<string, unknown> | null = null;
    if (episode.type === 'REMPLISSAGE_DETECTE') {
      const tickets = await this.ticketsAround(mapping.vehicleId, detectedAt, policy.ticket.windowHours);
      const result = matchTicket({ detectedAt, liters: episode.liters }, tickets, policy.ticket);
      if (result.matched) {
        fuelEntryId = result.ticketId;
        autoJustified = true;
        match = { resultat: 'RAPPROCHE', ecartLitres: result.differenceLiters.toString() };
      } else if (result.reason === 'ECART_LITRES') {
        type = 'ECART_TICKET';
        fuelEntryId = result.nearestTicketId;
        match = { resultat: 'ECART_LITRES', ecartLitres: result.differenceLiters?.toString() ?? null };
      } else {
        match = { resultat: 'ABSENCE_TICKET' };
      }
    }
    const now = this.clock.now();
    const details = {
      nature: FUEL_MEASURE_KIND_LABELS[kind],
      unite: unit.label,
      seuils: episode.type === 'BAISSE_ANORMALE' ? policy.drop : policy.refill,
      ...(match ? { rapprochement: { ...match, fenetreHeures: policy.ticket.windowHours, toleranceLitres: policy.ticket.toleranceLiters, tolerancePourcentage: policy.ticket.tolerancePercent } } : {}),
    };
    let event: FuelEvent;
    try {
      event = await this.prisma.client.$transaction(async (tx) => {
        const created = await tx.fuelEvent.create({
          data: {
            organizationId: scope.organizationId,
            companyId: mapping.companyId,
            vehicleId: mapping.vehicleId,
            unitId: unit.unitId,
            type,
            measureKind: kind,
            detectedAt,
            windowStart: episode.startAt,
            windowEnd: episode.endAt,
            litersDelta: episode.liters?.toDecimalPlaces(3).toString() ?? null,
            percentDelta: episode.percent?.toDecimalPlaces(3).toString() ?? null,
            fuelEntryId,
            details: details as Prisma.InputJsonValue,
            dedupeKey,
            ...(autoJustified
              ? { status: 'QUALIFIE' as const, qualification: 'JUSTIFIE' as const, qualifiedAt: now, qualificationNote: 'Remplissage rapproché automatiquement d’un plein saisi (même véhicule, fenêtre et tolérance respectées).' }
              : { status: 'A_QUALIFIER' as const }),
          },
        });
        if (autoJustified) {
          await this.audit.recordSystem(scope.organizationId, { action: 'telemetrie.carburant.justification_automatique', objectType: FUEL_EVENT_OBJECT, objectId: created.id, companyId: mapping.companyId, after: { fuelEntryId, litersDelta: created.litersDelta?.toString() ?? null } }, tx);
        }
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
    if (event.status === 'A_QUALIFIER') await this.raiseAlert(event, mapping.vehicle.code);
    return true;
  }

  /**
   * Rapprochement tardif (D-242) : un remplissage sans ticket encore à qualifier, dont le plein a été saisi
   * depuis, est qualifié JUSTIFIE automatiquement (audit) et son alerte résolue.
   */
  async rematchPendingFills(organizationId: string, companyId: string, now: Date): Promise<number> {
    const pending = await this.prisma.client.fuelEvent.findMany({
      where: { organizationId, companyId, type: 'REMPLISSAGE_DETECTE', status: 'A_QUALIFIER', fuelEntryId: null, detectedAt: { gte: new Date(now.getTime() - REMATCH_DAYS * DAY_MS) } },
    });
    if (pending.length === 0) return 0;
    const policy = await this.policy(organizationId, companyId);
    let justified = 0;
    for (const e of pending) {
      const tickets = await this.ticketsAround(e.vehicleId, e.detectedAt, policy.ticket.windowHours);
      const result = matchTicket({ detectedAt: e.detectedAt, liters: e.litersDelta ? dec(e.litersDelta) : null }, tickets, policy.ticket);
      if (!result.matched) continue;
      const updated = await this.prisma.client.$transaction(async (tx) => {
        const res = await tx.fuelEvent.updateMany({
          where: { id: e.id, status: 'A_QUALIFIER', version: e.version },
          data: { status: 'QUALIFIE', qualification: 'JUSTIFIE', fuelEntryId: result.ticketId, qualifiedAt: this.clock.now(), qualificationNote: 'Plein saisi après la détection : remplissage rapproché automatiquement.', version: { increment: 1 } },
        });
        if (res.count === 1) {
          await this.audit.recordSystem(organizationId, { action: 'telemetrie.carburant.justification_automatique', objectType: FUEL_EVENT_OBJECT, objectId: e.id, companyId, after: { fuelEntryId: result.ticketId } }, tx);
        }
        return res.count;
      });
      if (updated === 1) {
        justified += 1;
        await this.alerts.resolve({ organizationId, type: ALERT_BY_EVENT[e.type], objectType: FUEL_EVENT_OBJECT, objectId: e.id }, 'Remplissage rapproché d’un plein saisi.');
      }
    }
    return justified;
  }

  // ------------------------------------------------------------------------------------------
  // Consultation et qualification (chef de parc, administrateur)
  // ------------------------------------------------------------------------------------------

  async list(ctx: RequestContext, query: FuelEventsQueryDto): Promise<Page<FuelEventViewDto>> {
    const scope = this.providers.readScope(ctx, query.companyId);
    if (query.from && query.to && query.from > query.to) throw new BusinessRuleError('PERIODE_INVALIDE', 'La fin de période précède son début.', { fieldErrors: { to: ['Fin avant le début.'] } });
    const where: Prisma.FuelEventWhereInput = {
      organizationId: ctx.organizationId,
      ...(scope ? { companyId: { in: scope } } : {}),
      ...(query.vehicleId ? { vehicleId: query.vehicleId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.from || query.to ? { detectedAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.client.fuelEvent.findMany({ where, include: eventInclude, orderBy: [{ detectedAt: 'desc' }, { id: 'asc' }], ...skipTake(query) }),
      this.prisma.client.fuelEvent.count({ where }),
    ]);
    const simulated = await this.simulatedUnits(rows);
    return pageOf(
      rows.map((row) => eventView(row, simulated)),
      total,
      query,
    );
  }

  async get(ctx: RequestContext, id: string): Promise<FuelEventViewDto> {
    const row = await this.loadVisible(ctx, id);
    return eventView(row, await this.simulatedUnits([row]));
  }

  /** Unités d'un fournisseur SIMULATEUR parmi celles des événements (D-303 : mention visible partout). */
  private async simulatedUnits(rows: readonly EventRow[]): Promise<ReadonlySet<string>> {
    const unitIds = [...new Set(rows.map((r) => r.unitId).filter((id): id is string => id !== null))];
    if (unitIds.length === 0) return new Set();
    const units = await this.prisma.client.telemetryUnit.findMany({ where: { id: { in: unitIds }, provider: { kind: 'SIMULATEUR' } }, select: { id: true } });
    return new Set(units.map((u) => u.id));
  }

  /** Qualification par le chef de parc ou l'administrateur (D-112, D-242) : jamais de dépense déduite. */
  async qualify(ctx: RequestContext, id: string, dto: QualifyFuelEventDto): Promise<FuelEventViewDto> {
    const event = await this.loadVisible(ctx, id);
    this.access.requireManager(ctx, event.companyId);
    assertExpectedVersion(event, dto.expectedVersion, 'événement carburant');
    if (event.status !== 'A_QUALIFIER') throw new BusinessRuleError('DEJA_QUALIFIE', 'Cet événement carburant est déjà qualifié.');
    const note = dto.note.trim();
    if (note.length < 3) throw new BusinessRuleError('VALIDATION', 'Note de qualification trop courte.', { fieldErrors: { note: ['3 caractères au moins.'] } });
    await this.prisma.client.$transaction(async (tx) => {
      const res = await tx.fuelEvent.updateMany({
        where: { id, status: 'A_QUALIFIER', version: dto.expectedVersion },
        data: { status: 'QUALIFIE', qualification: dto.qualification, qualificationNote: note, qualifiedAt: this.clock.now(), qualifiedById: ctx.userId, version: { increment: 1 } },
      });
      if (res.count !== 1) {
        const fresh = await tx.fuelEvent.findUniqueOrThrow({ where: { id } });
        assertExpectedVersion(fresh, dto.expectedVersion, 'événement carburant');
        throw new BusinessRuleError('DEJA_QUALIFIE', 'Cet événement carburant est déjà qualifié.');
      }
      await this.audit.record(
        ctx,
        { action: 'telemetrie.carburant.qualification', objectType: FUEL_EVENT_OBJECT, objectId: id, companyId: event.companyId, reason: note, before: { status: event.status }, after: { status: 'QUALIFIE', qualification: dto.qualification } },
        tx,
      );
    });
    await this.alerts.resolve({ organizationId: ctx.organizationId, type: ALERT_BY_EVENT[event.type], objectType: FUEL_EVENT_OBJECT, objectId: id }, `Événement qualifié (${dto.qualification}).`);
    return this.get(ctx, id);
  }

  // ------------------------------------------------------------------------------------------

  private async loadVisible(ctx: RequestContext, id: string): Promise<EventRow> {
    const scope = this.providers.readScope(ctx);
    const row = await this.prisma.client.fuelEvent.findFirst({ where: { id, organizationId: ctx.organizationId }, include: eventInclude });
    if (!row || (scope && !scope.includes(row.companyId))) throw new NotFoundOrOutOfScopeError('Événement carburant');
    return row;
  }

  private async ticketsAround(vehicleId: string, at: Date, windowHours: number): Promise<Array<{ id: string; filledAt: Date; liters: Decimal }>> {
    const windowMs = windowHours * 3_600_000;
    const rows = await this.prisma.client.fuelEntry.findMany({
      // Un plein ne justifie qu'un seul remplissage : ceux déjà rapprochés (JUSTIFIE) sont exclus.
      where: {
        vehicleId,
        status: { in: ['SOUMIS', 'VALIDE'] },
        filledAt: { gte: new Date(at.getTime() - windowMs), lte: new Date(at.getTime() + windowMs) },
        fuelEvents: { none: { type: 'REMPLISSAGE_DETECTE', qualification: 'JUSTIFIE' } },
      },
      select: { id: true, filledAt: true, liters: true },
    });
    return rows.map((r) => ({ id: r.id, filledAt: r.filledAt, liters: dec(r.liters) }));
  }

  private async raiseAlert(event: FuelEvent, vehicleCode: string): Promise<void> {
    const liters = event.litersDelta ? `${new Decimal(event.litersDelta.toString()).toDecimalPlaces(1).toString().replace('.', ',')} L` : null;
    const org = await this.prisma.client.organization.findUniqueOrThrow({ where: { id: event.organizationId }, select: { timezone: true } });
    const format = new Intl.DateTimeFormat('fr-FR', { timeZone: org.timezone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const window = `du ${format.format(event.windowStart)} au ${format.format(event.windowEnd)}`;
    const text: Record<FuelEventType, string> = {
      BAISSE_ANORMALE: `Baisse de niveau${liters ? ` de ${liters}` : ''} moteur coupé et véhicule à l’arrêt (${FUEL_MEASURE_KIND_LABELS[event.measureKind]}, ${window}).`,
      REMPLISSAGE_DETECTE: `Remplissage détecté${liters ? ` de ${liters}` : ''} sans ticket de carburant saisi dans la fenêtre de rapprochement (${window}).`,
      ECART_TICKET: `Remplissage détecté${liters ? ` de ${liters}` : ''} dont les litres s’écartent du ticket le plus proche au-delà de la tolérance (${window}).`,
    };
    await this.alerts.raise({
      organizationId: event.organizationId,
      companyId: event.companyId,
      type: ALERT_BY_EVENT[event.type],
      severity: event.type === 'BAISSE_ANORMALE' ? 'URGENT' : 'ATTENTION',
      objectType: FUEL_EVENT_OBJECT,
      objectId: event.id,
      vehicleId: event.vehicleId,
      occurrenceKey: ALERT_OCCURRENCE,
      title: `${FUEL_EVENT_TYPE_LABELS[event.type]} — ${vehicleCode}`,
      message: `${text[event.type]} Anomalie à qualifier par le chef de parc ; aucune dépense n’est créée automatiquement.`,
      condition: { fuelEventId: event.id, type: event.type, litersDelta: event.litersDelta?.toString() ?? null, measureKind: event.measureKind },
      actionPath: `/telematique/carburant?evenement=${event.id}`,
    });
  }

  /** Surcharges du véhicule (VehicleFuelThresholds), converties en nombres ; null sans surcharge. */
  private async vehicleThresholds(vehicleId: string): Promise<VehicleFuelThresholdValues | null> {
    const row = await this.prisma.client.vehicleFuelThresholds.findUnique({ where: { vehicleId } });
    if (!row) return null;
    const num = (v: { toString(): string } | null) => (v === null ? null : Number(v.toString()));
    return {
      dropLiters: num(row.dropLiters),
      dropPercent: num(row.dropPercent),
      dropWindowMinutes: row.dropWindowMinutes,
      fillLiters: num(row.fillLiters),
      fillPercent: num(row.fillPercent),
      fillWindowMinutes: row.fillWindowMinutes,
    };
  }

  private async policy(organizationId: string, companyId: string): Promise<FuelPolicy> {
    const [stepMinutes, dropLiters, dropPercent, dropWindow, fillLiters, fillPercent, fillWindow, ticketHours, ticketLiters, ticketPercent] = await Promise.all([
      this.settings.get(organizationId, 'telemetry.fuelSampleStepMinutes'),
      this.settings.get(organizationId, 'telemetry.fuelDropLiters', companyId),
      this.settings.get(organizationId, 'telemetry.fuelDropPercent', companyId),
      this.settings.get(organizationId, 'telemetry.fuelDropWindowMinutes', companyId),
      this.settings.get(organizationId, 'telemetry.fuelFillMinLiters', companyId),
      this.settings.get(organizationId, 'telemetry.fuelFillPercent', companyId),
      this.settings.get(organizationId, 'telemetry.fuelFillWindowMinutes', companyId),
      this.settings.get(organizationId, 'telemetry.fuelTicketWindowHours', companyId),
      this.settings.get(organizationId, 'telemetry.fuelTicketToleranceLiters', companyId),
      this.settings.get(organizationId, 'telemetry.fuelTicketTolerancePercent', companyId),
    ]);
    return {
      stepMinutes,
      drop: { liters: dropLiters, percent: dropPercent, windowMinutes: dropWindow },
      refill: { liters: fillLiters, percent: fillPercent, windowMinutes: fillWindow },
      ticket: { windowHours: ticketHours, toleranceLiters: ticketLiters, tolerancePercent: ticketPercent },
    };
  }
}

function eventView(e: EventRow, simulatedUnits: ReadonlySet<string>): FuelEventViewDto {
  const details = e.details && typeof e.details === 'object' && !Array.isArray(e.details) ? (e.details as Record<string, unknown>) : null;
  return {
    id: e.id,
    isSimulator: e.unitId !== null && simulatedUnits.has(e.unitId),
    companyId: e.companyId,
    vehicleId: e.vehicleId,
    vehicleCode: e.vehicle.code,
    vehicleRegistration: e.vehicle.registration,
    unitId: e.unitId,
    type: e.type,
    typeLabel: FUEL_EVENT_TYPE_LABELS[e.type],
    measureKind: e.measureKind,
    measureKindLabel: FUEL_MEASURE_KIND_LABELS[e.measureKind],
    detectedAt: e.detectedAt.toISOString(),
    windowStart: e.windowStart.toISOString(),
    windowEnd: e.windowEnd.toISOString(),
    litersDelta: e.litersDelta?.toFixed(3) ?? null,
    percentDelta: e.percentDelta?.toFixed(3) ?? null,
    fuelEntryId: e.fuelEntryId,
    status: e.status,
    qualification: e.qualification,
    qualifiedAt: e.qualifiedAt?.toISOString() ?? null,
    qualifiedById: e.qualifiedById,
    qualificationNote: e.qualificationNote,
    details,
    version: e.version,
  };
}
