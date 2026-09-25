import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { AfterCommit } from '../../../common/after-commit.js';
import { AppError } from '../../../common/errors.js';
import { describeErrorSafely } from '../../../common/secret-redaction.js';
import { endOfLocalDay, localDate, startOfLocalDay } from '../../../domain/civil-date.js';
import { estimateFromGps } from '../../../domain/telemetry/gps-calibration.js';
import { type HistorizationReason, historizationReason, planThresholds } from '../../../domain/telemetry/historization.js';
import { PrismaService, type Tx } from '../../../infra/prisma.service.js';
import { OdometerIngestionService, cumulativeFor, dec } from '../../odometer/odometer-ingestion.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { SIMULATOR_LABEL } from '../telemetry-settings.js';
import { TelemetryCalibrationService } from './telemetry-calibration.service.js';
import type { NormalizedOdometerSample } from './telemetry-samples.js';
import { type MappedUnit, type RunCounters, type RunScope, type SyncMapping, countError, countIssue, coveringMapping, vehicleActiveAt } from './telemetry-sync.types.js';

/** Délai d'attente d'un verrou véhicule par le worker : une saisie manuelle garde la priorité (D-183). */
const LOCK_TIMEOUT = '2s';
const HOUR_MS = 3_600_000;
/** Motif d'un relevé automatique d'un véhicule hors service (D-175, D-186). */
const INACTIVE_CODE = 'VEHICULE_NON_ACTIF';

type Historized = { km: Decimal; observedAt: Date } | null;

type CanOutcome =
  | { kind: 'ACCEPTE' | 'EN_ATTENTE' | 'IDEMPOTENT'; readingStatus: string; observedAt: Date }
  | { kind: 'REFUSE'; reason: string }
  | { kind: 'CONFLIT_REPRISE' }
  | { kind: 'ANOMALIE_DEJA_EN_ATTENTE' };

/**
 * Ingestion des échantillons d'odomètre d'un run (CDC 5.6 ; D-173 à D-195, D-255, D-285, D-299, D-322) :
 *  - échantillons stockés (TelemetryOdometerSample, unicité unité/nature/instant) seulement sous une
 *    association CONFIRME ou CLOTURE couvrant l'instant ; état de l'unité mis à jour à chaque synchro ;
 *  - relevé TELEMATICS historisé par l'ingestion unique (OdometerIngestionService) selon
 *    historizationReason : premier échantillon après association ou silence, premier du jour local,
 *    franchissement d'un seuil de plan, ou progression après l'intervalle d'historisation ; une
 *    régression CAN est présentée à l'ingestion (EN_ATTENTE motivé, D-322 : une seule par motif) ;
 *  - COMPTEUR_CAN = compteur physique ; DISTANCE_GPS = estimation calibrée (ingestGpsEstimate) ;
 *  - véhicule HORS_SERVICE : au plus un relevé EN_ATTENTE motivé VEHICULE_NON_ACTIF (D-175, D-186) ;
 *    véhicule cédé ou archivé à la date d'observation : échantillon conservé, aucun relevé ;
 *  - reprise initiale : relevés quotidiens seulement, une valeur en conflit reste un échantillon (D-185) ;
 *  - le connecteur ne crée jamais de compteur (D-169) : véhicule non initialisé = échantillon conservé.
 */
@Injectable()
export class TelemetryOdometerSyncService {
  private readonly logger = new Logger('TelemetrieKilometrage');

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestion: OdometerIngestionService,
    private readonly calibration: TelemetryCalibrationService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Traite les échantillons normalisés du run. `historyKeys` : échantillons reçus uniquement par
   * l'historique (reprise initiale) — clé unité|nature|instant.
   */
  async process(scope: RunScope, units: ReadonlyMap<string, MappedUnit>, samples: readonly NormalizedOdometerSample[], historyKeys: ReadonlySet<string>, counters: RunCounters): Promise<void> {
    if (samples.length === 0) return;
    const [minIntervalMinutes, silentAfterHours] = await Promise.all([
      this.settings.get(scope.organizationId, 'telemetry.historizeEveryMinutes'),
      this.settings.get(scope.organizationId, 'telemetry.silentAfterHours', scope.companyId),
    ]);
    const byUnit = new Map<string, NormalizedOdometerSample[]>();
    for (const s of samples) byUnit.set(s.unitExternalId, [...(byUnit.get(s.unitExternalId) ?? []), s]);
    for (const [externalId, unitSamples] of byUnit) {
      const unit = units.get(externalId);
      if (!unit) continue;
      try {
        await this.processUnit(scope, unit, unitSamples, historyKeys, { minIntervalMinutes, silentAfterHours }, counters);
      } catch (error) {
        countError(counters, `erreur technique sur une unité : ${describeErrorSafely(error, [], 160)}`);
        this.logger.error(`Ingestion kilométrique de l’unité ${unit.unitId} en échec : ${describeErrorSafely(error)}`);
      }
    }
  }

  private async processUnit(
    scope: RunScope,
    unit: MappedUnit,
    unitSamples: NormalizedOdometerSample[],
    historyKeys: ReadonlySet<string>,
    policy: { minIntervalMinutes: number; silentAfterHours: number },
    counters: RunCounters,
  ): Promise<void> {
    counters.odometerSamples += unitSamples.length;
    const covered: Array<{ sample: NormalizedOdometerSample; mapping: SyncMapping }> = [];
    for (const sample of unitSamples) {
      const mapping = coveringMapping(unit.mappings, sample.observedAt);
      if (!mapping) countIssue(counters, 'échantillon hors période d’association (ignoré)');
      else covered.push({ sample, mapping });
    }
    await this.storeSamples(scope, unit, covered.map((c) => c.sample), counters);

    let last: Historized = unit.state?.lastHistorizedAt && unit.state.lastHistorizedValueKm ? { km: dec(unit.state.lastHistorizedValueKm), observedAt: unit.state.lastHistorizedAt } : null;
    let previousObservedAt: Date | null = unit.state?.lastOdometerObservedAt ?? null;
    let lastError: string | null = null;
    const thresholds = new Map<string, { can: Decimal[]; gps: Decimal[] }>();
    const bootstrapped = new Set<string>();

    for (const { sample, mapping } of covered) {
      const vehicle = mapping.vehicle;
      const silence = previousObservedAt !== null && sample.observedAt.getTime() - previousObservedAt.getTime() > policy.silentAfterHours * HOUR_MS;
      if (!previousObservedAt || sample.observedAt.getTime() > previousObservedAt.getTime()) previousObservedAt = sample.observedAt;
      if (mapping.odometerKind !== sample.kind) {
        countIssue(counters, `nature ${sample.kind} non retenue pour l’association (échantillon conservé)`);
        continue;
      }
      const backfill = historyKeys.has(sampleKey(sample)) && scope.backfillMappingIds.has(mapping.id);
      if (!vehicleActiveAt(vehicle, sample.observedAt)) {
        // D-175, D-186 : véhicule HORS_SERVICE → au plus un relevé CAN EN_ATTENTE (VEHICULE_NON_ACTIF) ouvert
        // par véhicule et un par jour local, sans recalcul d'entretien ; cédé ou archivé → échantillon seul.
        if (vehicle.lifecycleStatus === 'HORS_SERVICE' && sample.kind === 'COMPTEUR_CAN' && !backfill) {
          try {
            const error = await this.pendInactive(scope, unit, mapping, sample, counters);
            if (error) lastError = error;
          } catch (error) {
            const message = isLockTimeout(error) ? 'véhicule verrouillé par une saisie en cours : relevé reporté au cycle suivant' : `relevé refusé : ${describeErrorSafely(error, [], 160)}`;
            if (isLockTimeout(error)) countIssue(counters, message);
            else countError(counters, message);
            lastError = message;
          }
        } else {
          countIssue(counters, 'véhicule non actif à la date d’observation (échantillon conservé)');
        }
        continue;
      }
      const firstAfterMappingOrSilence = silence || (last !== null && mapping.validFrom !== null && last.observedAt.getTime() < mapping.validFrom.getTime());
      let planKm = thresholds.get(vehicle.id);
      if (!planKm) {
        planKm = await this.planThresholdsOf(vehicle.id);
        thresholds.set(vehicle.id, planKm);
      }
      try {
        if (sample.kind === 'COMPTEUR_CAN') {
          const result = await this.historizeCan(scope, unit, mapping, sample, { last, firstAfterMappingOrSilence, thresholds: planKm.can, minIntervalMinutes: policy.minIntervalMinutes, backfill }, counters);
          if (result.historized) last = result.historized;
          if (result.error) lastError = result.error;
        } else {
          if (!bootstrapped.has(mapping.id)) {
            await this.calibration.ensureCalibrations(mapping.id);
            bootstrapped.add(mapping.id);
          }
          const result = await this.historizeGps(scope, unit, mapping, sample, { last, firstAfterMappingOrSilence, thresholds: planKm.gps, minIntervalMinutes: policy.minIntervalMinutes, backfill }, counters);
          if (result.historized) last = result.historized;
          if (result.error) lastError = result.error;
        }
      } catch (error) {
        const message = isLockTimeout(error) ? 'véhicule verrouillé par une saisie en cours : relevé reporté au cycle suivant' : error instanceof AppError ? `relevé refusé : ${describeErrorSafely(error, [], 160)}` : `erreur technique : ${describeErrorSafely(error, [], 160)}`;
        if (isLockTimeout(error)) countIssue(counters, message);
        else countError(counters, message);
        lastError = message;
        if (!(error instanceof AppError) && !isLockTimeout(error)) this.logger.error(`Historisation (unité ${unit.unitId}, véhicule ${vehicle.id}) en échec : ${describeErrorSafely(error)}`);
      }
    }

    const latest = unitSamples.reduce<NormalizedOdometerSample | null>((a, b) => (!a || b.observedAt.getTime() > a.observedAt.getTime() ? b : a), null);
    await this.updateState(scope, unit, latest, last, lastError);
  }

  /** Échantillons bruts (unicité unité/nature/instant) : doublon = même valeur ; conflit = valeur différente, le premier est gardé. */
  private async storeSamples(scope: RunScope, unit: MappedUnit, samples: readonly NormalizedOdometerSample[], counters: RunCounters): Promise<void> {
    if (samples.length === 0) return;
    const existing = await this.prisma.client.telemetryOdometerSample.findMany({
      where: { unitId: unit.unitId, observedAt: { in: samples.map((s) => s.observedAt) } },
      select: { kind: true, observedAt: true, valueKm: true },
    });
    const known = new Map(existing.map((e) => [`${e.kind}|${e.observedAt.getTime()}`, dec(e.valueKm)]));
    const fresh = [];
    for (const s of samples) {
      const value = known.get(`${s.kind}|${s.observedAt.getTime()}`);
      if (value === undefined) fresh.push(s);
      else if (value.eq(s.valueKm)) counters.duplicatesIgnored += 1;
      else countError(counters, 'échantillon déjà reçu avec une autre valeur (premier conservé)');
    }
    if (fresh.length === 0) return;
    await this.prisma.client.telemetryOdometerSample.createMany({
      data: fresh.map((s) => ({ organizationId: scope.organizationId, unitId: unit.unitId, observedAt: s.observedAt, kind: s.kind, valueKm: s.valueKm.toString(), sourceReference: s.sourceReference, receivedAt: scope.now })),
      skipDuplicates: true,
    });
  }

  private async historizeCan(
    scope: RunScope,
    unit: MappedUnit,
    mapping: SyncMapping,
    sample: NormalizedOdometerSample,
    rule: { last: Historized; firstAfterMappingOrSilence: boolean; thresholds: Decimal[]; minIntervalMinutes: number; backfill: boolean },
    counters: RunCounters,
  ): Promise<{ historized?: Historized; error?: string }> {
    const vehicleId = mapping.vehicleId;
    const segment = await this.ingestion.findSegment(this.prisma.client, vehicleId, sample.observedAt, null);
    if (!segment) {
      const any = await this.prisma.client.odometerSegment.count({ where: { vehicleId } });
      const reason = any === 0 ? 'compteur du véhicule non initialisé : relevé manuel initial requis (échantillon conservé)' : 'échantillon antérieur au premier compteur enregistré (échantillon conservé)';
      countIssue(counters, reason);
      return { error: reason };
    }
    const cumulative = cumulativeFor(segment, sample.valueKm);
    let reason: HistorizationReason | 'REGRESSION' | null = historizationReason({
      sampleKm: cumulative,
      observedAt: sample.observedAt,
      timezone: scope.timezone,
      lastHistorized: rule.last,
      firstAfterMappingOrSilence: rule.firstAfterMappingOrSilence,
      minIntervalMinutes: rule.minIntervalMinutes,
      thresholdsKm: rule.thresholds,
    });
    // Une régression CAN n'est jamais « non progressée » : elle est présentée à l'ingestion unique (T40).
    if (!reason && rule.last && sample.observedAt.getTime() > rule.last.observedAt.getTime() && cumulative.lt(rule.last.km)) reason = 'REGRESSION';
    if (!reason) return {};
    if (rule.backfill && reason !== 'PREMIER' && reason !== 'QUOTIDIEN') return {};

    const outcome = await this.inTransaction(async (tx, after): Promise<CanOutcome> => {
      const pre = await this.ingestion.evaluate(tx, { organizationId: scope.organizationId, vehicleId, origin: 'TELEMATICS', physicalKm: sample.valueKm, observedAt: sample.observedAt }, segment, null);
      if (pre.outcome === 'REJECT') return { kind: 'REFUSE', reason: pre.reason };
      if (pre.outcome === 'PENDING') {
        if (rule.backfill) return { kind: 'CONFLIT_REPRISE' };
        const already = await tx.odometerReading.findFirst({ where: { vehicleId, source: 'TELEMATICS', status: 'EN_ATTENTE', anomalyCode: pre.code }, select: { id: true } });
        if (already) return { kind: 'ANOMALIE_DEJA_EN_ATTENTE' };
      }
      const result = await this.ingestion.ingest(
        tx,
        {
          organizationId: scope.organizationId,
          vehicleId,
          origin: 'TELEMATICS',
          context: 'SYNCHRONISATION',
          measurementKind: 'COMPTEUR_CAN',
          physicalKm: sample.valueKm,
          observedAt: sample.observedAt,
          author: { kind: 'SYSTEM' },
          telematics: { channel: scope.provider.channel, providerId: scope.provider.id, providerUnitId: unit.externalId, sourceReference: sample.sourceReference, receivedAt: scope.now },
          allowAutoInit: false,
          note: simulatedNote(scope),
        },
        after,
      );
      return { kind: result.outcome, readingStatus: result.reading.status, observedAt: result.reading.observedAt };
    });

    switch (outcome.kind) {
      case 'ACCEPTE':
        counters.readingsCreated += 1;
        return { historized: { km: cumulative, observedAt: sample.observedAt } };
      case 'EN_ATTENTE':
        counters.readingsPending += 1;
        return { error: 'relevé automatique incohérent mis en attente de validation' };
      case 'IDEMPOTENT':
        counters.duplicatesIgnored += 1;
        return outcome.readingStatus === 'ACCEPTE' && (!rule.last || outcome.observedAt.getTime() >= rule.last.observedAt.getTime()) ? { historized: { km: cumulative, observedAt: outcome.observedAt } } : {};
      case 'REFUSE':
        countError(counters, `valeur refusée : ${outcome.reason}`);
        return { error: outcome.reason };
      case 'CONFLIT_REPRISE':
        countIssue(counters, 'reprise initiale : valeur en conflit avec un relevé existant (échantillon conservé, jamais mis en attente)');
        return {};
      case 'ANOMALIE_DEJA_EN_ATTENTE':
        countIssue(counters, 'anomalie déjà en attente de validation pour ce véhicule (échantillon conservé)');
        return {};
    }
  }

  /**
   * Véhicule HORS_SERVICE (D-175, D-186, D-322) : relevé CAN présenté à l'ingestion unique et mis d'office
   * EN_ATTENTE avec le motif VEHICULE_NON_ACTIF ; aucun nouveau tant qu'un tel relevé attend une décision,
   * ni plus d'un par jour local ; les échantillons suivants ne mettent à jour que l'état de l'unité.
   */
  private async pendInactive(scope: RunScope, unit: MappedUnit, mapping: SyncMapping, sample: NormalizedOdometerSample, counters: RunCounters): Promise<string | null> {
    const vehicleId = mapping.vehicleId;
    if (!(await this.ingestion.findSegment(this.prisma.client, vehicleId, sample.observedAt, null))) {
      const reason = 'compteur du véhicule non initialisé à cette date : relevé manuel initial requis (échantillon conservé)';
      countIssue(counters, reason);
      return reason;
    }
    const day = localDate(sample.observedAt, scope.timezone);
    const outcome = await this.inTransaction(async (tx, after) => {
      const already = await tx.odometerReading.findFirst({
        where: {
          vehicleId,
          source: 'TELEMATICS',
          anomalyCode: INACTIVE_CODE,
          OR: [{ status: 'EN_ATTENTE' }, { observedAt: { gte: startOfLocalDay(day, scope.timezone), lte: endOfLocalDay(day, scope.timezone) } }],
        },
        select: { id: true },
      });
      if (already) return null;
      return this.ingestion.ingestTelematicsPending(
        tx,
        {
          organizationId: scope.organizationId,
          vehicleId,
          origin: 'TELEMATICS',
          context: 'SYNCHRONISATION',
          measurementKind: 'COMPTEUR_CAN',
          physicalKm: sample.valueKm,
          observedAt: sample.observedAt,
          author: { kind: 'SYSTEM' },
          telematics: { channel: scope.provider.channel, providerId: scope.provider.id, providerUnitId: unit.externalId, sourceReference: sample.sourceReference, receivedAt: scope.now },
          allowAutoInit: false,
          note: simulatedNote(scope),
        },
        { code: INACTIVE_CODE, reason: 'Véhicule hors service à la date d’observation : relevé automatique à valider par le chef de parc (aucun recalcul d’entretien avant décision).' },
        after,
      );
    });
    if (!outcome) {
      countIssue(counters, 'véhicule hors service : relevé à valider déjà en attente ou déjà créé ce jour (échantillon conservé)');
      return null;
    }
    if (outcome.outcome === 'IDEMPOTENT') {
      counters.duplicatesIgnored += 1;
      return null;
    }
    counters.readingsPending += 1;
    return 'véhicule hors service : relevé automatique mis en attente de validation';
  }

  private async historizeGps(
    scope: RunScope,
    unit: MappedUnit,
    mapping: SyncMapping,
    sample: NormalizedOdometerSample,
    rule: { last: Historized; firstAfterMappingOrSilence: boolean; thresholds: Decimal[]; minIntervalMinutes: number; backfill: boolean },
    counters: RunCounters,
  ): Promise<{ historized?: Historized; error?: string }> {
    const calibration = await this.calibration.activeCalibration(mapping.id, sample.observedAt, scope.timezone);
    if (!calibration) {
      countIssue(counters, 'distance GPS non calibrée : aucune référence manuelle exploitable (échantillon conservé)');
      return {};
    }
    const estimate = estimateFromGps(calibration.reference, sample.valueKm);
    if (!estimate) {
      const reason = 'distance GPS en recul depuis la référence (boîtier changé ou remis à zéro) : estimation suspendue';
      countIssue(counters, reason);
      return { error: reason };
    }
    const reason = historizationReason({
      sampleKm: estimate,
      observedAt: sample.observedAt,
      timezone: scope.timezone,
      lastHistorized: rule.last,
      firstAfterMappingOrSilence: rule.firstAfterMappingOrSilence,
      minIntervalMinutes: rule.minIntervalMinutes,
      thresholdsKm: rule.thresholds,
    });
    if (!reason) return {};
    if (rule.backfill && reason !== 'PREMIER' && reason !== 'QUOTIDIEN') return {};
    const result = await this.inTransaction((tx, after) =>
      this.ingestion.ingestGpsEstimate(
        tx,
        {
          organizationId: scope.organizationId,
          vehicleId: mapping.vehicleId,
          observedAt: sample.observedAt,
          estimatedCumulativeKm: estimate,
          gpsDistanceKm: sample.valueKm,
          calibrationId: calibration.id,
          referenceSegmentId: calibration.referenceSegmentId,
          note: calibration.note,
          telematics: { channel: scope.provider.channel, providerId: scope.provider.id, providerUnitId: unit.externalId, sourceReference: sample.sourceReference, receivedAt: scope.now },
        },
        after,
      ),
    );
    if (result.outcome === 'ACCEPTE') {
      counters.readingsCreated += 1;
      return { historized: { km: estimate, observedAt: sample.observedAt } };
    }
    if (result.outcome === 'IDEMPOTENT') {
      counters.duplicatesIgnored += 1;
      return {};
    }
    const why = result.reason?.reason ?? 'estimation incohérente';
    countIssue(counters, `estimation GPS écartée : ${why}`);
    return { error: why };
  }

  /** Transaction sérialisable courte par relevé, verrou véhicule borné ; effets dépendants après validation. */
  private async inTransaction<T>(fn: (tx: Tx, after: AfterCommit) => Promise<T>): Promise<T> {
    const { value, after } = await this.prisma.serializable(async (tx) => {
      const after = new AfterCommit();
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      const value = await fn(tx, after);
      return { value, after };
    });
    await after.run();
    return value;
  }

  /**
   * Seuils kilométriques des plans actifs (échéance − préavis, échéance, échéance + 1 km) : tous les
   * plans pour le CAN, les plans « toutes sources » seulement pour une estimation GPS (6.1, D-179).
   */
  private async planThresholdsOf(vehicleId: string): Promise<{ can: Decimal[]; gps: Decimal[] }> {
    const plans = await this.prisma.client.vehicleMaintenancePlan.findMany({ where: { vehicleId, active: true }, select: { nextDueKm: true, noticeKm: true, acceptedSources: true } });
    const can: Decimal[] = [];
    const gps: Decimal[] = [];
    for (const p of plans) {
      const values = planThresholds(p.nextDueKm ? dec(p.nextDueKm) : null, p.noticeKm ? dec(p.noticeKm) : null);
      can.push(...values);
      if (p.acceptedSources === 'TOUTES') gps.push(...values);
    }
    return { can, gps };
  }

  /** Dernier état reçu de l'unité (5.6) : mis à jour à chaque synchronisation, sans jamais reculer. */
  private async updateState(scope: RunScope, unit: MappedUnit, latest: NormalizedOdometerSample | null, historized: Historized, lastError: string | null): Promise<void> {
    const current = await this.prisma.client.telemetryUnitState.findUnique({ where: { unitId: unit.unitId } });
    const newer = latest && (!current?.lastOdometerObservedAt || latest.observedAt.getTime() >= current.lastOdometerObservedAt.getTime());
    const historizedNewer = historized && (!current?.lastHistorizedAt || historized.observedAt.getTime() >= current.lastHistorizedAt.getTime());
    const data = {
      ...(newer && latest ? { lastOdometerValueKm: latest.valueKm.toString(), lastOdometerKind: latest.kind, lastOdometerObservedAt: latest.observedAt } : {}),
      ...(historizedNewer && historized ? { lastHistorizedAt: historized.observedAt, lastHistorizedValueKm: historized.km.toString() } : {}),
      lastReceivedAt: scope.now,
      lastError,
    };
    await this.prisma.client.telemetryUnitState.upsert({
      where: { unitId: unit.unitId },
      create: { unitId: unit.unitId, organizationId: scope.organizationId, providerId: scope.provider.id, ...data },
      update: data,
    });
  }
}

export function sampleKey(sample: { unitExternalId: string; kind: string; observedAt: Date }): string {
  return `${sample.unitExternalId}|${sample.kind}|${sample.observedAt.getTime()}`;
}

/** Délai d'attente d'un verrou dépassé (PostgreSQL 55P03) : le véhicule est repris au cycle suivant. */
export function isLockTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const meta = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } }).meta;
  if (meta?.driverAdapterError?.cause?.originalCode === '55P03') return true;
  return /lock timeout|55P03/i.test(error.message);
}

/** Relevé issu du simulateur : libellé « SIMULATEUR — données fictives » visible avec la valeur (D-303). */
function simulatedNote(scope: RunScope): string | null {
  return scope.provider.kind === 'SIMULATEUR' ? SIMULATOR_LABEL : null;
}
