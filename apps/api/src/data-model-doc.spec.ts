import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CDC 13.1 : « les tables techniques globales sont explicitement documentées » et « politique explicite
 * d'archivage ». docs/modele-de-donnees.md doit rester fidèle au schéma Prisma et au code : chaque table y
 * figure, les tables sans organizationId sont exactement celles déclarées globales, et toute table dont le
 * code supprime physiquement des lignes est listée dans la section « Suppressions physiques ».
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCHEMA = readFileSync(join(ROOT, 'packages/db/prisma/schema.prisma'), 'utf8');
const DOC = readFileSync(join(ROOT, 'docs/modele-de-donnees.md'), 'utf8');

interface Model {
  name: string;
  body: string;
}

function models(): Model[] {
  return [...SCHEMA.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)].map((m) => ({ name: m[1] ?? '', body: m[2] ?? '' }));
}

/** Contenu d'une section « ## Titre » du document, jusqu'à la section suivante. */
function section(title: string): string {
  const start = DOC.indexOf(`## ${title}\n`);
  if (start < 0) throw new Error(`Section « ${title} » absente de docs/modele-de-donnees.md`);
  const next = DOC.indexOf('\n## ', start + 3);
  return DOC.slice(start, next < 0 ? undefined : next);
}

/** Premières cellules des lignes de tableau d'une section : `Table`. */
function tableNames(text: string): string[] {
  return [...text.matchAll(/^\| `([\w]+)` \|/gm)].map((m) => m[1] ?? '');
}

describe('Documentation du modèle de données (docs/modele-de-donnees.md)', () => {
  const all = models();

  it('décrit chaque table du schéma Prisma, une fois, avec sa portée et sa fin de vie', () => {
    expect(all.length).toBeGreaterThan(50);
    const documented = tableNames(section('Tables'));
    expect([...documented].sort()).toEqual(all.map((m) => m.name).sort());
    for (const row of section('Tables').split('\n').filter((l) => l.startsWith('| `'))) {
      const cells = row.split(' | ');
      expect(cells.length, row).toBe(4);
      expect(cells.every((c) => c.replace(/\|/g, '').trim().length > 0), row).toBe(true);
    }
  });

  it('liste exactement les tables sans organizationId comme tables globales (plus _prisma_migrations)', () => {
    const withoutOrganization = all.filter((m) => !/^\s+organizationId\s/m.test(m.body)).map((m) => m.name);
    expect(withoutOrganization.sort()).toEqual(['JobLease', 'LoginAttempt', 'Organization', 'WorkerHeartbeat']);
    expect(tableNames(section('Tables techniques globales')).sort()).toEqual([...withoutOrganization, '_prisma_migrations'].sort());
  });

  it('ne documente comme archivables que des tables sans suppression physique par le code, hors cas listés', () => {
    // Les tables métier principales ne sont jamais supprimées : aucune ne doit apparaître dans la section.
    const listed = new Set(tableNames(section('Suppressions physiques')));
    for (const table of ['Company', 'User', 'Driver', 'Vehicle', 'OdometerReading', 'VehicleUsage', 'Reservation', 'Intervention', 'Expense', 'FuelEntry', 'AuditEvent', 'DocumentVersion', 'Attachment', 'Alert']) {
      expect(listed.has(table), table).toBe(false);
    }
  });
});
