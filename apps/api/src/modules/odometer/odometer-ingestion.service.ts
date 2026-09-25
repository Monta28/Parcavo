import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { MeasurementKind, OdometerReading, OdometerSegment, ReadingContext, ReadingSource, TelemetryChannel } from '@parc-auto/db';
import { AfterCommit } from '../../common/after-commit.js';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, ConflictError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { cumulativeKm, evaluateReading, instantWindow, isOrdinaryFirstSegment, ordinaryFirstSegmentStart, readingFieldForAnomaly, type Evaluation, type NeighborReading } from '../../domain/odometer-rules.js';
import { type Tx, isUniqueViolation } from '../../infra/prisma.service.js';
import { organizationTimezone } from '../../common/request-memo.js';
import { AlertsService } from '../alerts/alerts.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { OdometerEventsService } from './odometer-events.service.js';

export type IngestAuthor = { kind: 'STAFF'; userId: string } | { kind: 'DRIVER'; userId: string } | { kind: 'SYSTEM' };

export interface IngestInput {
  organizationId: string;
  vehicleId: string;
  origin: ReadingSource;
  context: ReadingContext;
  measurementKind: Exclude<MeasurementKind, 'DISTANCE_GPS'>;
  physicalKm: Decimal;
  observedAt: Date;
  author: IngestAuthor;
  attachmentId?: string | null;
  note?: string | null;
  /** Segment explicite (relevé rétroactif sur un ancien compteur) ; sinon segment couvrant la date. */
  segmentId?: string | null;
  telematics?: { channel: TelemetryChannel; providerId: string; providerUnitId: string; sourceReference: string | null; receivedAt: Date } | null;
  importBatchId?: string | null;
  /**
   * Création automatique du premier segment (initialisation ordinaire : cumul = physique). Par défaut pour
   * tout relevé manuel du personnel (D-167 : le premier relevé accepté crée le segment 1) ; jamais pour un
   * import (D-279 : INITIAL explicite) ni pour la télématique.
   */
  allowAutoInit?: boolean;
}

export interface IngestResult {
  reading: OdometerReading;
  outcome: 'ACCEPTE' | 'EN_ATTENTE' | 'IDEMPOTENT';
  anomaly: { code: string; reason: string } | null;
  /** Rang du compteur du relevé créé (absent pour une réponse IDEMPOTENT : relevé existant à relire). */
  segmentSequence?: number;
}

/**
 * Estimation DISTANCE_GPS calibrée (CDC 5.6 ; D-147, D-161, D-178, D-285) : kilométrage cumulé estimé par
 * le calibrage (domain/telemetry/gps-calibration.ts), jamais présenté comme un compteur. Réservée au
 * connecteur télématique (auteur système).
 */
export interface GpsEstimateInput {
  organizationId: string;
  vehicleId: string;
  observedAt: Date;
  /** Kilométrage cumulé estimé (référence manuelle + distance GPS parcourue depuis la référence). */
  estimatedCumulativeKm: Decimal;
  /** Odomètre virtuel brut du fournisseur à observedAt. */
  gpsDistanceKm: Decimal;
  calibrationId: string;
  /** Segment du relevé de référence : une estimation ne franchit jamais un changement de compteur (D-174). */
  referenceSegmentId: string;
  /** Libellé affiché avec la valeur (« estimé GPS » et date de la référence manuelle). */
  note: string;
  telematics: { channel: TelemetryChannel; providerId: string; providerUnitId: string; sourceReference: string | null; receivedAt: Date };
  /** Recalcul après une nouvelle référence (D-147) : l'estimation remplacée passe REMPLACE, sans être écrasée. */
  replaces?: { readingId: string; reason: string } | null;
}

export interface GpsEstimateResult {
  reading: OdometerReading | null;
  outcome: 'ACCEPTE' | 'IDEMPOTENT' | 'ECARTE';
  /** Motif d'une estimation écartée (contrôles uniques de 5.2 appliqués à la valeur estimée). */
  reason: { code: string; reason: string } | null;
}

/**
 * Service d'ingestion unique des relevés (CDC 14.3) : MANUAL, IMPORT et TELEMATICS passent par les
 * mêmes contrôles de validation, de chronologie, d'idempotence et de source. La source TELEMATICS n'est
 * jamais acceptée depuis un endpoint public : seul le worker (auteur SYSTEM) l'utilise.
 * Doit être appelé dans une transaction ; les effets dépendants sont différés après validation.
 */
@Injectable()
export class OdometerIngestionService {
  constructor(
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly events: OdometerEventsService,
    private readonly alerts: AlertsService,
  ) {}

  async ingest(tx: Tx, input: IngestInput, afterCommit: AfterCommit): Promise<IngestResult> {
    if (input.origin === 'TELEMATICS' && input.author.kind !== 'SYSTEM') {
      throw new BusinessRuleError('SOURCE_INTERDITE', 'La source TELEMATICS est réservée au connecteur télématique.');
    }
    const vehicle = await lockVehicleOf(tx, input.vehicleId, input.organizationId);
    if (!vehicle) throw new NotFoundOrOutOfScopeError('Véhicule');

    // Idempotence télématique (5.6) : (fournisseur, unité, sourceReference).
    if (input.telematics?.sourceReference) {
      const dup = await tx.odometerReading.findFirst({
        where: { providerId: input.telematics.providerId, providerUnitId: input.telematics.providerUnitId, sourceReference: input.telematics.sourceReference },
      });
      if (dup) return { reading: dup, outcome: 'IDEMPOTENT', anomaly: null };
    }

    let segment = await this.findSegment(tx, input.vehicleId, input.observedAt, input.segmentId ?? null);
    const isDriver = input.author.kind === 'DRIVER';
    const autoInit = input.allowAutoInit ?? (input.origin === 'MANUAL' && input.author.kind === 'STAFF');
    if (!segment) {
      const first = await tx.odometerSegment.findFirst({ where: { vehicleId: input.vehicleId }, orderBy: { sequence: 'asc' } });
      if (first) {
        // D-167 : un relevé du personnel antérieur au segment 1 d'initialisation ordinaire y est évalué (seuls
        // ses voisins le contraignent) ; accepté, il en devient le début (refreshSegmentLast).
        const intoOrdinaryFirst = !input.segmentId && autoInit && input.author.kind === 'STAFF' && input.origin !== 'TELEMATICS' && (await isOrdinarySegment(tx, first));
        if (!intoOrdinaryFirst) {
          const reason = 'La date d’observation précède le début du premier compteur enregistré.';
          if (input.origin === 'TELEMATICS') return this.storePending(tx, input, vehicle.companyId, first, 'AVANT_DEBUT_SEGMENT', reason, afterCommit);
          throw new BusinessRuleError('AVANT_DEBUT_SEGMENT', reason, { fieldErrors: { observedAt: [reason] } });
        }
        segment = first;
      } else {
        if (!autoInit && !isDriver) {
          throw new BusinessRuleError('COMPTEUR_NON_INITIALISE', 'Le compteur de ce véhicule n’est pas initialisé : enregistrez d’abord la valeur initiale.');
        }
        if (isDriver) {
          // Pas de segment : la soumission reste en attente sur un segment provisoire (D-167).
          return this.storePendingWithoutSegment(tx, input, vehicle.companyId, afterCommit);
        }
        segment = await tx.odometerSegment.create({
          data: {
            organizationId: input.organizationId,
            vehicleId: input.vehicleId,
            sequence: 1,
            startedAt: input.observedAt,
            startPhysicalKm: input.physicalKm.toString(),
            startCumulativeKm: input.physicalKm.toString(),
            cumulativeKnown: true,
            replacementReason: 'Initialisation ordinaire au premier relevé (cumul égal au compteur physique).',
            createdById: input.author.kind === 'SYSTEM' ? null : input.author.userId,
          },
        });
      }
    }

    // Même opération déjà enregistrée en attente (même compteur, source, contexte, valeur et instant) :
    // le relevé existant est renvoyé, sans doublon (D-149).
    if (input.origin !== 'TELEMATICS') {
      const pendingSame = await tx.odometerReading.findFirst({
        where: { vehicleId: input.vehicleId, segmentId: segment.id, status: 'EN_ATTENTE', source: input.origin, context: input.context, physicalKm: input.physicalKm.toString(), observedAt: instantWindow(input.origin, input.observedAt) },
      });
      if (pendingSame) return { reading: pendingSame, outcome: 'IDEMPOTENT', anomaly: null };
    }

    // Segment 1 d'initialisation ordinaire (D-167) : évalué une fois, réutilisé par evaluate et refreshSegmentLast.
    const ordinary = await isOrdinarySegment(tx, segment);
    const evaluation = await this.evaluate(tx, input, segment, null, vehicle.companyId, { ordinary });
    const companyId = await companyAt(tx, input.vehicleId, input.observedAt, vehicle.companyId);

    if (evaluation.outcome === 'IDEMPOTENT') {
      const existing = await tx.odometerReading.findUniqueOrThrow({ where: { id: evaluation.existingId } });
      return { reading: existing, outcome: 'IDEMPOTENT', anomaly: null };
    }
    if (evaluation.outcome === 'REJECT') {
      throw new BusinessRuleError(evaluation.code, evaluation.reason, { fieldErrors: { [readingFieldForAnomaly(evaluation.code)]: [evaluation.reason] }, details: { anomaly: evaluation.code } });
    }
    if (evaluation.outcome === 'CONFLICT') {
      throw new ConflictError(evaluation.code, evaluation.reason, { existingReadingId: evaluation.existingId });
    }

    let status: 'ACCEPTE' | 'EN_ATTENTE' = evaluation.outcome === 'ACCEPT' ? 'ACCEPTE' : 'EN_ATTENTE';
    let anomaly: { code: string; reason: string } | null = evaluation.outcome === 'PENDING' ? { code: evaluation.code, reason: evaluation.reason } : null;
    if (isDriver && status === 'ACCEPTE') {
      status = 'EN_ATTENTE';
      anomaly = { code: 'SOUMISSION_CONDUCTEUR', reason: 'Soumission conducteur : validation par le chef de parc requise.' };
    } else if (isDriver && anomaly) {
      anomaly = { code: anomaly.code, reason: `Soumission conducteur. ${anomaly.reason}` };
    }

    const reading = await this.insert(tx, input, companyId, segment, status, anomaly);
    if (status === 'ACCEPTE') {
      // Le relevé inséré ne modifie pas le segment ; un relevé d'initialisation retire au segment son caractère ordinaire.
      await refreshSegmentLast(tx, segment.id, { segment, ordinary: ordinary && input.context !== 'INITIALISATION' });
      this.scheduleAccepted(afterCommit, { organizationId: input.organizationId, companyId, vehicleId: input.vehicleId, readingId: reading.id, origin: input.origin, measurementKind: input.measurementKind }, { acceptedAtInsert: true });
    } else {
      this.schedulePendingAlert(afterCommit, reading, input);
    }
    return { reading, outcome: status, anomaly, segmentSequence: segment.sequence };
  }

  /**
   * Estimation GPS calibrée (D-147, D-161, D-178) : stockée ACCEPTE, isEstimate, DISTANCE_GPS, avec la
   * distance GPS brute et le lien de calibrage. Elle passe par les mêmes contrôles que les autres sources
   * (evaluate : valeur, date, chronologie et plausibilité face aux seuls relevés physiques du segment,
   * ramenée au compteur physique du segment) ; une estimation incohérente est écartée, jamais mise en
   * attente, car elle ne se valide pas comme une lecture de compteur. Les estimations ne servent jamais
   * de voisin aux relevés physiques (evaluate les exclut). Idempotence par (fournisseur, unité,
   * sourceReference) comme pour ingest.
   */
  async ingestGpsEstimate(tx: Tx, input: GpsEstimateInput, afterCommit: AfterCommit): Promise<GpsEstimateResult> {
    const vehicle = await lockVehicleOf(tx, input.vehicleId, input.organizationId);
    if (!vehicle) throw new NotFoundOrOutOfScopeError('Véhicule');
    if (!input.replaces && input.telematics.sourceReference) {
      const dup = await tx.odometerReading.findFirst({
        where: { providerId: input.telematics.providerId, providerUnitId: input.telematics.providerUnitId, sourceReference: input.telematics.sourceReference },
      });
      if (dup) return { reading: dup, outcome: 'IDEMPOTENT', reason: null };
    }
    const segment = await this.findSegment(tx, input.vehicleId, input.observedAt, null);
    if (!segment || segment.id !== input.referenceSegmentId) {
      return { reading: null, outcome: 'ECARTE', reason: { code: 'SEGMENT_DIFFERENT', reason: 'Le compteur a changé depuis la référence manuelle : estimation GPS suspendue jusqu’au prochain relevé manuel.' } };
    }
    const physicalEquivalent = input.estimatedCumulativeKm.minus(dec(segment.startCumulativeKm)).plus(dec(segment.startPhysicalKm));
    const evaluation = await this.evaluate(tx, { organizationId: input.organizationId, vehicleId: input.vehicleId, origin: 'TELEMATICS', physicalKm: physicalEquivalent, observedAt: input.observedAt }, segment, null, vehicle.companyId);
    if (evaluation.outcome === 'IDEMPOTENT') {
      return { reading: null, outcome: 'ECARTE', reason: { code: 'MESURE_EXISTANTE', reason: 'Un relevé physique de même valeur existe au même instant.' } };
    }
    if (evaluation.outcome !== 'ACCEPT') return { reading: null, outcome: 'ECARTE', reason: { code: evaluation.code, reason: evaluation.reason } };
    const companyId = await companyAt(tx, input.vehicleId, input.observedAt, vehicle.companyId);
    if (input.replaces) {
      const replaced = await tx.odometerReading.updateMany({
        where: { id: input.replaces.readingId, vehicleId: input.vehicleId, status: 'ACCEPTE', isEstimate: true },
        data: { status: 'REMPLACE', version: { increment: 1 } },
      });
      if (replaced.count === 0) return { reading: null, outcome: 'ECARTE', reason: { code: 'DEJA_REMPLACE', reason: 'Estimation déjà remplacée.' } };
    }
    const now = this.clock.now();
    let reading: OdometerReading;
    try {
      reading = await tx.odometerReading.create({
        data: {
          organizationId: input.organizationId,
          companyId,
          vehicleId: input.vehicleId,
          segmentId: segment.id,
          source: 'TELEMATICS',
          context: 'SYNCHRONISATION',
          measurementKind: 'DISTANCE_GPS',
          status: 'ACCEPTE',
          physicalKm: null,
          cumulativeKm: input.estimatedCumulativeKm.toString(),
          isEstimate: true,
          gpsDistanceKm: input.gpsDistanceKm.toString(),
          calibrationId: input.calibrationId,
          observedAt: input.observedAt,
          enteredAt: now,
          note: input.note,
          channel: input.telematics.channel,
          providerId: input.telematics.providerId,
          providerUnitId: input.telematics.providerUnitId,
          // Un recalcul garde la référence d'origine sur l'estimation remplacée : le rejeu reste idempotent.
          sourceReference: input.replaces ? null : input.telematics.sourceReference,
          receivedAt: input.telematics.receivedAt,
          replacesReadingId: input.replaces?.readingId ?? null,
          correctionReason: input.replaces?.reason ?? null,
          decidedAt: now,
        },
      });
    } catch (error) {
      // Insertion concurrente du même échantillon : la transaction est invalidée, l'appelant compte un doublon.
      if (isUniqueViolation(error, 'reading_telematics_source_ref')) throw new ConflictError('DOUBLON_TELEMATIQUE', 'Échantillon télématique déjà enregistré.');
      throw error;
    }
    this.scheduleAccepted(afterCommit, { organizationId: input.organizationId, companyId, vehicleId: input.vehicleId, readingId: reading.id, origin: 'TELEMATICS', measurementKind: 'DISTANCE_GPS', isEstimate: true }, { acceptedAtInsert: true });
    return { reading, outcome: 'ACCEPTE', reason: null };
  }

  /**
   * Relevé automatique mis d'office en attente avec un motif imposé par le connecteur (D-175, D-186 :
   * véhicule HORS_SERVICE à la date d'observation → VEHICULE_NON_ACTIF). Mêmes garde-fous que ingest :
   * source réservée au connecteur, verrou véhicule, idempotence (fournisseur, unité, sourceReference),
   * segment couvrant la date et contrôles uniques de valeur et de date (evaluate) ; jamais accepté
   * automatiquement, donc exclu des calculs et du contrôle de chronologie jusqu'à la décision du chef.
   */
  async ingestTelematicsPending(tx: Tx, input: IngestInput, anomaly: { code: string; reason: string }, afterCommit: AfterCommit): Promise<IngestResult> {
    if (input.origin !== 'TELEMATICS' || input.author.kind !== 'SYSTEM') {
      throw new BusinessRuleError('SOURCE_INTERDITE', 'La mise en attente d’office est réservée au connecteur télématique.');
    }
    const vehicle = await lockVehicleOf(tx, input.vehicleId, input.organizationId);
    if (!vehicle) throw new NotFoundOrOutOfScopeError('Véhicule');
    if (input.telematics?.sourceReference) {
      const dup = await tx.odometerReading.findFirst({
        where: { providerId: input.telematics.providerId, providerUnitId: input.telematics.providerUnitId, sourceReference: input.telematics.sourceReference },
      });
      if (dup) return { reading: dup, outcome: 'IDEMPOTENT', anomaly: null };
    }
    const segment = await this.findSegment(tx, input.vehicleId, input.observedAt, null);
    if (!segment) throw new BusinessRuleError('COMPTEUR_NON_INITIALISE', 'Le compteur de ce véhicule n’est pas initialisé à cette date : enregistrez d’abord la valeur initiale.');
    const evaluation = await this.evaluate(tx, input, segment, null, vehicle.companyId);
    if (evaluation.outcome === 'REJECT') throw new BusinessRuleError(evaluation.code, evaluation.reason, { details: { anomaly: evaluation.code } });
    if (evaluation.outcome === 'IDEMPOTENT') {
      return { reading: await tx.odometerReading.findUniqueOrThrow({ where: { id: evaluation.existingId } }), outcome: 'IDEMPOTENT', anomaly: null };
    }
    const reason = evaluation.outcome === 'ACCEPT' ? anomaly.reason : `${anomaly.reason} ${evaluation.reason}`;
    return this.storePending(tx, input, vehicle.companyId, segment, anomaly.code, reason, afterCommit);
  }

  /**
   * Réévalue un relevé en attente au moment de son approbation (voisins courants, lui-même exclu).
   * Une hausse jugée implausible peut être validée explicitement ; une rupture de chronologie non.
   */
  async evaluateForApproval(tx: Tx, reading: OdometerReading, segment: OdometerSegment): Promise<Evaluation> {
    const physical = reading.physicalKm ? new Decimal(reading.physicalKm.toString()) : null;
    if (!physical) return { outcome: 'REJECT', code: 'VALEUR_NEGATIVE', reason: 'Relevé sans valeur physique.' };
    // Une approbation humaine est un acte manuel : la diminution d'un relevé automatique reste refusée.
    return this.evaluate(tx, { organizationId: reading.organizationId, vehicleId: reading.vehicleId, origin: 'MANUAL', physicalKm: physical, observedAt: reading.observedAt }, segment, reading.id, reading.companyId);
  }

  async evaluate(tx: Tx, input: Pick<IngestInput, 'vehicleId' | 'origin' | 'physicalKm' | 'observedAt' | 'organizationId'>, segment: OdometerSegment, excludeId: string | null, companyId?: string, known?: { ordinary?: boolean }): Promise<Evaluation> {
    const instant = instantWindow(input.origin, input.observedAt);
    // Voisins physiques acceptés du segment (lui-même exclu) : précédent, suivant et même instant, en une lecture.
    const [neighbors, following] = await Promise.all([
      tx.$queryRaw<Array<{ slot: 'previous' | 'next' | 'same'; id: string; physicalKm: string | null; observedAt: Date }>>`
        (SELECT 'previous' AS "slot", "id", "physicalKm"::text AS "physicalKm", "observedAt" FROM "OdometerReading"
          WHERE "segmentId" = ${segment.id}::uuid AND "status" = 'ACCEPTE'::"ReadingStatus" AND "isEstimate" = false AND (${excludeId}::uuid IS NULL OR "id" <> ${excludeId}::uuid)
            AND "observedAt" < ${instant.gte}::timestamptz
          ORDER BY "observedAt" DESC, "enteredAt" DESC LIMIT 1)
        UNION ALL
        (SELECT 'next' AS "slot", "id", "physicalKm"::text AS "physicalKm", "observedAt" FROM "OdometerReading"
          WHERE "segmentId" = ${segment.id}::uuid AND "status" = 'ACCEPTE'::"ReadingStatus" AND "isEstimate" = false AND (${excludeId}::uuid IS NULL OR "id" <> ${excludeId}::uuid)
            AND "observedAt" >= ${instant.lt}::timestamptz
          ORDER BY "observedAt" ASC, "enteredAt" ASC LIMIT 1)
        UNION ALL
        (SELECT 'same' AS "slot", "id", "physicalKm"::text AS "physicalKm", "observedAt" FROM "OdometerReading"
          WHERE "segmentId" = ${segment.id}::uuid AND "status" = 'ACCEPTE'::"ReadingStatus" AND "isEstimate" = false AND (${excludeId}::uuid IS NULL OR "id" <> ${excludeId}::uuid)
            AND "observedAt" >= ${instant.gte}::timestamptz AND "observedAt" < ${instant.lt}::timestamptz
          ORDER BY "observedAt" ASC, "enteredAt" ASC LIMIT 1)`,
      segment.endedAt ? tx.odometerSegment.findFirst({ where: { vehicleId: segment.vehicleId, sequence: { gt: segment.sequence } }, orderBy: { sequence: 'asc' } }) : null,
    ]);
    const slot = (name: 'previous' | 'next' | 'same') => neighbors.find((n) => n.slot === name) ?? null;
    const previous = slot('previous');
    const next = slot('next');
    const sameInstant = slot('same');
    const vehicleCompany = companyId ?? (await tx.vehicle.findUniqueOrThrow({ where: { id: input.vehicleId }, select: { companyId: true } })).companyId;
    const { 'odometer.plausibilityMaxKmPerDay': maxKmPerDay, 'odometer.plausibilityMinKm': minKm } = await this.settings.getMany(input.organizationId, ['odometer.plausibilityMaxKmPerDay', 'odometer.plausibilityMinKm'], vehicleCompany, tx);
    const timezone = await organizationTimezone(tx, input.organizationId);
    return evaluateReading({
      origin: input.origin,
      physicalKm: input.physicalKm,
      observedAt: input.observedAt,
      now: this.clock.now(),
      timezone,
      segment: { startPhysicalKm: dec(segment.startPhysicalKm), startCumulativeKm: dec(segment.startCumulativeKm), startedAt: segment.startedAt, ordinary: known?.ordinary ?? (await isOrdinarySegment(tx, segment)) },
      sameInstant: neighbor(sameInstant),
      previous: neighbor(previous),
      next: neighbor(next) ?? closedSegmentBound(segment, following),
      policy: { maxKmPerDay: new Decimal(maxKmPerDay), minAllowanceKm: new Decimal(minKm) },
    });
  }

  async findSegment(tx: Tx, vehicleId: string, observedAt: Date, explicitSegmentId: string | null): Promise<OdometerSegment | null> {
    if (explicitSegmentId) {
      const s = await tx.odometerSegment.findFirst({ where: { id: explicitSegmentId, vehicleId } });
      if (!s) throw new NotFoundOrOutOfScopeError('Segment de compteur');
      return s;
    }
    // Segment couvrant la date : début ≤ observation et (ouvert ou observation < fin) ; à égalité le plus récent.
    return tx.odometerSegment.findFirst({
      where: { vehicleId, startedAt: { lte: observedAt }, OR: [{ endedAt: null }, { endedAt: { gt: observedAt } }] },
      orderBy: { sequence: 'desc' },
    });
  }

  scheduleAccepted(
    afterCommit: AfterCommit,
    event: Parameters<OdometerEventsService['onAccepted']>[1] extends (e: infer E) => Promise<void> ? Omit<E, 'isEstimate'> & { isEstimate?: boolean } : never,
    options: { acceptedAtInsert?: boolean } = {},
  ): void {
    const accepted = { ...event, isEstimate: event.isEstimate ?? false };
    // Fraîcheur, échéances d'entretien et leurs alertes : une seule transaction après validation (lectures et
    // écritures groupées), au lieu d'une transaction par plan et d'écritures unitaires.
    afterCommit.add('relevé accepté → données dépendantes (fraîcheur, entretien)', async () => {
      await this.events.recomputeDependents(accepted);
    });
    for (const { name, listener } of this.events.subscribers()) {
      afterCommit.add(`relevé accepté → ${name}`, () => listener(accepted));
    }
    // Relevé accepté dès son insertion (nouvel identifiant, jamais en attente) : aucune alerte « à valider » ne le vise.
    if (options.acceptedAtInsert) return;
    afterCommit.add('relevé accepté → alertes de validation', async () => {
      await this.alerts.resolve({ organizationId: event.organizationId, type: 'RELEVE_A_VALIDER', objectType: 'OdometerReading', objectId: event.readingId }, 'relevé accepté');
    });
  }

  private schedulePendingAlert(afterCommit: AfterCommit, reading: OdometerReading, input: IngestInput): void {
    afterCommit.add('relevé en attente → alerte', async () => {
      await this.alerts.raise({
        organizationId: input.organizationId,
        companyId: reading.companyId,
        type: 'RELEVE_A_VALIDER',
        severity: reading.anomalyCode === 'SOUMISSION_CONDUCTEUR' ? 'INFO' : 'ATTENTION',
        objectType: 'OdometerReading',
        objectId: reading.id,
        vehicleId: reading.vehicleId,
        occurrenceKey: 'validation',
        title: 'Relevé kilométrique à valider',
        message: reading.statusReason ?? 'Relevé en attente de validation.',
        condition: { physicalKm: reading.physicalKm?.toString() ?? null, observedAt: reading.observedAt.toISOString(), anomaly: reading.anomalyCode },
        actionPath: `/kilometrage?statut=EN_ATTENTE&vehicule=${reading.vehicleId}`,
      });
    });
  }

  private async insert(tx: Tx, input: IngestInput, companyId: string, segment: OdometerSegment, status: 'ACCEPTE' | 'EN_ATTENTE', anomaly: { code: string; reason: string } | null): Promise<OdometerReading> {
    const cumulative = cumulativeKm({ startPhysicalKm: dec(segment.startPhysicalKm), startCumulativeKm: dec(segment.startCumulativeKm) }, input.physicalKm);
    try {
      return await tx.odometerReading.create({
        data: {
          organizationId: input.organizationId,
          companyId,
          vehicleId: input.vehicleId,
          segmentId: segment.id,
          source: input.origin,
          context: input.context,
          measurementKind: input.measurementKind,
          status,
          physicalKm: input.physicalKm.toString(),
          cumulativeKm: cumulative.toString(),
          isEstimate: false,
          observedAt: input.observedAt,
          enteredAt: this.clock.now(),
          statusReason: anomaly?.reason ?? null,
          anomalyCode: anomaly?.code ?? null,
          attachmentId: input.attachmentId ?? null,
          note: input.note ?? null,
          channel: input.telematics?.channel ?? null,
          providerId: input.telematics?.providerId ?? null,
          providerUnitId: input.telematics?.providerUnitId ?? null,
          sourceReference: input.telematics?.sourceReference ?? null,
          receivedAt: input.telematics?.receivedAt ?? null,
          importBatchId: input.importBatchId ?? null,
          decidedAt: status === 'ACCEPTE' ? this.clock.now() : null,
          decidedById: status === 'ACCEPTE' && input.author.kind !== 'SYSTEM' ? input.author.userId : null,
          createdById: input.author.kind === 'SYSTEM' ? null : input.author.userId,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error, 'reading_one_accepted_physical_per_instant')) {
        throw new ConflictError('CONFLIT_MEME_INSTANT', 'Un autre relevé accepté existe au même instant sur ce compteur.');
      }
      if (isUniqueViolation(error, 'reading_telematics_source_ref')) {
        const dup = await tx.odometerReading.findFirstOrThrow({ where: { providerId: input.telematics?.providerId ?? null, providerUnitId: input.telematics?.providerUnitId ?? null, sourceReference: input.telematics?.sourceReference ?? null } });
        return dup;
      }
      throw error;
    }
  }

  private async storePending(tx: Tx, input: IngestInput, vehicleCompanyId: string, segment: OdometerSegment, code: string, reason: string, afterCommit: AfterCommit): Promise<IngestResult> {
    const companyId = await companyAt(tx, input.vehicleId, input.observedAt, vehicleCompanyId);
    const reading = await this.insert(tx, input, companyId, segment, 'EN_ATTENTE', { code, reason });
    this.schedulePendingAlert(afterCommit, reading, input);
    return { reading, outcome: 'EN_ATTENTE', anomaly: { code, reason }, segmentSequence: segment.sequence };
  }

  /** Soumission conducteur sur un véhicule sans compteur initialisé : segment provisoire créé à l'approbation. */
  private async storePendingWithoutSegment(tx: Tx, input: IngestInput, vehicleCompanyId: string, afterCommit: AfterCommit): Promise<IngestResult> {
    const segment = await tx.odometerSegment.create({
      data: {
        organizationId: input.organizationId,
        vehicleId: input.vehicleId,
        sequence: 1,
        startedAt: input.observedAt,
        startPhysicalKm: input.physicalKm.toString(),
        startCumulativeKm: input.physicalKm.toString(),
        cumulativeKnown: true,
        replacementReason: 'Initialisation ordinaire à partir de la première soumission (en attente de validation).',
      },
    });
    const reason = 'Soumission conducteur : validation par le chef de parc requise.';
    const reading = await this.insert(tx, input, vehicleCompanyId, segment, 'EN_ATTENTE', { code: 'SOUMISSION_CONDUCTEUR', reason });
    this.schedulePendingAlert(afterCommit, reading, input);
    return { reading, outcome: 'EN_ATTENTE', anomaly: { code: 'SOUMISSION_CONDUCTEUR', reason }, segmentSequence: segment.sequence };
  }
}

/**
 * Segment 1 d'initialisation ordinaire (D-167, règle unique domain/odometer-rules.ts) : créé au premier relevé,
 * cumul = physique, sans relevé d'initialisation explicite ; son début n'est que le premier relevé accepté.
 */
export async function isOrdinarySegment(tx: Tx, segment: OdometerSegment): Promise<boolean> {
  const shape = { sequence: segment.sequence, cumulativeKnown: segment.cumulativeKnown, startPhysicalKm: dec(segment.startPhysicalKm), startCumulativeKm: dec(segment.startCumulativeKm) };
  if (!isOrdinaryFirstSegment(shape, false)) return false;
  return isOrdinaryFirstSegment(shape, (await tx.odometerReading.count({ where: { segmentId: segment.id, context: 'INITIALISATION' } })) > 0);
}

export function cumulativeFor(segment: OdometerSegment, physicalKm: Decimal): Decimal {
  return cumulativeKm({ startPhysicalKm: dec(segment.startPhysicalKm), startCumulativeKm: dec(segment.startCumulativeKm) }, physicalKm);
}

export function dec(value: { toString(): string } | string | number): Decimal {
  return new Decimal(typeof value === 'object' ? value.toString() : value);
}

function neighbor(r: { id: string; physicalKm: { toString(): string } | string | null; observedAt: Date } | null): NeighborReading | null {
  return r && r.physicalKm ? { id: r.id, physicalKm: dec(r.physicalKm), observedAt: r.observedAt } : null;
}

/**
 * Borne de fin d'un compteur remplacé (CDC 5.4, 5.3) : la base cumulée du compteur suivant est la dernière
 * distance cumulée validée à la date du remplacement ; ramenée à l'échelle physique du compteur clos, elle sert
 * de voisin « suivant » à tout relevé rétroactif ou corrigé postérieur à son dernier relevé. Sans elle, un relevé
 * accepté après coup dépasserait la base et rendrait décroissant le cumul du véhicule. Aucune borne si la base
 * du compteur suivant n'a pas été dérivée de ce compteur (cumul inconnu faute de relevé validé).
 */
function closedSegmentBound(segment: OdometerSegment, following: OdometerSegment | null): NeighborReading | null {
  if (!segment.endedAt || !following || (segment.cumulativeKnown && !following.cumulativeKnown)) return null;
  const physicalKm = dec(segment.startPhysicalKm).plus(dec(following.startCumulativeKm).minus(dec(segment.startCumulativeKm)));
  return { id: `segment:${following.id}`, physicalKm, observedAt: segment.endedAt };
}

/** Verrou de ligne sur le véhicule : ordre constant véhicule → conducteur → utilisation → relevé (13.3). */
export async function lockVehicle(tx: Tx, vehicleId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Vehicle" WHERE id = ${vehicleId}::uuid FOR UPDATE`;
}

/**
 * Même verrou que lockVehicle, avec la société courante lue sur la ligne verrouillée (une instruction au lieu
 * du verrou puis d'une relecture) ; null si le véhicule n'existe pas dans cette organisation.
 */
export async function lockVehicleOf(tx: Tx, vehicleId: string, organizationId: string): Promise<{ id: string; companyId: string } | null> {
  const [row] = await tx.$queryRaw<Array<{ id: string; companyId: string; organizationId: string }>>`SELECT "id", "companyId", "organizationId" FROM "Vehicle" WHERE "id" = ${vehicleId}::uuid FOR UPDATE`;
  return row && row.organizationId === organizationId ? { id: row.id, companyId: row.companyId } : null;
}

export async function lockDriver(tx: Tx, driverId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Driver" WHERE id = ${driverId}::uuid FOR UPDATE`;
}

/**
 * Verrou du véhicule pris par une transaction READ COMMITTED (remise, restitution, D-016) : même verrou que
 * lockVehicle (FOR UPDATE, même ordre), et nouvelle version de la ligne sans changement de valeur. Une
 * transaction sérialisable qui attendait ce verrou (archivage, réservation, immobilisation, transfert…) lit un
 * instantané antérieur à la remise : la nouvelle version la fait échouer en conflit de sérialisation (reprise
 * avec un instantané à jour) au lieu de décider sur un état périmé. Une instruction.
 */
export async function lockVehicleForWrite(tx: Tx, vehicleId: string): Promise<void> {
  await tx.$executeRaw`WITH "locked" AS (SELECT "id" FROM "Vehicle" WHERE "id" = ${vehicleId}::uuid FOR UPDATE)
    UPDATE "Vehicle" AS v SET "updatedAt" = v."updatedAt" FROM "locked" WHERE v."id" = "locked"."id"`;
}

/** Même principe que lockVehicleForWrite pour le conducteur (verrou pris après celui du véhicule). */
export async function lockDriverForWrite(tx: Tx, driverId: string): Promise<void> {
  await tx.$executeRaw`WITH "locked" AS (SELECT "id" FROM "Driver" WHERE "id" = ${driverId}::uuid FOR UPDATE)
    UPDATE "Driver" AS d SET "updatedAt" = d."updatedAt" FROM "locked" WHERE d."id" = "locked"."id"`;
}

/**
 * Société gestionnaire du véhicule à une date (événements datés : société historique, 2.4 ; D-121),
 * d'après VehicleCompanyHistory sur l'intervalle [effectiveAt, suivant[. Avant la première entrée
 * (événement antérieur à la création du dossier ou au premier transfert enregistré), c'est la société
 * d'origine de cette entrée — jamais la société courante, qui peut être la destinataire d'un transfert.
 * `fallback` ne sert que pour un véhicule sans aucun historique (aucun transfert).
 */
export async function companyAt(tx: Tx, vehicleId: string, at: Date, fallback: string): Promise<string> {
  const entry = await tx.vehicleCompanyHistory.findFirst({ where: { vehicleId, effectiveAt: { lte: at } }, orderBy: [{ effectiveAt: 'desc' }, { id: 'desc' }], select: { toCompanyId: true } });
  if (entry) return entry.toCompanyId;
  const first = await tx.vehicleCompanyHistory.findFirst({ where: { vehicleId }, orderBy: [{ effectiveAt: 'asc' }, { id: 'asc' }], select: { fromCompanyId: true, toCompanyId: true } });
  return first ? (first.fromCompanyId ?? first.toCompanyId) : fallback;
}

/**
 * Met à jour la dernière valeur physique acceptée du segment (lecture rapide) et, pour un segment 1
 * d'initialisation ordinaire, aligne son début sur le premier relevé accepté (D-167 : physique = cumulé ;
 * relevé antérieur, correction du premier relevé, soumission provisoire rejetée). Appelée après tout
 * changement de l'ensemble des relevés acceptés, dans la transaction qui l'opère.
 */
export async function refreshSegmentLast(tx: Tx, segmentId: string, known?: { segment: OdometerSegment; ordinary: boolean }): Promise<void> {
  const accepted = { segmentId, status: 'ACCEPTE' as const, isEstimate: false };
  const last = await tx.odometerReading.findFirst({ where: accepted, orderBy: [{ observedAt: 'desc' }, { enteredAt: 'desc' }] });
  // `known` : segment lu dans la même transaction et inchangé depuis, avec son caractère ordinaire courant (ingest).
  const segment = known && known.segment.id === segmentId ? known.segment : await tx.odometerSegment.findUniqueOrThrow({ where: { id: segmentId } });
  let start: ReturnType<typeof ordinaryFirstSegmentStart> = null;
  if (known && known.segment.id === segmentId ? known.ordinary : await isOrdinarySegment(tx, segment)) {
    const first = await tx.odometerReading.findFirst({ where: { ...accepted, physicalKm: { not: null } }, orderBy: [{ observedAt: 'asc' }, { enteredAt: 'asc' }] });
    start = ordinaryFirstSegmentStart({ startedAt: segment.startedAt, startPhysicalKm: dec(segment.startPhysicalKm) }, first?.physicalKm ? { observedAt: first.observedAt, physicalKm: dec(first.physicalKm) } : null);
  }
  await tx.odometerSegment.update({
    where: { id: segmentId },
    data: {
      lastPhysicalKm: last?.physicalKm ?? null,
      ...(start ? { startedAt: start.startedAt, startPhysicalKm: start.startPhysicalKm.toString(), startCumulativeKm: start.startPhysicalKm.toString(), version: { increment: 1 } } : {}),
    },
  });
}
