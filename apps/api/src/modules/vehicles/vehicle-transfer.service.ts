import { Injectable } from '@nestjs/common';
import type { FuelMeasureKind, Prisma, TelemetryOdometerKind, Vehicle } from '@parc-auto/db';
import { AfterCommit } from '../../common/after-commit.js';
import { Clock } from '../../common/clock.js';
import { AppError, BusinessRuleError, ConflictError } from '../../common/errors.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import type { RequestContext } from '../../common/request-context.js';
import { formatLocalDateTime, fromDbDate, localDate } from '../../domain/civil-date.js';
import { currentAssignmentWhere, upcomingAssignmentWhere } from '../../domain/responsible-assignment.js';
import {
  ALERT_OBJECT_TYPES_KEPT_BY_ORIGIN,
  TRANSFER_BLOCKER_LABELS,
  TRANSFER_BLOCKING_INTERVENTION_STATUSES,
  TRANSFER_OPEN_INCIDENT_STATUSES,
  TRANSFER_WARNING_LABELS,
  checkTransferDecisions,
  isDocumentShareSuggested,
  isReservationBlocking,
  type TransferBlockerType,
  type TransferWarningType,
} from '../../domain/vehicle-transfer.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, type Tx } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { MaintenancePlansService } from '../maintenance/maintenance-plans.service.js';
import { OdometerFreshnessService } from '../odometer/odometer-freshness.service.js';
import { OdometerIngestionService, lockVehicle } from '../odometer/odometer-ingestion.service.js';
import { parseKm } from '../odometer/odometer.service.js';
import { closeOpenMappingsForVehicle } from '../telemetry/telemetry-units.service.js';
import type {
  TransferAssignmentPreviewDto,
  TransferBlockerDto,
  TransferDocumentPreviewDto,
  TransferMappingPreviewDto,
  TransferPlanPreviewDto,
  TransferPreviewDto,
  TransferResponsiblesDto,
  TransferResultDto,
  TransferVehicleDto,
  TransferWarningDto,
} from './dto/transfer-vehicle.dto.js';
import { VehiclesService } from './vehicles.service.js';

type Db = Tx | PrismaService['client'];

/**
 * Refus du service unique d'ingestion (valeur invalide, diminution, conflit d'instant…) rapporté sur les
 * champs du relevé de transfert (transferReading.*) : le formulaire affiche l'erreur au bon endroit.
 */
async function transferReadingErrors<T>(ingest: () => Promise<T>): Promise<T> {
  try {
    return await ingest();
  } catch (error) {
    if (error instanceof BusinessRuleError && error.fieldErrors) {
      const fieldErrors = Object.fromEntries(Object.entries(error.fieldErrors).map(([field, messages]) => [`transferReading.${field}`, messages]));
      throw new BusinessRuleError(error.code, error.message, { fieldErrors, ...(error.details ? { details: error.details } : {}) });
    }
    throw error;
  }
}

/** Objets à réexaminer au transfert, lus dans la même transaction que la bascule (ou pour l'aperçu). */
interface TransferState {
  blockers: TransferBlockerDto[];
  warnings: TransferWarningDto[];
  assignments: TransferAssignmentPreviewDto[];
  plans: TransferPlanPreviewDto[];
  documents: TransferDocumentPreviewDto[];
  mappings: Array<TransferMappingPreviewDto & { unitId: string; odometerKind: TelemetryOdometerKind; fuelKinds: FuelMeasureKind[] }>;
  lastReading: { readingId: string; physicalKm: string | null; cumulativeKm: string | null; observedAt: string } | null;
  segment: { id: string; sequence: number; cumulativeKnown: boolean } | null;
}

/**
 * Transfert d'un véhicule entre sociétés (CDC 2.4, 11.3, 13.3 ; D-119 à D-125). Réservé à
 * l'administrateur groupe. Refusé tant qu'un objet bloquant existe ; sinon, dans une transaction qui
 * verrouille le véhicule et prend effet à l'heure du serveur : relevé de transfert (société d'origine),
 * décisions explicites sur l'affectation, les plans, le site, le service et les documents partagés,
 * mapping télématique clôturé, alertes de l'ancienne société résolues, historique et audit. Les
 * événements datés et les dépenses gardent leur société historique : aucun companyId n'est réécrit.
 */
@Injectable()
export class VehicleTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly vehicles: VehiclesService,
    private readonly ingestion: OdometerIngestionService,
    private readonly attachments: AttachmentsService,
    private readonly plans: MaintenancePlansService,
    private readonly documents: DocumentsService,
    private readonly freshness: OdometerFreshnessService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** Aperçu du transfert : objets bloquants typés avec liens, avertissements et objets à décider. */
  async preview(ctx: RequestContext, vehicleId: string): Promise<TransferPreviewDto> {
    const vehicle = await this.vehicles.load(ctx, vehicleId);
    this.access.requireAdmin(ctx);
    const now = this.clock.now();
    const timezone = await this.timezone(ctx.organizationId);
    const state = await this.collect(this.prisma.client, vehicle, now, timezone);
    const companies = await this.prisma.client.company.findMany({ where: { organizationId: ctx.organizationId, status: 'ACTIF', id: { not: vehicle.companyId } }, orderBy: { code: 'asc' }, select: { id: true, code: true, legalName: true } });
    return {
      vehicleId: vehicle.id,
      vehicleCode: vehicle.code,
      registration: vehicle.registration,
      companyId: vehicle.companyId,
      companyCode: vehicle.company.code,
      version: vehicle.version,
      evaluatedAt: now.toISOString(),
      canTransfer: state.blockers.length === 0,
      blockers: state.blockers,
      warnings: state.warnings,
      assignments: state.assignments,
      plans: state.plans,
      documents: state.documents,
      telemetryMappings: state.mappings.map(({ unitId: _unit, odometerKind: _kind, fuelKinds: _fuel, ...m }) => m),
      targetCompanies: companies,
      lastReading: state.lastReading,
    };
  }

  /**
   * Responsables de plan proposés pour la société cible : règle unique du responsable
   * (MaintenancePlansService.eligibleResponsibles), administrateurs groupe compris. Société cible inconnue,
   * identique à la société actuelle ou archivée : mêmes refus (422) qu'au transfert.
   */
  async responsibles(ctx: RequestContext, vehicleId: string, companyId: string): Promise<TransferResponsiblesDto> {
    const vehicle = await this.vehicles.load(ctx, vehicleId);
    this.access.requireAdmin(ctx);
    const target = await this.prisma.client.company.findFirst({ where: { id: companyId, organizationId: ctx.organizationId }, select: { id: true, status: true } });
    if (!target) throw new BusinessRuleError('REFERENCE_INVALIDE', 'Société cible inconnue.', { fieldErrors: { companyId: ['Référence invalide.'] } });
    if (target.id === vehicle.companyId) throw new BusinessRuleError('SOCIETE_IDENTIQUE', 'Le véhicule appartient déjà à cette société.', { fieldErrors: { companyId: ['Choisissez une autre société.'] } });
    if (target.status !== 'ACTIF') throw new BusinessRuleError('SOCIETE_ARCHIVEE', 'La société cible est archivée.', { fieldErrors: { companyId: ['Société archivée.'] } });
    return { companyId: target.id, items: await this.plans.eligibleResponsibles(ctx.organizationId, target.id) };
  }

  /**
   * Transfert (POST /vehicles/:id/transfer) : idempotent (clé liée à l'utilisateur, l'organisation et
   * l'opération), versionné (expectedVersion), transactionnel avec verrou de la ligne du véhicule.
   */
  async transfer(ctx: RequestContext, vehicleId: string, dto: TransferVehicleDto, idempotencyKey: string): Promise<TransferResultDto> {
    const vehicle = await this.vehicles.load(ctx, vehicleId);
    this.access.requireAdmin(ctx);
    const body = { ...dto, idempotencyKey: undefined, vehicleId };
    const result = await this.idempotency.run({ organizationId: ctx.organizationId, userId: ctx.userId, operation: 'vehicle.transfer', key: idempotencyKey }, body, async () => {
      const timezone = await this.timezone(ctx.organizationId);
      // Actions post-validation créées à chaque tentative : une reprise sur conflit de sérialisation
      // n'hérite d'aucune action d'une tentative annulée.
      const { outcome, after } = await this.prisma.serializable(
        async (tx) => {
          const actions = new AfterCommit();
          return { outcome: await this.transferInTx(tx, ctx, vehicle.id, dto, timezone, actions), after: actions };
        },
        { timeoutMs: 30_000 },
      );
      await after.run();
      const response: TransferResultDto = { ...outcome, vehicle: await this.vehicles.get(ctx, vehicleId) };
      return { status: 200, body: response, resourceId: outcome.historyId };
    });
    return result.body;
  }

  private async transferInTx(tx: Tx, ctx: RequestContext, vehicleId: string, dto: TransferVehicleDto, timezone: string, after: AfterCommit): Promise<Omit<TransferResultDto, 'vehicle'>> {
    await lockVehicle(tx, vehicleId);
    const fresh = await tx.vehicle.findUniqueOrThrow({ where: { id: vehicleId }, include: { company: { select: { code: true } } } });
    assertExpectedVersion(fresh, dto.expectedVersion, 'véhicule');
    if (fresh.lifecycleStatus === 'CEDE' || fresh.lifecycleStatus === 'ARCHIVE') throw new BusinessRuleError('VEHICULE_CLOS', 'Un véhicule cédé ou archivé ne peut pas être transféré.');
    const originId = fresh.companyId;
    const target = await tx.company.findFirst({ where: { id: dto.targetCompanyId, organizationId: ctx.organizationId }, select: { id: true, code: true, status: true, telemetryEnabled: true } });
    if (!target) throw new BusinessRuleError('REFERENCE_INVALIDE', 'Société cible inconnue.', { fieldErrors: { targetCompanyId: ['Référence invalide.'] } });
    if (target.id === originId) throw new BusinessRuleError('SOCIETE_IDENTIQUE', 'Le véhicule appartient déjà à cette société.', { fieldErrors: { targetCompanyId: ['Choisissez une autre société.'] } });
    if (target.status !== 'ACTIF') throw new BusinessRuleError('SOCIETE_ARCHIVEE', 'La société cible est archivée.', { fieldErrors: { targetCompanyId: ['Société archivée.'] } });

    // Prise d'effet à l'heure du serveur (pas d'antidatage en V1, D-120).
    const transferAt = this.clock.now();
    const state = await this.collect(tx, fresh, transferAt, timezone);
    if (state.blockers.length > 0) {
      throw new ConflictError('TRANSFERT_BLOQUE', `Transfert refusé : ${state.blockers.length} opération(s) ouverte(s) à traiter d’abord (utilisation, immobilisation, intervention ou réservation future).`, { blockers: state.blockers });
    }
    const fieldErrors = checkTransferDecisions(
      {
        hasOpenAssignment: state.assignments.length > 0,
        activePlanIds: state.plans.map((p) => p.id),
        documentVersionIds: state.documents.map((d) => d.id),
        hasWarnings: state.warnings.length > 0,
      },
      {
        closeAssignment: dto.assignment?.closeCurrent,
        plans: dto.plans,
        sharedDocumentVersionIds: dto.sharedDocumentVersionIds,
        hasTransferReading: dto.transferReading !== undefined,
        noReadingReason: dto.noReadingReason,
        acknowledgeWarnings: dto.acknowledgeWarnings,
      },
    );
    if (Object.keys(fieldErrors).length > 0) throw new BusinessRuleError('DECISIONS_TRANSFERT', 'Décisions de transfert incomplètes ou invalides : chaque objet à réexaminer doit recevoir une décision explicite.', { fieldErrors });
    await this.assertTargetReferences(tx, ctx, target.id, dto);

    // 1. Relevé de transfert : service unique d'ingestion, avant la bascule (société d'origine, D-121).
    let transferReadingId: string | null = null;
    if (dto.transferReading) {
      const reading = dto.transferReading;
      const ingested = await transferReadingErrors(() =>
        this.ingestion.ingest(
          tx,
          {
            organizationId: ctx.organizationId,
            vehicleId,
            origin: 'MANUAL',
            context: 'TRANSFERT',
            measurementKind: 'COMPTEUR_AFFICHE',
            physicalKm: parseKm(reading.physicalKm),
            observedAt: transferAt,
            author: { kind: 'STAFF', userId: ctx.userId },
            note: reading.note?.trim() || `Relevé de transfert vers la société ${target.code}`,
          },
          after,
        ),
      );
      if (ingested.outcome === 'EN_ATTENTE') {
        const reason = ingested.anomaly?.reason ?? 'contrôle en attente';
        throw new BusinessRuleError('RELEVE_TRANSFERT_EN_ATTENTE', `Le relevé de transfert n’est pas accepté (${reason}) : corrigez la valeur ou transférez sans relevé avec un motif.`, { fieldErrors: { 'transferReading.physicalKm': [reason] } });
      }
      transferReadingId = ingested.reading.id;
      if (dto.transferReading.attachmentId) {
        await this.attachments.attach(ctx, tx, dto.transferReading.attachmentId, 'RELEVE', ingested.reading.id, originId);
        await tx.odometerReading.update({ where: { id: ingested.reading.id }, data: { attachmentId: dto.transferReading.attachmentId } });
      }
    }

    // 2. Affectation habituelle : clôture de l'affectation en cours ; une affectation prévue (jamais entrée
    //    en vigueur, conducteur de l'ancienne société) est retirée ; nouveau responsable facultatif.
    const endReason = `Transfert du véhicule vers la société ${target.code}`;
    const closedAssignmentIds: string[] = [];
    const withdrawnAssignmentIds: string[] = [];
    for (const a of state.assignments) {
      if (a.isCurrent) {
        await tx.vehicleResponsibleAssignment.update({ where: { id: a.id }, data: { endsAt: transferAt, endReason, endedById: ctx.userId, version: { increment: 1 } } });
        closedAssignmentIds.push(a.id);
      } else {
        await tx.vehicleResponsibleAssignment.delete({ where: { id: a.id } });
        withdrawnAssignmentIds.push(a.id);
      }
    }
    let newAssignmentId: string | null = null;
    if (dto.assignment?.newResponsibleDriverId) {
      const created = await tx.vehicleResponsibleAssignment.create({
        data: { organizationId: ctx.organizationId, companyId: target.id, vehicleId, driverId: dto.assignment.newResponsibleDriverId, startsAt: transferAt, notes: 'Responsable habituel désigné lors du transfert', createdById: ctx.userId },
      });
      newAssignmentId = created.id;
    }

    // 3. Plans d'entretien : décision explicite par plan (bases et échéances conservées si KEEP).
    const keptPlanIds: string[] = [];
    const deactivatedPlanIds: string[] = [];
    for (const decision of dto.plans) {
      if (decision.decision === 'KEEP') {
        await tx.vehicleMaintenancePlan.update({ where: { id: decision.planId }, data: { companyId: target.id, responsibleUserId: decision.responsibleUserId ?? null, version: { increment: 1 } } });
        keptPlanIds.push(decision.planId);
      } else {
        await tx.vehicleMaintenancePlan.update({ where: { id: decision.planId }, data: { active: false, deactivatedAt: transferAt, deactivationReason: endReason, version: { increment: 1 } } });
        deactivatedPlanIds.push(decision.planId);
      }
    }

    // 4. Documents véhicule partagés avec la société cible (la version garde sa société historique).
    const sharedDocumentVersionIds = [...new Set(dto.sharedDocumentVersionIds)];
    for (const id of sharedDocumentVersionIds) {
      const doc = state.documents.find((d) => d.id === id);
      if (doc && !doc.sharedWithCompanyIds.includes(target.id)) {
        await tx.documentVersion.update({ where: { id }, data: { sharedWithCompanyIds: { push: target.id }, version: { increment: 1 } } });
      }
    }

    // 5. Mapping télématique : clôturé à la date du transfert ; proposition dans la société cible si le
    //    fournisseur actif la couvre et que F11 y est activé (D-124), à confirmer par son chef.
    const closedTelemetryMappingIds = state.mappings.map((m) => m.id);
    const proposedTelemetryMappingIds: string[] = [];
    await closeOpenMappingsForVehicle(tx, { organizationId: ctx.organizationId, vehicleId, at: transferAt, reason: endReason, userId: ctx.userId });
    for (const m of state.mappings) {
      if (m.status !== 'CONFIRME' || !target.telemetryEnabled) continue;
      const covered = await tx.telemetryProviderCompany.findFirst({ where: { providerId: m.providerId, companyId: target.id, provider: { status: 'ACTIF' } }, select: { providerId: true } });
      if (!covered) continue;
      const proposal = await tx.telemetryVehicleMapping.create({
        data: { organizationId: ctx.organizationId, companyId: target.id, providerId: m.providerId, unitId: m.unitId, vehicleId, status: 'PROPOSE', odometerKind: m.odometerKind, fuelKinds: m.fuelKinds, proposedAt: transferAt, proposalReason: `Transfert depuis la société ${fresh.company.code} : confirmation requise par la société cible.` },
      });
      proposedTelemetryMappingIds.push(proposal.id);
    }

    // 6. Fournisseur du contrat (loueur, crédit-bail) : fiche de la société d'origine, référence retirée —
    //    aucun objet de la société cible ne pointe vers une autre société (13.1, D-120) ; valeur figée
    //    dans l'historique et l'audit.
    let clearedContractSupplierId: string | null = null;
    if (fresh.contractSupplierId) {
      const supplier = await tx.supplier.findFirst({ where: { id: fresh.contractSupplierId, organizationId: ctx.organizationId }, select: { companyId: true } });
      if (supplier?.companyId !== target.id) clearedContractSupplierId = fresh.contractSupplierId;
    }

    // 7. Alertes actives de l'ancienne société sur ce véhicule : résolues (motif transfert), sauf celles
    //    des événements qu'elle conserve et qui restent ouverts (incident, relevé ou plein en attente).
    const resolved = await tx.alert.updateMany({
      where: {
        organizationId: ctx.organizationId,
        companyId: originId,
        status: 'ACTIVE',
        objectType: { notIn: [...ALERT_OBJECT_TYPES_KEPT_BY_ORIGIN] },
        OR: [{ vehicleId }, { objectType: 'Vehicle', objectId: vehicleId }],
      },
      data: { status: 'RESOLUE', resolvedAt: transferAt, resolutionReason: `transfert du véhicule vers la société ${target.code}`, version: { increment: 1 } },
    });

    // 8. Historique avec instantané technique (sans coût ni donnée personnelle), puis bascule.
    const decisionsByPlan = new Map(dto.plans.map((p) => [p.planId, p]));
    const technicalSnapshot = {
      odometer: {
        segment: state.segment,
        lastAcceptedReading: state.lastReading,
        transferReadingId,
        noReadingReason: dto.transferReading ? null : (dto.noReadingReason?.trim() ?? null),
        distanceAllocation: dto.transferReading ? 'BORNEE_PAR_RELEVE_DE_TRANSFERT' : 'NON_VENTILABLE',
      },
      plans: state.plans.map((p) => ({ planId: p.id, maintenanceType: p.maintenanceTypeLabel, status: p.status, baseKm: p.baseKm, baseDate: p.baseDate, nextDueKm: p.nextDueKm, nextDueDate: p.nextDueDate, decision: decisionsByPlan.get(p.id)?.decision ?? null })),
      documents: state.documents.map((d) => ({ documentVersionId: d.id, documentType: d.documentTypeLabel, validFrom: d.validFrom, validTo: d.validTo, shared: sharedDocumentVersionIds.includes(d.id) })),
      location: { siteId: dto.siteId, departmentId: dto.departmentId, previousSiteId: fresh.siteId, previousDepartmentId: fresh.departmentId },
      contract: { previousContractSupplierId: fresh.contractSupplierId, contractSupplierCleared: clearedContractSupplierId !== null },
      telemetry: { closedMappingIds: closedTelemetryMappingIds, proposedMappingIds: proposedTelemetryMappingIds },
      acknowledgedWarnings: state.warnings.map((w) => ({ type: w.type, id: w.id })),
    } satisfies Prisma.InputJsonValue;
    const history = await tx.vehicleCompanyHistory.create({
      data: {
        organizationId: ctx.organizationId,
        vehicleId,
        fromCompanyId: originId,
        toCompanyId: target.id,
        effectiveAt: transferAt,
        reason: dto.reason.trim(),
        technicalSnapshot,
        transferReadingId,
        sharedDocumentIds: sharedDocumentVersionIds,
        createdById: ctx.userId,
      },
    });
    await tx.vehicle.update({ where: { id: vehicleId, version: dto.expectedVersion }, data: { companyId: target.id, siteId: dto.siteId, departmentId: dto.departmentId, ...(clearedContractSupplierId ? { contractSupplierId: null } : {}), version: { increment: 1 } } });

    await this.audit.record(
      ctx,
      {
        action: 'vehicule.transfert',
        objectType: 'Vehicle',
        objectId: vehicleId,
        companyId: originId,
        reason: dto.reason.trim(),
        before: { companyId: originId, siteId: fresh.siteId, departmentId: fresh.departmentId, contractSupplierId: fresh.contractSupplierId, version: fresh.version },
        after: {
          companyId: target.id,
          effectiveAt: transferAt,
          historyId: history.id,
          siteId: dto.siteId,
          departmentId: dto.departmentId,
          clearedContractSupplierId,
          transferReadingId,
          noReadingReason: dto.transferReading ? null : (dto.noReadingReason?.trim() ?? null),
          closedAssignmentIds,
          withdrawnAssignments: state.assignments.filter((a) => !a.isCurrent).map((a) => ({ id: a.id, driverId: a.driverId, startsAt: a.startsAt, endsAt: a.endsAt })),
          newAssignmentId,
          newResponsibleDriverId: dto.assignment?.newResponsibleDriverId ?? null,
          plans: dto.plans.map((p) => ({ planId: p.planId, decision: p.decision, responsibleUserId: p.responsibleUserId ?? null })),
          sharedDocumentVersionIds,
          closedTelemetryMappingIds,
          proposedTelemetryMappingIds,
          resolvedAlerts: resolved.count,
          acknowledgedWarnings: state.warnings.map((w) => ({ type: w.type, id: w.id })),
        },
      },
      tx,
    );

    // Recalcul des alertes pour la nouvelle société, visible dès la validation (D-120, D-254).
    const recomputedPlanIds = [...keptPlanIds, ...deactivatedPlanIds];
    after.add('transfert → alertes d’entretien', async () => {
      for (const planId of recomputedPlanIds) await this.plans.syncAlerts(planId);
    });
    after.add('transfert → alertes documentaires', () => this.documents.evaluateOwner({ ownerType: 'VEHICULE', id: vehicleId, companyId: target.id, categoryId: fresh.categoryId, label: `${fresh.code} · ${fresh.registration}` }));
    after.add('transfert → fraîcheur du kilométrage', () => this.freshness.evaluateVehicle(vehicleId));

    return {
      historyId: history.id,
      fromCompanyId: originId,
      toCompanyId: target.id,
      effectiveAt: transferAt.toISOString(),
      transferReadingId,
      closedAssignmentIds,
      withdrawnAssignmentIds,
      newAssignmentId,
      keptPlanIds,
      deactivatedPlanIds,
      sharedDocumentVersionIds,
      closedTelemetryMappingIds,
      proposedTelemetryMappingIds,
      clearedContractSupplierId,
      resolvedAlerts: resolved.count,
    };
  }

  /** Références de la société cible : site, service, nouveau responsable, responsables des plans conservés. */
  private async assertTargetReferences(tx: Tx, ctx: RequestContext, targetId: string, dto: TransferVehicleDto): Promise<void> {
    const fieldErrors: Record<string, string[]> = {};
    if (dto.siteId) {
      const site = await tx.site.findFirst({ where: { id: dto.siteId, organizationId: ctx.organizationId, companyId: targetId, status: 'ACTIF' }, select: { id: true } });
      if (!site) fieldErrors['siteId'] = ['Référence invalide : site actif de la société cible attendu.'];
    }
    if (dto.departmentId) {
      const department = await tx.department.findFirst({ where: { id: dto.departmentId, organizationId: ctx.organizationId, companyId: targetId, status: 'ACTIF' }, select: { id: true } });
      if (!department) fieldErrors['departmentId'] = ['Référence invalide : service actif de la société cible attendu.'];
    }
    const driverId = dto.assignment?.newResponsibleDriverId;
    if (driverId) {
      const driver = await tx.driver.findFirst({ where: { id: driverId, organizationId: ctx.organizationId, companyId: targetId, status: 'ACTIF' }, select: { id: true } });
      if (!driver) fieldErrors['assignment.newResponsibleDriverId'] = ['Référence invalide : conducteur actif de la société cible attendu.'];
    }
    for (const [index, plan] of dto.plans.entries()) {
      if (plan.decision !== 'KEEP' || !plan.responsibleUserId) continue;
      try {
        await this.plans.assertResponsible(tx, ctx.organizationId, plan.responsibleUserId, targetId);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        fieldErrors[`plans.${index}.responsibleUserId`] = ['Référence invalide : compte actif habilité sur la société cible attendu.'];
      }
    }
    if (Object.keys(fieldErrors).length > 0) throw new BusinessRuleError('REFERENCE_INVALIDE', 'Certaines références ne relèvent pas de la société cible.', { fieldErrors });
  }

  /** Lecture des objets bloquants, des avertissements et des objets à décider (même règle pour l'aperçu et le transfert). */
  private async collect(db: Db, vehicle: Pick<Vehicle, 'id' | 'companyId'>, at: Date, timezone: string): Promise<TransferState> {
    const vehicleId = vehicle.id;
    const [usages, immobilizations, interventions, reservations, pendingReadings, submittedFuel, openIncidents, assignments, plans, documents, mappings, lastReading, segment] = await Promise.all([
      db.vehicleUsage.findMany({ where: { vehicleId, status: 'EN_COURS' }, select: { id: true, status: true, checkedOutAt: true, expectedReturnAt: true }, orderBy: { checkedOutAt: 'asc' } }),
      db.immobilization.findMany({ where: { vehicleId, status: 'ACTIVE' }, select: { id: true, status: true, startedAt: true }, orderBy: { startedAt: 'asc' } }),
      db.intervention.findMany({ where: { vehicleId, status: { in: [...TRANSFER_BLOCKING_INTERVENTION_STATUSES] } }, select: { id: true, reference: true, status: true }, orderBy: { createdAt: 'asc' } }),
      db.reservation.findMany({ where: { vehicleId, status: 'CONFIRMEE', endAt: { gt: at } }, select: { id: true, status: true, startAt: true, endAt: true }, orderBy: { startAt: 'asc' } }),
      db.odometerReading.findMany({ where: { vehicleId, status: 'EN_ATTENTE' }, select: { id: true, status: true, physicalKm: true, observedAt: true }, orderBy: { observedAt: 'asc' } }),
      db.fuelEntry.findMany({ where: { vehicleId, status: 'SOUMIS' }, select: { id: true, status: true, filledAt: true, liters: true }, orderBy: { filledAt: 'asc' } }),
      db.incident.findMany({ where: { vehicleId, status: { in: [...TRANSFER_OPEN_INCIDENT_STATUSES] } }, select: { id: true, reference: true, status: true, severity: true }, orderBy: { occurredAt: 'asc' } }),
      db.vehicleResponsibleAssignment.findMany({ where: { vehicleId, OR: [currentAssignmentWhere(at), upcomingAssignmentWhere(at)] }, include: { driver: { select: { firstName: true, lastName: true } } }, orderBy: { startsAt: 'asc' } }),
      db.vehicleMaintenancePlan.findMany({ where: { vehicleId, active: true }, include: { maintenanceType: { select: { label: true } } }, orderBy: { createdAt: 'asc' } }),
      db.documentVersion.findMany({ where: { vehicleId, ownerType: 'VEHICULE', archivedAt: null }, include: { documentType: { select: { label: true } } }, orderBy: [{ documentTypeId: 'asc' }, { validFrom: 'asc' }] }),
      db.telemetryVehicleMapping.findMany({ where: { vehicleId, status: { in: ['PROPOSE', 'CONFIRME'] }, validTo: null }, include: { provider: { select: { name: true } }, unit: { select: { label: true } } }, orderBy: { createdAt: 'asc' } }),
      db.odometerReading.findFirst({ where: { vehicleId, status: 'ACCEPTE', isEstimate: false }, orderBy: [{ observedAt: 'desc' }, { enteredAt: 'desc' }], select: { id: true, physicalKm: true, cumulativeKm: true, observedAt: true } }),
      db.odometerSegment.findFirst({ where: { vehicleId, endedAt: null }, orderBy: { sequence: 'desc' }, select: { id: true, sequence: true, cumulativeKnown: true } }),
    ]);
    const today = localDate(at, timezone);
    const when = (d: Date) => formatLocalDateTime(d, timezone, { sentence: true });
    const blocker = (type: TransferBlockerType, id: string, status: string, label: string, link: string): TransferBlockerDto => ({ type, id, status, label, action: TRANSFER_BLOCKER_LABELS[type], link });
    const warning = (type: TransferWarningType, id: string, status: string, label: string, link: string): TransferWarningDto => ({ type, id, status, label, action: TRANSFER_WARNING_LABELS[type], link });
    const blockers: TransferBlockerDto[] = [
      ...usages.map((u) => blocker('UTILISATION_EN_COURS', u.id, u.status, `Utilisation en cours depuis le ${when(u.checkedOutAt)}, retour prévu le ${when(u.expectedReturnAt)}`, `/utilisations/${u.id}`)),
      ...immobilizations.map((i) => blocker('IMMOBILISATION_ACTIVE', i.id, i.status, `Immobilisation depuis le ${when(i.startedAt)}`, `/immobilisations/${i.id}`)),
      ...interventions.map((i) => blocker('INTERVENTION_OUVERTE', i.id, i.status, `Intervention ${i.reference}`, `/interventions/${i.id}`)),
      ...reservations.filter((r) => isReservationBlocking(r, at)).map((r) => blocker('RESERVATION_A_TRAITER', r.id, r.status, `Réservation du ${when(r.startAt)} au ${when(r.endAt)}`, `/planning?reservation=${r.id}`)),
    ];
    const warnings: TransferWarningDto[] = [
      ...pendingReadings.map((r) => warning('RELEVE_EN_ATTENTE', r.id, r.status, `Relevé de ${r.physicalKm?.toString() ?? '?'} km observé le ${when(r.observedAt)}`, `/kilometrage?statut=EN_ATTENTE&vehicule=${vehicleId}`)),
      ...submittedFuel.map((f) => warning('PLEIN_SOUMIS', f.id, f.status, `Plein de ${f.liters.toString()} L du ${when(f.filledAt)}`, `/carburant?statut=SOUMIS&vehicule=${vehicleId}`)),
      ...openIncidents.map((i) => warning('INCIDENT_OUVERT', i.id, i.status, `Incident ${i.reference} (${i.severity.toLowerCase()})`, `/incidents/${i.id}`)),
    ];
    return {
      blockers,
      warnings,
      assignments: assignments.map((a) => ({ id: a.id, driverId: a.driverId, driverName: `${a.driver.firstName} ${a.driver.lastName}`, startsAt: a.startsAt.toISOString(), endsAt: a.endsAt?.toISOString() ?? null, isCurrent: a.startsAt.getTime() < at.getTime() })),
      plans: plans.map((p) => ({
        id: p.id,
        maintenanceTypeLabel: p.maintenanceType.label,
        status: p.computedStatus,
        baseKm: p.baseKm?.toString() ?? null,
        baseDate: fromDbDate(p.baseDate),
        nextDueKm: p.nextDueKm?.toString() ?? null,
        nextDueDate: fromDbDate(p.nextDueDate),
        responsibleUserId: p.responsibleUserId,
        version: p.version,
      })),
      documents: documents.map((d) => {
        const validTo = fromDbDate(d.validTo);
        return {
          id: d.id,
          documentTypeLabel: d.documentType.label,
          number: d.number,
          validFrom: fromDbDate(d.validFrom),
          validTo,
          suggested: isDocumentShareSuggested({ validTo }, today),
          sharedWithCompanyIds: d.sharedWithCompanyIds,
        };
      }),
      mappings: mappings.map((m) => ({
        id: m.id,
        providerId: m.providerId,
        providerName: m.provider.name,
        unitLabel: m.unit.label,
        status: m.status,
        outcome: m.status === 'CONFIRME' ? 'Clôturé à la date du transfert ; proposé à la société cible si son fournisseur actif la couvre et que la télématique y est activée.' : 'Proposition non confirmée : rejetée au transfert.',
        unitId: m.unitId,
        odometerKind: m.odometerKind,
        fuelKinds: m.fuelKinds,
      })),
      lastReading: lastReading ? { readingId: lastReading.id, physicalKm: lastReading.physicalKm?.toString() ?? null, cumulativeKm: lastReading.cumulativeKm?.toString() ?? null, observedAt: lastReading.observedAt.toISOString() } : null,
      segment,
    };
  }

  private async timezone(organizationId: string): Promise<string> {
    return (await this.prisma.client.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } })).timezone;
  }
}
