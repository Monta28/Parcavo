import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { DateTime } from 'luxon';
import type { Prisma, TelemetryCalibration } from '@parc-auto/db';
import { AfterCommit } from '../../../common/after-commit.js';
import { Clock } from '../../../common/clock.js';
import { describeErrorSafely } from '../../../common/secret-redaction.js';
import { kmLabel } from '../../../domain/km-display.js';
import { type CalibrationReference, computeDrift, estimateFromGps, formatPercent, sampleForInstant } from '../../../domain/telemetry/gps-calibration.js';
import { PrismaService } from '../../../infra/prisma.service.js';
import { AlertsService } from '../../alerts/alerts.service.js';
import { type ReadingAcceptedEvent, OdometerEventsService } from '../../odometer/odometer-events.service.js';
import { OdometerIngestionService, dec } from '../../odometer/odometer-ingestion.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { MAPPING_ALERT_OBJECT } from '../telemetry-alerts.service.js';

const DRIFT_OCCURRENCE = 'derive';
/** Nombre maximal d'estimations recalculées après une nouvelle référence (borne de volume). */
const MAX_RECALCULATED = 500;
/** Nombre maximal de relevés physiques examinés pour amorcer le calibrage d'une association. */
const BOOTSTRAP_CANDIDATES = 5;
/** Borne de Decimal(9,3) pour l'écart en pourcentage historisé. */
const MAX_STORED_PERCENT = new Decimal('999999.999');

/** Référence de calibrage en vigueur à un instant pour une association DISTANCE_GPS. */
export interface ActiveCalibration {
  id: string;
  reference: CalibrationReference;
  /** Segment du relevé de référence : l'estimation ne franchit pas un changement de compteur. */
  referenceSegmentId: string;
  /** Libellé « estimé GPS » avec la date de la référence manuelle (CDC 5.6 ; D-178). */
  note: string;
}

export interface CalibrationOutcome {
  calibrationId: string;
  status: 'CALIBRE' | 'NON_CALIBRABLE';
  driftPercent: string | null;
  driftAlert: boolean;
  recalculated: number;
}

type CoveringMapping = Prisma.TelemetryVehicleMappingGetPayload<{ include: { unit: { select: { id: true; externalId: true; label: true } }; provider: { select: { id: true; channel: true; status: true } } } }>;

/**
 * Calibrage des distances GPS (CDC 5.6 ; D-147, D-161, D-174, D-190 à D-193, D-285, D-300) :
 *  - chaque relevé physique MANUAL ou IMPORT accepté (saisie, remise, restitution, entretien, soumission
 *    conducteur approuvée plus tard, correction) d'un véhicule associé en DISTANCE_GPS devient une
 *    référence : kmEstimé = kmRéférence + (distanceGps − distanceGpsRéférence), la distance GPS à
 *    l'instant du relevé étant le dernier échantillon brut antérieur dans la fenêtre
 *    telemetry.calibrationMaxGapMinutes (sampleForInstant) ; sans échantillon, calibrage NON_CALIBRABLE
 *    (estimations suspendues jusqu'au relevé suivant) ;
 *  - l'écart entre l'estimation à l'instant du relevé et le relevé lui-même est historisé (computeDrift) ;
 *    au-delà de telemetry.driftThresholdPercent (distance ≥ telemetry.driftMinDistanceKm), alerte
 *    GPS_DERIVE sur l'association, résolue au calibrage suivant sous le seuil ;
 *  - les estimations postérieures à la référence, calculées sur une référence plus ancienne, sont
 *    recalculées : l'ancienne passe REMPLACE et la nouvelle la remplace (jamais d'écrasement).
 * Toutes les formules viennent de domain/telemetry/gps-calibration.ts (implémentation unique).
 */
@Injectable()
export class TelemetryCalibrationService implements OnModuleInit {
  private readonly logger = new Logger('TelemetrieCalibrage');

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestion: OdometerIngestionService,
    private readonly events: OdometerEventsService,
    private readonly settings: SettingsService,
    private readonly alerts: AlertsService,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.events.onAccepted('calibrage-gps', async (event) => {
      await this.onReadingAccepted(event);
    });
  }

  /** Relevé physique manuel ou importé accepté : nouvelle référence si le véhicule est associé en DISTANCE_GPS. */
  async onReadingAccepted(event: ReadingAcceptedEvent): Promise<CalibrationOutcome | null> {
    if (event.isEstimate || event.measurementKind !== 'COMPTEUR_AFFICHE' || (event.origin !== 'MANUAL' && event.origin !== 'IMPORT')) return null;
    // Véhicule sans association DISTANCE_GPS (cas courant) : aucune référence possible, une seule lecture
    // (calibrateFromReading exige de toute façon une association DISTANCE_GPS couvrant le relevé).
    const gps = await this.prisma.client.telemetryVehicleMapping.findFirst({ where: { vehicleId: event.vehicleId, odometerKind: 'DISTANCE_GPS', status: { in: ['CONFIRME', 'CLOTURE'] } }, select: { id: true } });
    if (!gps) return null;
    return this.calibrateFromReading(event.readingId);
  }

  /** Crée la référence de calibrage d'un relevé physique accepté (idempotent par relevé). */
  async calibrateFromReading(readingId: string): Promise<CalibrationOutcome | null> {
    const reading = await this.prisma.client.odometerReading.findUnique({ where: { id: readingId } });
    if (!reading || reading.status !== 'ACCEPTE' || reading.isEstimate || reading.measurementKind !== 'COMPTEUR_AFFICHE' || reading.source === 'TELEMATICS' || !reading.cumulativeKm) return null;
    const mapping = await this.coveringGpsMapping(reading.vehicleId, reading.observedAt);
    if (!mapping) return null;
    const company = await this.prisma.client.company.findUnique({ where: { id: mapping.companyId }, select: { telemetryEnabled: true } });
    if (!company?.telemetryEnabled) return null;
    if (await this.prisma.client.telemetryCalibration.findFirst({ where: { referenceReadingId: reading.id }, select: { id: true } })) return null;

    const org = reading.organizationId;
    const [gapMinutes, threshold, minDistance, timezone] = await Promise.all([
      this.settings.get(org, 'telemetry.calibrationMaxGapMinutes'),
      this.settings.get(org, 'telemetry.driftThresholdPercent', mapping.companyId),
      this.settings.get(org, 'telemetry.driftMinDistanceKm', mapping.companyId),
      this.timezone(org),
    ]);
    const at = reading.observedAt;
    const samples = await this.prisma.client.telemetryOdometerSample.findMany({
      where: { unitId: mapping.unitId, kind: 'DISTANCE_GPS', observedAt: { gte: new Date(at.getTime() - gapMinutes * 60_000), lte: at } },
      select: { observedAt: true, valueKm: true },
    });
    const sample = sampleForInstant(samples.map((s) => ({ observedAt: s.observedAt, gpsDistanceKm: dec(s.valueKm) })), at, gapMinutes);
    const previous = await this.prisma.client.telemetryCalibration.findFirst({
      where: { mappingId: mapping.id, status: 'CALIBRE', referenceAt: { lt: at } },
      orderBy: [{ referenceAt: 'desc' }, { createdAt: 'desc' }],
      include: { referenceReading: { select: { segmentId: true } } },
    });
    const manualKm = dec(reading.cumulativeKm);
    const previousReference: CalibrationReference | null =
      previous && previous.referenceGpsDistanceKm && previous.referenceReading.segmentId === reading.segmentId
        ? { manualKm: dec(previous.referenceKm), gpsDistanceKm: dec(previous.referenceGpsDistanceKm), observedAt: previous.referenceAt }
        : null;
    const drift = computeDrift(previousReference, sample, manualKm, threshold, minDistance);
    const status = sample ? 'CALIBRE' : 'NON_CALIBRABLE';
    const statusReason = sample
      ? null
      : `Aucune distance GPS reçue dans les ${gapMinutes} min précédant le relevé : estimations suspendues jusqu’au prochain relevé manuel.`;
    const calibration = await this.prisma.client.telemetryCalibration.create({
      data: {
        organizationId: org,
        vehicleId: reading.vehicleId,
        mappingId: mapping.id,
        status,
        referenceReadingId: reading.id,
        referenceKm: manualKm.toString(),
        referenceGpsDistanceKm: sample ? sample.gpsDistanceKm.toString() : null,
        referenceAt: at,
        previousCalibrationId: previous?.id ?? null,
        estimatedKmAtReference: drift ? drift.estimateKm.toString() : null,
        distanceSincePreviousKm: drift ? drift.distanceSinceReferenceKm.toString() : null,
        deviationKm: drift ? drift.estimateKm.minus(drift.manualKm).toString() : null,
        deviationPercent: drift ? Decimal.min(drift.percent, MAX_STORED_PERCENT).toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toString() : null,
        driftAlertRaised: drift?.exceeded ?? false,
        statusReason,
      },
    });

    if (drift) {
      const vehicle = await this.prisma.client.vehicle.findUniqueOrThrow({ where: { id: reading.vehicleId }, select: { code: true, lifecycleStatus: true } });
      const key = { organizationId: org, companyId: mapping.companyId, type: 'GPS_DERIVE' as const, objectType: MAPPING_ALERT_OBJECT, objectId: mapping.id, occurrenceKey: DRIFT_OCCURRENCE };
      if (drift.exceeded && vehicle.lifecycleStatus === 'ACTIF') {
        await this.alerts.raise({
          ...key,
          severity: 'ATTENTION',
          vehicleId: reading.vehicleId,
          title: `Dérive GPS — ${vehicle.code}`,
          message: `Écart de ${formatPercent(drift.percent)} % entre l’estimation GPS (${kmLabel(drift.estimateKm)}) et le relevé manuel (${kmLabel(drift.manualKm)}), sur ${kmLabel(drift.distanceSinceReferenceKm)} parcourus depuis la référence du ${formatLocal(previous?.referenceAt ?? at, timezone)} (seuil ${String(threshold).replace('.', ',')} %). Le relevé manuel devient la nouvelle référence.`,
          condition: { calibrationId: calibration.id, estimateKm: drift.estimateKm.toString(), manualKm: drift.manualKm.toString(), percent: drift.percent.toString(), thresholdPercent: threshold },
          actionPath: `/vehicules/${reading.vehicleId}?onglet=kilometrage`,
        });
      } else {
        await this.alerts.resolve(key, 'Écart GPS revenu sous le seuil au dernier calibrage.');
      }
    }

    const recalculated = status === 'CALIBRE' && sample ? await this.recalculateLaterEstimates(mapping, calibration, { manualKm, gpsDistanceKm: sample.gpsDistanceKm, observedAt: at }, reading.segmentId, timezone) : 0;
    return { calibrationId: calibration.id, status, driftPercent: drift ? formatPercent(drift.percent) : null, driftAlert: Boolean(drift?.exceeded), recalculated };
  }

  /**
   * Référence en vigueur à l'instant `at` pour l'association : la plus récente (referenceAt ≤ at) ; une
   * référence NON_CALIBRABLE suspend les estimations jusqu'à la suivante.
   */
  async activeCalibration(mappingId: string, at: Date, timezone: string): Promise<ActiveCalibration | null> {
    const calibration = await this.prisma.client.telemetryCalibration.findFirst({
      where: { mappingId, referenceAt: { lte: at } },
      orderBy: [{ referenceAt: 'desc' }, { createdAt: 'desc' }],
      include: { referenceReading: { select: { segmentId: true } } },
    });
    if (!calibration || calibration.status !== 'CALIBRE' || !calibration.referenceGpsDistanceKm) return null;
    return {
      id: calibration.id,
      reference: { manualKm: dec(calibration.referenceKm), gpsDistanceKm: dec(calibration.referenceGpsDistanceKm), observedAt: calibration.referenceAt },
      referenceSegmentId: calibration.referenceReading.segmentId,
      note: estimateNote(calibration.referenceAt, dec(calibration.referenceKm), timezone),
    };
  }

  /**
   * Amorçage : une association DISTANCE_GPS sans aucun calibrage prend comme références les derniers
   * relevés physiques acceptés de sa période (reprise initiale, association antidatée).
   */
  async ensureCalibrations(mappingId: string): Promise<void> {
    if ((await this.prisma.client.telemetryCalibration.count({ where: { mappingId } })) > 0) return;
    const mapping = await this.prisma.client.telemetryVehicleMapping.findUnique({ where: { id: mappingId } });
    if (!mapping?.validFrom || mapping.odometerKind !== 'DISTANCE_GPS') return;
    const candidates = await this.prisma.client.odometerReading.findMany({
      where: {
        vehicleId: mapping.vehicleId,
        status: 'ACCEPTE',
        isEstimate: false,
        measurementKind: 'COMPTEUR_AFFICHE',
        source: { in: ['MANUAL', 'IMPORT'] },
        observedAt: { gte: mapping.validFrom, ...(mapping.validTo ? { lt: mapping.validTo } : {}) },
      },
      orderBy: [{ observedAt: 'desc' }, { enteredAt: 'desc' }],
      take: BOOTSTRAP_CANDIDATES,
      select: { id: true },
    });
    for (const c of candidates.reverse()) {
      try {
        await this.calibrateFromReading(c.id);
      } catch (error) {
        this.logger.error(`Amorçage du calibrage (association ${mappingId}) en échec : ${describeErrorSafely(error)}`);
      }
    }
  }

  /** Association DISTANCE_GPS couvrant l'instant (validFrom ≤ t < validTo, confirmée ou clôturée). */
  private async coveringGpsMapping(vehicleId: string, at: Date): Promise<CoveringMapping | null> {
    return this.prisma.client.telemetryVehicleMapping.findFirst({
      where: { vehicleId, odometerKind: 'DISTANCE_GPS', status: { in: ['CONFIRME', 'CLOTURE'] }, validFrom: { lte: at }, OR: [{ validTo: null }, { validTo: { gt: at } }] },
      include: { unit: { select: { id: true, externalId: true, label: true } }, provider: { select: { id: true, channel: true, status: true } } },
      orderBy: { validFrom: 'desc' },
    });
  }

  /**
   * Estimations postérieures à la nouvelle référence (jusqu'à la référence suivante) calculées sur une
   * référence plus ancienne : recalculées par l'ingestion unique (D-147), l'ancienne passant REMPLACE.
   */
  private async recalculateLaterEstimates(mapping: CoveringMapping, calibration: TelemetryCalibration, reference: CalibrationReference, segmentId: string, timezone: string): Promise<number> {
    const next = await this.prisma.client.telemetryCalibration.findFirst({
      where: { mappingId: mapping.id, id: { not: calibration.id }, referenceAt: { gt: reference.observedAt } },
      orderBy: [{ referenceAt: 'asc' }, { createdAt: 'asc' }],
      select: { referenceAt: true },
    });
    const estimates = await this.prisma.client.odometerReading.findMany({
      where: {
        vehicleId: mapping.vehicleId,
        status: 'ACCEPTE',
        isEstimate: true,
        measurementKind: 'DISTANCE_GPS',
        providerId: mapping.providerId,
        providerUnitId: mapping.unit.externalId,
        observedAt: { gt: reference.observedAt, ...(next ? { lt: next.referenceAt } : {}) },
        OR: [{ calibrationId: null }, { calibrationId: { not: calibration.id } }],
      },
      orderBy: { observedAt: 'asc' },
      take: MAX_RECALCULATED,
    });
    const note = estimateNote(reference.observedAt, reference.manualKm, timezone);
    const reason = `Recalcul sur la nouvelle référence manuelle du ${formatLocal(reference.observedAt, timezone)} (${kmLabel(reference.manualKm)}).`;
    let recalculated = 0;
    for (const e of estimates) {
      if (!e.gpsDistanceKm) continue;
      const gpsDistanceKm = dec(e.gpsDistanceKm);
      const estimate = estimateFromGps(reference, gpsDistanceKm);
      if (!estimate) continue;
      try {
        const { result, after } = await this.prisma.serializable(async (tx) => {
          const after = new AfterCommit();
          const result = await this.ingestion.ingestGpsEstimate(
            tx,
            {
              organizationId: e.organizationId,
              vehicleId: e.vehicleId,
              observedAt: e.observedAt,
              estimatedCumulativeKm: estimate,
              gpsDistanceKm,
              calibrationId: calibration.id,
              referenceSegmentId: segmentId,
              note,
              telematics: { channel: e.channel ?? mapping.provider.channel, providerId: mapping.providerId, providerUnitId: mapping.unit.externalId, sourceReference: e.sourceReference, receivedAt: e.receivedAt ?? this.clock.now() },
              replaces: { readingId: e.id, reason },
            },
            after,
          );
          return { result, after };
        });
        await after.run();
        if (result.outcome === 'ACCEPTE') recalculated += 1;
      } catch (error) {
        this.logger.error(`Recalcul de l’estimation GPS ${e.id} en échec : ${describeErrorSafely(error)}`);
      }
    }
    return recalculated;
  }

  private async timezone(organizationId: string): Promise<string> {
    const org = await this.prisma.client.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } });
    return org.timezone;
  }
}

/** Date locale (fuseau de l'organisation) au format JJ/MM/AAAA. */
export function formatLocal(at: Date, timezone: string): string {
  return DateTime.fromJSDate(at, { zone: timezone }).toFormat('dd/LL/yyyy');
}

/** Libellé d'une estimation : « Estimé GPS (réf. manuelle du 24/09/2026, 80 000 km) » (D-178). */
export function estimateNote(referenceAt: Date, referenceKm: Decimal, timezone: string): string {
  return `Estimé GPS (réf. manuelle du ${formatLocal(referenceAt, timezone)}, ${kmLabel(referenceKm)})`;
}
