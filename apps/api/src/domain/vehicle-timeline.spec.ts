import { describe, expect, it } from 'vitest';
import {
  FOREIGN_COMPANY_POLICY,
  TIMELINE_OBJECT_KINDS,
  compareTimeline,
  mergeTimelinePage,
  sourceWindow,
  timelineAccess,
  type TimelineSortKey,
} from './vehicle-timeline.js';

describe('chronologie véhicule — visibilité après transfert (D-275)', () => {
  it('un objet de la société historique lisible est complet, quelle que soit sa famille', () => {
    for (const kind of TIMELINE_OBJECT_KINDS) {
      expect(timelineAccess(kind, { companyReadable: true }), kind).toBe('COMPLET');
    }
  });

  it('relevés, plans, compteur, dossier et changements de société d’une autre société : vue technique', () => {
    for (const kind of ['RELEVE', 'PLAN', 'COMPTEUR', 'DOSSIER', 'SOCIETE'] as const) {
      expect(timelineAccess(kind, { companyReadable: false }), kind).toBe('TECHNIQUE');
    }
  });

  it('jamais les utilisations, réservations, incidents, immobilisations ni affectations d’une autre société', () => {
    for (const kind of [
      'UTILISATION',
      'RESERVATION',
      'INCIDENT',
      'IMMOBILISATION',
      'AFFECTATION',
    ] as const) {
      expect(
        timelineAccess(kind, {
          companyReadable: false,
          interventionCompleted: true,
          sharedWithReader: true,
        }),
        kind,
      ).toBe('MASQUE');
      expect(FOREIGN_COMPANY_POLICY[kind]).toBe('MASQUE');
    }
  });

  it('intervention d’une autre société : vue technique seulement si TERMINEE', () => {
    expect(
      timelineAccess('INTERVENTION', { companyReadable: false, interventionCompleted: true }),
    ).toBe('TECHNIQUE');
    expect(
      timelineAccess('INTERVENTION', { companyReadable: false, interventionCompleted: false }),
    ).toBe('MASQUE');
    expect(timelineAccess('INTERVENTION', { companyReadable: false })).toBe('MASQUE');
  });

  it('document d’une autre société : visible seulement s’il est partagé avec le lecteur', () => {
    expect(timelineAccess('DOCUMENT', { companyReadable: false, sharedWithReader: true })).toBe(
      'TECHNIQUE',
    );
    expect(timelineAccess('DOCUMENT', { companyReadable: false, sharedWithReader: false })).toBe(
      'MASQUE',
    );
  });
});

describe('ordre et pagination d’une chronologie fusionnée', () => {
  const at = (iso: string, rank: number, objectId: string): TimelineSortKey => ({
    occurredAt: new Date(iso),
    rank,
    objectId,
  });

  it('trie par date, puis rang du type, puis identifiant ; desc est l’inverse exact de asc', () => {
    const items = [
      at('2026-09-02T10:00:00Z', 5, 'b'),
      at('2026-09-01T10:00:00Z', 1, 'a'),
      at('2026-09-02T10:00:00Z', 2, 'z'),
      at('2026-09-02T10:00:00Z', 5, 'a'),
    ];
    const asc = [...items].sort(compareTimeline('asc')).map((i) => `${i.rank}${i.objectId}`);
    const desc = [...items].sort(compareTimeline('desc')).map((i) => `${i.rank}${i.objectId}`);
    expect(asc).toEqual(['1a', '2z', '5a', '5b']);
    expect(desc).toEqual([...asc].reverse());
  });

  it('la fusion de sources triées donne la même page que le tri de l’ensemble complet', () => {
    const all: TimelineSortKey[] = [];
    const sources: TimelineSortKey[][] = [[], [], []];
    for (let i = 0; i < 37; i += 1) {
      const item = at(
        new Date(Date.UTC(2026, 0, 1 + (i % 11), i % 3)).toISOString(),
        i % 3,
        `id-${String(i).padStart(3, '0')}`,
      );
      all.push(item);
      sources[i % 3]?.push(item);
    }
    for (const order of ['asc', 'desc'] as const) {
      const expected = [...all].sort(compareTimeline(order));
      for (const pageSize of [5, 10]) {
        for (let page = 1; page <= 5; page += 1) {
          const window = sourceWindow({ page, pageSize });
          const truncated = sources.map((s) =>
            [...s].sort(compareTimeline(order)).slice(0, window),
          );
          expect(mergeTimelinePage(truncated, order, { page, pageSize })).toEqual(
            expected.slice((page - 1) * pageSize, page * pageSize),
          );
        }
      }
    }
  });

  it('page au-delà de la fin : liste vide', () => {
    expect(
      mergeTimelinePage([[at('2026-01-01T00:00:00Z', 1, 'a')]], 'desc', { page: 3, pageSize: 10 }),
    ).toEqual([]);
  });
});
