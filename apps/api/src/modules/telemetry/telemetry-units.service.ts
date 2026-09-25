import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, SyncTrigger, TelemetryProviderKind } from '@parc-auto/db';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, ConflictError, ForbiddenActionError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import { type Page, pageOf, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import { describeErrorSafely } from '../../common/secret-redaction.js';
import { normalizeRegistration } from '../../domain/registration.js';
import { proposeMappings } from '../../domain/telemetry/unit-matching.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, isConstraintViolation, isUniqueViolation, type Tx } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { MANAGER_ROLES } from '../access-control/permissions.js';
import type {
  CloseMappingDto,
  CloseMappingResultDto,
  ConfirmMappingDto,
  CreateMappingDto,
  DiscoveredUnitDto,
  DiscoveryResultDto,
  IgnoreUnitDto,
  MappingViewDto,
  MappingsQueryDto,
  RejectMappingDto,
  SyncRunViewDto,
  SyncRunsQueryDto,
  UnignoreUnitDto,
  UnitRowDto,
  UnitViewDto,
  UnitsPageDto,
  UnitsQueryDto,
  UnmappedReason,
} from './dto/telemetry.dto.js';
import { TelemetryAdapterRegistry } from './telemetry-adapter.registry.js';
import { F11_ALERT_TYPES, MAPPING_ALERT_OBJECT, TelemetryAlertsService, UNIT_ALERT_OBJECT } from './telemetry-alerts.service.js';
import { ProviderError, type ProviderUnit, type TelemetryProvider } from './telemetry-provider.interface.js';
import { TelemetryProvidersService, providerErrorMessage, providerFailure, withDeadline } from './telemetry-providers.service.js';
import { PROVIDER_TIMEOUT_MS } from './telemetry-settings.js';

const DAY_MS = 86_400_000;
const OPEN_MAPPING: Prisma.TelemetryVehicleMappingWhereInput = { OR: [{ status: 'PROPOSE' }, { status: 'CONFIRME', validTo: null }] };

const mappingInclude = {
  provider: { select: { id: true, name: true, kind: true } },
  unit: { select: { id: true, externalId: true, label: true, declaredRegistration: true } },
  vehicle: { select: { id: true, code: true, registration: true, companyId: true, lifecycleStatus: true } },
} satisfies Prisma.TelemetryVehicleMappingInclude;
type MappingRow = Prisma.TelemetryVehicleMappingGetPayload<{ include: typeof mappingInclude }>;

const unitInclude = { provider: { select: { id: true, name: true, kind: true } } } satisfies Prisma.TelemetryUnitInclude;
type UnitRow = Prisma.TelemetryUnitGetPayload<{ include: typeof unitInclude }>;

/** Fournisseur tel que la découverte en a besoin (ligne Prisma avec sociétés couvertes). */
export interface DiscoveryProvider {
  id: string;
  organizationId: string;
  name: string;
  kind: TelemetryProviderKind;
  baseUrl: string | null;
  settings: Prisma.JsonValue;
  companies: Array<{ companyId: string }>;
}

interface UnitOutcome {
  outcome: 'PROPOSEE' | 'ASSOCIEE' | 'NON_ASSOCIEE';
  mappingId: string | null;
  vehicleId: string | null;
  reason: UnmappedReason | null;
  /** Proposition possible et non encore créée (découverte : créée ; lecture : « à réexaminer »). */
  proposable: { vehicleId: string; companyId: string; code: string; registration: string } | null;
}

/**
 * Unités des fournisseurs et associations unité ↔ véhicule (CDC 14.5 ; D-175, D-186, D-249, D-300 à
 * D-302 ; T35). La découverte liste les unités chez le fournisseur et propose un rapprochement par
 * immatriculation normalisée ; le chef confirme chaque association (date d'effet, nature du kilométrage
 * et du carburant) : aucune donnée n'est ingérée avant confirmation. Un changement de boîtier clôt
 * l'association et en ouvre une nouvelle sans jamais toucher au kilométrage cumulé.
 */
@Injectable()
export class TelemetryUnitsService {
  private readonly logger = new Logger('Telemetrie');

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly providers: TelemetryProvidersService,
    private readonly registry: TelemetryAdapterRegistry,
    private readonly telemetryAlerts: TelemetryAlertsService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------------------------------
  // Découverte des unités
  // ------------------------------------------------------------------------------------------

  /** POST /telemetry/providers/:id/discover : administrateur, ou chef d'une société couverte (fournisseur actif). */
  async discover(ctx: RequestContext, providerId: string): Promise<DiscoveryResultDto> {
    const provider = await this.providers.loadVisible(ctx, providerId);
    let scopeCompanyIds: string[] | null = null;
    if (ctx.isAdmin) {
      if (provider.status !== 'BROUILLON' && provider.status !== 'ACTIF') throw new BusinessRuleError('FOURNISSEUR_INACTIF', 'Découverte impossible : le fournisseur est suspendu ou désactivé.');
    } else {
      const managed = this.access.companiesWithRole(ctx, MANAGER_ROLES).filter((c) => provider.companies.some((pc) => pc.companyId === c));
      if (managed.length === 0) throw new ForbiddenActionError('Découverte réservée à l’administrateur ou au chef de parc d’une société couverte.');
      if (provider.status !== 'ACTIF') throw new BusinessRuleError('FOURNISSEUR_INACTIF', 'Découverte impossible : le fournisseur n’est pas actif.');
      // Aucun appel externe pour une société où le module n'est pas activé (17.1, D-295).
      const enabled = await this.prisma.client.company.count({ where: { organizationId: ctx.organizationId, id: { in: managed }, telemetryEnabled: true } });
      if (enabled === 0) throw new BusinessRuleError('TELEMETRIE_DESACTIVEE', 'Le module télématique n’est activé pour aucune de vos sociétés couvertes par ce fournisseur.');
      scopeCompanyIds = managed;
    }
    return this.runDiscovery(provider, { ctx, scopeCompanyIds, trigger: 'MANUEL' });
  }

  /**
   * Découverte (API ou worker) : listUnits réel via l'adaptateur, mise à jour des unités et de leur
   * présence chez le fournisseur, propositions PROPOSE pour les véhicules ACTIF des sociétés couvertes
   * où le module est activé (et dans le périmètre de l'appelant). Aucun échantillon ni relevé n'est
   * enregistré. Chaque exécution est tracée (TelemetrySyncRun).
   */
  async runDiscovery(provider: DiscoveryProvider, options: { ctx: RequestContext | null; scopeCompanyIds: string[] | null; trigger: SyncTrigger }): Promise<DiscoveryResultDto> {
    const opened = await this.openDiscoveryRun(provider, options);
    let listed: ProviderUnit[];
    let partialList: boolean;
    try {
      ({ listed, partialList } = await this.registry.withAdapter(
        provider,
        async (adapter) => ({ listed: await withDeadline(adapter.listUnits(), PROVIDER_TIMEOUT_MS * 4), partialList: adapter.partialUnitList === true }),
        { syncRunId: opened.runId },
      ));
    } catch (error) {
      await opened.fail(error instanceof ProviderError ? providerErrorMessage(error) : describeErrorSafely(error));
      if (error instanceof ProviderError) throw providerFailure(error, 'Découverte des unités impossible', { syncRunId: opened.runId });
      throw error;
    }
    return this.applyListing(provider, options, opened, listed, partialList);
  }

  /**
   * Canal à liste partielle (RAPPORT, D-296) : pendant une synchronisation, les unités lues par l'adaptateur
   * de ce run sont enregistrées AVANT l'acquittement des fichiers. Sinon une unité présente seulement dans
   * des fichiers déjà acquittés ne serait jamais proposée à l'association. Un échec est tracé sans
   * interrompre la synchronisation.
   */
  async recordListingFromAdapter(provider: DiscoveryProvider, adapter: TelemetryProvider): Promise<DiscoveryResultDto | null> {
    const options = { ctx: null, scopeCompanyIds: null, trigger: 'PLANIFIE' as const };
    const opened = await this.openDiscoveryRun(provider, options);
    let listed: ProviderUnit[];
    try {
      listed = await withDeadline(adapter.listUnits(), PROVIDER_TIMEOUT_MS * 4);
    } catch (error) {
      await opened.fail(error instanceof ProviderError ? providerErrorMessage(error) : describeErrorSafely(error));
      return null;
    }
    try {
      return await this.applyListing(provider, options, opened, listed, adapter.partialUnitList === true);
    } catch (error) {
      this.logger.warn(`Enregistrement des unités lues en synchronisation en échec — fournisseur ${provider.id} : ${describeErrorSafely(error)}`);
      return null;
    }
  }

  private async openDiscoveryRun(provider: DiscoveryProvider, options: { ctx: RequestContext | null; trigger: SyncTrigger }): Promise<{ runId: string; startedAt: Date; fail: (summary: string) => Promise<void> }> {
    const startedAt = this.clock.now();
    const run = await this.prisma.client.telemetrySyncRun.create({
      data: { organizationId: provider.organizationId, providerId: provider.id, companyId: null, trigger: options.trigger, status: 'EN_COURS', startedAt, requestedById: options.ctx?.userId ?? null },
    });
    const fail = async (summary: string) => {
      const finishedAt = this.clock.now();
      await this.prisma.client.telemetrySyncRun.update({
        where: { id: run.id },
        data: { status: 'ECHEC', finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(), errorCount: 1, errorSummary: summary },
      });
      this.logger.warn(`Découverte des unités en échec — fournisseur ${provider.id} (${provider.kind}) : ${summary}`);
    };
    return { runId: run.id, startedAt, fail };
  }

  /** Enregistre une liste d'unités (création, présence, propositions) et clôt le run de découverte. */
  private async applyListing(
    provider: DiscoveryProvider,
    options: { ctx: RequestContext | null; scopeCompanyIds: string[] | null },
    opened: { runId: string; startedAt: Date; fail: (summary: string) => Promise<void> },
    listed: ProviderUnit[],
    partialList: boolean,
  ): Promise<DiscoveryResultDto> {
    const { ctx } = options;
    const run = { id: opened.runId };
    const startedAt = opened.startedAt;
    const fail = opened.fail;
    const valid = new Map<string, ProviderUnit>();
    let rejectedUnits = 0;
    for (const u of listed) {
      const externalId = typeof u.externalId === 'string' ? u.externalId.trim() : '';
      if (externalId.length === 0 || externalId.length > 200 || valid.has(externalId)) {
        rejectedUnits += 1;
        continue;
      }
      const label = (typeof u.label === 'string' ? u.label.trim() : '').slice(0, 200) || externalId;
      const declared = typeof u.declaredRegistration === 'string' && u.declaredRegistration.trim().length > 0 ? u.declaredRegistration.trim().slice(0, 50) : null;
      valid.set(externalId, { externalId, label, declaredRegistration: declared, odometerKinds: [...(u.odometerKinds ?? [])], fuelKinds: [...(u.fuelKinds ?? [])] });
    }

    try {
      const now = this.clock.now();
      const outcome = await this.prisma.transaction(async (tx) => {
        // Découvertes concurrentes d'un même fournisseur (API et worker) sérialisées : ni unité ni
        // proposition en double (verrou de ligne n'empêchant pas les insertions qui référencent le fournisseur).
        await tx.$queryRaw`SELECT id FROM "TelemetryProvider" WHERE id = ${provider.id}::uuid FOR NO KEY UPDATE`;
        const existing = await tx.telemetryUnit.findMany({ where: { providerId: provider.id } });
        const byExternal = new Map(existing.map((u) => [u.externalId, u]));
        let unitsCreated = 0;
        let unitsUpdated = 0;
        const unitIds = new Map<string, string>();
        for (const u of valid.values()) {
          const registrationNormalized = u.declaredRegistration ? normalizeRegistration(u.declaredRegistration) || null : null;
          const data = { label: u.label, declaredRegistration: u.declaredRegistration, registrationNormalized, lastSeenAt: now, presentAtProvider: true };
          const previous = byExternal.get(u.externalId);
          if (previous) {
            await tx.telemetryUnit.update({ where: { id: previous.id }, data });
            unitsUpdated += 1;
            unitIds.set(u.externalId, previous.id);
          } else {
            const created = await tx.telemetryUnit.create({ data: { organizationId: provider.organizationId, providerId: provider.id, externalId: u.externalId, firstSeenAt: now, ...data } });
            unitsCreated += 1;
            unitIds.set(u.externalId, created.id);
          }
        }
        // Canal RAPPORT : la liste ne reflète que les données reçues ; l'absence n'y vaut pas disparition.
        const missing = partialList ? [] : existing.filter((u) => u.presentAtProvider && !valid.has(u.externalId));
        if (missing.length > 0) await tx.telemetryUnit.updateMany({ where: { id: { in: missing.map((m) => m.id) } }, data: { presentAtProvider: false } });

        const outcomes = await this.computeOutcomes(tx, provider, options.scopeCompanyIds);
        let proposalsCreated = 0;
        for (const [unitId, o] of outcomes) {
          if (!o.proposable) continue;
          const unit = await tx.telemetryUnit.findUniqueOrThrow({ where: { id: unitId }, select: { declaredRegistration: true } });
          const created = await tx.telemetryVehicleMapping.create({
            data: {
              organizationId: provider.organizationId,
              companyId: o.proposable.companyId,
              providerId: provider.id,
              unitId,
              vehicleId: o.proposable.vehicleId,
              status: 'PROPOSE',
              proposedAt: now,
              proposalReason: `Immatriculation déclarée « ${unit.declaredRegistration ?? ''} » identique à celle du véhicule ${o.proposable.code} (${o.proposable.registration}) après normalisation.`,
            },
          });
          outcomes.set(unitId, { outcome: 'PROPOSEE', mappingId: created.id, vehicleId: o.proposable.vehicleId, reason: null, proposable: null });
          proposalsCreated += 1;
        }

        // Périmètre de l'appelant (chef) : une unité déjà proposée ou associée à un véhicule d'une autre
        // société est signalée sans identifiant de véhicule ni d'association (rien de l'autre société, T01).
        const outOfScope = new Set<string>();
        if (options.scopeCompanyIds !== null) {
          const scope = options.scopeCompanyIds;
          const vehicleIds = [...new Set([...outcomes.values()].map((o) => o.vehicleId).filter((v): v is string => v !== null))];
          const owners = vehicleIds.length > 0 ? await tx.vehicle.findMany({ where: { id: { in: vehicleIds } }, select: { id: true, companyId: true } }) : [];
          for (const v of owners) if (!scope.includes(v.companyId)) outOfScope.add(v.id);
        }
        const units: DiscoveredUnitDto[] = [];
        for (const u of valid.values()) {
          const id = unitIds.get(u.externalId) as string;
          const o = outcomes.get(id);
          const hidden = o?.vehicleId ? outOfScope.has(o.vehicleId) : false;
          units.push({
            unitId: id,
            externalId: u.externalId,
            label: u.label,
            declaredRegistration: u.declaredRegistration,
            odometerKinds: u.odometerKinds,
            fuelKinds: u.fuelKinds,
            outcome: o?.outcome ?? 'NON_ASSOCIEE',
            mappingId: hidden ? null : (o?.mappingId ?? null),
            vehicleId: hidden ? null : (o?.vehicleId ?? null),
            unmappedReason: o ? o.reason : 'INCONNUE',
          });
        }
        const finishedAt = this.clock.now();
        await tx.telemetrySyncRun.update({
          where: { id: run.id },
          data: {
            status: rejectedUnits > 0 ? 'PARTIEL' : 'SUCCES',
            finishedAt,
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            unitsSeen: valid.size,
            errorCount: rejectedUnits,
            errorSummary: rejectedUnits > 0 ? `${rejectedUnits} unité(s) écartée(s) : identifiant absent, trop long ou en double.` : null,
          },
        });
        const result: DiscoveryResultDto = {
          syncRunId: run.id,
          unitsSeen: valid.size,
          unitsCreated,
          unitsUpdated,
          unitsMissing: missing.length,
          proposalsCreated,
          proposalsPending: units.filter((u) => u.outcome === 'PROPOSEE').length,
          unmapped: units.filter((u) => u.outcome === 'NON_ASSOCIEE' && u.unmappedReason !== 'IGNOREE').length,
          ignored: units.filter((u) => u.unmappedReason === 'IGNOREE').length,
          rejectedUnits,
          units,
        };
        const entry = {
          action: 'telemetrie.unites.decouverte',
          objectType: 'TelemetryProvider',
          objectId: provider.id,
          after: { syncRunId: run.id, unitsSeen: result.unitsSeen, unitsCreated, unitsUpdated, unitsMissing: result.unitsMissing, proposalsCreated, unmapped: result.unmapped, ignored: result.ignored },
        };
        if (ctx) await this.audit.record(ctx, entry, tx);
        else await this.audit.recordSystem(provider.organizationId, entry, tx);
        return result;
      });
      await this.telemetryAlerts.refreshUnmappedUnitAlerts(provider.organizationId, provider.id);
      return outcome;
    } catch (error) {
      await fail(describeErrorSafely(error));
      throw error;
    }
  }

  /**
   * Situation de chaque unité présente du fournisseur : associée, proposée, proposable ou non associée
   * avec motif (D-302). Correspondance exacte et unique sur l'immatriculation normalisée, uniquement vers
   * un véhicule ACTIF d'une société couverte, où le module est activé, et dans le périmètre donné. Une
   * unité ignorée (D-249) n'entre pas dans le rapprochement : motif IGNOREE, jamais de proposition.
   */
  private async computeOutcomes(tx: Tx, provider: DiscoveryProvider, scopeCompanyIds: string[] | null, onlyUnitIds?: string[]): Promise<Map<string, UnitOutcome>> {
    const covered = provider.companies.map((c) => c.companyId).filter((c) => scopeCompanyIds === null || scopeCompanyIds.includes(c));
    const eligibleCompanies = covered.length
      ? await tx.company.findMany({ where: { organizationId: provider.organizationId, id: { in: covered }, telemetryEnabled: true, status: 'ACTIF' }, select: { id: true } })
      : [];
    const vehicles = eligibleCompanies.length
      ? await tx.vehicle.findMany({
          where: { organizationId: provider.organizationId, lifecycleStatus: 'ACTIF', companyId: { in: eligibleCompanies.map((c) => c.id) } },
          select: { id: true, code: true, registration: true, companyId: true },
        })
      : [];
    const units = await tx.telemetryUnit.findMany({
      where: { providerId: provider.id, presentAtProvider: true },
      select: {
        id: true,
        label: true,
        declaredRegistration: true,
        registrationNormalized: true,
        ignoredAt: true,
        mappings: { where: { OR: [...(OPEN_MAPPING.OR ?? []), { status: 'REJETE' }] }, select: { id: true, status: true, validTo: true, vehicleId: true } },
      },
    });
    const matching = proposeMappings(
      units.filter((u) => u.ignoredAt === null).map((u) => ({ unitId: u.id, label: u.label, declaredRegistration: u.declaredRegistration })),
      vehicles.map((v) => ({ vehicleId: v.id, registration: v.registration })),
    );
    const proposalByUnit = new Map(matching.proposals.map((p) => [p.unitId, p]));
    const ambiguous = new Set(matching.ambiguousUnitIds);
    const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
    const vehicleOpen = await tx.telemetryVehicleMapping.findMany({ where: { vehicleId: { in: vehicles.map((v) => v.id) }, ...OPEN_MAPPING }, select: { vehicleId: true, status: true, unitId: true } });
    const equipped = new Set(vehicleOpen.filter((m) => m.status === 'CONFIRME').map((m) => m.vehicleId));
    const pendingByVehicle = new Map(vehicleOpen.filter((m) => m.status === 'PROPOSE').map((m) => [m.vehicleId, m.unitId]));
    const unmatchedNormalized = units
      .filter((u) => u.ignoredAt === null && !proposalByUnit.has(u.id) && !ambiguous.has(u.id) && u.registrationNormalized)
      .map((u) => u.registrationNormalized as string);
    const orgMatches = new Set(
      unmatchedNormalized.length
        ? (await tx.vehicle.findMany({ where: { organizationId: provider.organizationId, registrationNormalized: { in: unmatchedNormalized } }, select: { registrationNormalized: true } })).map((v) => v.registrationNormalized)
        : [],
    );

    const outcomes = new Map<string, UnitOutcome>();
    for (const u of units) {
      if (onlyUnitIds && !onlyUnitIds.includes(u.id)) continue;
      const confirmed = u.mappings.find((m) => m.status === 'CONFIRME' && m.validTo === null);
      const proposed = u.mappings.find((m) => m.status === 'PROPOSE');
      if (confirmed) {
        outcomes.set(u.id, { outcome: 'ASSOCIEE', mappingId: confirmed.id, vehicleId: confirmed.vehicleId, reason: null, proposable: null });
        continue;
      }
      if (proposed) {
        outcomes.set(u.id, { outcome: 'PROPOSEE', mappingId: proposed.id, vehicleId: proposed.vehicleId, reason: null, proposable: null });
        continue;
      }
      const unmapped = (reason: UnmappedReason) => outcomes.set(u.id, { outcome: 'NON_ASSOCIEE', mappingId: null, vehicleId: null, reason, proposable: null });
      if (u.ignoredAt !== null) {
        unmapped('IGNOREE');
        continue;
      }
      const proposal = proposalByUnit.get(u.id);
      if (proposal) {
        const vehicle = vehicleById.get(proposal.vehicleId);
        const pendingUnit = pendingByVehicle.get(proposal.vehicleId);
        if (!vehicle) unmapped('INCONNUE');
        else if (equipped.has(proposal.vehicleId)) unmapped('VEHICULE_DEJA_EQUIPE');
        else if (u.mappings.some((m) => m.status === 'REJETE' && m.vehicleId === proposal.vehicleId)) unmapped('PROPOSITION_REJETEE');
        else if (pendingUnit !== undefined && pendingUnit !== u.id) unmapped('AMBIGUE');
        else outcomes.set(u.id, { outcome: 'NON_ASSOCIEE', mappingId: null, vehicleId: null, reason: 'A_REEXAMINER', proposable: { vehicleId: vehicle.id, companyId: vehicle.companyId, code: vehicle.code, registration: vehicle.registration } });
      } else if (ambiguous.has(u.id)) unmapped('AMBIGUE');
      else if (!u.registrationNormalized) unmapped('IMMATRICULATION_ABSENTE');
      else if (scopeCompanyIds === null && orgMatches.has(u.registrationNormalized)) unmapped('VEHICULE_NON_ELIGIBLE');
      else unmapped('INCONNUE');
    }
    return outcomes;
  }

  // ------------------------------------------------------------------------------------------
  // Lecture : unités non associées, propositions, associations, véhicules sans unité
  // ------------------------------------------------------------------------------------------

  /** Onglet « Associations » : unités non associées, propositions, associations, véhicules sans unité, unités ignorées (D-249). */
  async listUnits(ctx: RequestContext, query: UnitsQueryDto): Promise<UnitsPageDto> {
    const scope = this.providers.readScope(ctx, query.companyId);
    const provider = query.providerId ? await this.providers.loadVisible(ctx, query.providerId) : null;
    const providerWhere: Prisma.TelemetryProviderWhereInput = {
      organizationId: ctx.organizationId,
      ...(provider ? { id: provider.id } : {}),
      ...(scope ? { companies: { some: { companyId: { in: scope } } } } : {}),
    };
    const vehicleScope: Prisma.VehicleWhereInput = scope ? { companyId: { in: scope } } : {};
    const coveredByProvider = provider ? provider.companies.map((c) => c.companyId) : null;
    const text = query.q?.trim();
    const unitText: Prisma.TelemetryUnitWhereInput = text
      ? { OR: [{ label: { contains: text, mode: 'insensitive' } }, { externalId: { contains: text, mode: 'insensitive' } }, { registrationNormalized: { contains: normalizeRegistration(text) } }] }
      : {};
    const unmappedWhere: Prisma.TelemetryUnitWhereInput = {
      organizationId: ctx.organizationId,
      presentAtProvider: true,
      // Les unités d'un fournisseur désactivé ne sont plus associables : elles ne sont plus « à associer ».
      provider: { ...providerWhere, status: { not: 'DESACTIVE' } },
      mappings: { none: OPEN_MAPPING },
      // Une unité ignorée (D-249) n'est plus « à associer » : elle figure dans la catégorie IGNOREES.
      ignoredAt: null,
      ...unitText,
    };
    // Unités ignorées, présentes ou non chez le fournisseur (l'état persiste jusqu'à la reprise).
    const ignoredWhere: Prisma.TelemetryUnitWhereInput = {
      organizationId: ctx.organizationId,
      provider: { ...providerWhere, status: { not: 'DESACTIVE' } },
      ignoredAt: { not: null },
      ...unitText,
    };
    const mappingWhere = (status: 'PROPOSE' | 'CONFIRME'): Prisma.TelemetryVehicleMappingWhereInput => ({
      organizationId: ctx.organizationId,
      status,
      ...(status === 'CONFIRME' ? { validTo: null } : {}),
      ...(provider ? { providerId: provider.id } : {}),
      vehicle: { ...vehicleScope, ...(text ? { OR: [{ code: { contains: text, mode: 'insensitive' } }, { registrationNormalized: { contains: normalizeRegistration(text) } }] } : {}) },
    });
    const companyFilter = scope && coveredByProvider ? scope.filter((c) => coveredByProvider.includes(c)) : (scope ?? coveredByProvider);
    const withoutUnitWhere: Prisma.VehicleWhereInput = {
      organizationId: ctx.organizationId,
      lifecycleStatus: 'ACTIF',
      company: { telemetryEnabled: true },
      ...(companyFilter ? { companyId: { in: companyFilter } } : {}),
      telemetryMappings: { none: { status: 'CONFIRME', validTo: null } },
      ...(text ? { OR: [{ code: { contains: text, mode: 'insensitive' } }, { registrationNormalized: { contains: normalizeRegistration(text) } }] } : {}),
    };

    const [nonAssociees, proposees, associees, vehiculesSansUnite, ignorees] = await Promise.all([
      this.prisma.client.telemetryUnit.count({ where: unmappedWhere }),
      this.prisma.client.telemetryVehicleMapping.count({ where: mappingWhere('PROPOSE') }),
      this.prisma.client.telemetryVehicleMapping.count({ where: mappingWhere('CONFIRME') }),
      this.prisma.client.vehicle.count({ where: withoutUnitWhere }),
      this.prisma.client.telemetryUnit.count({ where: ignoredWhere }),
    ]);
    const counts = { nonAssociees, proposees, associees, vehiculesSansUnite, ignorees };
    let items: UnitRowDto[] = [];
    let total = 0;
    switch (query.category) {
      case 'NON_ASSOCIEES': {
        const rows = await this.prisma.client.telemetryUnit.findMany({ where: unmappedWhere, include: unitInclude, orderBy: [{ label: 'asc' }, { id: 'asc' }], ...skipTake(query) });
        const reasons = await this.unmappedReasons(ctx, rows, scope);
        items = rows.map((u) => ({ category: 'NON_ASSOCIEES', unit: unitView(u), mapping: null, vehicle: null, unmappedReason: reasons.get(u.id) ?? 'INCONNUE' }));
        total = nonAssociees;
        break;
      }
      case 'PROPOSEES':
      case 'ASSOCIEES': {
        const status = query.category === 'PROPOSEES' ? 'PROPOSE' : 'CONFIRME';
        const rows = await this.prisma.client.telemetryVehicleMapping.findMany({ where: mappingWhere(status), include: mappingInclude, orderBy: [{ proposedAt: 'desc' }, { id: 'asc' }], ...skipTake(query) });
        const units = await this.prisma.client.telemetryUnit.findMany({ where: { id: { in: rows.map((r) => r.unitId) } }, include: unitInclude });
        items = rows.map((m) => {
          const unit = units.find((u) => u.id === m.unitId);
          return { category: query.category, unit: unit ? unitView(unit) : null, mapping: mappingView(m), vehicle: vehicleRef(m.vehicle), unmappedReason: null };
        });
        total = status === 'PROPOSE' ? proposees : associees;
        break;
      }
      case 'VEHICULES_SANS_UNITE': {
        const rows = await this.prisma.client.vehicle.findMany({
          where: withoutUnitWhere,
          select: { id: true, code: true, registration: true, companyId: true, lifecycleStatus: true },
          orderBy: [{ code: 'asc' }],
          ...skipTake(query),
        });
        items = rows.map((v) => ({ category: 'VEHICULES_SANS_UNITE', unit: null, mapping: null, vehicle: vehicleRef(v), unmappedReason: null }));
        total = vehiculesSansUnite;
        break;
      }
      case 'IGNOREES': {
        const rows = await this.prisma.client.telemetryUnit.findMany({ where: ignoredWhere, include: unitInclude, orderBy: [{ ignoredAt: 'desc' }, { id: 'asc' }], ...skipTake(query) });
        items = rows.map((u) => ({ category: 'IGNOREES', unit: unitView(u), mapping: null, vehicle: null, unmappedReason: 'IGNOREE' }));
        total = ignorees;
        break;
      }
    }
    return { items, total, page: query.page, pageSize: query.pageSize, counts };
  }

  private async unmappedReasons(ctx: RequestContext, rows: UnitRow[], scope: string[] | null): Promise<Map<string, UnmappedReason>> {
    const reasons = new Map<string, UnmappedReason>();
    const byProvider = new Map<string, string[]>();
    for (const u of rows) byProvider.set(u.providerId, [...(byProvider.get(u.providerId) ?? []), u.id]);
    for (const [providerId, unitIds] of byProvider) {
      const provider = await this.prisma.client.telemetryProvider.findFirstOrThrow({ where: { id: providerId, organizationId: ctx.organizationId }, include: { companies: { select: { companyId: true } } } });
      const managedScope = ctx.isAdmin ? null : (scope ?? []);
      const outcomes = await this.computeOutcomes(this.prisma.client, provider, managedScope, unitIds);
      for (const [unitId, o] of outcomes) reasons.set(unitId, o.reason ?? 'INCONNUE');
    }
    return reasons;
  }

  async listMappings(ctx: RequestContext, query: MappingsQueryDto): Promise<Page<MappingViewDto>> {
    const scope = this.providers.readScope(ctx, query.companyId);
    const where: Prisma.TelemetryVehicleMappingWhereInput = {
      organizationId: ctx.organizationId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.providerId ? { providerId: query.providerId } : {}),
      ...(query.vehicleId ? { vehicleId: query.vehicleId } : {}),
      ...(query.unitId ? { unitId: query.unitId } : {}),
      ...(scope ? { vehicle: { companyId: { in: scope } } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.client.telemetryVehicleMapping.findMany({ where, include: mappingInclude, orderBy: [{ proposedAt: 'desc' }, { id: 'asc' }], ...skipTake(query) }),
      this.prisma.client.telemetryVehicleMapping.count({ where }),
    ]);
    return pageOf(rows.map(mappingView), total, query);
  }

  async getMapping(ctx: RequestContext, id: string): Promise<MappingViewDto> {
    return mappingView(await this.loadMapping(ctx, id));
  }

  // ------------------------------------------------------------------------------------------
  // Décisions du chef : association manuelle, confirmation, rejet, clôture / changement de boîtier
  // ------------------------------------------------------------------------------------------

  async createMapping(ctx: RequestContext, dto: CreateMappingDto): Promise<MappingViewDto> {
    this.access.requireStaff(ctx);
    const vehicle = await this.prisma.client.vehicle.findFirst({ where: { id: dto.vehicleId, organizationId: ctx.organizationId }, select: vehicleSelect });
    if (!vehicle || !this.access.canReadCompany(ctx, vehicle.companyId)) throw new NotFoundOrOutOfScopeError('Véhicule');
    this.access.requireManager(ctx, vehicle.companyId);
    const unit = await this.loadUnitFor(ctx, dto.unitId);
    await this.assertMappable(unit, vehicle);
    await this.assertNoOpenConfirmed(unit.id, vehicle.id);
    const validFrom = await this.effectiveFrom(vehicle, unit, dto.validFrom);
    const now = this.clock.now();
    const id = await this.writeMapping(async (tx) => {
      await this.lockFollowedUnit(tx, unit.id);
      const pending = await tx.telemetryVehicleMapping.findFirst({ where: { unitId: unit.id, vehicleId: vehicle.id, status: 'PROPOSE' } });
      const decision = { status: 'CONFIRME' as const, companyId: vehicle.companyId, validFrom, odometerKind: dto.odometerKind, fuelKinds: dto.fuelKinds, decidedAt: now, decidedById: ctx.userId };
      const mapping = pending
        ? await tx.telemetryVehicleMapping.update({ where: { id: pending.id, version: pending.version }, data: { ...decision, version: { increment: 1 } } })
        : await tx.telemetryVehicleMapping.create({
            data: { organizationId: ctx.organizationId, providerId: unit.providerId, unitId: unit.id, vehicleId: vehicle.id, proposedAt: now, proposalReason: 'Association manuelle par le chef de parc.', ...decision },
          });
      await this.rejectCompetingProposals(tx, ctx, unit.id, vehicle.id, mapping.id);
      await this.audit.record(ctx, { action: 'telemetrie.association.confirmation', objectType: 'TelemetryVehicleMapping', objectId: mapping.id, companyId: vehicle.companyId, reason: 'Association manuelle.', after: decisionAudit(mapping) }, tx);
      return mapping.id;
    });
    await this.telemetryAlerts.refreshUnmappedUnitAlerts(ctx.organizationId, unit.providerId);
    return this.getMapping(ctx, id);
  }

  async confirm(ctx: RequestContext, id: string, dto: ConfirmMappingDto): Promise<MappingViewDto> {
    const mapping = await this.loadMapping(ctx, id);
    this.access.requireManager(ctx, mapping.vehicle.companyId);
    assertExpectedVersion(mapping, dto.expectedVersion, 'association');
    if (mapping.status !== 'PROPOSE') throw new BusinessRuleError('TRANSITION_INVALIDE', 'Seule une proposition peut être confirmée.');
    const unit = await this.loadUnitFor(ctx, mapping.unitId);
    const vehicle = await this.prisma.client.vehicle.findUniqueOrThrow({ where: { id: mapping.vehicleId }, select: vehicleSelect });
    await this.assertMappable(unit, vehicle);
    await this.assertNoOpenConfirmed(unit.id, vehicle.id);
    const validFrom = await this.effectiveFrom(vehicle, unit, dto.validFrom);
    const now = this.clock.now();
    await this.writeMapping(async (tx) => {
      await this.lockFollowedUnit(tx, unit.id);
      const updated = await tx.telemetryVehicleMapping.update({
        where: { id, version: dto.expectedVersion },
        data: { status: 'CONFIRME', companyId: vehicle.companyId, validFrom, odometerKind: dto.odometerKind, fuelKinds: dto.fuelKinds, decidedAt: now, decidedById: ctx.userId, version: { increment: 1 } },
      });
      await this.rejectCompetingProposals(tx, ctx, unit.id, vehicle.id, id);
      await this.audit.record(ctx, { action: 'telemetrie.association.confirmation', objectType: 'TelemetryVehicleMapping', objectId: id, companyId: vehicle.companyId, before: { status: 'PROPOSE' }, after: decisionAudit(updated) }, tx);
      return id;
    });
    await this.telemetryAlerts.refreshUnmappedUnitAlerts(ctx.organizationId, unit.providerId);
    return this.getMapping(ctx, id);
  }

  async reject(ctx: RequestContext, id: string, dto: RejectMappingDto): Promise<MappingViewDto> {
    const mapping = await this.loadMapping(ctx, id);
    this.access.requireManager(ctx, mapping.vehicle.companyId);
    assertExpectedVersion(mapping, dto.expectedVersion, 'association');
    if (mapping.status !== 'PROPOSE') throw new BusinessRuleError('TRANSITION_INVALIDE', 'Seule une proposition peut être rejetée.');
    const reason = dto.reason.trim();
    await this.prisma.client.$transaction(async (tx) => {
      await tx.telemetryVehicleMapping.update({
        where: { id, version: dto.expectedVersion },
        data: { status: 'REJETE', decidedAt: this.clock.now(), decidedById: ctx.userId, closedReason: reason, version: { increment: 1 } },
      });
      await this.audit.record(ctx, { action: 'telemetrie.association.rejet', objectType: 'TelemetryVehicleMapping', objectId: id, companyId: mapping.vehicle.companyId, reason, before: { status: 'PROPOSE' }, after: { status: 'REJETE' } }, tx);
    });
    await this.telemetryAlerts.refreshUnmappedUnitAlerts(ctx.organizationId, mapping.providerId);
    return this.getMapping(ctx, id);
  }

  /**
   * Clôture d'une association confirmée (D-300) : validTo = instant du changement, motif, audit ; avec
   * remplacement, nouvelle association confirmée dès cet instant. Le kilométrage cumulé n'est jamais
   * modifié : une valeur CAN inférieure reçue ensuite est traitée comme une anomalie par l'ingestion
   * unique (EN_ATTENTE), jamais comme un remplacement de compteur implicite.
   */
  async close(ctx: RequestContext, id: string, dto: CloseMappingDto): Promise<CloseMappingResultDto> {
    const mapping = await this.loadMapping(ctx, id);
    this.access.requireManager(ctx, mapping.vehicle.companyId);
    assertExpectedVersion(mapping, dto.expectedVersion, 'association');
    if (mapping.status !== 'CONFIRME' || mapping.validTo !== null) throw new BusinessRuleError('TRANSITION_INVALIDE', 'Seule une association confirmée en cours peut être clôturée.');
    const now = this.clock.now();
    const closedAt = dto.closedAt ? new Date(dto.closedAt) : now;
    if (closedAt.getTime() > now.getTime()) throw new BusinessRuleError('DATE_CLOTURE_FUTURE', 'La date de clôture ne peut pas être dans le futur.', { fieldErrors: { closedAt: ['Date future.'] } });
    if (mapping.validFrom && closedAt.getTime() <= mapping.validFrom.getTime()) {
      throw new BusinessRuleError('DATE_CLOTURE_INVALIDE', 'La date de clôture doit suivre la date d’effet de l’association.', { fieldErrors: { closedAt: ['Antérieure à la date d’effet.'] } });
    }
    const lastIngested = await this.prisma.client.odometerReading.findFirst({
      where: { vehicleId: mapping.vehicleId, providerId: mapping.providerId, providerUnitId: { in: [mapping.unit.externalId, mapping.unitId] } },
      orderBy: { observedAt: 'desc' },
      select: { observedAt: true },
    });
    if (lastIngested && closedAt.getTime() < lastIngested.observedAt.getTime()) {
      throw new BusinessRuleError('DATE_CLOTURE_ANTERIEURE', `La date de clôture précède le dernier relevé déjà reçu de cette unité (${lastIngested.observedAt.toISOString()}).`, {
        fieldErrors: { closedAt: ['Antérieure au dernier relevé reçu.'] },
      });
    }
    const reason = dto.reason.trim();
    const vehicle = await this.prisma.client.vehicle.findUniqueOrThrow({ where: { id: mapping.vehicleId }, select: vehicleSelect });
    let replacementUnit: UnitWithProvider | null = null;
    if (dto.replacement) {
      if (dto.replacement.unitId === mapping.unitId) throw new BusinessRuleError('UNITE_IDENTIQUE', 'La nouvelle unité doit différer de l’unité clôturée.');
      replacementUnit = await this.loadUnitFor(ctx, dto.replacement.unitId);
      await this.assertMappable(replacementUnit, vehicle);
      const unitOpen = await this.prisma.client.telemetryVehicleMapping.findFirst({ where: { unitId: replacementUnit.id, status: 'CONFIRME', validTo: null } });
      if (unitOpen) throw new ConflictError('UNITE_DEJA_ASSOCIEE', 'La nouvelle unité est déjà associée à un véhicule : clôturez d’abord cette association.');
      await this.effectiveFrom(vehicle, replacementUnit, closedAt.toISOString());
    }
    const replacementId = await this.writeMapping(async (tx) => {
      if (replacementUnit) await this.lockFollowedUnit(tx, replacementUnit.id);
      await tx.telemetryVehicleMapping.update({ where: { id, version: dto.expectedVersion }, data: { status: 'CLOTURE', validTo: closedAt, closedReason: reason, version: { increment: 1 } } });
      await this.audit.record(
        ctx,
        { action: 'telemetrie.association.cloture', objectType: 'TelemetryVehicleMapping', objectId: id, companyId: vehicle.companyId, reason, before: { status: 'CONFIRME', validTo: null }, after: { status: 'CLOTURE', validTo: closedAt, remplacement: dto.replacement?.unitId ?? null } },
        tx,
      );
      await this.telemetryAlerts.resolveObjectAlerts(ctx.organizationId, MAPPING_ALERT_OBJECT, id, 'Association unité ↔ véhicule clôturée.', tx);
      if (!dto.replacement || !replacementUnit) return null;
      const created = await tx.telemetryVehicleMapping.create({
        data: {
          organizationId: ctx.organizationId,
          companyId: vehicle.companyId,
          providerId: replacementUnit.providerId,
          unitId: replacementUnit.id,
          vehicleId: vehicle.id,
          status: 'CONFIRME',
          odometerKind: dto.replacement.odometerKind,
          fuelKinds: dto.replacement.fuelKinds,
          validFrom: closedAt,
          proposedAt: now,
          proposalReason: `Changement de boîtier : remplace l’unité « ${mapping.unit.label} » (${mapping.unit.externalId}). Kilométrage cumulé inchangé.`,
          decidedAt: now,
          decidedById: ctx.userId,
        },
      });
      await this.rejectCompetingProposals(tx, ctx, replacementUnit.id, vehicle.id, created.id);
      await this.audit.record(ctx, { action: 'telemetrie.association.remplacement', objectType: 'TelemetryVehicleMapping', objectId: created.id, companyId: vehicle.companyId, reason, after: { ...decisionAudit(created), remplace: id } }, tx);
      return created.id;
    });
    await this.telemetryAlerts.refreshUnmappedUnitAlerts(ctx.organizationId, mapping.providerId);
    if (replacementUnit && replacementUnit.providerId !== mapping.providerId) await this.telemetryAlerts.refreshUnmappedUnitAlerts(ctx.organizationId, replacementUnit.providerId);
    return { closed: await this.getMapping(ctx, id), replacement: replacementId ? await this.getMapping(ctx, replacementId) : null };
  }

  // ------------------------------------------------------------------------------------------
  // Unités ignorées (D-249) : remorque, boîtier de rechange, unité volontairement sans véhicule
  // ------------------------------------------------------------------------------------------

  /**
   * POST /telemetry/units/:id/ignore : l'unité ne reçoit plus de proposition ni d'alerte « unité non
   * associée ». L'état est porté par l'unité, car une association exige un véhicule. Refus (409) si
   * l'unité a une association confirmée en cours : il faut d'abord la clôturer. Les propositions en
   * attente sont rejetées avec le motif, l'alerte GPS_UNITE_NON_MAPPEE de l'unité est résolue.
   */
  async ignoreUnit(ctx: RequestContext, unitId: string, dto: IgnoreUnitDto): Promise<UnitViewDto> {
    const { unit, managed } = await this.loadUnitForDecision(ctx, unitId);
    const reason = dto.reason.trim();
    if (reason.length < 3) throw new BusinessRuleError('MOTIF_REQUIS', 'Indiquez un motif (3 caractères minimum).', { fieldErrors: { reason: ['Motif requis (3 caractères minimum).'] } });
    if (unit.provider.status === 'DESACTIVE') throw new BusinessRuleError('FOURNISSEUR_DESACTIVE', 'Le fournisseur de cette unité est désactivé.');
    const now = this.clock.now();
    await this.prisma.transaction(async (tx) => {
      // Sérialisé avec la découverte du fournisseur (même verrou) et avec toute association de l'unité.
      await tx.$queryRaw`SELECT id FROM "TelemetryProvider" WHERE id = ${unit.providerId}::uuid FOR NO KEY UPDATE`;
      const [locked] = await tx.$queryRaw<Array<{ ignoredAt: Date | null }>>`SELECT "ignoredAt" FROM "TelemetryUnit" WHERE id = ${unit.id}::uuid FOR UPDATE`;
      if (!locked) throw new NotFoundOrOutOfScopeError('Unité');
      if (locked.ignoredAt !== null) throw new BusinessRuleError('TRANSITION_INVALIDE', 'Cette unité est déjà ignorée.');
      const open = await tx.telemetryVehicleMapping.findMany({ where: { unitId: unit.id, ...OPEN_MAPPING }, select: { id: true, status: true, vehicle: { select: { companyId: true } } } });
      if (open.some((m) => m.status === 'CONFIRME')) {
        throw new ConflictError('UNITE_ASSOCIEE', 'Cette unité est associée à un véhicule : clôturez d’abord cette association avant de l’ignorer.');
      }
      const proposals = open.filter((m) => m.status === 'PROPOSE');
      // Le chef ne décide pas pour un véhicule d'une société qu'il ne gère pas (rien n'en est révélé).
      if (managed && proposals.some((m) => !managed.includes(m.vehicle.companyId))) {
        throw new ForbiddenActionError('Cette unité est proposée pour un véhicule hors de votre périmètre de gestion : seul l’administrateur peut l’ignorer.');
      }
      await tx.telemetryUnit.update({ where: { id: unit.id }, data: { ignoredAt: now, ignoredById: ctx.userId, ignoredReason: reason } });
      if (proposals.length > 0) {
        await tx.telemetryVehicleMapping.updateMany({
          where: { id: { in: proposals.map((m) => m.id) }, status: 'PROPOSE' },
          data: { status: 'REJETE', decidedAt: now, decidedById: ctx.userId, closedReason: `Unité ignorée : ${reason}`, version: { increment: 1 } },
        });
      }
      const resolvedAlerts = await this.telemetryAlerts.resolveUnmappedUnitAlerts(ctx.organizationId, unit.id, `Unité ignorée : ${reason}`, tx);
      await this.audit.record(
        ctx,
        {
          action: 'telemetrie.unite.ignoree',
          objectType: UNIT_ALERT_OBJECT,
          objectId: unit.id,
          reason,
          before: { ignoredAt: null },
          after: { ignoredAt: now, providerId: unit.providerId, externalId: unit.externalId, propositionsRejetees: proposals.map((m) => m.id), alertesResolues: resolvedAlerts },
        },
        tx,
      );
    });
    await this.telemetryAlerts.refreshUnmappedUnitAlerts(ctx.organizationId, unit.providerId);
    return this.unitViewById(unit.id);
  }

  /**
   * POST /telemetry/units/:id/unignore : l'unité redevient « à associer » ; l'alerte « unité non
   * associée » est relevée de nouveau si les conditions sont réunies, et la découverte suivante peut
   * de nouveau proposer une association.
   */
  async unignoreUnit(ctx: RequestContext, unitId: string, dto: UnignoreUnitDto): Promise<UnitViewDto> {
    const { unit } = await this.loadUnitForDecision(ctx, unitId);
    const reason = dto.reason?.trim() || null;
    await this.prisma.transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "TelemetryProvider" WHERE id = ${unit.providerId}::uuid FOR NO KEY UPDATE`;
      const [locked] = await tx.$queryRaw<Array<{ ignoredAt: Date | null; ignoredReason: string | null }>>`SELECT "ignoredAt", "ignoredReason" FROM "TelemetryUnit" WHERE id = ${unit.id}::uuid FOR UPDATE`;
      if (!locked) throw new NotFoundOrOutOfScopeError('Unité');
      if (locked.ignoredAt === null) throw new BusinessRuleError('TRANSITION_INVALIDE', 'Cette unité n’est pas ignorée.');
      await tx.telemetryUnit.update({ where: { id: unit.id }, data: { ignoredAt: null, ignoredById: null, ignoredReason: null } });
      await this.audit.record(
        ctx,
        {
          action: 'telemetrie.unite.reprise',
          objectType: UNIT_ALERT_OBJECT,
          objectId: unit.id,
          reason,
          before: { ignoredAt: locked.ignoredAt, ignoredReason: locked.ignoredReason },
          after: { ignoredAt: null, providerId: unit.providerId, externalId: unit.externalId },
        },
        tx,
      );
    });
    await this.telemetryAlerts.refreshUnmappedUnitAlerts(ctx.organizationId, unit.providerId);
    return this.unitViewById(unit.id);
  }

  // ------------------------------------------------------------------------------------------
  // Exécutions de synchronisation (lecture, périmètre)
  // ------------------------------------------------------------------------------------------

  async listSyncRuns(ctx: RequestContext, query: SyncRunsQueryDto): Promise<Page<SyncRunViewDto>> {
    const scope = this.providers.readScope(ctx, query.companyId);
    const where: Prisma.TelemetrySyncRunWhereInput = {
      organizationId: ctx.organizationId,
      ...(query.providerId ? { providerId: query.providerId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(scope ? { OR: [{ companyId: { in: scope } }, { companyId: null, provider: { companies: { some: { companyId: { in: scope } } } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.client.telemetrySyncRun.findMany({ where, include: { provider: { select: { name: true } } }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], ...skipTake(query) }),
      this.prisma.client.telemetrySyncRun.count({ where }),
    ]);
    return pageOf(
      rows.map((r) => ({
        id: r.id,
        providerId: r.providerId,
        providerName: r.provider.name,
        companyId: r.companyId,
        trigger: r.trigger,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        durationMs: r.durationMs,
        unitsSeen: r.unitsSeen,
        odometerSamples: r.odometerSamples,
        readingsCreated: r.readingsCreated,
        readingsPending: r.readingsPending,
        duplicatesIgnored: r.duplicatesIgnored,
        fuelSamples: r.fuelSamples,
        fuelEventsCreated: r.fuelEventsCreated,
        errorCount: r.errorCount,
        errorSummary: r.errorSummary ? describeErrorSafely(r.errorSummary) : null,
        requestedById: r.requestedById,
      })),
      total,
      query,
    );
  }

  // ------------------------------------------------------------------------------------------
  // Contrôles communs
  // ------------------------------------------------------------------------------------------

  /** Association visible : véhicule dans le périmètre de lecture (404 sinon, T01). */
  private async loadMapping(ctx: RequestContext, id: string): Promise<MappingRow> {
    const scope = this.providers.readScope(ctx);
    const row = await this.prisma.client.telemetryVehicleMapping.findFirst({ where: { id, organizationId: ctx.organizationId }, include: mappingInclude });
    if (!row || (scope && !scope.includes(row.vehicle.companyId))) throw new NotFoundOrOutOfScopeError('Association');
    return row;
  }

  /** Unité d'un fournisseur visible par l'appelant (404 sinon). */
  private async loadUnitFor(ctx: RequestContext, unitId: string): Promise<UnitWithProvider> {
    const unit = await this.prisma.client.telemetryUnit.findFirst({
      where: { id: unitId, organizationId: ctx.organizationId },
      include: { provider: { select: { id: true, name: true, kind: true, status: true, backfillDays: true, companies: { select: { companyId: true } } } } },
    });
    if (!unit) throw new NotFoundOrOutOfScopeError('Unité');
    if (!ctx.isAdmin && !unit.provider.companies.some((c) => this.access.canReadCompany(ctx, c.companyId))) throw new NotFoundOrOutOfScopeError('Unité');
    return unit;
  }

  /**
   * Décision sur une unité (ignorer, reprendre ; D-249), même règle que la découverte : administrateur,
   * ou chef de parc d'une société couverte par le fournisseur. Unité hors périmètre de lecture : 404.
   * Renvoie les sociétés couvertes gérées par le chef (null pour l'administrateur).
   */
  private async loadUnitForDecision(ctx: RequestContext, unitId: string): Promise<{ unit: UnitWithProvider; managed: string[] | null }> {
    this.access.requireStaff(ctx);
    const unit = await this.loadUnitFor(ctx, unitId);
    if (ctx.isAdmin) return { unit, managed: null };
    const managed = this.access.companiesWithRole(ctx, MANAGER_ROLES).filter((c) => unit.provider.companies.some((pc) => pc.companyId === c));
    if (managed.length === 0) throw new ForbiddenActionError('Action réservée à l’administrateur ou au chef de parc d’une société couverte par le fournisseur.');
    return { unit, managed };
  }

  /**
   * Dans la transaction d'une association : verrou partagé sur l'unité et refus si elle est ignorée.
   * Une décision « ignorer » concurrente (verrou exclusif) attend ou fait échouer l'association : jamais
   * d'unité ignorée avec une association en cours.
   */
  private async lockFollowedUnit(tx: Tx, unitId: string): Promise<void> {
    const [row] = await tx.$queryRaw<Array<{ ignoredAt: Date | null }>>`SELECT "ignoredAt" FROM "TelemetryUnit" WHERE id = ${unitId}::uuid FOR SHARE`;
    if (row?.ignoredAt) throw new BusinessRuleError('UNITE_IGNOREE', 'Cette unité est ignorée : cessez de l’ignorer avant de l’associer à un véhicule.');
  }

  private async unitViewById(unitId: string): Promise<UnitViewDto> {
    return unitView(await this.prisma.client.telemetryUnit.findUniqueOrThrow({ where: { id: unitId }, include: unitInclude }));
  }

  /** Conditions d'une association confirmée (D-175, D-186, D-302). */
  private async assertMappable(unit: UnitWithProvider, vehicle: VehicleForMapping): Promise<void> {
    if (unit.provider.status === 'DESACTIVE') throw new BusinessRuleError('FOURNISSEUR_DESACTIVE', 'Le fournisseur de cette unité est désactivé.');
    if (!unit.provider.companies.some((c) => c.companyId === vehicle.companyId)) {
      throw new BusinessRuleError('SOCIETE_NON_COUVERTE', 'La société du véhicule n’est pas couverte par le fournisseur de cette unité.');
    }
    if (!vehicle.company.telemetryEnabled) throw new BusinessRuleError('TELEMETRIE_DESACTIVEE', 'Le module télématique n’est pas activé pour la société du véhicule.');
    if (!unit.presentAtProvider) throw new BusinessRuleError('UNITE_ABSENTE', 'Cette unité n’est plus présente chez le fournisseur.');
    if (unit.ignoredAt) throw new BusinessRuleError('UNITE_IGNOREE', 'Cette unité est ignorée : cessez de l’ignorer avant de l’associer à un véhicule.');
    if (vehicle.lifecycleStatus !== 'ACTIF') throw new BusinessRuleError('VEHICULE_NON_ACTIF', 'Seul un véhicule ACTIF peut être associé à une unité.');
  }

  private async assertNoOpenConfirmed(unitId: string, vehicleId: string): Promise<void> {
    const open = await this.prisma.client.telemetryVehicleMapping.findMany({ where: { status: 'CONFIRME', validTo: null, OR: [{ unitId }, { vehicleId }] }, select: { unitId: true, vehicleId: true } });
    if (open.some((m) => m.unitId === unitId)) throw new ConflictError('UNITE_DEJA_ASSOCIEE', 'Cette unité est déjà associée à un véhicule : clôturez d’abord cette association.');
    if (open.some((m) => m.vehicleId === vehicleId)) {
      throw new ConflictError('VEHICULE_DEJA_EQUIPE', 'Ce véhicule a déjà une unité active : utilisez la clôture avec remplacement (changement de boîtier).');
    }
  }

  /**
   * Date d'effet (D-186, D-301) : par défaut la plus tardive de maintenant − reprise initiale, début du
   * compteur ouvert, entrée du véhicule dans sa société courante et fin des associations précédentes
   * du véhicule ou de l'unité ; une date saisie doit respecter ces bornes et ne pas être future.
   */
  private async effectiveFrom(vehicle: VehicleForMapping, unit: UnitWithProvider, requested: string | undefined): Promise<Date> {
    const now = this.clock.now();
    const [segment, entry, previousVehicle, previousUnit] = await Promise.all([
      this.prisma.client.odometerSegment.findFirst({ where: { vehicleId: vehicle.id, endedAt: null }, select: { startedAt: true } }),
      this.prisma.client.vehicleCompanyHistory.findFirst({ where: { vehicleId: vehicle.id, toCompanyId: vehicle.companyId }, orderBy: { effectiveAt: 'desc' }, select: { effectiveAt: true } }),
      this.prisma.client.telemetryVehicleMapping.findFirst({ where: { vehicleId: vehicle.id, validTo: { not: null } }, orderBy: { validTo: 'desc' }, select: { validTo: true } }),
      this.prisma.client.telemetryVehicleMapping.findFirst({ where: { unitId: unit.id, validTo: { not: null } }, orderBy: { validTo: 'desc' }, select: { validTo: true } }),
    ]);
    const bounds: Array<{ at: Date; label: string }> = [{ at: new Date(now.getTime() - unit.provider.backfillDays * DAY_MS), label: `reprise initiale limitée à ${unit.provider.backfillDays} jour(s)` }];
    if (segment) bounds.push({ at: segment.startedAt, label: 'début du compteur ouvert' });
    if (entry) bounds.push({ at: entry.effectiveAt, label: 'entrée du véhicule dans sa société courante' });
    if (previousVehicle?.validTo) bounds.push({ at: previousVehicle.validTo, label: 'fin de la précédente association du véhicule' });
    if (previousUnit?.validTo) bounds.push({ at: previousUnit.validTo, label: 'fin de la précédente association de l’unité' });
    const minimum = bounds.reduce((a, b) => (b.at.getTime() > a.at.getTime() ? b : a));
    if (!requested) return minimum.at.getTime() > now.getTime() ? now : minimum.at;
    const at = new Date(requested);
    if (at.getTime() > now.getTime()) throw new BusinessRuleError('DATE_EFFET_FUTURE', 'La date d’effet ne peut pas être dans le futur.', { fieldErrors: { validFrom: ['Date future.'] } });
    // Chevauchement avec une association précédente de l'unité ou du véhicule (R-14.5-X01) : conflit (409),
    // la contrainte d'exclusion SQL restant la garantie ultime en cas de décisions concurrentes.
    if (previousUnit?.validTo && at.getTime() < previousUnit.validTo.getTime()) {
      throw new ConflictError('PERIODE_UNITE_CHEVAUCHEMENT', `Cette unité était associée à un véhicule jusqu’au ${previousUnit.validTo.toISOString()} : la date d’effet ne peut pas la précéder.`, {
        minimum: previousUnit.validTo.toISOString(),
      });
    }
    if (previousVehicle?.validTo && at.getTime() < previousVehicle.validTo.getTime()) {
      throw new ConflictError('PERIODE_VEHICULE_CHEVAUCHEMENT', `Ce véhicule était équipé d’une unité jusqu’au ${previousVehicle.validTo.toISOString()} : la date d’effet ne peut pas la précéder.`, {
        minimum: previousVehicle.validTo.toISOString(),
      });
    }
    if (at.getTime() < minimum.at.getTime()) {
      throw new BusinessRuleError('DATE_EFFET_TROP_ANCIENNE', `La date d’effet ne peut pas précéder le ${minimum.at.toISOString()} (${minimum.label}).`, {
        fieldErrors: { validFrom: ['Date trop ancienne.'] },
        details: { minimum: minimum.at.toISOString(), motif: minimum.label },
      });
    }
    return at;
  }

  private async rejectCompetingProposals(tx: Tx, ctx: RequestContext, unitId: string, vehicleId: string, keepId: string): Promise<void> {
    await tx.telemetryVehicleMapping.updateMany({
      where: { status: 'PROPOSE', id: { not: keepId }, OR: [{ unitId }, { vehicleId }] },
      data: { status: 'REJETE', decidedAt: this.clock.now(), decidedById: ctx.userId, closedReason: 'Autre association confirmée pour cette unité ou ce véhicule.', version: { increment: 1 } },
    });
  }

  /**
   * Écriture transactionnelle d'une association ; contrainte « une association ouverte » ou périodes
   * [validFrom, validTo[ en chevauchement (contraintes d'exclusion, R-14.5-X01) → 409, jamais 500.
   */
  private async writeMapping<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.transaction(fn);
    } catch (error) {
      if (isUniqueViolation(error, 'telemetry_mapping_one_open_per_unit') || isUniqueViolation(error, 'unitId')) {
        throw new ConflictError('UNITE_DEJA_ASSOCIEE', 'Cette unité vient d’être associée à un autre véhicule.');
      }
      if (isUniqueViolation(error, 'telemetry_mapping_one_open_per_vehicle') || isUniqueViolation(error, 'vehicleId')) {
        throw new ConflictError('VEHICULE_DEJA_EQUIPE', 'Ce véhicule vient d’être associé à une autre unité.');
      }
      if (isConstraintViolation(error, 'telemetry_mapping_no_overlap_unit')) {
        throw new ConflictError('PERIODE_UNITE_CHEVAUCHEMENT', 'Cette unité est déjà associée à un véhicule sur une partie de cette période : choisissez une date d’effet postérieure à la fin de son association précédente.');
      }
      if (isConstraintViolation(error, 'telemetry_mapping_no_overlap_vehicle')) {
        throw new ConflictError('PERIODE_VEHICULE_CHEVAUCHEMENT', 'Ce véhicule est déjà équipé d’une unité sur une partie de cette période : choisissez une date d’effet postérieure à la fin de son association précédente.');
      }
      throw error;
    }
  }
}

/**
 * Fin de l'association d'un véhicule sorti du périmètre télématique : cession ou archivage (D-175),
 * transfert de société. Clôt l'association confirmée ouverte (validTo = date de l'opération), rejette les
 * propositions en attente et résout les alertes F11 rattachées aux associations clôturées. À appeler dans
 * la transaction de l'opération (qui porte l'audit) ; renvoie le nombre d'associations clôturées.
 */
export async function closeOpenMappingsForVehicle(tx: Tx, input: { organizationId: string; vehicleId: string; at: Date; reason: string; userId: string | null }): Promise<number> {
  const open = await tx.telemetryVehicleMapping.findMany({ where: { organizationId: input.organizationId, vehicleId: input.vehicleId, status: 'CONFIRME', validTo: null }, select: { id: true, companyId: true } });
  const closed = await tx.telemetryVehicleMapping.updateMany({
    where: { id: { in: open.map((m) => m.id) }, status: 'CONFIRME', validTo: null },
    data: { status: 'CLOTURE', validTo: input.at, closedReason: input.reason, version: { increment: 1 } },
  });
  // Audit propre à chaque association clôturée (D-175), en plus de celui de l'opération appelante.
  for (const m of open) {
    await tx.auditEvent.create({
      data: {
        organizationId: input.organizationId,
        companyId: m.companyId,
        actorType: input.userId ? 'UTILISATEUR' : 'SYSTEME',
        actorUserId: input.userId,
        action: 'telemetrie.association.cloture',
        objectType: MAPPING_ALERT_OBJECT,
        objectId: m.id,
        reason: input.reason,
        before: { status: 'CONFIRME', validTo: null },
        after: { status: 'CLOTURE', validTo: input.at.toISOString() },
      },
    });
  }
  await tx.telemetryVehicleMapping.updateMany({
    where: { organizationId: input.organizationId, vehicleId: input.vehicleId, status: 'PROPOSE' },
    data: { status: 'REJETE', decidedAt: input.at, decidedById: input.userId, closedReason: input.reason, version: { increment: 1 } },
  });
  if (open.length > 0) {
    await tx.alert.updateMany({
      where: { organizationId: input.organizationId, objectType: MAPPING_ALERT_OBJECT, objectId: { in: open.map((m) => m.id) }, type: { in: [...F11_ALERT_TYPES] }, status: 'ACTIVE' },
      data: { status: 'RESOLUE', resolvedAt: input.at, resolutionReason: `Association clôturée : ${input.reason}`, version: { increment: 1 } },
    });
  }
  return closed.count;
}

const vehicleSelect = { id: true, code: true, registration: true, companyId: true, lifecycleStatus: true, company: { select: { telemetryEnabled: true } } } satisfies Prisma.VehicleSelect;
type VehicleForMapping = Prisma.VehicleGetPayload<{ select: typeof vehicleSelect }>;
type UnitWithProvider = Prisma.TelemetryUnitGetPayload<{
  include: { provider: { select: { id: true; name: true; kind: true; status: true; backfillDays: true; companies: { select: { companyId: true } } } } };
}>;

function unitView(u: UnitRow): UnitViewDto {
  return {
    id: u.id,
    providerId: u.providerId,
    providerName: u.provider.name,
    providerKind: u.provider.kind,
    isSimulator: u.provider.kind === 'SIMULATEUR',
    externalId: u.externalId,
    label: u.label,
    declaredRegistration: u.declaredRegistration,
    registrationNormalized: u.registrationNormalized,
    presentAtProvider: u.presentAtProvider,
    firstSeenAt: u.firstSeenAt.toISOString(),
    lastSeenAt: u.lastSeenAt.toISOString(),
    ignoredAt: u.ignoredAt?.toISOString() ?? null,
    ignoredById: u.ignoredById,
    ignoredReason: u.ignoredReason,
  };
}

function vehicleRef(v: { id: string; code: string; registration: string; companyId: string; lifecycleStatus: string }): UnitRowDto['vehicle'] {
  return { id: v.id, code: v.code, registration: v.registration, companyId: v.companyId, lifecycleStatus: v.lifecycleStatus };
}

function mappingView(m: MappingRow): MappingViewDto {
  return {
    id: m.id,
    providerId: m.providerId,
    providerName: m.provider.name,
    isSimulator: m.provider.kind === 'SIMULATEUR',
    unitId: m.unitId,
    unitExternalId: m.unit.externalId,
    unitLabel: m.unit.label,
    unitDeclaredRegistration: m.unit.declaredRegistration,
    vehicle: vehicleRef(m.vehicle) as NonNullable<UnitRowDto['vehicle']>,
    companyId: m.vehicle.companyId,
    status: m.status,
    odometerKind: m.odometerKind,
    fuelKinds: [...m.fuelKinds],
    validFrom: m.validFrom?.toISOString() ?? null,
    validTo: m.validTo?.toISOString() ?? null,
    proposedAt: m.proposedAt.toISOString(),
    proposalReason: m.proposalReason,
    decidedAt: m.decidedAt?.toISOString() ?? null,
    decidedById: m.decidedById,
    closedReason: m.closedReason,
    version: m.version,
  };
}

function decisionAudit(m: { status: string; unitId: string; vehicleId: string; validFrom: Date | null; odometerKind: string; fuelKinds: string[] }): Record<string, unknown> {
  return { status: m.status, unitId: m.unitId, vehicleId: m.vehicleId, validFrom: m.validFrom, odometerKind: m.odometerKind, fuelKinds: m.fuelKinds };
}
