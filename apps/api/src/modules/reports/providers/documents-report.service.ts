import { Injectable } from '@nestjs/common';
import { Prisma } from '@parc-auto/db';
import { DOCUMENT_STATUS_LABELS } from '@parc-auto/contracts';
import { localDate } from '../../../domain/civil-date.js';
import { PrismaService } from '../../../infra/prisma.service.js';
import { DocumentsService } from '../../documents/documents.service.js';
import { OWNER_TYPE_LABELS } from '../report-support.js';
import { TEXT_ORDER, and, inPageOrder, scopeSql, uuidEq, windowSql } from '../report-sql.js';
import { type ReportColumn, type ReportProvider, type ReportResult, type ReportRun, type ReportViewDefinition, type ReportWindow } from '../report-types.js';

/** Ordre d'urgence des statuts (expiré, manquant, à renouveler, valide). */
const STATUS_ORDER = ['EXPIRE', 'MANQUANT', 'A_RENOUVELER', 'VALIDE'];

/**
 * Expirations documentaires (CDC 11.2, 7.1, 7.2) : le tableau de conformité du module documents (statut
 * MANQUANT / EXPIRE / A_RENOUVELER / VALIDE calculé par document-status.ts au jour local du groupe),
 * trié par urgence puis échéance ; page calculée en base, lignes de la page recalculées par le module documents.
 */
@Injectable()
export class DocumentsReportService implements ReportProvider {
  readonly code = 'documents' as const;
  readonly label = 'Expirations documentaires';
  readonly description = 'Documents véhicules et conducteurs : manquants, expirés, à renouveler, valides ; échéance et caractère bloquant.';
  readonly costsRequired = false;
  readonly views: readonly ReportViewDefinition[] = [
    { code: 'echeances', label: 'Échéances', period: false, filters: ['companyId', 'vehicleId', 'driverId', 'documentTypeId', 'ownerType', 'status', 'blocking'], statuses: DOCUMENT_STATUS_LABELS },
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
  ) {}

  columns(): ReportColumn[] {
    return [
      { key: 'status', label: 'Statut', unit: null, kind: 'enum', labels: DOCUMENT_STATUS_LABELS },
      { key: 'ownerType', label: 'Objet', unit: null, kind: 'enum', labels: OWNER_TYPE_LABELS },
      { key: 'object', label: 'Véhicule ou conducteur', unit: null, kind: 'text' },
      { key: 'company', label: 'Société', unit: null, kind: 'text' },
      { key: 'documentType', label: 'Type de document', unit: null, kind: 'text' },
      { key: 'validTo', label: 'Échéance', unit: null, kind: 'date' },
      { key: 'daysRemaining', label: 'Jours restants', unit: 'jours', kind: 'integer' },
      { key: 'blocking', label: 'Bloque un départ', unit: null, kind: 'boolean' },
      { key: 'renewed', label: 'Renouvellement enregistré', unit: null, kind: 'boolean' },
      { key: 'detail', label: 'Détail', unit: null, kind: 'text' },
    ];
  }

  notes(): string[] {
    return ['Une date de fin reste valable jusqu’à la fin de ce jour dans le fuseau du groupe ; jours restants négatifs = jours écoulés depuis l’expiration.'];
  }

  /**
   * Page calculée en base : PostgreSQL évalue, pour chaque couple (objet du périmètre, type applicable), le
   * statut de conformité — traduction de computeDocumentStatus (document-status.ts) et de
   * isDocumentTypeApplicable : version en vigueur au jour local (celle qui court le plus loin), à défaut la
   * dernière expirée (EXPIRE), sinon MANQUANT si le type est exigé ou si une version existe ; préavis atteint
   * sans renouvellement → A_RENOUVELER — puis filtre, trie (urgence, échéance, objet, type) et découpe la page.
   * Les lignes affichées de la page sont recalculées par le module documents (règle unique).
   */
  async fetch(run: ReportRun, window: ReportWindow): Promise<ReportResult> {
    const f = run.filters;
    const organizationId = run.scope.organizationId;
    const types = await this.prisma.client.documentType.findMany({
      where: { organizationId, status: 'ACTIF', ...(f.documentTypeId ? { id: f.documentTypeId } : {}), ...(f.ownerType ? { ownerType: f.ownerType as 'VEHICULE' | 'CONDUCTEUR' } : {}) },
      select: { id: true, ownerType: true },
    });
    const withVehicles = !f.driverId && types.some((t) => t.ownerType === 'VEHICULE');
    const withDrivers = !f.vehicleId && types.some((t) => t.ownerType === 'CONDUCTEUR');
    if (!withVehicles && !withDrivers) return { rows: [], total: 0 };
    const today = localDate(run.now, run.timezone);
    const owners = Prisma.join(
      [
        ...(withVehicles
          ? [
              Prisma.sql`SELECT 'VEHICULE'::text AS "ownerType", "v"."id", "v"."companyId", "v"."categoryId", ("v"."code" || ' · ' || "v"."registration") AS "label", 0 AS "ownerRank", "v"."code" AS "o1", ''::text AS "o2"
                FROM "Vehicle" "v" WHERE ${and([scopeSql('v', run.scope), Prisma.sql`"v"."lifecycleStatus" IN ('ACTIF'::"VehicleLifecycle", 'HORS_SERVICE'::"VehicleLifecycle")`, uuidEq('v', 'id', f.vehicleId)])}`,
            ]
          : []),
        ...(withDrivers
          ? [
              Prisma.sql`SELECT 'CONDUCTEUR'::text AS "ownerType", "d"."id", "d"."companyId", NULL::uuid AS "categoryId", ("d"."firstName" || ' ' || "d"."lastName" || ' (' || "d"."code" || ')') AS "label", 1 AS "ownerRank", "d"."lastName" AS "o1", "d"."firstName" AS "o2"
                FROM "Driver" "d" WHERE ${and([scopeSql('d', run.scope), Prisma.sql`"d"."status" = 'ACTIF'::"DriverStatus"`, uuidEq('d', 'id', f.driverId)])}`,
            ]
          : []),
      ],
      ' UNION ALL ',
    );
    const day = Prisma.sql`${today}::date`;
    const typeIds = types.map((t) => t.id);
    // Versions non archivées des types demandés, agrégées une fois par (objet, type) : jointures par hachage,
    // jamais un parcours des versions pour chaque couple.
    const cte = Prisma.sql`WITH "owners" AS (${owners}),
      "pairs" AS (
        SELECT "o".*, "t"."id" AS "typeId", "t"."label" AS "typeLabel", "t"."hasExpiry", "t"."required", "t"."blocksCheckout",
          (SELECT MAX("n") FROM unnest("t"."noticeDays") AS "n" WHERE "n" >= 0) AS "maxNotice"
        FROM "owners" "o"
        JOIN "DocumentType" "t" ON "t"."id" = ANY(${typeIds}::uuid[]) AND "t"."ownerType"::text = "o"."ownerType"
          AND (cardinality("t"."companyIds") = 0 OR "o"."companyId" = ANY("t"."companyIds"))
          AND ("o"."ownerType" <> 'VEHICULE' OR cardinality("t"."vehicleCategoryIds") = 0 OR "o"."categoryId" = ANY("t"."vehicleCategoryIds"))
      ),
      "ver" AS (
        SELECT CASE WHEN "t"."ownerType" = 'VEHICULE' THEN "dv"."vehicleId" ELSE "dv"."driverId" END AS "ownerId", "dv"."documentTypeId" AS "typeId", "t"."hasExpiry", "dv"."validFrom", "dv"."validTo"
        FROM "DocumentVersion" "dv" JOIN "DocumentType" "t" ON "t"."id" = "dv"."documentTypeId"
        WHERE "dv"."archivedAt" IS NULL AND "dv"."documentTypeId" = ANY(${typeIds}::uuid[])
      ),
      "agg" AS (
        SELECT "ownerId", "typeId", COUNT(*) AS "versions",
          COUNT(*) FILTER (WHERE ("validFrom" IS NULL OR "validFrom" <= ${day}) AND (NOT "hasExpiry" OR "validTo" IS NULL OR "validTo" >= ${day})) AS "covering",
          MAX(COALESCE("validTo", 'infinity'::date)) FILTER (WHERE ("validFrom" IS NULL OR "validFrom" <= ${day}) AND (NOT "hasExpiry" OR "validTo" IS NULL OR "validTo" >= ${day})) AS "currentTo",
          MAX("validTo") FILTER (WHERE "hasExpiry" AND "validTo" < ${day}) AS "expiredTo"
        FROM "ver" GROUP BY "ownerId", "typeId"
      ),
      "renewal" AS (
        SELECT DISTINCT "a"."ownerId", "a"."typeId" FROM "agg" "a" JOIN "ver" "v" ON "v"."ownerId" = "a"."ownerId" AND "v"."typeId" = "a"."typeId"
        WHERE "a"."currentTo" <> 'infinity'::date AND "v"."validFrom" IS NOT NULL AND "v"."validFrom" <= "a"."currentTo" + 1 AND ("v"."validTo" IS NULL OR "v"."validTo" > "a"."currentTo")
      ),
      "facts" AS (
        SELECT "p".*, COALESCE("a"."versions", 0) AS "versions", COALESCE("a"."covering", 0) AS "covering", "a"."currentTo", "a"."expiredTo", ("r"."ownerId" IS NOT NULL) AS "renewed"
        FROM "pairs" "p"
        LEFT JOIN "agg" "a" ON "a"."ownerId" = "p"."id" AND "a"."typeId" = "p"."typeId"
        LEFT JOIN "renewal" "r" ON "r"."ownerId" = "p"."id" AND "r"."typeId" = "p"."typeId"
      ),
      "rows" AS (
        SELECT *,
          CASE
            WHEN "covering" = 0 AND "expiredTo" IS NOT NULL THEN 'EXPIRE'
            WHEN "covering" = 0 AND "versions" = 0 AND NOT "required" THEN NULL
            WHEN "covering" = 0 THEN 'MANQUANT'
            WHEN NOT "hasExpiry" OR "currentTo" = 'infinity'::date THEN 'VALIDE'
            WHEN "maxNotice" IS NOT NULL AND "currentTo" - ${day} <= "maxNotice" AND NOT "renewed" THEN 'A_RENOUVELER'
            ELSE 'VALIDE'
          END AS "status",
          CASE WHEN "covering" = 0 THEN "expiredTo" WHEN NOT "hasExpiry" OR "currentTo" = 'infinity'::date THEN NULL ELSE "currentTo" END AS "validTo"
        FROM "facts"
      ),
      "selected" AS (
        SELECT * FROM "rows" WHERE ${and([
          Prisma.sql`"status" IS NOT NULL`,
          f.status ? Prisma.sql`"status" = ${f.status}` : null,
          f.blocking === 'true' ? Prisma.sql`"status" IN ('EXPIRE', 'MANQUANT') AND "blocksCheckout"` : null,
        ])}
      )`;
    const [page, counted] = await Promise.all([
      this.prisma.client.$queryRaw<Array<{ ownerType: 'VEHICULE' | 'CONDUCTEUR'; id: string; companyId: string; categoryId: string | null; label: string; typeId: string }>>`${cte}
        SELECT "ownerType", "id", "companyId", "categoryId", "label", "typeId" FROM "selected"
        ORDER BY array_position(${STATUS_ORDER}::text[], "status"), COALESCE("validTo", '9999-12-31'::date), "label" ${TEXT_ORDER}, "typeLabel" ${TEXT_ORDER}, "ownerRank", "o1", "o2", "id", "typeId" ${windowSql(window)}`,
      this.prisma.client.$queryRaw<Array<{ total: number }>>`${cte} SELECT COUNT(*)::int AS "total" FROM "selected"`,
    ]);
    const total = counted[0]?.total ?? 0;
    const pageOwners = [...new Map(page.map((p) => [`${p.ownerType}:${p.id}`, { ownerType: p.ownerType, id: p.id, companyId: p.companyId, categoryId: p.categoryId, label: p.label }])).values()];
    const computed = await this.documents.complianceRowsFor(organizationId, pageOwners, [...new Set(page.map((p) => p.typeId))], today);
    const rows = inPageOrder(
      page.map((p) => `${p.ownerType}:${p.id}:${p.typeId}`),
      computed,
      (r) => `${r.ownerType}:${r.objectId}:${r.documentTypeId}`,
    );
    return {
      total,
      rows: rows.map((r) => ({
        id: `${r.ownerType}:${r.objectId}:${r.documentTypeId}`,
        companyId: r.companyId,
        values: {
          status: r.status,
          ownerType: r.ownerType,
          object: r.objectLabel,
          company: null,
          documentType: r.documentTypeLabel,
          validTo: r.validTo,
          daysRemaining: r.daysRemaining,
          blocking: r.blocksCheckout,
          renewed: r.renewed,
          detail: r.detail,
        },
      })),
    };
  }
}
