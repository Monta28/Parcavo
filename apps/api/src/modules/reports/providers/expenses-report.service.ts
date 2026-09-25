import { Injectable } from '@nestjs/common';
import { type ExpenseCategory, Prisma } from '@parc-auto/db';
import { EXPENSE_CATEGORY_LABELS } from '@parc-auto/contracts';
import { fromDbDate } from '../../../domain/civil-date.js';
import { COUNTED_EXPENSE_STATUS, EXPENSE_CATEGORIES, UNALLOCATED_EXPENSE_LABEL, UNALLOCATED_LINE_LABEL, signedAmount, summarizeLedger, type LedgerRow, type LedgerSummary } from '../../../domain/expense-ledger.js';
import { PrismaService } from '../../../infra/prisma.service.js';
import { EXPENSE_KIND_LABELS, EXPENSE_SOURCE_LABELS, civilRange, dec, vehicleRelation } from '../report-support.js';
import { TEXT_ORDER, and, enumEq, scopeSql, uuidEq, vehicleRelationSql, windowSql } from '../report-sql.js';
import { type ReportColumn, type ReportProvider, type ReportResult, type ReportRow, type ReportRun, type ReportViewDefinition, type ReportWindow, scopeWhere } from '../report-types.js';

const expenseSelect = {
  id: true,
  companyId: true,
  vehicleId: true,
  supplierId: true,
  occurredOn: true,
  category: true,
  kind: true,
  status: true,
  amount: true,
  reference: true,
  sourceType: true,
  excludedFromOperatingCost: true,
  vehicle: { select: { code: true, registration: true } },
  supplier: { select: { name: true } },
} satisfies Prisma.ExpenseSelect;

type ExpenseRow = Prisma.ExpenseGetPayload<{ select: typeof expenseSelect }>;

const GROUP_LABELS: Record<string, string> = { categorie: 'Catégorie', vehicule: 'Véhicule', societe: 'Société', fournisseur: 'Fournisseur' };
const PERIOD_FILTERS = ['companyId', 'siteId', 'vehicleId', 'categoryId', 'supplierId', 'category', 'from', 'to'] as const;

/**
 * Dépenses par catégorie, véhicule, société ou fournisseur (CDC 11.2, 8.4 ; D-229, D-230, D-233, D-269) :
 * registre unique, synthèse par expense-ledger.ts — dépenses VALIDEE moins AVOIR, hors
 * excludedFromOperatingCost pour le coût d'exploitation ; dépenses sans véhicule en ligne « Non ventilé ».
 * Rapport entièrement réservé à costs.read (D-266) : le périmètre ne contient que ces sociétés.
 */
@Injectable()
export class ExpensesReportService implements ReportProvider {
  readonly code = 'depenses' as const;
  readonly label = 'Dépenses';
  readonly description = 'Coût d’exploitation (dépenses validées moins avoirs) par catégorie, véhicule, société ou fournisseur, et détail des lignes.';
  readonly costsRequired = true;
  readonly views: readonly ReportViewDefinition[] = [
    { code: 'categorie', label: 'Par catégorie', period: true, filters: PERIOD_FILTERS },
    { code: 'vehicule', label: 'Par véhicule', period: true, filters: PERIOD_FILTERS },
    { code: 'societe', label: 'Par société', period: true, filters: PERIOD_FILTERS },
    { code: 'fournisseur', label: 'Par fournisseur', period: true, filters: PERIOD_FILTERS },
    { code: 'detail', label: 'Détail des lignes', period: true, filters: PERIOD_FILTERS },
  ];

  constructor(private readonly prisma: PrismaService) {}

  columns(view: string): ReportColumn[] {
    if (view === 'detail') {
      return [
        { key: 'occurredOn', label: 'Date', unit: null, kind: 'date' },
        { key: 'company', label: 'Société', unit: null, kind: 'text' },
        { key: 'vehicle', label: 'Véhicule', unit: null, kind: 'text' },
        { key: 'category', label: 'Catégorie', unit: null, kind: 'enum', labels: EXPENSE_CATEGORY_LABELS },
        { key: 'kind', label: 'Type', unit: null, kind: 'enum', labels: EXPENSE_KIND_LABELS },
        { key: 'supplier', label: 'Fournisseur', unit: null, kind: 'text' },
        { key: 'reference', label: 'Référence', unit: null, kind: 'text' },
        { key: 'source', label: 'Origine', unit: null, kind: 'enum', labels: EXPENSE_SOURCE_LABELS, missing: 'Saisie directe' },
        { key: 'amount', label: 'Montant TTC', unit: null, kind: 'money', cost: true },
        { key: 'signedAmount', label: 'Montant signé (avoir négatif)', unit: null, kind: 'money', cost: true },
        { key: 'excluded', label: 'Hors coût d’exploitation', unit: null, kind: 'boolean' },
      ];
    }
    const head: ReportColumn[] =
      view === 'vehicule'
        ? [
            { key: 'label', label: GROUP_LABELS[view] ?? 'Regroupement', unit: null, kind: 'text' },
            { key: 'registration', label: 'Immatriculation', unit: null, kind: 'text' },
            { key: 'company', label: 'Société', unit: null, kind: 'text' },
          ]
        : view === 'societe'
          ? [{ key: 'company', label: 'Société', unit: null, kind: 'text' }]
          : [{ key: 'label', label: GROUP_LABELS[view] ?? 'Regroupement', unit: null, kind: 'text' }];
    return [
      ...head,
      { key: 'expenses', label: 'Dépenses', unit: null, kind: 'money', cost: true },
      { key: 'credits', label: 'Avoirs', unit: null, kind: 'money', cost: true },
      { key: 'operatingNet', label: 'Coût d’exploitation net', unit: null, kind: 'money', cost: true },
      { key: 'excludedNet', label: 'Hors coût d’exploitation (net)', unit: null, kind: 'money', cost: true },
      { key: 'count', label: 'Lignes', unit: null, kind: 'integer' },
    ];
  }

  notes(view: string): string[] {
    const notes = ['Seules les dépenses validées comptent, à leur date d’origine et dans leur société historique ; un avoir réduit le coût.', 'Coût d’exploitation : hors dépenses exclues (achat de véhicule par défaut), conservées à titre informatif.'];
    if (view === 'vehicule') notes.push(`Les dépenses sans véhicule forment la ligne « ${UNALLOCATED_LINE_LABEL} », jamais répartie.`);
    return notes;
  }

  async fetch(run: ReportRun, window: ReportWindow): Promise<ReportResult> {
    const where = this.where(run);
    const [summary, page] = await Promise.all([this.ledgerTotals(where), run.view === 'detail' ? this.details(where, window) : this.groups(run, where, window)]);
    const totals = [
      { label: 'Coût d’exploitation net', value: summary.operating.net, kind: 'money' as const, unit: null, cost: true },
      { label: `dont ${UNALLOCATED_LINE_LABEL.toLowerCase()} (sans véhicule)`, value: summary.unallocated.net, kind: 'money' as const, unit: null, cost: true },
      { label: 'Hors coût d’exploitation (net)', value: summary.excluded.net, kind: 'money' as const, unit: null, cost: true },
      { label: 'Lignes validées', value: summary.operating.count + summary.excluded.count, kind: 'integer' as const, unit: null, cost: false },
    ];
    return { ...page, summary: totals };
  }

  /** Dépenses comptées (validées) de la sélection : filtres de la vue et périmètre. */
  private where(run: ReportRun): Prisma.ExpenseWhereInput {
    const f = run.filters;
    return {
      ...scopeWhere(run.scope),
      status: COUNTED_EXPENSE_STATUS,
      occurredOn: civilRange(run.period),
      ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}),
      ...(f.supplierId ? { supplierId: f.supplierId } : {}),
      ...(f.category ? { category: f.category as ExpenseCategory } : {}),
      ...vehicleRelation(f),
    };
  }

  /** Même sélection que where(), en SQL (alias e : dépense, v : véhicule courant). */
  private whereSql(run: ReportRun): Prisma.Sql {
    const f = run.filters;
    return and([
      scopeSql('e', run.scope),
      Prisma.sql`"e"."status" = ${COUNTED_EXPENSE_STATUS}::"ExpenseStatus"`,
      run.period ? Prisma.sql`"e"."occurredOn" BETWEEN ${run.period.from}::date AND ${run.period.to}::date` : null,
      uuidEq('e', 'vehicleId', f.vehicleId),
      uuidEq('e', 'supplierId', f.supplierId),
      enumEq('e', 'category', 'ExpenseCategory', f.category),
      ...vehicleRelationSql('v', f),
    ]);
  }

  /**
   * Totaux de la sélection entière : agrégés en base par nature (catégorie, dépense/avoir, exclusion,
   * affectation à un véhicule), puis synthétisés par la règle unique (expense-ledger.ts).
   */
  private async ledgerTotals(where: Prisma.ExpenseWhereInput): Promise<LedgerSummary> {
    const [allocated, unallocated] = await Promise.all([this.aggregate({ AND: [where, { vehicleId: { not: null } }] }), this.aggregate({ AND: [where, { vehicleId: null }] })]);
    // Seule l'absence de véhicule compte pour la synthèse (ligne « Non ventilé ») : un marqueur non nul suffit.
    return summarizeLedger([...allocated.map((g) => ({ ...g, vehicleId: 'vehicule' })), ...unallocated.map((g) => ({ ...g, vehicleId: null }))]);
  }

  private async aggregate(where: Prisma.ExpenseWhereInput): Promise<LedgerRow[]> {
    const groups = await this.prisma.client.expense.groupBy({ by: ['category', 'kind', 'status', 'excludedFromOperatingCost'], where, _sum: { amount: true }, _count: { _all: true } });
    return groups.map((g) => ({ category: g.category, kind: g.kind, status: g.status, excludedFromOperatingCost: g.excludedFromOperatingCost, amount: (g._sum.amount ?? 0).toString(), count: g._count._all, vehicleId: null }));
  }

  private async details(where: Prisma.ExpenseWhereInput, window: ReportWindow): Promise<Pick<ReportResult, 'rows' | 'total'>> {
    const [items, total] = await Promise.all([
      this.prisma.client.expense.findMany({ where, orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }], skip: window.skip, take: window.take, select: expenseSelect }),
      this.prisma.client.expense.count({ where }),
    ]);
    return { rows: items.map((e) => this.detailRow(e)), total };
  }

  /**
   * Regroupements paginés en base : PostgreSQL calcule les groupes de la sélection, leur ordre (catégories dans
   * l'ordre du CDC ; véhicules par code puis « Non ventilé » par société ; sociétés ; fournisseurs par nom puis
   * « Sans fournisseur ») et la page ; seuls les groupes de la page sont agrégés par nature pour la synthèse.
   */
  private async groups(run: ReportRun, where: Prisma.ExpenseWhereInput, window: ReportWindow): Promise<Pick<ReportResult, 'rows' | 'total'>> {
    const spec = GROUP_SQL[run.view as GroupView];
    const filtered = Prisma.sql`FROM "Expense" "e" LEFT JOIN "Vehicle" "v" ON "v"."id" = "e"."vehicleId" LEFT JOIN "Supplier" "s" ON "s"."id" = "e"."supplierId" WHERE ${this.whereSql(run)}`;
    const [page, counted] = await Promise.all([
      this.prisma.client.$queryRaw<GroupHead[]>`SELECT ${spec.select} ${filtered} GROUP BY ${spec.groupBy} ORDER BY ${spec.orderBy} ${windowSql(window)}`,
      this.prisma.client.$queryRaw<Array<{ total: number }>>`SELECT COUNT(*)::int AS "total" FROM (SELECT 1 ${filtered} GROUP BY ${spec.groupBy}) "g"`,
    ]);
    const total = counted[0]?.total ?? 0;
    if (page.length === 0) return { rows: [], total };
    const heads = page.map((g) => ({ ...g, key: groupKey(run.view as GroupView, g) }));
    const ledgers = await this.pageLedgers(run.view as GroupView, where, heads);
    return {
      total,
      rows: heads.map((head) => {
        const rows = ledgers.get(head.key) ?? [];
        const s = summarizeLedger(rows);
        const label: string | null = run.view === 'categorie' ? EXPENSE_CATEGORY_LABELS[head.category as ExpenseCategory] : run.view === 'vehicule' ? (head.vehicleId ? (head.code ?? null) : UNALLOCATED_LINE_LABEL) : run.view === 'fournisseur' ? (head.supplierId ? (head.supplierName ?? null) : 'Sans fournisseur') : null;
        return {
          id: head.key,
          companyId: run.view === 'vehicule' || run.view === 'societe' ? head.companyId : null,
          values: {
            ...(run.view === 'societe' ? { company: null } : { label }),
            ...(run.view === 'vehicule' ? { registration: head.vehicleId ? (head.registration ?? null) : null, company: null } : {}),
            expenses: s.operating.expenses.plus(s.excluded.expenses),
            credits: s.operating.credits.plus(s.excluded.credits),
            operatingNet: s.operating.net,
            excludedNet: s.excluded.net,
            count: s.operating.count + s.excluded.count,
          },
        };
      }),
    };
  }

  /**
   * Lignes agrégées (par nature) des seuls groupes de la page, par la sélection Prisma d'origine. Agrégation sur
   * la seule clé de la vue et la nature (catégorie, type, statut, exclusion) : le nombre de lignes lues dépend
   * de la page, pas du nombre de véhicules servis par un fournisseur ou une catégorie (CDC 17.2).
   */
  private async pageLedgers(view: GroupView, where: Prisma.ExpenseWhereInput, heads: Array<GroupHead & { key: string }>): Promise<Map<string, LedgerRow[]>> {
    const ids = (pick: (h: GroupHead) => string | null) => [...new Set(heads.map(pick).filter((x): x is string => x !== null))];
    const restriction: Prisma.ExpenseWhereInput =
      view === 'categorie'
        ? { category: { in: heads.map((h) => h.category as ExpenseCategory) } }
        : view === 'societe'
          ? { companyId: { in: ids((h) => h.companyId) } }
          : view === 'vehicule'
            ? { OR: [{ vehicleId: { in: ids((h) => h.vehicleId) } }, { vehicleId: null, companyId: { in: ids((h) => (h.vehicleId ? null : h.companyId)) } }] }
            : { OR: [{ supplierId: { in: ids((h) => h.supplierId) } }, ...(heads.some((h) => h.supplierId === null) ? [{ supplierId: null }] : [])] };
    const groups = await this.prisma.client.expense.groupBy({
      by: [...GROUP_KEY_COLUMNS[view], 'category', 'kind', 'status', 'excludedFromOperatingCost'],
      where: { AND: [where, restriction] },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const out = new Map<string, LedgerRow[]>();
    for (const g of groups) {
      const keys = g as { companyId?: string; vehicleId?: string | null; supplierId?: string | null };
      const key = groupKey(view, { category: g.category, companyId: keys.companyId ?? null, vehicleId: keys.vehicleId ?? null, supplierId: keys.supplierId ?? null });
      const list = out.get(key) ?? [];
      // Véhicule connu seulement pour la vue par véhicule ; ailleurs, la part « Non ventilé » de la synthèse n'est pas affichée par groupe.
      list.push({ category: g.category, kind: g.kind, status: g.status, excludedFromOperatingCost: g.excludedFromOperatingCost, vehicleId: keys.vehicleId ?? null, amount: (g._sum.amount ?? 0).toString(), count: g._count._all });
      out.set(key, list);
    }
    return out;
  }

  private detailRow(e: ExpenseRow): ReportRow {
    return {
      id: e.id,
      companyId: e.companyId,
      values: {
        occurredOn: fromDbDate(e.occurredOn),
        company: null,
        vehicle: e.vehicle ? `${e.vehicle.code} · ${e.vehicle.registration}` : UNALLOCATED_EXPENSE_LABEL,
        category: e.category,
        kind: e.kind,
        supplier: e.supplier?.name ?? null,
        reference: e.reference,
        source: e.sourceType,
        amount: dec(e.amount),
        signedAmount: signedAmount(e.kind, e.amount.toString()),
        excluded: e.excludedFromOperatingCost,
      },
    };
  }
}

type GroupView = 'categorie' | 'vehicule' | 'societe' | 'fournisseur';

interface GroupHead {
  category?: string;
  companyId: string | null;
  vehicleId: string | null;
  code?: string | null;
  registration?: string | null;
  supplierId: string | null;
  supplierName?: string | null;
}

/** Clé stable d'un groupe (identifiant de ligne) : identique à l'ancienne clé de regroupement en mémoire. */
function groupKey(view: GroupView, g: { category?: string; companyId: string | null; vehicleId: string | null; supplierId: string | null }): string {
  switch (view) {
    case 'categorie':
      return g.category as string;
    case 'vehicule':
      return g.vehicleId ? `${g.companyId}:${g.vehicleId}` : `${g.companyId}:non-ventile`;
    case 'societe':
      return g.companyId as string;
    default:
      return g.supplierId ?? 'sans-fournisseur';
  }
}

/** Colonnes de la clé de regroupement de chaque vue (groupKey), seules agrégées avec la nature des dépenses. */
const GROUP_KEY_COLUMNS: Record<GroupView, Array<'category' | 'companyId' | 'vehicleId' | 'supplierId'>> = {
  // La catégorie fait déjà partie de la nature agrégée.
  categorie: [],
  vehicule: ['companyId', 'vehicleId'],
  societe: ['companyId'],
  fournisseur: ['supplierId'],
};

const NONE = Prisma.sql`NULL::uuid`;

/**
 * Colonnes, regroupement et ordre SQL de chaque vue groupée. Fournisseurs de même nom : ordre de première
 * apparition dans le détail (date, saisie, identifiant), comme le regroupement en mémoire qu'il remplace.
 */
const GROUP_SQL: Record<GroupView, { select: Prisma.Sql; groupBy: Prisma.Sql; orderBy: Prisma.Sql }> = {
  categorie: {
    select: Prisma.sql`"e"."category"::text AS "category", ${NONE} AS "companyId", ${NONE} AS "vehicleId", ${NONE} AS "supplierId"`,
    groupBy: Prisma.sql`"e"."category"`,
    orderBy: Prisma.sql`array_position(${[...EXPENSE_CATEGORIES]}::text[], "e"."category"::text)`,
  },
  vehicule: {
    select: Prisma.sql`"e"."companyId", "e"."vehicleId", "v"."code", "v"."registration", ${NONE} AS "supplierId"`,
    groupBy: Prisma.sql`"e"."companyId", "e"."vehicleId", "v"."code", "v"."registration"`,
    orderBy: Prisma.sql`("e"."vehicleId" IS NULL), "v"."code" ${TEXT_ORDER}, "e"."companyId"`,
  },
  societe: {
    select: Prisma.sql`"e"."companyId", ${NONE} AS "vehicleId", ${NONE} AS "supplierId"`,
    groupBy: Prisma.sql`"e"."companyId"`,
    orderBy: Prisma.sql`"e"."companyId"`,
  },
  fournisseur: {
    select: Prisma.sql`${NONE} AS "companyId", ${NONE} AS "vehicleId", "e"."supplierId", "s"."name" AS "supplierName"`,
    groupBy: Prisma.sql`"e"."supplierId", "s"."name"`,
    orderBy: Prisma.sql`("e"."supplierId" IS NULL), "s"."name" ${TEXT_ORDER}, MAX(ARRAY["e"."occurredOn"::text, to_char("e"."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS')]) DESC, MIN("e"."id"::text)`,
  },
};
