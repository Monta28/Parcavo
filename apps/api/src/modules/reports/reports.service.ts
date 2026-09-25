import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { Clock } from '../../common/clock.js';
import { BusinessRuleError, ForbiddenActionError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { assertCivilDate, endOfLocalDay, localDate, startOfLocalDay } from '../../domain/civil-date.js';
import { CONSUMPTION_UNIT } from '../../domain/consumption.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import type { ReportCatalogueDto, ReportFilterAppliedDto, ReportFiltersDto, ReportMetaDto, ReportPageDto, ReportQueryDto, ReportSummaryDto } from './dto/reports.dto.js';
import { ReportExportPolicy } from './export/report-export.policy.js';
import { formatCivilDate } from './export/format.js';
import { DistanceCostReportService } from './providers/distance-cost-report.service.js';
import { DocumentsReportService } from './providers/documents-report.service.js';
import { ExpensesReportService } from './providers/expenses-report.service.js';
import { FuelReportService } from './providers/fuel-report.service.js';
import { IncidentsReportService } from './providers/incidents-report.service.js';
import { InventoryReportService } from './providers/inventory-report.service.js';
import { MaintenanceReportService } from './providers/maintenance-report.service.js';
import { ReadingsReportService } from './providers/readings-report.service.js';
import { UsageReportService } from './providers/usage-report.service.js';
import { REPORT_BOOLEAN_FILTER_LABELS, REPORT_ENUM_FILTER_OPTIONS } from './report-filter-options.js';
import { columnDecimalText } from './report-support.js';
import {
  REPORT_CODES,
  REPORT_FILTER_KEYS,
  type RawValue,
  type ReportCode,
  type ReportColumn,
  type ReportFilterKey,
  type ReportFilters,
  type ReportPeriod,
  type ReportProvider,
  type ReportResult,
  type ReportRow,
  type ReportRun,
  type ReportScope,
  type ReportSummaryItem,
  type ReportViewDefinition,
  type ReportWindow,
} from './report-types.js';

export type ReportPurpose = 'ecran' | 'export';

/** Rapport prêt à être lu : périmètre, filtres, colonnes visibles et métadonnées. */
export interface PreparedReport {
  provider: ReportProvider;
  view: ReportViewDefinition;
  run: ReportRun;
  columns: ReportColumn[];
  meta: ReportMetaDto;
  /** Colonnes de coût incluses (export : costs.read sur toutes les sociétés exportées). */
  hasCostColumns: boolean;
  /** costs.read détenu sur toutes les sociétés du périmètre (lignes multi-sociétés, totaux). */
  costOnAllCompanies: boolean;
  currencyDecimals: number;
  companies: ReadonlyMap<string, { code: string; legalName: string }>;
}

const FILTER_LABELS: Record<ReportFilterKey, string> = {
  companyId: 'Société',
  siteId: 'Site',
  vehicleId: 'Véhicule',
  driverId: 'Conducteur',
  categoryId: 'Catégorie de véhicule',
  supplierId: 'Fournisseur',
  maintenanceTypeId: 'Type d’opération',
  documentTypeId: 'Type de document',
  from: 'Du',
  to: 'Au',
  q: 'Recherche',
  vue: 'Vue',
  status: 'Statut',
  lifecycleStatus: 'Cycle de vie',
  operationalStatus: 'État opérationnel',
  distanceStatus: 'Statut de la distance',
  lateOnly: 'Retards uniquement',
  source: 'Source',
  freshness: 'Fraîcheur',
  ownerType: 'Objet',
  blocking: 'Bloquants uniquement',
  energy: 'Carburant',
  category: 'Catégorie de dépense',
  incidentType: 'Type d’incident',
  severity: 'Gravité',
};

const ENUM_FILTER_LABELS: Partial<Record<ReportFilterKey, Readonly<Record<string, string>>>> = {
  ...REPORT_ENUM_FILTER_OPTIONS,
  lateOnly: REPORT_BOOLEAN_FILTER_LABELS,
  blocking: REPORT_BOOLEAN_FILTER_LABELS,
};

/**
 * Rapports V1 (CDC 11.2, 11.3 ; D-266, D-269 à D-276). Point d'accès unique : périmètre calculé côté serveur
 * (sociétés visibles, filtre de société recoupé — hors périmètre : 404 —, conducteur seul : 403),
 * permissions (reports.export pour un export, costs.read pour les colonnes de coût et le rapport des
 * dépenses), filtres recoupés, métadonnées (filtres appliqués, fuseau, date de génération, unités,
 * colonnes). L'écran et l'export lisent les mêmes lignes par le même fournisseur.
 */
@Injectable()
export class ReportsService {
  private readonly providers: ReadonlyMap<ReportCode, ReportProvider>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly clock: Clock,
    private readonly policy: ReportExportPolicy,
    inventory: InventoryReportService,
    usages: UsageReportService,
    readings: ReadingsReportService,
    maintenance: MaintenanceReportService,
    documents: DocumentsReportService,
    fuel: FuelReportService,
    expenses: ExpensesReportService,
    incidents: IncidentsReportService,
    distances: DistanceCostReportService,
  ) {
    const all: ReportProvider[] = [inventory, usages, readings, maintenance, documents, fuel, expenses, incidents, distances];
    this.providers = new Map(all.map((p) => [p.code, p]));
  }

  catalogue(ctx: RequestContext): ReportCatalogueDto {
    this.access.requireStaff(ctx);
    const canReadCosts = this.access.hasPermissionAnywhere(ctx, 'costs.read');
    return {
      reports: REPORT_CODES.map((code) => this.provider(code)).map((p) => ({
        code: p.code,
        label: p.label,
        description: p.description,
        costsRequired: p.costsRequired,
        available: !p.costsRequired || canReadCosts,
        views: p.views.map((v) => ({ code: v.code, label: v.label, period: v.period, filters: [...v.filters], statuses: { ...(v.statuses ?? {}) } })),
      })),
      filterOptions: Object.fromEntries(Object.entries(REPORT_ENUM_FILTER_OPTIONS).map(([key, labels]) => [key, { ...labels }])),
      canExport: this.access.hasPermissionAnywhere(ctx, 'reports.export'),
      canReadCosts,
      syncMaxRows: this.policy.syncMaxRows,
      maxRows: this.policy.maxRows,
    };
  }

  /** Page d'un rapport pour l'écran. */
  async page(ctx: RequestContext, code: string, query: ReportQueryDto): Promise<ReportPageDto> {
    const prepared = await this.prepare(ctx, code, query, 'ecran');
    const result = await this.read(prepared, { skip: (query.page - 1) * query.pageSize, take: query.pageSize });
    return { items: this.jsonItems(prepared, result.rows), total: result.total, page: query.page, pageSize: query.pageSize, meta: this.withSummary(prepared, result) };
  }

  /** Lecture d'une fenêtre de lignes, sociétés renseignées par leur code. */
  async read(prepared: PreparedReport, window: ReportWindow): Promise<ReportResult> {
    const result = await prepared.provider.fetch(prepared.run, window);
    for (const row of result.rows) {
      if ('company' in row.values && (row.values['company'] === null || row.values['company'] === undefined) && row.companyId) {
        row.values['company'] = prepared.companies.get(row.companyId)?.code ?? null;
      }
    }
    return result;
  }

  /**
   * Prépare une exécution : rapport et vue connus, filtres pris en charge et recoupés avec le périmètre,
   * permissions vérifiées, période résolue (dates civiles locales incluses), colonnes visibles.
   */
  async prepare(ctx: RequestContext, code: string, query: ReportFiltersDto, purpose: ReportPurpose): Promise<PreparedReport> {
    this.access.requireStaff(ctx);
    const provider = this.provider(code);
    const filters = pickFilters(query);
    const viewCode = filters.vue ?? (provider.views[0] as ReportViewDefinition).code;
    const view = provider.views.find((v) => v.code === viewCode);
    if (!view) {
      throw new BusinessRuleError('VUE_INCONNUE', `Vue inconnue pour le rapport « ${provider.label} ».`, { fieldErrors: { vue: [`Vues possibles : ${provider.views.map((v) => v.code).join(', ')}.`] } });
    }
    filters.vue = view.code;
    const unsupported = (Object.keys(filters) as ReportFilterKey[]).filter((k) => k !== 'vue' && !view.filters.includes(k));
    if (unsupported.length > 0) {
      throw new BusinessRuleError('FILTRE_NON_PRIS_EN_CHARGE', `Filtre non pris en charge par la vue « ${view.label} » : ${unsupported.map((k) => FILTER_LABELS[k]).join(', ')}.`, {
        fieldErrors: Object.fromEntries(unsupported.map((k) => [k, ['Filtre non pris en charge par ce rapport.']])),
      });
    }
    if (filters.status && !(view.statuses && filters.status in view.statuses)) {
      throw new BusinessRuleError('STATUT_NON_PRIS_EN_CHARGE', 'Statut non pris en charge par cette vue.', { fieldErrors: { status: [`Valeurs possibles : ${Object.keys(view.statuses ?? {}).join(', ') || 'aucune'}.`] } });
    }

    const scope = this.resolveScope(ctx, provider, filters.companyId, purpose);
    const [org, companyRows] = await Promise.all([
      this.prisma.client.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true, currency: true, currencyDecimals: true } }),
      this.prisma.client.company.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true, code: true, legalName: true }, orderBy: { code: 'asc' } }),
    ]);
    const companies = new Map(companyRows.map((c) => [c.id, { code: c.code, legalName: c.legalName }]));
    const now = this.clock.now();
    const period = view.period ? resolvePeriod(filters, org.timezone, now) : null;
    const appliedFilters = await this.describeFilters(ctx, filters, view, companies);

    const raw = provider.columns(view.code);
    const costOnAllCompanies = scope.companyIds.length > 0 && scope.companyIds.every((c) => scope.costCompanyIds.has(c));
    const includeCost = purpose === 'export' ? costOnAllCompanies : scope.costCompanyIds.size > 0;
    const columns = raw
      .filter((c) => !c.cost || includeCost)
      .map((c) => (c.kind === 'money' ? { ...c, unit: c.perUnit ? `${org.currency}/${c.perUnit}` : org.currency, decimals: c.decimals ?? org.currencyDecimals } : c));
    const hasCostDefinitions = raw.some((c) => c.cost);
    const costColumns = !hasCostDefinitions ? 'sans_objet' : !includeCost ? 'aucune' : costOnAllCompanies ? 'toutes' : 'partielles';

    const run: ReportRun = { ctx, scope, filters, view: view.code, period, now, timezone: org.timezone, currency: org.currency, purpose };
    const meta: ReportMetaDto = {
      code: provider.code,
      label: provider.label,
      view: { code: view.code, label: view.label },
      generatedAt: now.toISOString(),
      timezone: org.timezone,
      currency: org.currency,
      author: ctx.displayName,
      scope: scope.companyIds.map((id) => ({ id, code: companies.get(id)?.code ?? '', legalName: companies.get(id)?.legalName ?? '' })).sort((a, b) => a.code.localeCompare(b.code)),
      filters: appliedFilters,
      period: period ? { from: period.from, to: period.to } : null,
      columns: columns.map((c) => ({
        key: c.key,
        label: c.label,
        unit: c.unit,
        kind: c.kind,
        cost: c.cost === true,
        decimals: c.kind === 'decimal' || c.kind === 'money' ? (c.decimals ?? 3) : null,
        missing: c.missing ?? null,
        labels: c.labels ? { ...c.labels } : null,
        estimates: c.estimates ? [...c.estimates] : null,
      })),
      costColumns,
      units: unitsOf(columns, org.timezone, org.currency),
      notes: provider.notes(view.code),
      summary: [],
    };
    return { provider, view, run, columns, meta, hasCostColumns: includeCost && hasCostDefinitions, costOnAllCompanies, currencyDecimals: org.currencyDecimals, companies };
  }

  /** Lignes JSON : une propriété par colonne ; colonnes de coût retirées sans costs.read sur la société de la ligne (D-266). */
  jsonItems(prepared: PreparedReport, rows: readonly ReportRow[]): Array<Record<string, unknown>> {
    return rows.map((row) => {
      const costAllowed = row.companyId ? prepared.run.scope.costCompanyIds.has(row.companyId) : prepared.costOnAllCompanies;
      const item: Record<string, unknown> = { id: row.id, companyId: row.companyId };
      for (const col of prepared.columns) {
        if (col.cost && !costAllowed) continue;
        item[col.key] = jsonValue(col, row.values[col.key] ?? null);
      }
      return item;
    });
  }

  /** Métadonnées complétées des totaux (valeurs de coût seulement avec costs.read sur tout le périmètre). */
  withSummary(prepared: PreparedReport, result: ReportResult): ReportMetaDto {
    const summary: ReportSummaryDto[] = (result.summary ?? [])
      .filter((s) => !s.cost || (prepared.costOnAllCompanies && prepared.columns.some((c) => c.cost)))
      .map((s) => ({ label: s.label, value: summaryValue(s, prepared.currencyDecimals), unit: s.kind === 'money' ? prepared.run.currency : s.unit, cost: s.cost }));
    return { ...prepared.meta, summary };
  }

  provider(code: string): ReportProvider {
    const provider = (REPORT_CODES as readonly string[]).includes(code) ? this.providers.get(code as ReportCode) : undefined;
    if (!provider) throw new NotFoundOrOutOfScopeError('Rapport');
    return provider;
  }

  /**
   * Périmètre effectif : filtre de société recoupé (404 hors périmètre) ou sociétés visibles ; pour un export,
   * les seules sociétés où reports.export est détenue ; pour le rapport des dépenses, celles où costs.read l'est.
   */
  private resolveScope(ctx: RequestContext, provider: ReportProvider, companyId: string | undefined, purpose: ReportPurpose): ReportScope {
    let companyIds: string[];
    if (companyId) {
      this.access.assertCompanyReadable(ctx, companyId);
      companyIds = [companyId];
    } else {
      companyIds = [...ctx.visibleCompanyIds];
    }
    if (purpose === 'export') {
      companyIds = companyIds.filter((c) => this.access.hasPermission(ctx, c, 'reports.export'));
      if (companyIds.length === 0) {
        throw new ForbiddenActionError(companyId ? 'Permission « reports.export » requise pour exporter les données de cette société.' : 'Export réservé aux utilisateurs disposant de la permission reports.export.', { permission: 'reports.export' });
      }
    }
    if (provider.costsRequired) {
      companyIds = companyIds.filter((c) => this.access.hasPermission(ctx, c, 'costs.read'));
      if (companyIds.length === 0) throw new ForbiddenActionError('Rapport réservé aux utilisateurs disposant de la permission costs.read (consultation des coûts).', { permission: 'costs.read' });
    }
    return {
      organizationId: ctx.organizationId,
      companyIds,
      costCompanyIds: new Set(companyIds.filter((c) => this.access.hasPermission(ctx, c, 'costs.read'))),
      visibleCompanyIds: ctx.visibleCompanyIds,
    };
  }

  /** Filtres appliqués, lisibles ; un objet filtré hors du périmètre de lecture est introuvable (404). */
  private async describeFilters(ctx: RequestContext, filters: ReportFilters, view: ReportViewDefinition, companies: ReadonlyMap<string, { code: string; legalName: string }>): Promise<ReportFilterAppliedDto[]> {
    const visible = { in: [...ctx.visibleCompanyIds] };
    const org = ctx.organizationId;
    const out: ReportFilterAppliedDto[] = [];
    for (const key of REPORT_FILTER_KEYS) {
      const value = filters[key];
      if (value === undefined) continue;
      let display: string;
      switch (key) {
        case 'companyId': {
          const c = companies.get(value);
          display = c ? `${c.code} — ${c.legalName}` : value;
          break;
        }
        case 'siteId': {
          const site = await this.prisma.client.site.findFirst({ where: { id: value, organizationId: org, companyId: visible }, select: { name: true } });
          if (!site) throw new NotFoundOrOutOfScopeError('Site');
          display = site.name;
          break;
        }
        case 'vehicleId': {
          const vehicle = await this.prisma.client.vehicle.findFirst({
            where: { id: value, organizationId: org, ...(ctx.isAdmin ? {} : { OR: [{ companyId: visible }, { companyHistory: { some: { OR: [{ fromCompanyId: visible }, { toCompanyId: visible }] } } }] }) },
            select: { code: true, registration: true },
          });
          if (!vehicle) throw new NotFoundOrOutOfScopeError('Véhicule');
          display = `${vehicle.code} · ${vehicle.registration}`;
          break;
        }
        case 'driverId': {
          const driver = await this.prisma.client.driver.findFirst({ where: { id: value, organizationId: org, companyId: visible }, select: { firstName: true, lastName: true, code: true } });
          if (!driver) throw new NotFoundOrOutOfScopeError('Conducteur');
          display = `${driver.firstName} ${driver.lastName} (${driver.code})`;
          break;
        }
        case 'categoryId': {
          const category = await this.prisma.client.vehicleCategory.findFirst({ where: { id: value, organizationId: org }, select: { label: true } });
          if (!category) throw new NotFoundOrOutOfScopeError('Catégorie');
          display = category.label;
          break;
        }
        case 'supplierId': {
          const supplier = await this.prisma.client.supplier.findFirst({ where: { id: value, organizationId: org, companyId: visible }, select: { name: true } });
          if (!supplier) throw new NotFoundOrOutOfScopeError('Fournisseur');
          display = supplier.name;
          break;
        }
        case 'maintenanceTypeId': {
          const type = await this.prisma.client.maintenanceType.findFirst({ where: { id: value, organizationId: org }, select: { label: true } });
          if (!type) throw new NotFoundOrOutOfScopeError('Type d’opération');
          display = type.label;
          break;
        }
        case 'documentTypeId': {
          const type = await this.prisma.client.documentType.findFirst({ where: { id: value, organizationId: org }, select: { label: true } });
          if (!type) throw new NotFoundOrOutOfScopeError('Type de document');
          display = type.label;
          break;
        }
        case 'from':
        case 'to':
          display = formatCivilDate(value);
          break;
        case 'vue':
          display = view.label;
          break;
        case 'status':
          display = view.statuses?.[value] ?? value;
          break;
        default:
          display = ENUM_FILTER_LABELS[key]?.[value] ?? value;
      }
      out.push({ key, label: FILTER_LABELS[key], value, display });
    }
    return out;
  }
}

function pickFilters(query: ReportFiltersDto): ReportFilters {
  const filters: ReportFilters = {};
  const source = query as unknown as Record<string, unknown>;
  for (const key of REPORT_FILTER_KEYS) {
    const value = source[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed !== '') filters[key] = trimmed;
  }
  return filters;
}

/** Période en dates civiles locales incluses ; défaut : du premier jour du mois courant à aujourd'hui (D-269). */
function resolvePeriod(filters: ReportFilters, timezone: string, now: Date): ReportPeriod {
  const today = localDate(now, timezone);
  const from = filters.from ?? `${today.slice(0, 8)}01`;
  const to = filters.to ?? today;
  for (const [key, value] of [['from', from], ['to', to]] as const) {
    try {
      assertCivilDate(value);
    } catch {
      throw new BusinessRuleError('DATE_INVALIDE', 'Date inexistante.', { fieldErrors: { [key]: ['Date civile inexistante (AAAA-MM-JJ).'] } });
    }
  }
  if (from > to) throw new BusinessRuleError('PERIODE_INVALIDE', 'La fin de période précède son début.', { fieldErrors: { to: ['Fin avant le début.'] } });
  filters.from = from;
  filters.to = to;
  return { from, to, start: startOfLocalDay(from, timezone), end: endOfLocalDay(to, timezone) };
}

function toDecimalValue(value: RawValue): Decimal | null {
  if (value === null) return null;
  if (value instanceof Decimal) return value;
  if (typeof value === 'number' || typeof value === 'string') return new Decimal(value);
  return null;
}

/** Sérialisation JSON d'une cellule selon la nature de la colonne (décimaux en chaînes exactes arrondies à l'affichage). */
export function jsonValue(col: ReportColumn, value: RawValue): unknown {
  if (value === null) return null;
  switch (col.kind) {
    case 'decimal':
    case 'money': {
      const d = toDecimalValue(value);
      return d === null ? null : columnDecimalText(col, d, col.decimals ?? 3);
    }
    case 'integer':
      return typeof value === 'number' ? value : Number(value);
    case 'boolean':
      return value === true;
    case 'datetime':
      return value instanceof Date ? value.toISOString() : String(value);
    default:
      return value instanceof Date ? value.toISOString() : String(value);
  }
}

function summaryValue(s: ReportSummaryItem, currencyDecimals: number): string | null {
  const d = toDecimalValue(s.value);
  if (!d) return null;
  return s.kind === 'integer' ? d.toFixed(0) : d.toFixed(s.kind === 'money' ? currencyDecimals : 3);
}

/** Unités et conventions rappelées dans l'écran et l'export (D-270). */
export function unitsOf(columns: readonly ReportColumn[], timezone: string, currency: string): string[] {
  const units: string[] = [];
  const add = (text: string) => {
    if (!units.includes(text)) units.push(text);
  };
  for (const c of columns) {
    if (c.kind === 'money') add(c.perUnit ? `Coûts rapportés en ${currency}/${c.perUnit}.` : `Montants en ${currency} TTC.`);
    else if (c.unit === 'km') add('Distances et compteurs en kilomètres (km).');
    else if (c.unit === 'L') add('Volumes en litres (L).');
    else if (c.unit === CONSUMPTION_UNIT) add(`Consommation en ${CONSUMPTION_UNIT} : estimation fondée sur les pleins saisis.`);
    else if (c.unit === 'jours') add('Durées en jours.');
    else if (c.unit === 'minutes') add('Retards en minutes.');
    else if (c.unit === '%') add('Couverture en pourcentage de la période demandée.');
  }
  if (columns.some((c) => c.kind === 'datetime')) add(`Horodatages en heure locale du groupe (${timezone}).`);
  if (columns.some((c) => c.kind === 'date')) add('Dates civiles locales.');
  return units;
}
