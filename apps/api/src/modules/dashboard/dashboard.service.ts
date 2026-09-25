import { Injectable } from '@nestjs/common';
import { ALERT_SEVERITY_LABELS } from '@parc-auto/contracts';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { localDate, type CivilDate } from '../../domain/civil-date.js';
import { resolveIndicatorPeriod, tallyFleet, type FleetTally, type IndicatorPeriod } from '../../domain/dashboard-indicators.js';
import { computeFreshness } from '../../domain/freshness.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { AlertCenterService } from '../alerts/alert-center.service.js';
import { AlertsQueryDto } from '../alerts/dto/alerts.dto.js';
import { DocumentsService } from '../documents/documents.service.js';
import { ComplianceQueryDto } from '../documents/dto/documents.dto.js';
import { ExpensesService } from '../expenses/expenses.service.js';
import { InterventionsQueryDto } from '../interventions/dto/interventions.dto.js';
import { InterventionsService } from '../interventions/interventions.service.js';
import { PlansQueryDto } from '../maintenance/dto/maintenance.dto.js';
import { MaintenancePlansService } from '../maintenance/maintenance-plans.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { UsagesQueryDto } from '../usages/dto/usages.dto.js';
import { UsagesService } from '../usages/usages.service.js';
import { nonCompliantVehicleIds, staleAfterDaysByCompany } from '../vehicles/vehicle-conditions.js';
import type { DashboardDto, DashboardQueryDto, IndicatorDto, IndicatorGroup, IndicatorKind, IndicatorLinkDto, OmittedIndicatorDto } from './dto/dashboard.dto.js';

type Query = Record<string, string>;

interface IndicatorSpec {
  key: string;
  label: string;
  definition: string;
  group: IndicatorGroup;
  /** FLUX : filtré par la période ; ETAT (défaut) : instantané. */
  kind?: IndicatorKind;
  value: number | string;
  unit: string;
  denominator?: { key: string; label: string; value: number } | null;
  parentKey?: string | null;
  api: { path: string; query: Query; field?: string };
  screen: IndicatorLinkDto | null;
}

interface FleetState {
  tally: FleetTally;
  freshness: { A_ACTUALISER: number; INCONNU: number; A_JOUR: number };
}

/**
 * Écran web d'une liste justificative filtrée par véhicule : les écrans de liste acceptent le paramètre
 * « vehicule », sauf la liste des véhicules, remplacée par la route de l'API (panneau justificatif).
 */
function screenForVehicle(screen: IndicatorLinkDto | null, vehicleId: string | null): IndicatorLinkDto | null {
  if (!screen || !vehicleId) return screen;
  if (screen.path === '/vehicules') return null;
  return { path: screen.path, query: { ...screen.query, vehicule: vehicleId } };
}

/** DTO de liste construit côté serveur (valeurs par défaut de pagination comprises). */
function dto<T extends object>(cls: new () => T, values: Partial<T>): T {
  return Object.assign(new cls(), values);
}

/** Alertes prioritaires : compteurs par gravité, de la plus grave à la moins grave (libellés accordés). */
const ALERT_SEVERITIES = [
  { severity: 'CRITIQUE', key: 'alerts.critical', label: 'Alertes critiques' },
  { severity: 'URGENT', key: 'alerts.urgent', label: 'Alertes urgentes' },
  { severity: 'ATTENTION', key: 'alerts.attention', label: 'Alertes « Attention »' },
  { severity: 'INFO', key: 'alerts.info', label: 'Alertes d’information' },
] as const;

const COSTS_OMITTED_REASON = {
  company: 'La consultation des coûts requiert la permission costs.read sur la société affichée.',
  vehicle: 'La consultation des coûts requiert la permission costs.read sur la société du véhicule.',
  consolidated: 'La consultation des coûts requiert la permission costs.read sur au moins une société de votre périmètre.',
} as const;

/**
 * Tableau de bord (CDC 11.1, 10.2 ; D-269) : indicateurs d'état instantanés et horodatés, flux sur une
 * période civile incluse. Chaque indicateur porte sa définition, son dénominateur éventuel et sa liste
 * justificative (route de l'API interrogée avec la même requête, écran web lorsqu'il propose ce
 * filtre). Calcul en direct à chaque appel, sans cache partagé ; périmètre recalculé côté serveur.
 *
 * Les états du parc passent par les règles uniques du domaine (vehicle-status.ts, document-compliance.ts,
 * freshness.ts) ; les autres totaux sont ceux des listes justificatives elles-mêmes (mêmes services,
 * mêmes filtres), ce qui garantit l'égalité indicateur = liste.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly settings: SettingsService,
    private readonly documents: DocumentsService,
    private readonly plans: MaintenancePlansService,
    private readonly usages: UsagesService,
    private readonly interventions: InterventionsService,
    private readonly expenses: ExpensesService,
    private readonly alerts: AlertCenterService,
    private readonly clock: Clock,
  ) {}

  async get(ctx: RequestContext, query: DashboardQueryDto): Promise<DashboardDto> {
    this.access.requireStaff(ctx);
    const companyId = query.companyId ?? null;
    // Le filtre du navigateur ne fait jamais autorité : une société hors périmètre est introuvable (T01).
    if (companyId && !this.access.visibleCompanyIds(ctx).includes(companyId)) throw new NotFoundOrOutOfScopeError('Société');
    const vehicleId = query.vehicleId ?? null;
    // Filtre par véhicule (11.1) : véhicule actuellement géré par une société du périmètre (et par la
    // société demandée, le cas échéant) ; sinon introuvable, sans révéler son existence.
    let vehicleCompanyId: string | null = null;
    if (vehicleId) {
      const vehicle = await this.prisma.client.vehicle.findFirst({ where: { id: vehicleId, organizationId: ctx.organizationId }, select: { companyId: true } });
      if (!vehicle || !this.access.visibleCompanyIds(ctx).includes(vehicle.companyId) || (companyId !== null && vehicle.companyId !== companyId)) throw new NotFoundOrOutOfScopeError('Véhicule');
      vehicleCompanyId = vehicle.companyId;
    }
    const now = this.clock.now();
    const org = await this.prisma.client.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } });
    const today = localDate(now, org.timezone);
    const resolved = resolveIndicatorPeriod(query.from, query.to, today);
    if (!resolved.ok) throw new BusinessRuleError(resolved.code, resolved.message, { fieldErrors: { [resolved.field]: [resolved.message] } });
    const period = resolved.period;
    // Filtré sur un véhicule, le périmètre est la seule société qui le gère : les coûts n'y figurent qu'avec
    // costs.read sur cette société (jamais un total nul calculé sur les autres sociétés du périmètre).
    const scopeCompanyIds = companyId ? [companyId] : vehicleCompanyId ? [vehicleCompanyId] : [...this.access.visibleCompanyIds(ctx)];
    // D-111, D-266 : les coûts ne portent que sur les sociétés où l'utilisateur détient costs.read (même
    // périmètre que GET /expenses/summary) ; sans aucune, l'indicateur est absent, jamais remplacé par 0.
    const costCompanyIds = scopeCompanyIds.filter((id) => this.access.hasPermission(ctx, id, 'costs.read'));
    const canReadCosts = costCompanyIds.length > 0;
    const scope: { companyId?: string; vehicleId?: string } = { ...(companyId ? { companyId } : {}), ...(vehicleId ? { vehicleId } : {}) };
    const scoped = (q: Query): Query => ({ ...scope, ...q });
    // Filtres partagés par le calcul et la liste justificative (même requête).
    const f = {
      urgent: { urgent: 'true' },
      due: { status: 'A_FAIRE' },
      overdue: { status: 'EN_RETARD' },
      expired: { status: 'EXPIRE' },
      missing: { status: 'MANQUANT' },
      returnDue: { returnDue: 'true' },
      late: { late: 'true' },
      completed: { status: 'TERMINEE', from: period.from, to: period.to },
      costs: { from: period.from, to: period.to },
    } as const;
    const count = { page: 1, pageSize: 1 };

    const [fleet, urgentPlans, duePlans, overduePlans, expiredDocs, missingDocs, returnsDue, lateReturns, completedInterventions, costs, alertCounts, costScope] = await Promise.all([
      this.fleet(ctx, companyId, vehicleId, now, today),
      this.plans.list(ctx, dto(PlansQueryDto, { ...scope, ...f.urgent, ...count })),
      this.plans.list(ctx, dto(PlansQueryDto, { ...scope, ...f.due, ...count })),
      this.plans.list(ctx, dto(PlansQueryDto, { ...scope, ...f.overdue, ...count })),
      this.documents.compliance(ctx, dto(ComplianceQueryDto, { ...scope, ...f.expired, ...count })),
      this.documents.compliance(ctx, dto(ComplianceQueryDto, { ...scope, ...f.missing, ...count })),
      this.usages.list(ctx, dto(UsagesQueryDto, { ...scope, ...f.returnDue, ...count })),
      this.usages.list(ctx, dto(UsagesQueryDto, { ...scope, ...f.late, ...count })),
      this.interventions.list(ctx, dto(InterventionsQueryDto, { ...scope, ...f.completed, ...count })),
      canReadCosts ? this.expenses.summary(ctx, { ...scope, ...f.costs }) : Promise.resolve(null),
      // Alertes actives visibles pour ce rôle, hors reports de l'utilisateur courant (D-244, D-252).
      Promise.all(
        ALERT_SEVERITIES.map(async ({ severity, key, label }) => {
          const filter = { status: 'ACTIVE', severity, snoozed: 'exclude' } as const;
          const page = await this.alerts.list(ctx, dto(AlertsQueryDto, { ...scope, ...filter, ...count }));
          return { severity, key, label, filter, total: page.total };
        }),
      ),
      this.costScope(ctx, scopeCompanyIds, costCompanyIds),
    ]);

    const t = fleet.tally;
    const active = { key: 'vehicles.active', label: 'véhicules actifs', value: t.active };
    const specs: IndicatorSpec[] = [
      {
        key: 'vehicles.active',
        label: 'Parc actif',
        definition: 'Véhicules au cycle de vie ACTIF ; dénominateur des états du parc.',
        group: 'parc',
        value: t.active,
        unit: 'vehicules',
        api: { path: '/vehicles', query: scoped({ lifecycleStatus: 'ACTIF' }) },
        screen: { path: '/vehicules', query: { lifecycle: 'ACTIF' } },
      },
      {
        key: 'vehicles.active.nonCompliant',
        label: 'Parc actif dont non conformes',
        definition: 'Véhicules actifs dont un document bloquant applicable est manquant ou expiré au jour local (indicateur distinct du statut).',
        group: 'parc',
        value: t.nonCompliant.active,
        unit: 'vehicules',
        denominator: active,
        parentKey: 'vehicles.active',
        api: { path: '/vehicles', query: scoped({ lifecycleStatus: 'ACTIF', blockingDocuments: 'true' }) },
        screen: null,
      },
      ...this.statusGroup('vehicles.available', 'Disponibles', 'DISPONIBLE', 'Véhicules actifs ni immobilisés ni en utilisation.', t, active, scoped),
      ...this.statusGroup('vehicles.inUse', 'En utilisation', 'EN_UTILISATION', 'Véhicules actifs avec une utilisation en cours, non immobilisés.', t, active, scoped),
      ...this.statusGroup('vehicles.immobilized', 'Immobilisés', 'IMMOBILISE', 'Véhicules actifs avec une immobilisation active (prioritaire sur l’utilisation).', t, active, scoped),
      {
        key: 'vehicles.outOfService',
        label: 'Hors service',
        definition: 'Véhicules au cycle de vie HORS_SERVICE, exclus du parc actif et des disponibles.',
        group: 'parc',
        value: t.outOfService,
        unit: 'vehicules',
        api: { path: '/vehicles', query: scoped({ lifecycleStatus: 'HORS_SERVICE' }) },
        screen: { path: '/vehicules', query: { lifecycle: 'HORS_SERVICE' } },
      },
      {
        key: 'maintenance.urgent',
        label: 'Entretiens urgents',
        definition: 'Plans d’entretien actifs au statut À faire ou En retard.',
        group: 'entretiens',
        value: urgentPlans.total,
        unit: 'plans',
        api: { path: '/maintenance-plans', query: scoped(f.urgent) },
        screen: { path: '/entretiens', query: { urgent: '1' } },
      },
      {
        key: 'maintenance.urgent.due',
        label: 'dont à faire',
        definition: 'Plans actifs au statut À faire : échéance atteinte (valeur kilométrique exacte ou jour de l’échéance).',
        group: 'entretiens',
        value: duePlans.total,
        unit: 'plans',
        parentKey: 'maintenance.urgent',
        api: { path: '/maintenance-plans', query: scoped(f.due) },
        screen: { path: '/entretiens', query: { statut: 'A_FAIRE' } },
      },
      {
        key: 'maintenance.urgent.overdue',
        label: 'dont en retard',
        definition: 'Plans actifs au statut En retard : échéance dépassée.',
        group: 'entretiens',
        value: overduePlans.total,
        unit: 'plans',
        parentKey: 'maintenance.urgent',
        api: { path: '/maintenance-plans', query: scoped(f.overdue) },
        screen: { path: '/entretiens', query: { statut: 'EN_RETARD' } },
      },
      {
        key: 'documents.expired',
        label: 'Documents expirés',
        definition: 'Documents de véhicules (actifs ou hors service) et de conducteurs actifs dont la dernière version est expirée au jour local.',
        group: 'documents',
        value: expiredDocs.total,
        unit: 'documents',
        api: { path: '/documents/compliance', query: scoped(f.expired) },
        screen: { path: '/documents', query: { statut: 'EXPIRE' } },
      },
      {
        key: 'documents.missing',
        label: 'Documents manquants',
        definition: 'Documents exigés sans aucune version en vigueur (comptés à part des expirés).',
        group: 'documents',
        value: missingDocs.total,
        unit: 'documents',
        api: { path: '/documents/compliance', query: scoped(f.missing) },
        screen: { path: '/documents', query: { statut: 'MANQUANT' } },
      },
      {
        key: 'odometer.stale',
        label: 'Relevés anciens',
        definition: 'Véhicules actifs dont la dernière observation acceptée dépasse le seuil de fraîcheur de leur société (À actualiser).',
        group: 'kilometrage',
        value: fleet.freshness.A_ACTUALISER,
        unit: 'vehicules',
        denominator: active,
        api: { path: '/vehicles', query: scoped({ lifecycleStatus: 'ACTIF', freshness: 'A_ACTUALISER' }) },
        screen: null,
      },
      {
        key: 'odometer.unknown',
        label: 'Kilométrage inconnu',
        definition: 'Véhicules actifs sans aucun relevé accepté (compté à part des relevés anciens).',
        group: 'kilometrage',
        value: fleet.freshness.INCONNU,
        unit: 'vehicules',
        denominator: active,
        api: { path: '/vehicles', query: scoped({ lifecycleStatus: 'ACTIF', freshness: 'INCONNU' }) },
        screen: null,
      },
      {
        key: 'usages.returnDue',
        label: 'Retours attendus',
        definition: 'Utilisations en cours dont le retour prévu tombe au plus tard à la fin de la journée locale, retards compris.',
        group: 'utilisations',
        value: returnsDue.total,
        unit: 'utilisations',
        api: { path: '/usages', query: scoped(f.returnDue) },
        screen: null,
      },
      {
        key: 'usages.returnDue.late',
        label: 'dont retours dépassés',
        definition: 'Utilisations en cours dont l’heure de retour prévue est passée.',
        group: 'utilisations',
        value: lateReturns.total,
        unit: 'utilisations',
        parentKey: 'usages.returnDue',
        api: { path: '/usages', query: scoped(f.late) },
        screen: { path: '/utilisations', query: { retard: '1' } },
      },
      {
        key: 'interventions.completed',
        label: 'Interventions terminées',
        definition: 'Interventions (préventives et correctives) terminées dont la date de réalisation est dans la période.',
        group: 'interventions',
        kind: 'FLUX',
        value: completedInterventions.total,
        unit: 'interventions',
        api: { path: '/interventions', query: scoped(f.completed) },
        screen: { path: '/interventions', query: { statut: 'TERMINEE', du: period.from, au: period.to } },
      },
    ];
    for (const { severity, key, label, filter, total } of alertCounts) {
      specs.push({
        key,
        label,
        definition: `Alertes actives de gravité « ${ALERT_SEVERITY_LABELS[severity]} » visibles pour votre rôle, hors celles que vous avez reportées.`,
        group: 'alertes',
        value: total,
        unit: 'alertes',
        api: { path: '/alerts', query: scoped(filter) },
        screen: null,
      });
    }
    const omitted: OmittedIndicatorDto[] = [];
    if (costs) {
      const partial = costScope.excluded.length > 0 ? ` Sociétés comprises (permission costs.read) : ${costScope.included.join(', ')} ; non comprises : ${costScope.excluded.join(', ')}.` : '';
      specs.push({
        key: 'costs.operating',
        label: costScope.excluded.length > 0 ? `Coûts d’exploitation (${costScope.included.join(', ')})` : 'Coûts d’exploitation',
        definition: `Dépenses validées moins avoirs dont la date est dans la période, hors dépenses exclues du coût d’exploitation (achats de véhicules par défaut).${partial}`,
        group: 'couts',
        kind: 'FLUX',
        value: costs.operating.net,
        unit: costs.currency,
        api: { path: '/expenses/summary', query: scoped(f.costs), field: 'operating.net' },
        screen: null,
      });
    } else {
      omitted.push({ key: 'costs.operating', label: 'Coûts d’exploitation', reason: vehicleId ? COSTS_OMITTED_REASON.vehicle : companyId ? COSTS_OMITTED_REASON.company : COSTS_OMITTED_REASON.consolidated });
    }

    const asOf = now.toISOString();
    return {
      asOf,
      timezone: org.timezone,
      today,
      period,
      periodIsDefault: resolved.defaulted,
      companyId,
      vehicleId,
      indicators: specs.map((s) => this.indicator({ ...s, screen: screenForVehicle(s.screen, vehicleId) }, asOf, period)),
      omitted,
    };
  }

  /**
   * Codes des sociétés comprises dans l'indicateur de coûts et de celles qui en sont exclues faute de
   * costs.read (vue consolidée, D-111) : le périmètre partiel est affiché, jamais implicite.
   */
  private async costScope(ctx: RequestContext, scopeCompanyIds: readonly string[], costCompanyIds: readonly string[]): Promise<{ included: string[]; excluded: string[] }> {
    if (costCompanyIds.length === 0 || costCompanyIds.length === scopeCompanyIds.length) return { included: [], excluded: [] };
    const companies = await this.prisma.client.company.findMany({ where: { organizationId: ctx.organizationId, id: { in: [...scopeCompanyIds] } }, select: { id: true, code: true }, orderBy: { code: 'asc' } });
    const readable = new Set(costCompanyIds);
    return { included: companies.filter((c) => readable.has(c.id)).map((c) => c.code), excluded: companies.filter((c) => !readable.has(c.id)).map((c) => c.code) };
  }

  /** Un groupe de la partition et son « dont non conformes ». */
  private statusGroup(key: string, label: string, status: 'DISPONIBLE' | 'EN_UTILISATION' | 'IMMOBILISE', definition: string, t: FleetTally, active: { key: string; label: string; value: number }, scoped: (q: Query) => Query): IndicatorSpec[] {
    return [
      {
        key,
        label,
        definition: `${definition} Groupes exclusifs : Immobilisé > En utilisation > Disponible.`,
        group: 'parc',
        value: t.byStatus[status],
        unit: 'vehicules',
        denominator: active,
        api: { path: '/vehicles', query: scoped({ operationalStatus: status }) },
        screen: { path: '/vehicules', query: { statut: status } },
      },
      {
        key: `${key}.nonCompliant`,
        label: `${label} dont non conformes`,
        definition: 'Véhicules du groupe dont un document bloquant applicable est manquant ou expiré au jour local.',
        group: 'parc',
        value: t.nonCompliant.byStatus[status],
        unit: 'vehicules',
        denominator: { key, label: label.toLowerCase(), value: t.byStatus[status] },
        parentKey: key,
        api: { path: '/vehicles', query: scoped({ operationalStatus: status, blockingDocuments: 'true' }) },
        screen: null,
      },
    ];
  }

  private indicator(s: IndicatorSpec, asOf: string, period: IndicatorPeriod): IndicatorDto {
    const flux = s.kind === 'FLUX';
    return {
      key: s.key,
      label: s.label,
      definition: s.definition,
      group: s.group,
      kind: s.kind ?? 'ETAT',
      value: s.value,
      unit: s.unit,
      denominator: s.denominator ?? null,
      parentKey: s.parentKey ?? null,
      asOf: flux ? null : asOf,
      period: flux ? { from: period.from, to: period.to } : null,
      justification: { path: s.api.path, query: s.api.query, field: s.api.field ?? 'total', screen: s.screen },
    };
  }

  /**
   * États du parc au même instant : partition exclusive des véhicules actifs, non-conformité
   * documentaire bloquante et fraîcheur du kilométrage (dernier relevé accepté, seuil par société).
   */
  private async fleet(ctx: RequestContext, companyId: string | null, vehicleId: string | null, now: Date, today: CivilDate): Promise<FleetState> {
    const vehicles = await this.prisma.client.vehicle.findMany({
      where: { ...this.access.companyWhere(ctx, companyId), ...(vehicleId ? { id: vehicleId } : {}), lifecycleStatus: { in: ['ACTIF', 'HORS_SERVICE'] } },
      select: {
        id: true,
        companyId: true,
        categoryId: true,
        lifecycleStatus: true,
        immobilizations: { where: { status: 'ACTIVE' }, select: { id: true }, take: 1 },
        usages: { where: { status: 'EN_COURS' }, select: { id: true }, take: 1 },
      },
    });
    const active = vehicles.filter((v) => v.lifecycleStatus === 'ACTIF');
    const [nonCompliant, lastAccepted, staleDays] = await Promise.all([
      nonCompliantVehicleIds(this.prisma, ctx.organizationId, active, today),
      active.length > 0
        ? this.prisma.client.odometerReading.groupBy({ by: ['vehicleId'], where: { vehicleId: { in: active.map((v) => v.id) }, status: 'ACCEPTE' }, _max: { observedAt: true } })
        : Promise.resolve([]),
      staleAfterDaysByCompany(this.settings, ctx.organizationId, active.map((v) => v.companyId)),
    ]);
    const tally = tallyFleet(vehicles.map((v) => ({ lifecycle: v.lifecycleStatus, hasActiveImmobilization: v.immobilizations.length > 0, hasOpenUsage: v.usages.length > 0, blockingNonCompliant: nonCompliant.has(v.id) })));
    const lastObserved = new Map(lastAccepted.map((r) => [r.vehicleId, r._max.observedAt]));
    const freshness = { A_ACTUALISER: 0, INCONNU: 0, A_JOUR: 0 };
    for (const v of active) {
      const days = staleDays.get(v.companyId);
      if (days === undefined) throw new Error(`Seuil de fraîcheur absent pour la société ${v.companyId}.`);
      freshness[computeFreshness(lastObserved.get(v.id) ?? null, now, days).status] += 1;
    }
    return { tally, freshness };
  }
}
