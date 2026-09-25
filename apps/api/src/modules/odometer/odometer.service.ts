import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { OdometerReading, OdometerSegment, Prisma } from '@parc-auto/db';
import { AfterCommit } from '../../common/after-commit.js';
import { Clock } from '../../common/clock.js';
import { AppError, BusinessRuleError, ConflictError, type FieldErrors, ForbiddenActionError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import { type Page, pageOf, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import { formatLocalDateTime } from '../../domain/civil-date.js';
import { computeFreshness } from '../../domain/freshness.js';
import { formatKm, readingFieldForAnomaly } from '../../domain/odometer-rules.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, type Tx } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { AlertsService } from '../alerts/alerts.service.js';
import { DriverSubmissionService } from '../assignments/driver-submission.service.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { VehiclesService } from '../vehicles/vehicles.service.js';
import type { BatchReadingsDto, BatchResultItemDto, CorrectReadingDto, CreateReadingDto, CurrentOdometerDto, DecideReadingDto, IngestResultDto, InitSegmentDto, ReadingViewDto, ReadingsQueryDto, SegmentViewDto } from './dto/odometer.dto.js';
import { OdometerEventsService } from './odometer-events.service.js';
import { type IngestResult, OdometerIngestionService, cumulativeFor, dec, isOrdinarySegment, lockVehicle, refreshSegmentLast } from './odometer-ingestion.service.js';
import { recomputeUsagesForReading } from './usage-distance.js';

type ReadingRow = OdometerReading & { vehicle: { code: string }; segment: { sequence: number }; replacedBy: { id: string } | null };

const readingInclude = { vehicle: { select: { code: true } }, segment: { select: { sequence: true } }, replacedBy: { select: { id: true } } } as const;

/** Relevés kilométriques et segments de compteur (CDC 5.1 à 5.5, 15.2, 15.3). */
@Injectable()
export class OdometerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly vehicles: VehiclesService,
    private readonly ingestion: OdometerIngestionService,
    private readonly attachments: AttachmentsService,
    private readonly settings: SettingsService,
    private readonly alerts: AlertsService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly submissions: DriverSubmissionService,
    private readonly events: OdometerEventsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Saisie
  // ---------------------------------------------------------------------------

  /**
   * Relevé libre : accepté directement pour le personnel si cohérent ; soumission en attente pour un
   * conducteur, sur le véhicule de son utilisation EN_COURS ou, si drivers.allowHabitualVehicleSubmissions
   * est actif, sur celui dont il est responsable habituel en cours (D-268).
   */
  async create(ctx: RequestContext, vehicleId: string, dto: CreateReadingDto, idempotencyKey: string | undefined): Promise<IngestResultDto> {
    const vehicle = await this.vehicles.loadRef(ctx, vehicleId);
    const isDriver = ctx.isDriverOnly;
    if (!isDriver) this.access.requireOperational(ctx, vehicle.companyId);
    // Paramètres de la saisie (plausibilité) et des données dépendantes (fraîcheur) : une lecture pour la requête.
    await this.settings.prefetch(ctx.organizationId, READING_SETTINGS, vehicle.companyId);
    const work = async () => {
      const { result, after } = await this.prisma.serializable(async (tx) => {
        const after = new AfterCommit();
        if (isDriver) await this.assertDriverMaySubmit(ctx, vehicleId, tx);
        const result = await this.ingestion.ingest(
          tx,
          {
            organizationId: ctx.organizationId,
            vehicleId,
            origin: 'MANUAL',
            context: isDriver ? 'RELEVE_LIBRE' : (dto.context ?? 'RELEVE_LIBRE'),
            measurementKind: 'COMPTEUR_AFFICHE',
            physicalKm: parseKm(dto.physicalKm),
            observedAt: new Date(dto.observedAt),
            author: isDriver ? { kind: 'DRIVER', userId: ctx.userId } : { kind: 'STAFF', userId: ctx.userId },
            attachmentId: null,
            note: dto.note ?? null,
            segmentId: dto.odometerSegmentId ?? null,
            allowAutoInit: true,
          },
          after,
        );
        // Société à la date d'observation (D-121) : un relevé antérieur à un transfert appartient à la société
        // d'origine ; seul un utilisateur habilité sur elle (ou l'administrateur) peut l'y enregistrer.
        if (!isDriver && !this.access.canReadCompany(ctx, result.reading.companyId)) {
          throw new BusinessRuleError('PERIODE_HORS_PERIMETRE', 'À cette date, le véhicule relevait d’une autre société : seul un utilisateur habilité sur cette société peut y enregistrer un relevé.', { fieldErrors: { observedAt: ['Date antérieure au transfert du véhicule dans votre société.'] } });
        }
        if (dto.attachmentId) {
          await this.attachments.attach(ctx, tx, dto.attachmentId, 'RELEVE', result.reading.id, result.reading.companyId);
          await tx.odometerReading.update({ where: { id: result.reading.id }, data: { attachmentId: dto.attachmentId } });
        }
        if (result.outcome !== 'IDEMPOTENT') {
          await this.audit.record(ctx, { action: 'releve.saisie', objectType: 'OdometerReading', objectId: result.reading.id, companyId: result.reading.companyId, after: { vehicleId, physicalKm: dto.physicalKm, observedAt: dto.observedAt, status: result.outcome, anomaly: result.anomaly } }, tx);
        }
        return { result, after };
      });
      await after.run();
      return { status: 201, body: await this.ingestView(result, vehicle.code, dto.attachmentId ?? null), resourceId: result.reading.id };
    };
    if (idempotencyKey) {
      const replay = await this.idempotency.run({ organizationId: ctx.organizationId, userId: ctx.userId, operation: `releve:${vehicleId}`, key: idempotencyKey }, { vehicleId, ...dto }, work);
      return replay.body;
    }
    return (await work()).body;
  }

  /**
   * Saisie rapide par parc (10.2, D-265) : chaque ligne est traitée indépendamment, comme un relevé
   * unitaire (photo comprise), sous la clé d'idempotence dérivée « <cléLot>:<vehicleId> » : un lot renvoyé
   * après une coupure rejoue les lignes déjà enregistrées sans doublon et traite les autres.
   */
  async batch(ctx: RequestContext, dto: BatchReadingsDto, batchKey: string): Promise<BatchResultItemDto[]> {
    this.access.requireStaff(ctx);
    const seen = new Set<string>();
    const duplicates: FieldErrors = {};
    dto.items.forEach((item, index) => {
      if (seen.has(item.vehicleId)) duplicates[`items.${index}.vehicleId`] = ['Ce véhicule figure déjà dans la saisie (une ligne par véhicule).'];
      seen.add(item.vehicleId);
    });
    if (Object.keys(duplicates).length > 0) {
      throw new BusinessRuleError('VEHICULE_EN_DOUBLE', 'Un véhicule ne peut figurer qu’une fois par saisie rapide.', { fieldErrors: duplicates });
    }
    const results: BatchResultItemDto[] = [];
    for (const item of dto.items) {
      try {
        const line: CreateReadingDto = { physicalKm: item.physicalKm, observedAt: item.observedAt, context: 'RELEVE_LIBRE', note: item.note, attachmentId: item.attachmentId };
        const r = await this.create(ctx, item.vehicleId, line, `${batchKey}:${item.vehicleId}`);
        results.push({ vehicleId: item.vehicleId, outcome: r.outcome, readingId: r.reading.id, code: r.anomaly?.code ?? null, message: r.anomaly?.reason ?? null });
      } catch (error) {
        if (error instanceof AppError) {
          results.push({ vehicleId: item.vehicleId, outcome: 'REFUSE', readingId: null, code: error.code, message: error.message });
        } else throw error;
      }
    }
    return results;
  }

  /**
   * Droit de soumission du conducteur (D-116, D-268), vérifié dans la transaction de saisie avec la règle
   * unique de DriverSubmissionService. Le véhicule est lisible (fiche ouverte) : refus 403 (D-118).
   */
  private async assertDriverMaySubmit(ctx: RequestContext, vehicleId: string, tx: Tx): Promise<void> {
    const targets = await this.submissions.targets(ctx, tx);
    if (!targets.some((t) => t.vehicleId === vehicleId)) {
      throw new ForbiddenActionError('Vous ne pouvez déclarer un kilométrage que pour le véhicule de votre utilisation en cours, ou pour celui dont vous êtes responsable habituel si l’organisation l’autorise.');
    }
  }

  // ---------------------------------------------------------------------------
  // Consultation
  // ---------------------------------------------------------------------------

  /**
   * Filtre unique des relevés visibles (CDC 2.2, 2.3), commun à GET /readings, GET /vehicles/:id/readings
   * et au compteur des relevés en attente : un conducteur ne voit que ses propres soumissions ; le
   * personnel voit les relevés des sociétés de son périmètre (société à la date d'observation) et,
   * avec mine=true, uniquement ceux dont il est l'auteur (« Mes soumissions »).
   */
  private readingsWhere(ctx: RequestContext, filters: Pick<ReadingsQueryDto, 'companyId' | 'vehicleId' | 'status' | 'source' | 'mine' | 'observedFrom' | 'observedTo'>): Prisma.OdometerReadingWhereInput {
    const scope: Prisma.OdometerReadingWhereInput = ctx.isDriverOnly ? { organizationId: ctx.organizationId, createdById: ctx.userId } : { ...this.access.companyWhere(ctx, filters.companyId) };
    return {
      ...scope,
      ...(filters.mine === 'true' ? { createdById: ctx.userId } : {}),
      ...(filters.vehicleId ? { vehicleId: filters.vehicleId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.source ? { source: filters.source } : {}),
      ...(filters.observedFrom || filters.observedTo ? { observedAt: { ...(filters.observedFrom ? { gte: new Date(filters.observedFrom) } : {}), ...(filters.observedTo ? { lte: new Date(filters.observedTo) } : {}) } } : {}),
    };
  }

  async list(ctx: RequestContext, query: ReadingsQueryDto): Promise<Page<ReadingViewDto>> {
    const scoped = this.readingsWhere(ctx, query);
    // Soumissions d'un conducteur (3.3) : clause ajoutée au périmètre, jamais substituée.
    const where: Prisma.OdometerReadingWhereInput = query.driverId ? { AND: [scoped, { createdById: await this.driverAccount(ctx, query.driverId) }] } : scoped;
    const [items, total] = await Promise.all([
      this.prisma.client.odometerReading.findMany({ where, ...skipTake(query), orderBy: [{ observedAt: query.order }, { enteredAt: query.order }], include: readingInclude }),
      this.prisma.client.odometerReading.count({ where }),
    ]);
    return pageOf(await this.views(items), total, query);
  }

  /**
   * Compte utilisateur lié à la fiche d'un conducteur visible (fiche conducteur, CDC 3.3) : conducteur d'une
   * société hors périmètre (ou, pour un compte conducteur, une autre fiche que la sienne) → 404 ; fiche sans
   * compte → identifiant nul, qui ne correspond à aucun auteur (aucune soumission possible sans compte).
   */
  private async driverAccount(ctx: RequestContext, driverId: string): Promise<string> {
    const driver = await this.prisma.client.driver.findFirst({ where: { id: driverId, organizationId: ctx.organizationId }, select: { companyId: true, userId: true } });
    const visible = driver !== null && (ctx.isDriverOnly ? ctx.driverId === driverId : this.access.canReadCompany(ctx, driver.companyId));
    if (!visible) throw new NotFoundOrOutOfScopeError('Conducteur');
    return driver.userId ?? '00000000-0000-0000-0000-000000000000';
  }

  /** Historique d'un véhicule visible : même filtre et même tri (order) que GET /readings. */
  async listForVehicle(ctx: RequestContext, vehicleId: string, query: ReadingsQueryDto): Promise<Page<ReadingViewDto>> {
    await this.vehicles.load(ctx, vehicleId);
    return this.list(ctx, { ...query, vehicleId });
  }

  /** Compteur courant (5.3, 5.5) : dernier relevé accepté selon la date d'observation, avec fraîcheur. */
  async current(ctx: RequestContext, vehicleId: string): Promise<CurrentOdometerDto> {
    const v = await this.vehicles.load(ctx, vehicleId);
    const [last, openSegment, pendingCount, mapping] = await Promise.all([
      this.prisma.client.odometerReading.findFirst({ where: { vehicleId, status: 'ACCEPTE' }, orderBy: [{ observedAt: 'desc' }, { enteredAt: 'desc' }], include: readingInclude }),
      this.prisma.client.odometerSegment.findFirst({ where: { vehicleId, endedAt: null } }),
      this.prisma.client.odometerReading.count({ where: this.readingsWhere(ctx, { vehicleId, status: 'EN_ATTENTE' }) }),
      this.prisma.client.telemetryVehicleMapping.findFirst({ where: { vehicleId, status: 'CONFIRME', validTo: null }, include: { unit: { include: { state: true } } } }),
    ]);
    const staleAfterDays = await this.settings.get(ctx.organizationId, 'odometer.staleAfterDays', v.companyId);
    const freshness = computeFreshness(last?.observedAt ?? null, this.clock.now(), staleAfterDays);
    const state = mapping?.unit.state;
    return {
      reading: last ? (await this.views([last]))[0] ?? null : null,
      freshness: freshness.status,
      ageDays: freshness.ageDays,
      cumulativeKnown: openSegment?.cumulativeKnown ?? true,
      openSegmentId: openSegment?.id ?? null,
      pendingCount,
      lastTelematicsHint:
        state?.lastOdometerValueKm && state.lastOdometerObservedAt && state.lastOdometerKind
          ? { valueKm: state.lastOdometerValueKm.toFixed(3), kind: state.lastOdometerKind, observedAt: state.lastOdometerObservedAt.toISOString() }
          : null,
    };
  }

  async segments(ctx: RequestContext, vehicleId: string): Promise<SegmentViewDto[]> {
    await this.vehicles.load(ctx, vehicleId);
    const items = await this.prisma.client.odometerSegment.findMany({ where: { vehicleId }, orderBy: { sequence: 'asc' } });
    return items.map(segmentView);
  }

  // ---------------------------------------------------------------------------
  // Validation, rejet, correction
  // ---------------------------------------------------------------------------

  async approve(ctx: RequestContext, readingId: string, dto: DecideReadingDto): Promise<ReadingViewDto> {
    const reading = await this.loadReading(ctx, readingId);
    this.access.requirePermission(ctx, reading.companyId, 'readings.approve', 'La validation des relevés requiert la permission readings.approve.');
    const { after } = await this.prisma.serializable(async (tx) => {
      const after = new AfterCommit();
      const fresh = await lockReading(tx, reading, dto.expectedVersion);
      if (fresh.status !== 'EN_ATTENTE') throw new ConflictError('ETAT_INVALIDE', 'Seul un relevé en attente peut être validé.');
      const segment = await tx.odometerSegment.findUniqueOrThrow({ where: { id: fresh.segmentId } });
      const evaluation = await this.ingestion.evaluateForApproval(tx, fresh, segment);
      if (evaluation.outcome === 'REJECT' || (evaluation.outcome === 'PENDING' && evaluation.code !== 'HAUSSE_IMPLAUSIBLE')) {
        throw new BusinessRuleError('VALIDATION_IMPOSSIBLE', `Validation impossible : ${evaluation.reason} Rejetez ce relevé ou corrigez les relevés voisins.`, { details: { anomaly: evaluation.code } });
      }
      if (evaluation.outcome === 'CONFLICT' || evaluation.outcome === 'IDEMPOTENT') {
        throw new ConflictError('CONFLIT_MEME_INSTANT', 'Un relevé accepté existe déjà au même instant sur ce compteur : rejetez ce doublon.');
      }
      await tx.odometerReading.update({
        where: { id: readingId, version: dto.expectedVersion },
        data: { status: 'ACCEPTE', decidedAt: this.clock.now(), decidedById: ctx.userId, decisionReason: dto.reason ?? null, version: { increment: 1 } },
      });
      await refreshSegmentLast(tx, segment.id);
      await this.resolveValidatedDistances(tx, await recomputeUsagesForReading(tx, readingId), 'relevé de retour validé');
      await this.audit.record(ctx, { action: 'releve.validation', objectType: 'OdometerReading', objectId: readingId, companyId: fresh.companyId, reason: dto.reason ?? null, before: { status: 'EN_ATTENTE', anomaly: fresh.anomalyCode }, after: { status: 'ACCEPTE' } }, tx);
      this.ingestion.scheduleAccepted(after, { organizationId: fresh.organizationId, companyId: fresh.companyId, vehicleId: fresh.vehicleId, readingId, origin: fresh.source, measurementKind: fresh.measurementKind });
      return { after };
    });
    await after.run();
    return this.view(readingId);
  }

  async reject(ctx: RequestContext, readingId: string, dto: DecideReadingDto): Promise<ReadingViewDto> {
    const reading = await this.loadReading(ctx, readingId);
    this.access.requirePermission(ctx, reading.companyId, 'readings.approve', 'Le rejet des relevés requiert la permission readings.approve.');
    if (!dto.reason || dto.reason.trim().length < 3) throw new BusinessRuleError('MOTIF_REQUIS', 'Un motif de rejet est requis.', { fieldErrors: { reason: ['Motif requis.'] } });
    await this.prisma.serializable(async (tx) => {
      const fresh = await lockReading(tx, reading, dto.expectedVersion);
      if (fresh.status !== 'EN_ATTENTE') throw new ConflictError('ETAT_INVALIDE', 'Seul un relevé en attente peut être rejeté.');
      await tx.odometerReading.update({
        where: { id: readingId, version: dto.expectedVersion },
        data: { status: 'REJETE', decidedAt: this.clock.now(), decidedById: ctx.userId, decisionReason: dto.reason ?? null, version: { increment: 1 } },
      });
      await recomputeUsagesForReading(tx, readingId);
      await this.audit.record(ctx, { action: 'releve.rejet', objectType: 'OdometerReading', objectId: readingId, companyId: fresh.companyId, reason: dto.reason ?? null, before: { status: 'EN_ATTENTE', anomaly: fresh.anomalyCode }, after: { status: 'REJETE' } }, tx);
    });
    await this.alerts.resolve({ organizationId: ctx.organizationId, type: 'RELEVE_A_VALIDER', objectType: 'OdometerReading', objectId: readingId }, 'relevé rejeté');
    return this.view(readingId);
  }

  /**
   * Correction motivée (5.3, T13) : l'original accepté est conservé (REMPLACE), un remplacement est créé,
   * les liens métier (remise, restitution, plein, intervention) pointent vers le remplacement et les
   * données dépendantes sont recalculées. Une correction qui rompt la chronologie est bloquée.
   */
  async correct(ctx: RequestContext, readingId: string, dto: CorrectReadingDto, idempotencyKey: string): Promise<ReadingViewDto> {
    const original = await this.loadReading(ctx, readingId);
    this.access.requirePermission(ctx, original.companyId, 'readings.correct', 'La correction d’un relevé accepté requiert la permission readings.correct.');
    const replay = await this.idempotency.run({ organizationId: ctx.organizationId, userId: ctx.userId, operation: `releve.correction:${readingId}`, key: idempotencyKey }, dto, async () => {
      const { newId, after } = await this.prisma.serializable(async (tx) => {
        const after = new AfterCommit();
        const fresh = await lockReading(tx, original, dto.expectedVersion);
        if (fresh.status !== 'ACCEPTE' || fresh.isEstimate) throw new ConflictError('ETAT_INVALIDE', 'Seul un relevé accepté (non estimé) peut être corrigé.');
        const segment = await tx.odometerSegment.findUniqueOrThrow({ where: { id: fresh.segmentId } });
        // Erreurs de valeur sous les mêmes clés que la validation du DTO (replacementReading.*).
        const physicalKm = parseKm(dto.replacementReading.physicalKm, 'replacementReading.physicalKm');
        const observedAt = dto.replacementReading.observedAt ? new Date(dto.replacementReading.observedAt) : fresh.observedAt;
        // Segment 1 ordinaire (D-167) : son début n'est que le premier relevé accepté, il suit la correction.
        const beforeStart = observedAt < segment.startedAt && !(await isOrdinarySegment(tx, segment));
        if (beforeStart || (segment.endedAt && observedAt >= segment.endedAt)) {
          const reason = 'La date corrigée sort de la période du compteur concerné.';
          throw new BusinessRuleError('HORS_SEGMENT', reason, { fieldErrors: { 'replacementReading.observedAt': [reason] } });
        }
        // 5.3 : la date d'un relevé rattaché à une remise, une restitution, un plein ou une intervention est celle
        // de cet événement ; la déplacer rendrait l'événement incohérent : correction bloquée (valeur seule ici).
        if (observedAt.getTime() !== fresh.observedAt.getTime()) {
          const linked = await this.dependents(tx, fresh.id);
          if (linked.length > 0) {
            const reason = `La date de ce relevé est celle ${linked.map((d) => DEPENDENT_LABELS[d.type] ?? d.type).join(', ')} qui l’utilise : seule sa valeur peut être corrigée ici. Pour changer la date, régularisez d’abord l’événement concerné.`;
            throw new BusinessRuleError('CORRECTION_BLOQUEE', `Correction bloquée : ${reason}`, { fieldErrors: { 'replacementReading.observedAt': [reason] }, details: { anomaly: 'DATE_LIEE_A_UN_EVENEMENT', dependents: linked } });
          }
        }
        // 5.4 : la valeur du dernier relevé validé d'un compteur remplacé a fixé la base cumulée du compteur suivant ;
        // la corriger rendrait faux le cumul de tous les relevés postérieurs (et des entretiens qui s'y rapportent).
        const base = await this.followingSegmentBase(tx, segment, fresh);
        if (base && fresh.physicalKm && !physicalKm.eq(dec(fresh.physicalKm))) {
          const { timezone } = await tx.organization.findUniqueOrThrow({ where: { id: fresh.organizationId }, select: { timezone: true } });
          const reason = `La valeur de ce relevé a fixé la base cumulée (${formatKm(dec(base.startCumulativeKm))}) du compteur installé le ${formatLocalDateTime(base.startedAt, timezone, { sentence: true })} : la corriger fausserait le kilométrage cumulé de tous les relevés suivants.`;
          throw new BusinessRuleError('CORRECTION_BLOQUEE', `Correction bloquée : ${reason}`, { fieldErrors: { 'replacementReading.physicalKm': [reason] }, details: { anomaly: 'BASE_COMPTEUR_SUIVANT', segmentId: base.id, segmentSequence: base.sequence } });
        }
        const evaluation = await this.ingestion.evaluate(tx, { organizationId: fresh.organizationId, vehicleId: fresh.vehicleId, origin: 'MANUAL', physicalKm, observedAt }, segment, fresh.id);
        if (evaluation.outcome === 'REJECT' || evaluation.outcome === 'CONFLICT' || (evaluation.outcome === 'PENDING' && evaluation.code !== 'HAUSSE_IMPLAUSIBLE')) {
          const neighbors = await this.dependents(tx, fresh.id);
          const reason = `Correction bloquée : ${evaluation.reason} Régularisez d’abord les relevés voisins.`;
          throw new BusinessRuleError('CORRECTION_BLOQUEE', reason, { fieldErrors: { [`replacementReading.${readingFieldForAnomaly(evaluation.code)}`]: [evaluation.reason] }, details: { anomaly: evaluation.code, dependents: neighbors } });
        }
        if (evaluation.outcome === 'IDEMPOTENT') {
          // Même valeur qu'un autre relevé accepté au même instant (D-149) : le remplacement serait un doublon.
          const reason = 'Un autre relevé accepté de même valeur existe déjà au même instant : la correction créerait un doublon. Rejetez ou corrigez plutôt ce relevé.';
          throw new BusinessRuleError('CORRECTION_BLOQUEE', `Correction bloquée : ${reason}`, { fieldErrors: { [`replacementReading.${readingFieldForAnomaly('CONFLIT_MEME_INSTANT')}`]: [reason] }, details: { anomaly: 'CONFLIT_MEME_INSTANT', existingReadingId: evaluation.existingId } });
        }
        await tx.odometerReading.update({ where: { id: fresh.id, version: dto.expectedVersion }, data: { status: 'REMPLACE', decisionReason: dto.reason, version: { increment: 1 } } });
        const replacement = await tx.odometerReading.create({
          data: {
            organizationId: fresh.organizationId,
            companyId: fresh.companyId,
            vehicleId: fresh.vehicleId,
            segmentId: segment.id,
            source: 'MANUAL',
            context: fresh.context,
            measurementKind: fresh.measurementKind === 'COMPTEUR_CAN' ? 'COMPTEUR_AFFICHE' : fresh.measurementKind,
            status: 'ACCEPTE',
            physicalKm: physicalKm.toString(),
            cumulativeKm: cumulativeFor(segment, physicalKm).toString(),
            observedAt,
            enteredAt: this.clock.now(),
            replacesReadingId: fresh.id,
            correctionReason: dto.reason,
            attachmentId: fresh.attachmentId,
            note: fresh.note,
            decidedAt: this.clock.now(),
            decidedById: ctx.userId,
            createdById: ctx.userId,
          },
        });
        // Les objets métier suivent le remplacement (aucun écrasement de l'original).
        await tx.vehicleUsage.updateMany({ where: { checkoutReadingId: fresh.id }, data: { checkoutReadingId: replacement.id } });
        await tx.vehicleUsage.updateMany({ where: { returnReadingId: fresh.id }, data: { returnReadingId: replacement.id } });
        await tx.fuelEntry.updateMany({ where: { readingId: fresh.id }, data: { readingId: replacement.id, declaredPhysicalKm: physicalKm.toString() } });
        await tx.intervention.updateMany({ where: { performedReadingId: fresh.id }, data: { performedReadingId: replacement.id, performedKm: replacement.cumulativeKm } });
        const usages = await recomputeUsagesForReading(tx, replacement.id);
        await this.resolveValidatedDistances(tx, usages, 'relevé corrigé');
        await refreshSegmentLast(tx, segment.id);
        // 13.3 : échéances d'entretien, fraîcheur et leurs alertes recalculées dans la transaction de correction.
        const event = { organizationId: fresh.organizationId, companyId: fresh.companyId, vehicleId: fresh.vehicleId, readingId: replacement.id, origin: 'MANUAL' as const, measurementKind: 'COMPTEUR_AFFICHE' as const, isEstimate: false };
        const recomputed = await this.events.recomputeDependentsInTx(tx, event, after);
        await this.audit.record(ctx, {
          action: 'releve.correction',
          objectType: 'OdometerReading',
          objectId: fresh.id,
          companyId: fresh.companyId,
          reason: dto.reason,
          before: { readingId: fresh.id, physicalKm: fresh.physicalKm?.toString(), observedAt: fresh.observedAt },
          after: { readingId: replacement.id, physicalKm: physicalKm.toString(), observedAt, usages: usages.map((u) => ({ id: u.id, distanceStatus: u.distanceStatus, distanceKm: u.distanceKm })), recomputed },
        }, tx);
        this.ingestion.scheduleAccepted(after, { organizationId: fresh.organizationId, companyId: fresh.companyId, vehicleId: fresh.vehicleId, readingId: replacement.id, origin: 'MANUAL', measurementKind: 'COMPTEUR_AFFICHE' });
        return { newId: replacement.id, after };
      });
      await after.run();
      return { status: 200, body: await this.view(newId), resourceId: newId };
    });
    return replay.body;
  }

  // ---------------------------------------------------------------------------
  // Segments de compteur
  // ---------------------------------------------------------------------------

  /**
   * Initialisation du compteur ou remplacement autorisé (5.4, T14). Le remplacement clôt l'ancien segment
   * et ouvre un segment dont la base cumulée est le dernier cumul validé ; aucun remplacement implicite.
   */
  /**
   * Initialisation d'un compteur dans une transaction existante (formulaire ou import, 5.4, D-279) :
   * premier segment (cumul = compteur à l'initialisation ordinaire, ou base cumulée validée), relevé
   * d'initialisation accepté via le service unique d'ingestion. Refusée si un relevé est déjà accepté.
   */
  async initialSegmentInTx(
    tx: Tx,
    ctx: RequestContext,
    vehicle: { id: string; companyId: string },
    input: { physicalKm: Decimal; startedAt: Date; cumulativeKm: Decimal | null; cumulativeKnown: boolean; reason: string | null; origin: 'MANUAL' | 'IMPORT'; importBatchId?: string | null },
    after: AfterCommit,
  ): Promise<OdometerSegment> {
    await lockVehicle(tx, vehicle.id);
    const existing = await tx.odometerSegment.findMany({ where: { vehicleId: vehicle.id }, orderBy: { sequence: 'asc' } });
    const hasAccepted = await tx.odometerReading.count({ where: { vehicleId: vehicle.id, status: 'ACCEPTE' } });
    if (existing.length > 0 && hasAccepted > 0) throw new ConflictError('COMPTEUR_DEJA_INITIALISE', 'Le compteur est déjà initialisé ; utilisez un remplacement de compteur.');
    const known = input.cumulativeKnown;
    const declared = {
      startedAt: input.startedAt,
      startPhysicalKm: input.physicalKm.toString(),
      startCumulativeKm: (input.cumulativeKm ?? input.physicalKm).toString(),
      cumulativeKnown: known,
      replacementReason: input.reason ?? (known ? 'Initialisation ordinaire (cumul égal au compteur).' : 'Initialisation sans historique connu : cumul incomplet.'),
      createdById: ctx.userId,
    };
    // D-167 : le segment provisoire d'une soumission conducteur (aucun relevé accepté) devient le segment
    // initialisé ; ses soumissions y restent et leur cumul est recalculé sur la base déclarée (jamais un
    // segment clos à côté d'un nouveau, qui laisserait les soumissions sur un cumul faux).
    const provisional = existing.find((s) => s.endedAt === null) ?? null;
    const segment = provisional
      ? await tx.odometerSegment.update({ where: { id: provisional.id }, data: { ...declared, version: { increment: 1 } } })
      : await tx.odometerSegment.create({ data: { organizationId: ctx.organizationId, vehicleId: vehicle.id, sequence: (existing.at(-1)?.sequence ?? 0) + 1, ...declared } });
    if (provisional) {
      const submissions = await tx.odometerReading.findMany({ where: { segmentId: segment.id }, select: { id: true, physicalKm: true } });
      for (const r of submissions) {
        if (r.physicalKm) await tx.odometerReading.update({ where: { id: r.id }, data: { cumulativeKm: cumulativeFor(segment, dec(r.physicalKm)).toString(), version: { increment: 1 } } });
      }
    }
    const init = await this.ingestion.ingest(tx, { organizationId: ctx.organizationId, vehicleId: vehicle.id, origin: input.origin, context: 'INITIALISATION', measurementKind: 'COMPTEUR_AFFICHE', physicalKm: input.physicalKm, observedAt: input.startedAt, author: { kind: 'STAFF', userId: ctx.userId }, segmentId: segment.id, importBatchId: input.importBatchId ?? null }, after);
    if (init.outcome !== 'ACCEPTE') throw new BusinessRuleError('INITIALISATION_REFUSEE', init.anomaly?.reason ?? 'Relevé initial refusé.');
    await this.audit.record(ctx, { action: 'compteur.initialisation', objectType: 'OdometerSegment', objectId: segment.id, companyId: vehicle.companyId, reason: input.reason, ...(provisional ? { before: segmentView(provisional) } : {}), after: segmentView(segment) }, tx);
    return segment;
  }

  async initSegment(ctx: RequestContext, vehicleId: string, dto: InitSegmentDto): Promise<SegmentViewDto> {
    const vehicle = await this.vehicles.load(ctx, vehicleId);
    // D-167 : l'initialisation explicite (base cumulée différente, cumul incomplet) est réservée au chef et à
    // l'administrateur ; l'initialisation ordinaire se fait au premier relevé accepté du personnel.
    if (dto.mode === 'INITIAL') this.access.requireManager(ctx, vehicle.companyId);
    else this.access.requirePermission(ctx, vehicle.companyId, 'readings.correct', 'Le remplacement de compteur requiert la permission readings.correct.');
    const startedAt = new Date(dto.startedAt);
    if (startedAt.getTime() > this.clock.now().getTime() + 5 * 60 * 1000) throw new BusinessRuleError('DATE_FUTURE', 'La date d’effet ne peut pas être future.');
    const physical = parseKm(dto.physicalKm);
    const { segmentId, after } = await this.prisma.serializable(async (tx) => {
      const after = new AfterCommit();
      await lockVehicle(tx, vehicleId);
      const existing = await tx.odometerSegment.findMany({ where: { vehicleId }, orderBy: { sequence: 'asc' } });
      const author = { kind: 'STAFF' as const, userId: ctx.userId };
      if (dto.mode === 'INITIAL') {
        const segment = await this.initialSegmentInTx(tx, ctx, { id: vehicleId, companyId: vehicle.companyId }, { physicalKm: physical, startedAt, cumulativeKm: dto.cumulativeKm ? parseKm(dto.cumulativeKm) : null, cumulativeKnown: dto.cumulativeKnown ?? true, reason: dto.reason ?? null, origin: 'MANUAL' }, after);
        return { segmentId: segment.id, after };
      }

      const open = existing.find((s) => s.endedAt === null);
      if (!open) throw new BusinessRuleError('COMPTEUR_NON_INITIALISE', 'Aucun compteur ouvert à remplacer.');
      if (!dto.reason) throw new BusinessRuleError('MOTIF_REQUIS', 'Le motif du remplacement est obligatoire.', { fieldErrors: { reason: ['Motif requis.'] } });
      // 5.4 : le remplacement autorisé s'appuie sur un justificatif (photo, facture, attestation).
      if (!dto.justificationAttachmentId) throw new BusinessRuleError('JUSTIFICATIF_REQUIS', 'Joignez le justificatif du remplacement de compteur.', { fieldErrors: { justificationAttachmentId: ['Justificatif requis.'] } });
      if (startedAt <= open.startedAt) throw new BusinessRuleError('DATE_REMPLACEMENT', 'La date de remplacement doit suivre la mise en service du compteur actuel.');
      const later = await tx.odometerReading.count({ where: { segmentId: open.id, status: { in: ['ACCEPTE', 'EN_ATTENTE'] }, observedAt: { gt: startedAt } } });
      if (later > 0) throw new BusinessRuleError('RELEVES_POSTERIEURS', 'Des relevés postérieurs à la date de remplacement existent sur l’ancien compteur : régularisez-les d’abord.');
      if (dto.oldCounterFinalKm) {
        const closing = await this.ingestion.ingest(tx, { organizationId: ctx.organizationId, vehicleId, origin: 'MANUAL', context: 'RELEVE_LIBRE', measurementKind: 'COMPTEUR_AFFICHE', physicalKm: parseKm(dto.oldCounterFinalKm), observedAt: startedAt, author, segmentId: open.id, note: 'Relevé de clôture de l’ancien compteur' }, after);
        if (closing.outcome === 'EN_ATTENTE') throw new BusinessRuleError('RELEVE_CLOTURE_A_VALIDER', `Relevé de clôture non validé : ${closing.anomaly?.reason ?? ''}`);
      }
      const lastValidated = await tx.odometerReading.findFirst({ where: { segmentId: open.id, status: 'ACCEPTE', isEstimate: false, observedAt: { lte: startedAt } }, orderBy: [{ observedAt: 'desc' }, { enteredAt: 'desc' }] });
      const base = lastValidated?.cumulativeKm ? dec(lastValidated.cumulativeKm) : dto.cumulativeKm ? parseKm(dto.cumulativeKm) : null;
      await tx.odometerSegment.update({ where: { id: open.id }, data: { endedAt: startedAt, lastPhysicalKm: lastValidated?.physicalKm ?? open.lastPhysicalKm, version: { increment: 1 } } });
      const segment = await tx.odometerSegment.create({
        data: {
          organizationId: ctx.organizationId,
          vehicleId,
          sequence: open.sequence + 1,
          startedAt,
          startPhysicalKm: physical.toString(),
          startCumulativeKm: (base ?? physical).toString(),
          cumulativeKnown: open.cumulativeKnown && base !== null,
          replacementReason: dto.reason,
          justificationAttachmentId: dto.justificationAttachmentId ?? null,
          createdById: ctx.userId,
        },
      });
      if (dto.justificationAttachmentId) await this.attachments.attach(ctx, tx, dto.justificationAttachmentId, 'SEGMENT_COMPTEUR', segment.id, vehicle.companyId);
      const init = await this.ingestion.ingest(tx, { organizationId: ctx.organizationId, vehicleId, origin: 'MANUAL', context: 'INITIALISATION', measurementKind: 'COMPTEUR_AFFICHE', physicalKm: physical, observedAt: startedAt, author, segmentId: segment.id, note: 'Nouveau compteur' }, after);
      if (init.outcome !== 'ACCEPTE') throw new BusinessRuleError('INITIALISATION_REFUSEE', init.anomaly?.reason ?? 'Relevé initial refusé.');
      await this.audit.record(ctx, {
        action: 'compteur.remplacement',
        objectType: 'OdometerSegment',
        objectId: segment.id,
        companyId: vehicle.companyId,
        reason: dto.reason,
        before: { ...segmentView(open), endedAt: startedAt.toISOString(), lastValidatedCumulativeKm: base?.toString() ?? null },
        after: { ...segmentView(segment), newPhysicalKm: physical.toString(), justificationAttachmentId: dto.justificationAttachmentId },
      }, tx);
      return { segmentId: segment.id, after };
    });
    await after.run();
    const segment = await this.prisma.client.odometerSegment.findUniqueOrThrow({ where: { id: segmentId } });
    return segmentView(segment);
  }

  // ---------------------------------------------------------------------------

  async loadReading(ctx: RequestContext, id: string): Promise<OdometerReading> {
    const r = await this.prisma.client.odometerReading.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!r) throw new NotFoundOrOutOfScopeError('Relevé');
    if (ctx.isDriverOnly) {
      if (r.createdById !== ctx.userId) throw new NotFoundOrOutOfScopeError('Relevé');
    } else if (!this.access.canReadCompany(ctx, r.companyId)) {
      throw new NotFoundOrOutOfScopeError('Relevé');
    }
    return r;
  }

  async view(id: string): Promise<ReadingViewDto> {
    const r = await this.prisma.client.odometerReading.findUniqueOrThrow({ where: { id }, include: readingInclude });
    return (await this.views([r]))[0] as ReadingViewDto;
  }

  /**
   * Réponse d'une saisie. Relevé créé par cette requête : vue construite depuis la ligne insérée (code du
   * véhicule et rang du compteur connus, aucun remplacement possible, pièce jointe rattachée dans la même
   * transaction), sans relecture ; relevé existant rejoué (IDEMPOTENT) : relu.
   */
  private async ingestView(result: IngestResult, vehicleCode: string, attachmentId: string | null): Promise<IngestResultDto> {
    const created = result.outcome !== 'IDEMPOTENT' && result.segmentSequence !== undefined;
    const reading = created
      ? ((await this.views([{ ...result.reading, attachmentId: attachmentId ?? result.reading.attachmentId, vehicle: { code: vehicleCode }, segment: { sequence: result.segmentSequence as number }, replacedBy: null }]))[0] as ReadingViewDto)
      : await this.view(result.reading.id);
    return { reading, outcome: result.outcome, anomaly: result.anomaly };
  }

  /** Utilisations dont la distance est devenue validée : l'alerte DISTANCE_NON_VALIDEE est résolue dans la transaction. */
  private async resolveValidatedDistances(tx: Tx, usages: ReadonlyArray<{ id: string; organizationId: string; distanceStatus: string }>, reason: string): Promise<void> {
    for (const u of usages) {
      if (u.distanceStatus === 'VALIDEE') await this.alerts.resolve({ organizationId: u.organizationId, type: 'DISTANCE_NON_VALIDEE', objectType: 'VehicleUsage', objectId: u.id }, reason, tx);
    }
  }

  /**
   * Segment suivant dont la base cumulée provient de ce relevé (5.4) : compteur clos, relevé = dernier relevé
   * physique accepté du compteur à la date du remplacement, et cumul égal à la base du compteur suivant.
   */
  private async followingSegmentBase(tx: Tx, segment: OdometerSegment, reading: OdometerReading): Promise<OdometerSegment | null> {
    if (!segment.endedAt || !reading.cumulativeKm) return null;
    const following = await tx.odometerSegment.findFirst({ where: { vehicleId: segment.vehicleId, sequence: { gt: segment.sequence } }, orderBy: { sequence: 'asc' } });
    if (!following || !dec(following.startCumulativeKm).eq(dec(reading.cumulativeKm))) return null;
    const last = await tx.odometerReading.findFirst({ where: { segmentId: segment.id, status: 'ACCEPTE', isEstimate: false, observedAt: { lte: segment.endedAt } }, orderBy: [{ observedAt: 'desc' }, { enteredAt: 'desc' }], select: { id: true } });
    return last?.id === reading.id ? following : null;
  }

  private async dependents(tx: Tx, readingId: string): Promise<Array<{ type: string; id: string }>> {
    const [usages, fuel, interventions] = await Promise.all([
      tx.vehicleUsage.findMany({ where: { OR: [{ checkoutReadingId: readingId }, { returnReadingId: readingId }] }, select: { id: true } }),
      tx.fuelEntry.findMany({ where: { readingId }, select: { id: true } }),
      tx.intervention.findMany({ where: { performedReadingId: readingId }, select: { id: true } }),
    ]);
    return [...usages.map((u) => ({ type: 'utilisation', id: u.id })), ...fuel.map((f) => ({ type: 'plein', id: f.id })), ...interventions.map((i) => ({ type: 'intervention', id: i.id }))];
  }

  async views(items: ReadingRow[]): Promise<ReadingViewDto[]> {
    const authorIds = [...new Set(items.map((i) => i.createdById).filter((x): x is string => Boolean(x)))];
    const authors = authorIds.length ? await this.prisma.client.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, firstName: true, lastName: true } }) : [];
    return items.map((r) => {
      const a = authors.find((u) => u.id === r.createdById);
      return {
        id: r.id,
        vehicleId: r.vehicleId,
        vehicleCode: r.vehicle.code,
        companyId: r.companyId,
        segmentId: r.segmentId,
        segmentSequence: r.segment.sequence,
        source: r.source,
        context: r.context,
        measurementKind: r.measurementKind,
        status: r.status,
        physicalKm: r.physicalKm?.toFixed(3) ?? null,
        cumulativeKm: r.cumulativeKm?.toFixed(3) ?? null,
        isEstimate: r.isEstimate,
        gpsDistanceKm: r.gpsDistanceKm?.toFixed(3) ?? null,
        observedAt: r.observedAt.toISOString(),
        enteredAt: r.enteredAt.toISOString(),
        statusReason: r.statusReason,
        anomalyCode: r.anomalyCode,
        attachmentId: r.attachmentId,
        note: r.note,
        replacesReadingId: r.replacesReadingId,
        replacedByReadingId: r.replacedBy?.id ?? null,
        correctionReason: r.correctionReason,
        authorName: r.source === 'TELEMATICS' ? 'Connecteur télématique' : a ? `${a.firstName} ${a.lastName}` : null,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        decisionReason: r.decisionReason,
        channel: r.channel,
        version: r.version,
      };
    });
  }
}

/** Paramètres lus par une saisie de relevé et par ses recalculs dépendants (lecture groupée anticipée). */
export const READING_SETTINGS = ['odometer.plausibilityMaxKmPerDay', 'odometer.plausibilityMinKm', 'odometer.staleAfterDays'] as const;

/** Objets métier qui fixent la date d'un relevé (messages de blocage d'une correction, 5.3). */
const DEPENDENT_LABELS: Record<string, string> = { utilisation: 'de la remise ou de la restitution', plein: 'du plein', intervention: 'de l’intervention' };

/** Valeur kilométrique saisie ; `field` est la clé d'erreur du champ dans le DTO appelant. */
export function parseKm(value: string, field = 'physicalKm'): Decimal {
  let d: Decimal;
  try {
    d = new Decimal(value);
  } catch {
    throw new BusinessRuleError('VALEUR_INVALIDE', 'Valeur kilométrique invalide.', { fieldErrors: { [field]: ['Nombre attendu.'] } });
  }
  if (!d.isFinite() || d.isNegative()) throw new BusinessRuleError('VALEUR_NEGATIVE', 'La valeur du compteur doit être un nombre positif ou nul.', { fieldErrors: { [field]: ['Valeur positive attendue.'] } });
  if (d.decimalPlaces() > 3 || d.gt('9999999999')) throw new BusinessRuleError('VALEUR_INVALIDE', 'Valeur kilométrique hors format (3 décimales maximum).', { fieldErrors: { [field]: ['Format invalide.'] } });
  return d;
}

/**
 * Verrou du relevé (SELECT … FOR UPDATE) pris après celui du véhicule (ordre constant véhicule → conducteur →
 * utilisation → relevé, 13.3), puis relecture : la version attendue est contrôlée sur l'état verrouillé. En
 * isolation sérialisable, un relevé modifié par une transaction concurrente validée provoque une reprise
 * (PrismaService.serializable) qui relit la nouvelle version et répond 409 VERSION_OBSOLETE.
 */
async function lockReading(tx: Tx, reading: { id: string; vehicleId: string }, expectedVersion: number): Promise<OdometerReading> {
  await lockVehicle(tx, reading.vehicleId);
  await tx.$queryRaw`SELECT id FROM "OdometerReading" WHERE id = ${reading.id}::uuid FOR UPDATE`;
  const fresh = await tx.odometerReading.findUniqueOrThrow({ where: { id: reading.id } });
  assertExpectedVersion(fresh, expectedVersion, 'relevé');
  return fresh;
}

export function segmentView(s: OdometerSegment): SegmentViewDto {
  return {
    id: s.id,
    sequence: s.sequence,
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt?.toISOString() ?? null,
    startPhysicalKm: s.startPhysicalKm.toFixed(3),
    startCumulativeKm: s.startCumulativeKm.toFixed(3),
    cumulativeKnown: s.cumulativeKnown,
    lastPhysicalKm: s.lastPhysicalKm?.toFixed(3) ?? null,
    replacementReason: s.replacementReason,
    justificationAttachmentId: s.justificationAttachmentId,
  };
}
