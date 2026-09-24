import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { MaintenancePlanTemplate, MaintenancePlanTemplateItem, MaintenanceType, Prisma, VehicleMaintenancePlan } from '@parc-auto/db';
import { ConflictError, ErrorCodes, NotFoundOrOutOfScopeError, BusinessRuleError, type FieldErrors } from '../../common/errors.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import type { RequestContext } from '../../common/request-context.js';
import { truncatedKm, type IntervalsError, type PlanIntervals } from '../../domain/maintenance-schedule.js';
import { INITIAL_MAINTENANCE_TYPES, planCatalogInstall } from '../../domain/initial-catalog.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, isUniqueViolation } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { VehiclesService } from '../vehicles/vehicles.service.js';
import type {
  ApplyTemplateDto,
  ApplyTemplateResultDto,
  ApplyTemplateVehicleResultDto,
  CatalogQueryDto,
  CreateMaintenanceTypeDto,
  CreateTemplateDto,
  InstallMaintenanceCatalogResultDto,
  MaintenanceTypeViewDto,
  PlanImpactStateDto,
  PlanViewDto,
  TemplateItemDto,
  TemplatePlanImpactDto,
  TemplateViewDto,
  UpdateMaintenanceTypeDto,
  UpdateTemplateDto,
} from './dto/maintenance.dto.js';
import { MaintenancePlansService, intervalMessage } from './maintenance-plans.service.js';

type TemplateRow = MaintenancePlanTemplate & { items: Array<MaintenancePlanTemplateItem & { maintenanceType: { label: string; status: string } }> };

const templateInclude = { items: { include: { maintenanceType: { select: { label: true, status: true } } }, orderBy: { maintenanceType: { label: 'asc' } } } } satisfies Prisma.MaintenancePlanTemplateInclude;

/** Inclusions nécessaires à la vue d'un plan (impact avant/après d'une application de modèle). */
const impactInclude = { maintenanceType: { select: { label: true } }, vehicle: { select: { code: true } } } satisfies Prisma.VehicleMaintenancePlanInclude;

type OnExisting = 'IGNORER' | 'METTRE_A_JOUR';

/** Annule la transaction d'une prévisualisation en portant l'impact calculé. */
class TemplatePreviewRollback extends Error {
  constructor(readonly impacts: TemplatePlanImpactDto[]) {
    super('prévisualisation');
  }
}

interface ValidItem {
  maintenanceTypeId: string;
  intervalKm: string | null;
  intervalMonths: number | null;
  intervalDays: number | null;
  noticeKm: string | null;
  noticeDays: number | null;
}

/**
 * Catalogue des opérations et modèles de plans (6.1). Le catalogue est commun à l'organisation :
 * sa modification relève du paramétrage (administrateur) ; la copie d'un modèle vers des véhicules
 * relève du chef de parc de leur société. La copie est un instantané (D-198).
 */
@Injectable()
export class MaintenanceCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly vehicles: VehiclesService,
    private readonly plans: MaintenancePlansService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // --- Types d'opération -----------------------------------------------------

  async listTypes(ctx: RequestContext, query: CatalogQueryDto): Promise<MaintenanceTypeViewDto[]> {
    this.access.requireStaff(ctx);
    const items = await this.prisma.client.maintenanceType.findMany({
      where: { organizationId: ctx.organizationId, ...(query.includeArchived === 'true' ? {} : { status: 'ACTIF' }) },
      orderBy: { label: 'asc' },
    });
    return items.map(typeView);
  }

  async createType(ctx: RequestContext, dto: CreateMaintenanceTypeDto): Promise<MaintenanceTypeViewDto> {
    this.access.requireAdmin(ctx);
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const created = await tx.maintenanceType.create({ data: { organizationId: ctx.organizationId, code: dto.code, label: dto.label.trim(), description: dto.description?.trim() || null, createdById: ctx.userId } });
        await this.audit.record(ctx, { action: 'type_entretien.creation', objectType: 'MaintenanceType', objectId: created.id, after: typeView(created) }, tx);
        return typeView(created);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('CODE_EXISTANT', `Le code ${dto.code} existe déjà dans le catalogue.`);
      throw error;
    }
  }

  /**
   * Installation du catalogue initial (6.1) par l'administrateur, en production comme en démonstration :
   * seules les opérations absentes (ni même code, ni même libellé, actives ou archivées) sont ajoutées ;
   * aucune opération existante n'est modifiée ni réactivée. Rejouable sans effet (ON CONFLICT DO NOTHING
   * sur le code unique, y compris sous concurrence) ; Idempotency-Key facultative pour rejouer la réponse.
   * Audit : une création par opération ajoutée et une trace de l'installation.
   */
  async installInitialTypes(ctx: RequestContext, idempotencyKey?: string): Promise<InstallMaintenanceCatalogResultDto> {
    this.access.requireAdmin(ctx);
    return this.idempotency.runOptional({ organizationId: ctx.organizationId, userId: ctx.userId, operation: 'type_entretien.catalogue_initial' }, idempotencyKey, {}, async () => ({
      status: 200,
      body: await this.prisma.client.$transaction(async (tx) => {
        const existing = await tx.maintenanceType.findMany({ where: { organizationId: ctx.organizationId }, select: { code: true, label: true } });
        const plan = planCatalogInstall(INITIAL_MAINTENANCE_TYPES, existing);
        const created =
          plan.toCreate.length > 0
            ? await tx.maintenanceType.createManyAndReturn({
                data: plan.toCreate.map((t) => ({ organizationId: ctx.organizationId, code: t.code, label: t.label, description: t.description, createdById: ctx.userId })),
                skipDuplicates: true,
              })
            : [];
        // Une installation concurrente a pu créer un code entre la lecture et l'écriture : il est ignoré.
        const createdCodes = new Set(created.map((c) => c.code));
        const skipped = [...plan.skipped, ...plan.toCreate.filter((t) => !createdCodes.has(t.code)).map((t) => ({ code: t.code, label: t.label, reason: 'CODE_EXISTANT' as const }))];
        const views = created.sort((a, b) => a.label.localeCompare(b.label, 'fr')).map(typeView);
        for (const v of views) await this.audit.record(ctx, { action: 'type_entretien.creation', objectType: 'MaintenanceType', objectId: v.id, reason: 'Installation du catalogue initial', after: v }, tx);
        await this.audit.record(ctx, { action: 'type_entretien.catalogue_initial', objectType: 'Organization', objectId: ctx.organizationId, after: { created: views.map((v) => v.code), skipped } }, tx);
        return { created: views, skipped };
      }),
    }));
  }

  async updateType(ctx: RequestContext, id: string, dto: UpdateMaintenanceTypeDto): Promise<MaintenanceTypeViewDto> {
    this.access.requireAdmin(ctx);
    const current = await this.prisma.client.maintenanceType.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!current) throw new NotFoundOrOutOfScopeError('Type d’opération');
    assertExpectedVersion(current, dto.expectedVersion, 'opération');
    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.maintenanceType.update({
        where: { id, version: dto.expectedVersion },
        data: {
          ...(dto.label !== undefined ? { label: dto.label.trim() } : {}),
          ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          version: { increment: 1 },
        },
      });
      await this.audit.record(ctx, { action: 'type_entretien.modification', objectType: 'MaintenanceType', objectId: id, before: typeView(current), after: typeView(updated) }, tx);
      return typeView(updated);
    });
  }

  // --- Modèles de plans ------------------------------------------------------

  async listTemplates(ctx: RequestContext, query: CatalogQueryDto): Promise<TemplateViewDto[]> {
    this.access.requireStaff(ctx);
    const items = await this.prisma.client.maintenancePlanTemplate.findMany({
      where: { organizationId: ctx.organizationId, ...(query.includeArchived === 'true' ? {} : { status: 'ACTIF' }) },
      include: templateInclude,
      orderBy: { name: 'asc' },
    });
    return items.map(templateView);
  }

  async getTemplate(ctx: RequestContext, id: string): Promise<TemplateViewDto> {
    this.access.requireStaff(ctx);
    return templateView(await this.loadTemplate(ctx, id));
  }

  async createTemplate(ctx: RequestContext, dto: CreateTemplateDto): Promise<TemplateViewDto> {
    this.access.requireAdmin(ctx);
    const items = await this.validateItems(ctx, dto.items, []);
    try {
      const id = await this.prisma.client.$transaction(async (tx) => {
        const t = await tx.maintenancePlanTemplate.create({ data: { organizationId: ctx.organizationId, name: dto.name.trim(), description: dto.description?.trim() || null, createdById: ctx.userId } });
        await tx.maintenancePlanTemplateItem.createMany({ data: items.map((i) => ({ ...i, organizationId: ctx.organizationId, templateId: t.id })) });
        await this.audit.record(ctx, { action: 'modele_entretien.creation', objectType: 'MaintenancePlanTemplate', objectId: t.id, after: { name: t.name, items } }, tx);
        return t.id;
      });
      return this.getTemplate(ctx, id);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('NOM_EXISTANT', 'Un modèle porte déjà ce nom.');
      throw error;
    }
  }

  async updateTemplate(ctx: RequestContext, id: string, dto: UpdateTemplateDto): Promise<TemplateViewDto> {
    this.access.requireAdmin(ctx);
    const current = await this.loadTemplate(ctx, id);
    assertExpectedVersion(current, dto.expectedVersion, 'modèle');
    // Une ligne inchangée peut référencer une opération archivée depuis ; une ligne nouvelle ou modifiée non.
    const items = dto.items ? await this.validateItems(ctx, dto.items, current.items) : null;
    try {
      await this.prisma.client.$transaction(async (tx) => {
        await tx.maintenancePlanTemplate.update({
          where: { id, version: dto.expectedVersion },
          data: {
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
            ...(dto.status !== undefined ? { status: dto.status } : {}),
            version: { increment: 1 },
          },
        });
        if (items) {
          // Les plans déjà copiés ne sont pas modifiés : la copie est un instantané (6.1).
          await tx.maintenancePlanTemplateItem.deleteMany({ where: { templateId: id } });
          await tx.maintenancePlanTemplateItem.createMany({ data: items.map((i) => ({ ...i, organizationId: ctx.organizationId, templateId: id })) });
        }
        await this.audit.record(ctx, { action: 'modele_entretien.modification', objectType: 'MaintenancePlanTemplate', objectId: id, before: templateView(current), after: { ...dto, items } }, tx);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('NOM_EXISTANT', 'Un modèle porte déjà ce nom.');
      throw error;
    }
    return this.getTemplate(ctx, id);
  }

  /**
   * Copie d'un modèle vers des véhicules (6.1, D-198). Pour chaque ligne : plan actif existant ignoré
   * ou mis à jour (intervalles et préavis, base conservée) selon le choix du véhicule, à défaut le choix
   * global ; sinon nouveau plan dont la base est la dernière opération de ce type sur le véhicule, ou
   * INCOMPLET avec alerte. Les opérations archivées au catalogue ne sont pas copiées. Tout ou rien.
   */
  async applyTemplate(ctx: RequestContext, id: string, dto: ApplyTemplateDto, idempotencyKey?: string): Promise<ApplyTemplateResultDto> {
    // Une prévisualisation n'enregistre rien : elle ne consomme pas la clé d'idempotence.
    if (idempotencyKey === undefined || dto.preview === true) return this.applyTemplateOnce(ctx, id, dto);
    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new BusinessRuleError('IDEMPOTENCE_CLE_INVALIDE', 'La clé d’idempotence doit compter de 8 à 128 caractères.', { fieldErrors: { idempotencyKey: ['Clé de 8 à 128 caractères.'] } });
    }
    // Même clé + même corps : résultat initial rejoué (aucune seconde mise à jour ni audit) ; corps différent : 409.
    const replay = await this.idempotency.run({ organizationId: ctx.organizationId, userId: ctx.userId, operation: `modele_entretien.application:${id}`, key: idempotencyKey }, dto, async () => ({ status: 200, body: await this.applyTemplateOnce(ctx, id, dto), resourceId: id }));
    return replay.body;
  }

  private async applyTemplateOnce(ctx: RequestContext, id: string, dto: ApplyTemplateDto): Promise<ApplyTemplateResultDto> {
    const template = await this.loadTemplate(ctx, id);
    if (template.status !== 'ACTIF') throw new BusinessRuleError('MODELE_ARCHIVE', 'Ce modèle est archivé.');
    const vehicleIds = [...new Set(dto.vehicleIds)];
    const onExisting: OnExisting = dto.onExisting ?? 'IGNORER';
    const choices = new Map<string, OnExisting>();
    const choiceErrors: FieldErrors = {};
    (dto.perVehicle ?? []).forEach((c, index) => {
      if (!vehicleIds.includes(c.vehicleId)) choiceErrors[`perVehicle.${index}.vehicleId`] = ['Ce véhicule ne fait pas partie de la sélection.'];
      else if (choices.has(c.vehicleId)) choiceErrors[`perVehicle.${index}.vehicleId`] = ['Un seul choix par véhicule.'];
      else choices.set(c.vehicleId, c.onExisting);
    });
    if (Object.keys(choiceErrors).length > 0) throw new BusinessRuleError('CHOIX_VEHICULE_INVALIDE', 'Chaque choix par véhicule doit concerner un véhicule sélectionné, une seule fois.', { fieldErrors: choiceErrors });
    const vehicles: Array<Awaited<ReturnType<VehiclesService['load']>>> = [];
    for (const vehicleId of vehicleIds) {
      const v = await this.vehicles.load(ctx, vehicleId);
      this.access.requireManager(ctx, v.companyId);
      if (v.lifecycleStatus === 'CEDE' || v.lifecycleStatus === 'ARCHIVE') throw new BusinessRuleError('VEHICULE_INACTIF', `Le véhicule ${v.code} est cédé ou archivé.`);
      vehicles.push(v);
    }
    const items = template.items.filter((i) => i.maintenanceType.status === 'ACTIF');
    const archivedSkipped = template.items.filter((i) => i.maintenanceType.status !== 'ACTIF').map((i) => i.maintenanceType.label);
    // Intervalles résolus une fois par société (préavis par défaut de la société du véhicule).
    const intervalsByCompany = new Map<string, Map<string, PlanIntervals>>();
    for (const companyId of new Set(vehicles.map((v) => v.companyId))) {
      const defaults = await this.plans.noticeDefaults(ctx.organizationId, companyId);
      const byItem = new Map<string, PlanIntervals>();
      for (const item of items) {
        const r = this.plans.resolveIntervals({ intervalKm: item.intervalKm?.toString() ?? null, intervalMonths: item.intervalMonths, intervalDays: item.intervalDays, noticeKm: item.noticeKm?.toString() ?? null, noticeDays: item.noticeDays }, defaults);
        if (r.errors.length > 0) throw new BusinessRuleError(r.errors[0] as string, `${item.maintenanceType.label} : ${intervalMessage(r.errors[0] as IntervalsError)}`);
        byItem.set(item.id, r.intervals);
      }
      intervalsByCompany.set(companyId, byItem);
    }
    const reason = `Application du modèle « ${template.name} »`;
    const touched: string[] = [];
    const results: ApplyTemplateVehicleResultDto[] = [];
    const preview = dto.preview === true;
    // État « avant » au jour local courant, comme la liste des échéances et la prévisualisation d'un plan.
    await this.plans.refreshForVehicles(ctx.organizationId, vehicles.map((v) => v.id));
    let impacts: TemplatePlanImpactDto[];
    try {
      impacts = await this.prisma.client.$transaction(
        async (tx) => {
          const existingPlans = items.length > 0 ? await tx.vehicleMaintenancePlan.findMany({ where: { vehicleId: { in: vehicles.map((v) => v.id) }, maintenanceTypeId: { in: items.map((i) => i.maintenanceTypeId) }, active: true }, include: impactInclude }) : [];
          const existingByKey = new Map(existingPlans.map((p) => [`${p.vehicleId}:${p.maintenanceTypeId}`, p]));
          const versionBefore = new Map(existingPlans.map((p) => [p.id, p.version]));
          // Confirmation d'un aperçu (17.1) : la mise à jour doit porter exactement sur les plans présentés, aux
          // versions lues par la prévisualisation ; sinon l'impact a changé et rien n'est enregistré (409).
          if (!preview && dto.expectedPlanVersions) {
            const toUpdate = new Map<string, number>();
            for (const v of vehicles) {
              if ((choices.get(v.id) ?? onExisting) !== 'METTRE_A_JOUR') continue;
              for (const item of items) {
                const existing = existingByKey.get(`${v.id}:${item.maintenanceTypeId}`);
                if (existing) toUpdate.set(existing.id, existing.version);
              }
            }
            const expected = new Map(dto.expectedPlanVersions.map((e) => [e.planId, e.version]));
            if (expected.size !== toUpdate.size || [...toUpdate].some(([planId, version]) => expected.get(planId) !== version)) {
              throw new ConflictError(
                ErrorCodes.VERSION_OBSOLETE,
                'Les plans concernés ont changé depuis la prévisualisation (plan modifié, créé ou désactivé entre-temps) : rien n’a été enregistré, prévisualisez de nouveau l’impact avant de confirmer.',
                { expected: dto.expectedPlanVersions, current: [...toUpdate].map(([planId, version]) => ({ planId, version })) },
              );
            }
          }
          const beforeViews = new Map((await this.plans.views(existingPlans, tx)).map((v) => [v.id, v]));
          const touchedPlans: VehicleMaintenancePlan[] = [];
          const createdIds = new Set<string>();
          for (const v of vehicles) {
            const choice = choices.get(v.id) ?? onExisting;
            const r: ApplyTemplateVehicleResultDto = { vehicleId: v.id, vehicleCode: v.code, onExisting: choice, created: [], updated: [], ignored: [] };
            for (const item of items) {
              const intervals = intervalsByCompany.get(v.companyId)?.get(item.id) as PlanIntervals;
              const data = {
                intervalKm: intervals.intervalKm?.toString() ?? null,
                intervalMonths: intervals.intervalMonths,
                intervalDays: intervals.intervalDays,
                noticeKm: intervals.noticeKm?.toString() ?? null,
                noticeDays: intervals.noticeDays,
              };
              const existing = existingByKey.get(`${v.id}:${item.maintenanceTypeId}`);
              if (existing) {
                if (choice === 'IGNORER') {
                  r.ignored.push(item.maintenanceType.label);
                  continue;
                }
                // Mise à jour versionnée (verrou optimiste sur la version lue) et auditée plan par plan.
                const updated = await tx.vehicleMaintenancePlan.update({
                  where: { id: existing.id, version: existing.version, active: true },
                  data: { ...data, templateId: template.id, ...(dto.acceptedSources ? { acceptedSources: dto.acceptedSources } : {}), version: { increment: 1 } },
                });
                await this.audit.record(
                  ctx,
                  {
                    action: 'plan_entretien.modification',
                    objectType: 'VehicleMaintenancePlan',
                    objectId: existing.id,
                    companyId: existing.companyId,
                    reason,
                    before: planIntervalsView(existing),
                    after: { ...planIntervalsView(updated), templateId: template.id, version: updated.version },
                  },
                  tx,
                );
                touchedPlans.push(updated);
                r.updated.push(item.maintenanceType.label);
                continue;
              }
              const plan = await tx.vehicleMaintenancePlan.create({
                data: {
                  organizationId: ctx.organizationId,
                  companyId: v.companyId,
                  vehicleId: v.id,
                  maintenanceTypeId: item.maintenanceTypeId,
                  ...data,
                  baseMode: 'AUCUNE',
                  acceptedSources: dto.acceptedSources ?? 'TOUTES',
                  templateId: template.id,
                  createdById: ctx.userId,
                },
              });
              touchedPlans.push(plan);
              createdIds.add(plan.id);
              r.created.push(item.maintenanceType.label);
            }
            results.push(r);
          }
          // Recalcul en lot des échéances et statuts depuis les opérations validées de chaque véhicule.
          await this.plans.recomputePlans(tx, touchedPlans);
          const afterRows = touchedPlans.length > 0 ? await tx.vehicleMaintenancePlan.findMany({ where: { id: { in: touchedPlans.map((p) => p.id) } }, include: impactInclude }) : [];
          const afterById = new Map((await this.plans.views(afterRows, tx)).map((v) => [v.id, v]));
          // Impact plan par plan (17.1) : échéances futures recalculées, bases et historique inchangés.
          const planImpacts: TemplatePlanImpactDto[] = touchedPlans.map((p) => {
            const after = afterById.get(p.id) as PlanViewDto;
            const before = beforeViews.get(p.id);
            const created = createdIds.has(p.id);
            return {
              planId: created && preview ? null : p.id,
              vehicleId: after.vehicleId,
              vehicleCode: after.vehicleCode,
              maintenanceTypeLabel: after.maintenanceTypeLabel,
              action: created ? 'CREATION' : 'MISE_A_JOUR',
              planVersion: created ? null : (versionBefore.get(p.id) ?? null),
              before: before && !created ? impactState(before) : null,
              after: impactState(after),
            };
          });
          if (preview) throw new TemplatePreviewRollback(planImpacts);
          touched.push(...touchedPlans.map((p) => p.id));
          await this.audit.record(ctx, { action: 'modele_entretien.application', objectType: 'MaintenancePlanTemplate', objectId: template.id, after: { onExisting, perVehicle: Object.fromEntries(choices), archivedSkipped, results } }, tx);
          return planImpacts;
        },
        { timeout: 60_000 },
      );
    } catch (error) {
      // Prévisualisation : transaction annulée, aucun effet persistant (ni plan, ni audit, ni alerte).
      if (error instanceof TemplatePreviewRollback) return { templateId: template.id, vehicles: results, archivedSkipped, preview: true, impacts: error.impacts };
      if (isUniqueViolation(error, 'maintenance_plan_one_active_per_type')) throw new ConflictError('PLAN_EXISTANT', 'Un plan actif a été créé en parallèle pour l’une de ces opérations ; relancez l’application.');
      throw error;
    }
    for (const planId of touched) await this.plans.syncAlerts(planId);
    return { templateId: template.id, vehicles: results, archivedSkipped, preview: false, impacts };
  }

  private async loadTemplate(ctx: RequestContext, id: string): Promise<TemplateRow> {
    this.access.requireStaff(ctx);
    const t = await this.prisma.client.maintenancePlanTemplate.findFirst({ where: { id, organizationId: ctx.organizationId }, include: templateInclude });
    if (!t) throw new NotFoundOrOutOfScopeError('Modèle de plan');
    return t;
  }

  /**
   * Lignes d'un modèle : opération présente une fois, connue du catalogue et active — sauf ligne
   * inchangée d'un modèle existant (même opération, mêmes intervalles et préavis) dont l'opération a été
   * archivée depuis. Toutes les erreurs sont renvoyées par ligne (items.N.champ), 422.
   */
  private async validateItems(ctx: RequestContext, items: TemplateItemDto[], currentItems: TemplateRow['items']): Promise<ValidItem[]> {
    const typeIds = items.map((i) => i.maintenanceTypeId);
    const fieldErrors: FieldErrors = {};
    const seen = new Map<string, number>();
    items.forEach((item, index) => {
      if (seen.has(item.maintenanceTypeId)) (fieldErrors[`items.${index}.maintenanceTypeId`] ??= []).push(`Opération déjà présente à la ligne ${(seen.get(item.maintenanceTypeId) as number) + 1}.`);
      else seen.set(item.maintenanceTypeId, index);
    });
    if (Object.keys(fieldErrors).length > 0) throw new BusinessRuleError('TYPE_EN_DOUBLE', 'Une opération ne peut figurer qu’une fois dans un modèle.', { fieldErrors });
    const types = await this.prisma.client.maintenanceType.findMany({ where: { id: { in: typeIds }, organizationId: ctx.organizationId }, select: { id: true, label: true, status: true } });
    const typeById = new Map(types.map((t) => [t.id, t]));
    if (typeIds.some((typeId) => !typeById.has(typeId))) throw new NotFoundOrOutOfScopeError('Type d’opération');
    const currentByType = new Map(currentItems.map((i) => [i.maintenanceTypeId, i]));
    const archived: Array<{ index: number; maintenanceTypeId: string; label: string }> = [];
    items.forEach((item, index) => {
      const type = typeById.get(item.maintenanceTypeId) as { id: string; label: string; status: string };
      if (type.status === 'ACTIF') return;
      const current = currentByType.get(item.maintenanceTypeId);
      if (current && sameItem(current, item)) return;
      archived.push({ index, maintenanceTypeId: type.id, label: type.label });
      (fieldErrors[`items.${index}.maintenanceTypeId`] ??= []).push(`Opération « ${type.label} » archivée au catalogue : retirez cette ligne, rétablissez-la telle quelle ou réactivez l’opération.`);
    });
    if (archived.length > 0) {
      const lines = archived.map((a) => `ligne ${a.index + 1} (${a.label})`).join(', ');
      throw new BusinessRuleError('TYPE_ARCHIVE', `Opération archivée au catalogue : ${lines}.`, { fieldErrors, details: { items: archived } });
    }
    // Les préavis restent ceux saisis ; à défaut, les paramètres s'appliquent à la copie.
    const defaults = await this.plans.noticeDefaults(ctx.organizationId, null);
    const out: ValidItem[] = [];
    let firstError: IntervalsError | null = null;
    items.forEach((item, index) => {
      const r = this.plans.resolveIntervals(item, defaults, `items.${index}.`);
      if (r.errors.length > 0) {
        firstError ??= r.errors[0] as IntervalsError;
        for (const [field, messages] of Object.entries(r.fieldErrors)) (fieldErrors[field] ??= []).push(...messages);
        return;
      }
      out.push({
        maintenanceTypeId: item.maintenanceTypeId,
        intervalKm: r.intervals.intervalKm?.toString() ?? null,
        intervalMonths: r.intervals.intervalMonths,
        intervalDays: r.intervals.intervalDays,
        noticeKm: item.noticeKm ?? null,
        noticeDays: item.noticeDays ?? null,
      });
    });
    if (firstError !== null) throw new BusinessRuleError(firstError, `Intervalles invalides : ${intervalMessage(firstError)}`, { fieldErrors });
    return out;
  }
}

/** Ligne inchangée : même opération, mêmes intervalles et préavis (valeurs saisies, null = défaut). */
function sameItem(current: MaintenancePlanTemplateItem, item: TemplateItemDto): boolean {
  const sameDec = (a: { toString(): string } | null, b: string | null | undefined) => (a === null || b === null || b === undefined ? a === null && (b === null || b === undefined) : new Decimal(a.toString()).eq(b));
  return (
    sameDec(current.intervalKm, item.intervalKm) &&
    current.intervalMonths === (item.intervalMonths ?? null) &&
    current.intervalDays === (item.intervalDays ?? null) &&
    sameDec(current.noticeKm, item.noticeKm) &&
    current.noticeDays === (item.noticeDays ?? null)
  );
}

function planIntervalsView(p: VehicleMaintenancePlan): Record<string, unknown> {
  return { intervalKm: p.intervalKm?.toString() ?? null, intervalMonths: p.intervalMonths, intervalDays: p.intervalDays, noticeKm: p.noticeKm?.toString() ?? null, noticeDays: p.noticeDays, acceptedSources: p.acceptedSources };
}

function impactState(v: PlanViewDto): PlanImpactStateDto {
  return {
    intervalKm: v.intervalKm,
    intervalMonths: v.intervalMonths,
    intervalDays: v.intervalDays,
    noticeKm: v.noticeKm,
    noticeDays: v.noticeDays,
    nextDueKm: v.nextDueKm,
    nextDueDate: v.nextDueDate,
    status: v.status,
    remainingKm: v.remainingKm,
    remainingDays: v.remainingDays,
  };
}

function typeView(t: MaintenanceType): MaintenanceTypeViewDto {
  return { id: t.id, code: t.code, label: t.label, description: t.description, status: t.status, version: t.version };
}

function templateView(t: TemplateRow): TemplateViewDto {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    status: t.status,
    version: t.version,
    items: t.items.map((i) => ({
      id: i.id,
      maintenanceTypeId: i.maintenanceTypeId,
      maintenanceTypeLabel: i.maintenanceType.label,
      maintenanceTypeStatus: i.maintenanceType.status,
      intervalKm: truncatedKm(i.intervalKm === null ? null : new Decimal(i.intervalKm.toString())),
      intervalMonths: i.intervalMonths,
      intervalDays: i.intervalDays,
      noticeKm: truncatedKm(i.noticeKm === null ? null : new Decimal(i.noticeKm.toString())),
      noticeDays: i.noticeDays,
    })),
  };
}
