import { describe, expect, it } from 'vitest';
import { parseListSort } from './list-sort';

describe('Tri au choix des listes (CDC 10.1)', () => {
  const SORTS = ['code', 'registration', 'make', 'createdAt'] as const;

  it('lit la clé et le sens dans l’URL, bornés aux tris autorisés par l’API', () => {
    expect(parseListSort('registration', 'desc', SORTS, 'code')).toEqual({ sort: 'registration', order: 'desc' });
    expect(parseListSort('make', 'asc', SORTS, 'code')).toEqual({ sort: 'make', order: 'asc' });
  });

  it('revient au tri par défaut pour une clé inconnue ou absente, et au sens croissant pour un sens invalide', () => {
    expect(parseListSort('passwordHash', 'desc', SORTS, 'code')).toEqual({ sort: 'code', order: 'desc' });
    expect(parseListSort('', '', SORTS, 'code')).toEqual({ sort: 'code', order: 'asc' });
    expect(parseListSort('code', 'DROP', SORTS, 'code')).toEqual({ sort: 'code', order: 'asc' });
  });
});
