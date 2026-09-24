import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/test-app.js';

/**
 * CDC 13.1 : tables techniques globales explicitement documentées. Contrôle sur la base PostgreSQL réelle,
 * migrée par `prisma migrate deploy` : les tables sans colonne organizationId sont exactement celles de la
 * section « Tables techniques globales » de docs/modele-de-donnees.md, et le journal d'audit refuse la
 * suppression physique (ajout seul).
 */
describe('Modèle de données : tables globales et politique de suppression (base réelle)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('les tables sans organizationId de la base migrée sont exactement les tables globales documentées', async () => {
    const rows = await t.prisma.client.$queryRaw<Array<{ table_name: string }>>`
      SELECT c.relname AS table_name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organizationId' AND NOT a.attisdropped)
      ORDER BY 1`;
    const doc = readFileSync(fileURLToPath(new URL('../../../../docs/modele-de-donnees.md', import.meta.url)), 'utf8');
    const start = doc.indexOf('## Tables techniques globales\n');
    const globalSection = doc.slice(start, doc.indexOf('\n## ', start + 3));
    const documented = [...globalSection.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]);
    expect(rows.map((r) => r.table_name).sort()).toEqual([...documented].sort());

    // Les partitions des échantillons portent organizationId (tables filles, non globales).
    const partitions = await t.prisma.client.$queryRaw<Array<{ table_name: string }>>`
      SELECT c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relispartition
        AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organizationId' AND NOT a.attisdropped)`;
    expect(partitions).toEqual([]);
  });

  it('le journal d’audit est en ajout seul : ni modification ni suppression physique', async () => {
    const org = await t.prisma.client.organization.create({ data: { code: `ORG-DM-${Date.now()}`, name: 'Groupe modèle' } });
    const event = await t.prisma.client.auditEvent.create({ data: { organizationId: org.id, actorType: 'SYSTEME', action: 'essai.modele', objectType: 'Organization', objectId: org.id } });
    await expect(t.prisma.client.auditEvent.delete({ where: { id: event.id } })).rejects.toThrow();
    await expect(t.prisma.client.auditEvent.update({ where: { id: event.id }, data: { reason: 'altération' } })).rejects.toThrow();
    expect(await t.prisma.client.auditEvent.count({ where: { id: event.id, reason: null } })).toBe(1);
  });
});
