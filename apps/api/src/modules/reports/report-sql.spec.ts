import { describe, expect, it } from 'vitest';
import { and, col, enumEq, inPageOrder, scopeSql, uuidEq, windowSql } from './report-sql.js';

describe('fragments SQL des rapports paginés en base (CDC 17.2)', () => {
  it('identifiants qualifiés : constantes du code uniquement, jamais une saisie', () => {
    expect(col('e', 'vehicleId').sql).toBe('"e"."vehicleId"');
    expect(() => col('e', 'id"; DROP TABLE "Expense')).toThrow(/Identifiant SQL invalide/);
    expect(() => enumEq('e', 'status', 'Expense"Status', 'VALIDEE')).toThrow(/Type SQL invalide/);
  });

  it('filtres : valeurs toujours passées en paramètres, filtre absent → aucune condition', () => {
    const scope = scopeSql('u', { organizationId: 'org', companyIds: ['a', 'b'], costCompanyIds: new Set(), visibleCompanyIds: [] });
    expect(scope.sql).toBe('"u"."organizationId" = ?::uuid AND "u"."companyId" = ANY(?::uuid[])');
    expect(scope.values).toEqual(['org', ['a', 'b']]);
    expect(uuidEq('u', 'vehicleId', undefined)).toBeNull();
    expect(enumEq('u', 'status', 'UsageStatus', undefined)).toBeNull();
    const where = and([uuidEq('u', 'vehicleId', 'v1'), null, enumEq('u', 'status', 'UsageStatus', 'EN_COURS')]);
    expect(where.sql).toBe('"u"."vehicleId" = ?::uuid AND "u"."status" = ?::"UsageStatus"');
    expect(where.values).toEqual(['v1', 'EN_COURS']);
    expect(and([null, undefined]).sql).toBe('TRUE');
    expect(windowSql({ skip: 50, take: 25 }).values).toEqual([25, 50]);
  });

  it('lignes rechargées par identifiant : remises dans l’ordre de la page, absentes ignorées', () => {
    const rows = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];
    expect(inPageOrder(['b', 'x', 'a', 'c'], rows, (r) => r.id).map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });
});
