import { Prisma } from '@parc-auto/db';
import type { ReportFilters, ReportScope, ReportWindow } from './report-types.js';

/**
 * Fragments SQL des rapports paginés en base (CDC 17.2 : aucune page de 25 lignes ne charge l'historique
 * complet). Les regroupements, tris et fenêtres sont calculés par PostgreSQL ; les valeurs affichées de la
 * page restent produites par les règles uniques du domaine.
 *
 * Tri des libellés : la collation ICU racine de PostgreSQL (« und-x-icu ») ordonne comme
 * String.prototype.localeCompare de Node (ICU, racine CLDR), indépendamment de la collation de la base
 * (en_US.utf8 sous musl = ordre des octets).
 */
export const TEXT_ORDER = Prisma.raw('COLLATE "und-x-icu"');

/** Colonne qualifiée ("alias"."colonne") ; alias et colonne sont des constantes du code, jamais une saisie. */
export function col(alias: string, column: string): Prisma.Sql {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) throw new Error(`Identifiant SQL invalide : ${alias}.${column}`);
  return Prisma.raw(`"${alias}"."${column}"`);
}

/** Périmètre effectif (organisation, sociétés couvertes) sur la société historique de l'objet (13.1). */
export function scopeSql(alias: string, scope: ReportScope): Prisma.Sql {
  return Prisma.sql`${col(alias, 'organizationId')} = ${scope.organizationId}::uuid AND ${col(alias, 'companyId')} = ANY(${scope.companyIds}::uuid[])`;
}

/** Égalité sur un identifiant optionnel (filtre absent → aucune condition). */
export function uuidEq(alias: string, column: string, value: string | undefined): Prisma.Sql | null {
  return value ? Prisma.sql`${col(alias, column)} = ${value}::uuid` : null;
}

/** Égalité sur une énumération PostgreSQL (valeur déjà validée par le DTO) ; filtre absent → aucune condition. */
export function enumEq(alias: string, column: string, enumType: string, value: string | undefined): Prisma.Sql | null {
  if (!value) return null;
  if (!/^[A-Za-z]+$/.test(enumType)) throw new Error(`Type SQL invalide : ${enumType}`);
  return Prisma.sql`${col(alias, column)} = ${value}::${Prisma.raw(`"${enumType}"`)}`;
}

/** Filtres portant sur le véhicule courant (site, catégorie), comme vehicleRelation() : la jointure doit exister. */
export function vehicleRelationSql(vehicleAlias: string, filters: ReportFilters): Array<Prisma.Sql | null> {
  return [uuidEq(vehicleAlias, 'siteId', filters.siteId), uuidEq(vehicleAlias, 'categoryId', filters.categoryId)];
}

/** Conjonction des conditions présentes (TRUE si aucune). */
export function and(parts: ReadonlyArray<Prisma.Sql | null | undefined>): Prisma.Sql {
  const present = parts.filter((p): p is Prisma.Sql => p !== null && p !== undefined);
  return present.length > 0 ? Prisma.join(present, ' AND ') : Prisma.sql`TRUE`;
}

/** Fenêtre de la page (LIMIT/OFFSET). */
export function windowSql(window: ReportWindow): Prisma.Sql {
  return Prisma.sql`LIMIT ${window.take} OFFSET ${window.skip}`;
}

/** Remet des lignes chargées par identifiant dans l'ordre de la page calculée en base. */
export function inPageOrder<T>(keys: readonly string[], rows: readonly T[], keyOf: (row: T) => string): T[] {
  const byKey = new Map(rows.map((r) => [keyOf(r), r]));
  return keys.map((k) => byKey.get(k)).filter((r): r is T => r !== undefined);
}
