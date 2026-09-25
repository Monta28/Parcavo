import { Injectable } from '@nestjs/common';
import { type ImmobilizationCauseKind, type ImmobilizationStatus, type IncidentSeverity, type IncidentStatus, type IncidentType, Prisma } from '@parc-auto/db';
import { INCIDENT_SEVERITY_LABELS, INCIDENT_STATUS_LABELS, INCIDENT_TYPE_LABELS } from '@parc-auto/contracts';
import { immobilizationIntervals } from '../../../domain/immobilization-duration.js';
import { durationDays, unionWithinPeriod, type OpenInterval } from '../../../domain/interval-union.js';
import { PrismaService } from '../../../infra/prisma.service.js';
import { CAUSE_KIND_LABELS, IMMOBILIZATION_STATUS_LABELS, instantRange, personName, vehicleRelation } from '../report-support.js';
import { TEXT_ORDER, and, enumEq, scopeSql, uuidEq, vehicleRelationSql, windowSql } from '../report-sql.js';
import { type ReportColumn, type ReportProvider, type ReportResult, type ReportRow, type ReportRun, type ReportViewDefinition, type ReportWindow, scopeWhere } from '../report-types.js';

/** Durée (ms) de l'union d'un groupe : somme exacte des intervalles disjoints du multirange (0 sans intervalle retenu). */
const UNION_MS = Prisma.sql`COALESCE((SELECT SUM(EXTRACT(EPOCH FROM upper("r")) - EXTRACT(EPOCH FROM lower("r"))) * 1000 FROM unnest("dur"."u") AS "r"), 0)::float8`;

const OVERLAP_NOTE = 'Les causes se chevauchent : la somme des durées par cause peut dépasser la durée d’immobilisation du véhicule.';

interface ImmobilizationGroup {
  key: string;
  companyId: string;
  vehicle: string;
  registration: string;
  intervals: OpenInterval[];
  count: number;
  causes: Set<string>;
}

/**
 * Incidents et durées d'immobilisation (CDC 11.2, 7.3, 7.4 ; D-271). Incidents survenus dans la période ;
 * durée d'immobilisation par véhicule = union des intervalles (fin réelle, ou min(maintenant, fin de
 * période) si en cours, libellé « en cours ») découpée à la période ; ventilation par cause avec la mention
 * « les causes se chevauchent ». Durées en jours, une décimale.
 */
@Injectable()
export class IncidentsReportService implements ReportProvider {
  readonly code = 'incidents-immobilisations' as const;
  readonly label = 'Incidents et immobilisations';
  readonly description = 'Incidents de la période ; durées d’immobilisation par véhicule (union des intervalles) et ventilation par cause.';
  readonly costsRequired = false;
  readonly views: readonly ReportViewDefinition[] = [
    { code: 'incidents', label: 'Incidents', period: true, filters: ['companyId', 'siteId', 'vehicleId', 'driverId', 'categoryId', 'from', 'to', 'status', 'incidentType', 'severity'], statuses: INCIDENT_STATUS_LABELS },
    { code: 'immobilisations', label: 'Durées d’immobilisation', period: true, filters: ['companyId', 'siteId', 'vehicleId', 'categoryId', 'from', 'to', 'status'], statuses: IMMOBILIZATION_STATUS_LABELS },
    { code: 'causes', label: 'Ventilation par cause', period: true, filters: ['companyId', 'siteId', 'vehicleId', 'categoryId', 'from', 'to'] },
  ];

  constructor(private readonly prisma: PrismaService) {}

  columns(view: string): ReportColumn[] {
    if (view === 'immobilisations') {
      return [
        { key: 'vehicle', label: 'Véhicule', unit: null, kind: 'text' },
        { key: 'registration', label: 'Immatriculation', unit: null, kind: 'text' },
        { key: 'company', label: 'Société', unit: null, kind: 'text' },
        { key: 'immobilizations', label: 'Immobilisations', unit: null, kind: 'integer' },
        { key: 'durationDays', label: 'Durée immobilisée (période)', unit: 'jours', kind: 'decimal', decimals: 1 },
        { key: 'state', label: 'État', unit: null, kind: 'enum', labels: IMMOBILIZATION_STATUS_LABELS },
        { key: 'firstStart', label: 'Début (dans la période)', unit: null, kind: 'datetime' },
        { key: 'lastEnd', label: 'Fin (dans la période)', unit: null, kind: 'datetime' },
        { key: 'causes', label: 'Causes', unit: null, kind: 'text' },
      ];
    }
    if (view === 'causes') {
      return [
        { key: 'vehicle', label: 'Véhicule', unit: null, kind: 'text' },
        { key: 'registration', label: 'Immatriculation', unit: null, kind: 'text' },
        { key: 'company', label: 'Société', unit: null, kind: 'text' },
        { key: 'causeKind', label: 'Cause', unit: null, kind: 'enum', labels: CAUSE_KIND_LABELS },
        { key: 'causes', label: 'Nombre de causes', unit: null, kind: 'integer' },
        { key: 'durationDays', label: 'Durée (période)', unit: 'jours', kind: 'decimal', decimals: 1 },
        { key: 'state', label: 'État', unit: null, kind: 'enum', labels: IMMOBILIZATION_STATUS_LABELS },
        { key: 'reasons', label: 'Motifs', unit: null, kind: 'text' },
      ];
    }
    return [
      { key: 'occurredAt', label: 'Survenu le', unit: null, kind: 'datetime' },
      { key: 'reference', label: 'Référence', unit: null, kind: 'text' },
      { key: 'vehicle', label: 'Véhicule', unit: null, kind: 'text' },
      { key: 'registration', label: 'Immatriculation', unit: null, kind: 'text' },
      { key: 'company', label: 'Société', unit: null, kind: 'text' },
      { key: 'driver', label: 'Conducteur', unit: null, kind: 'text' },
      { key: 'type', label: 'Type', unit: null, kind: 'enum', labels: INCIDENT_TYPE_LABELS },
      { key: 'severity', label: 'Gravité', unit: null, kind: 'enum', labels: INCIDENT_SEVERITY_LABELS },
      { key: 'status', label: 'Statut', unit: null, kind: 'enum', labels: INCIDENT_STATUS_LABELS },
      { key: 'immobilizing', label: 'A immobilisé le véhicule', unit: null, kind: 'boolean' },
      { key: 'resolvedAt', label: 'Résolu le', unit: null, kind: 'datetime' },
      { key: 'closedAt', label: 'Clôturé le', unit: null, kind: 'datetime' },
      { key: 'description', label: 'Description', unit: null, kind: 'text' },
    ];
  }

  notes(view: string): string[] {
    if (view === 'causes') return [OVERLAP_NOTE, 'Durée par cause : union des intervalles de cette nature pour le véhicule, découpée à la période.'];
    if (view === 'immobilisations') return ['Durée : union des intervalles d’immobilisation du véhicule, découpée à la période ; une immobilisation en cours est comptée jusqu’à maintenant (ou la fin de période) et libellée « En cours ».', OVERLAP_NOTE];
    return ['Incidents survenus dans la période, rattachés à leur société historique.'];
  }

  async fetch(run: ReportRun, window: ReportWindow): Promise<ReportResult> {
    if (run.view === 'immobilisations') return this.immobilizations(run, window);
    if (run.view === 'causes') return this.causes(run, window);
    return this.incidents(run, window);
  }

  private async incidents(run: ReportRun, window: ReportWindow): Promise<ReportResult> {
    const f = run.filters;
    const where: Prisma.IncidentWhereInput = {
      ...scopeWhere(run.scope),
      occurredAt: instantRange(run.period),
      ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}),
      ...(f.driverId ? { driverId: f.driverId } : {}),
      ...(f.status ? { status: f.status as IncidentStatus } : {}),
      ...(f.incidentType ? { type: f.incidentType as IncidentType } : {}),
      ...(f.severity ? { severity: f.severity as IncidentSeverity } : {}),
      ...vehicleRelation(f),
    };
    const [items, total] = await Promise.all([
      this.prisma.client.incident.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { reference: 'desc' }],
        skip: window.skip,
        take: window.take,
        select: {
          id: true,
          companyId: true,
          reference: true,
          occurredAt: true,
          type: true,
          severity: true,
          status: true,
          resolvedAt: true,
          closedAt: true,
          description: true,
          vehicle: { select: { code: true, registration: true } },
          driver: { select: { firstName: true, lastName: true } },
          _count: { select: { immobilizationCauses: true } },
        },
      }),
      this.prisma.client.incident.count({ where }),
    ]);
    return {
      total,
      rows: items.map((i) => ({
        id: i.id,
        companyId: i.companyId,
        values: {
          occurredAt: i.occurredAt,
          reference: i.reference,
          vehicle: i.vehicle.code,
          registration: i.vehicle.registration,
          company: null,
          driver: personName(i.driver),
          type: i.type,
          severity: i.severity,
          status: i.status,
          immobilizing: i._count.immobilizationCauses > 0,
          resolvedAt: i.resolvedAt,
          closedAt: i.closedAt,
          description: i.description,
        },
      })),
    };
  }

  private immobilizationWhere(run: ReportRun): Prisma.ImmobilizationWhereInput {
    const f = run.filters;
    const period = run.period;
    return {
      ...scopeWhere(run.scope),
      ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}),
      ...(f.status ? { status: f.status as ImmobilizationStatus } : {}),
      ...vehicleRelation(f),
      ...(period ? { startedAt: { lte: period.end }, OR: [{ endedAt: null }, { endedAt: { gte: period.start } }] } : {}),
    };
  }

  /** Même sélection que immobilizationWhere(), en SQL (alias i : immobilisation, v : véhicule courant). */
  private immobilizationSql(run: ReportRun): Prisma.Sql {
    const f = run.filters;
    const period = run.period;
    return Prisma.sql`SELECT "i"."id", "i"."companyId", "i"."vehicleId", "i"."startedAt", "i"."endedAt"
      FROM "Immobilization" "i" JOIN "Vehicle" "v" ON "v"."id" = "i"."vehicleId"
      WHERE ${and([
        scopeSql('i', run.scope),
        uuidEq('i', 'vehicleId', f.vehicleId),
        enumEq('i', 'status', 'ImmobilizationStatus', f.status),
        ...vehicleRelationSql('v', f),
        period ? Prisma.sql`"i"."startedAt" <= ${period.end}::timestamptz AND ("i"."endedAt" IS NULL OR "i"."endedAt" >= ${period.start}::timestamptz)` : null,
      ])}`;
  }

  /**
   * Intervalles découpés à la période puis unis par PostgreSQL (range_agg), traduction de unionWithinPeriod
   * (interval-union.ts) : intervalle en cours borné à min(maintenant, fin de période), début et fin bornés à la
   * période, intervalles vides écartés ; durée = somme des intervalles disjoints de l'union (ms).
   */
  private unionSql(run: ReportRun, intervals: Prisma.Sql, keys: Prisma.Sql): Prisma.Sql {
    const period = run.period ?? { start: new Date(0), end: run.now };
    return Prisma.sql`SELECT ${keys}, range_agg(tstzrange("cs", "ce", '[)')) AS "u"
      FROM (SELECT *, GREATEST("s", ${period.start}::timestamptz) AS "cs", LEAST(COALESCE("e", LEAST(${run.now}::timestamptz, ${period.end}::timestamptz)), ${period.end}::timestamptz) AS "ce" FROM (${intervals}) "iv") "clipped"
      WHERE "ce" > "cs" GROUP BY ${keys}`;
  }

  /**
   * Durées par véhicule, paginées en base : PostgreSQL calcule l'union des intervalles (causes, ou à défaut
   * l'immobilisation elle-même : immobilizationIntervals), l'ordre (durée décroissante, code du véhicule) et la
   * page ; les valeurs affichées sont recalculées pour les véhicules de la page par les règles du domaine.
   */
  private async immobilizations(run: ReportRun, window: ReportWindow): Promise<ReportResult> {
    const intervals = Prisma.sql`SELECT "imm"."companyId", "imm"."vehicleId", "c"."startedAt" AS "s", "c"."endedAt" AS "e" FROM "imm" JOIN "ImmobilizationCause" "c" ON "c"."immobilizationId" = "imm"."id"
      UNION ALL
      SELECT "imm"."companyId", "imm"."vehicleId", "imm"."startedAt", "imm"."endedAt" FROM "imm" WHERE NOT EXISTS (SELECT 1 FROM "ImmobilizationCause" "c" WHERE "c"."immobilizationId" = "imm"."id")`;
    const cte = Prisma.sql`WITH "imm" AS (${this.immobilizationSql(run)}),
      "dur" AS (${this.unionSql(run, intervals, Prisma.sql`"companyId", "vehicleId"`)}),
      "g" AS (SELECT "companyId", "vehicleId", MIN("startedAt") AS "first" FROM "imm" GROUP BY "companyId", "vehicleId")`;
    const [page, counted] = await Promise.all([
      this.prisma.client.$queryRaw<Array<{ companyId: string; vehicleId: string }>>`${cte}
        SELECT "g"."companyId", "g"."vehicleId", ${UNION_MS} AS "ms"
        FROM "g" JOIN "Vehicle" "vv" ON "vv"."id" = "g"."vehicleId" LEFT JOIN "dur" ON "dur"."companyId" = "g"."companyId" AND "dur"."vehicleId" = "g"."vehicleId"
        ORDER BY "ms" DESC, "vv"."code" ${TEXT_ORDER}, "g"."first", "g"."companyId" ${windowSql(window)}`,
      this.prisma.client.$queryRaw<Array<{ total: number }>>`${cte} SELECT COUNT(*)::int AS "total" FROM "g"`,
    ]);
    const total = counted[0]?.total ?? 0;
    if (page.length === 0) return { rows: [], total };
    const items = await this.prisma.client.immobilization.findMany({
      where: { AND: [this.immobilizationWhere(run), { vehicleId: { in: [...new Set(page.map((p) => p.vehicleId))] } }] },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, companyId: true, vehicleId: true, startedAt: true, endedAt: true, vehicle: { select: { code: true, registration: true } }, causes: { select: { reason: true, startedAt: true, endedAt: true }, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] } },
    });
    const groups = new Map<string, ImmobilizationGroup>();
    for (const i of items) {
      const key = `${i.companyId}:${i.vehicleId}`;
      const g = groups.get(key) ?? { key, companyId: i.companyId, vehicle: i.vehicle.code, registration: i.vehicle.registration, intervals: [], count: 0, causes: new Set<string>() };
      // Même règle que la fiche d'immobilisation : union des intervalles des causes (D-219, D-271).
      g.intervals.push(...immobilizationIntervals(i.causes, { start: i.startedAt, end: i.endedAt }));
      g.count += 1;
      for (const c of i.causes) g.causes.add(c.reason);
      groups.set(key, g);
    }
    const rows: ReportRow[] = [];
    for (const { companyId, vehicleId } of page) {
      const g = groups.get(`${companyId}:${vehicleId}`);
      if (!g) continue;
      const union = this.union(run, g.intervals);
      rows.push({
        id: g.key,
        companyId: g.companyId,
        values: {
          vehicle: g.vehicle,
          registration: g.registration,
          company: null,
          immobilizations: g.count,
          durationDays: durationDays(union.totalMs),
          state: union.ongoing ? 'ACTIVE' : 'TERMINEE',
          firstStart: union.intervals[0]?.start ?? null,
          lastEnd: union.intervals.at(-1)?.end ?? null,
          causes: [...g.causes].join(' ; ') || null,
        },
      });
    }
    return { rows, total };
  }

  /**
   * Ventilation par cause, paginée en base : union par véhicule et nature de cause (une cause restée ouverte
   * sur une immobilisation terminée s'arrête avec elle), groupes sans durée dans la période écartés, ordre
   * (code du véhicule, durée décroissante) et page calculés par PostgreSQL ; valeurs de la page recalculées.
   */
  private async causes(run: ReportRun, window: ReportWindow): Promise<ReportResult> {
    const intervals = Prisma.sql`SELECT "imm"."companyId", "imm"."vehicleId", "c"."kind"::text AS "kind", "c"."startedAt" AS "s", COALESCE("c"."endedAt", "imm"."endedAt") AS "e" FROM "imm" JOIN "ImmobilizationCause" "c" ON "c"."immobilizationId" = "imm"."id"`;
    const cte = Prisma.sql`WITH "imm" AS (${this.immobilizationSql(run)}),
      "dur" AS (${this.unionSql(run, intervals, Prisma.sql`"companyId", "vehicleId", "kind"`)})`;
    const [page, counted] = await Promise.all([
      this.prisma.client.$queryRaw<Array<{ companyId: string; vehicleId: string; kind: ImmobilizationCauseKind }>>`${cte}
        SELECT "dur"."companyId", "dur"."vehicleId", "dur"."kind", ${UNION_MS} AS "ms"
        FROM "dur" JOIN "Vehicle" "vv" ON "vv"."id" = "dur"."vehicleId"
        ORDER BY "vv"."code" ${TEXT_ORDER}, "ms" DESC, "dur"."kind", "dur"."companyId" ${windowSql(window)}`,
      this.prisma.client.$queryRaw<Array<{ total: number }>>`${cte} SELECT COUNT(*)::int AS "total" FROM "dur"`,
    ]);
    const total = counted[0]?.total ?? 0;
    if (page.length === 0) return { rows: [], total };
    const items = await this.prisma.client.immobilization.findMany({
      where: { AND: [this.immobilizationWhere(run), { vehicleId: { in: [...new Set(page.map((p) => p.vehicleId))] } }] },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      select: { companyId: true, vehicleId: true, endedAt: true, vehicle: { select: { code: true, registration: true } }, causes: { select: { kind: true, reason: true, startedAt: true, endedAt: true }, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] } },
    });
    const groups = new Map<string, ImmobilizationGroup & { kind: ImmobilizationCauseKind }>();
    for (const i of items) {
      for (const c of i.causes) {
        const key = `${i.companyId}:${i.vehicleId}:${c.kind}`;
        const g = groups.get(key) ?? { key, kind: c.kind, companyId: i.companyId, vehicle: i.vehicle.code, registration: i.vehicle.registration, intervals: [], count: 0, causes: new Set<string>() };
        // Une cause restée ouverte sur une immobilisation terminée s'arrête avec elle.
        g.intervals.push({ start: c.startedAt, end: c.endedAt ?? i.endedAt });
        g.count += 1;
        g.causes.add(c.reason);
        groups.set(key, g);
      }
    }
    const rows: ReportRow[] = [];
    for (const { companyId, vehicleId, kind } of page) {
      const g = groups.get(`${companyId}:${vehicleId}:${kind}`);
      if (!g) continue;
      const union = this.union(run, g.intervals);
      rows.push({
        id: g.key,
        companyId: g.companyId,
        values: {
          vehicle: g.vehicle,
          registration: g.registration,
          company: null,
          causeKind: g.kind,
          causes: g.count,
          durationDays: durationDays(union.totalMs),
          state: union.ongoing ? 'ACTIVE' : 'TERMINEE',
          reasons: [...g.causes].join(' ; ') || null,
        },
      });
    }
    return { rows, total };
  }

  private union(run: ReportRun, intervals: OpenInterval[]) {
    const period = run.period ?? { start: new Date(0), end: run.now };
    return unionWithinPeriod(intervals, { from: period.start, to: period.end }, run.now);
  }
}
