import { describe, expect, it } from 'vitest';
import type { SessionInfo } from './api-types';
import { ALL_COMPANIES, resolveCompanyScope } from './company-scope';

/**
 * CDC 10.1 : « afficher le sélecteur de société et le périmètre courant ; la vue “Toutes mes sociétés”
 * existe seulement pour les personnes habilitées ». Le choix est un filtre d'affichage (l'API applique
 * seule les droits) : un compte d'une seule société reste sur la sienne, même avec un cookie forgé.
 */

const A = { id: '0199a000-0000-7000-8000-00000000000a', code: 'A', name: 'Société A', status: 'ACTIVE' };
const B = { id: '0199a000-0000-7000-8000-00000000000b', code: 'B', name: 'Société B', status: 'ACTIVE' };

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    userId: 'u',
    email: 'u@exemple.test',
    firstName: 'Prénom',
    lastName: 'Nom',
    organizationId: 'o',
    organizationName: 'Groupe',
    timezone: 'Africa/Tunis',
    currency: 'TND',
    currencyDecimals: 3,
    isAdmin: false,
    isDriverOnly: false,
    driverId: null,
    grants: [],
    companies: [A],
    sessionExpiresAt: '2026-09-24T22:00:00.000Z',
    emailChannelConfigured: false,
    ...overrides,
  };
}

describe('Société courante et vue « Toutes mes sociétés » (CDC 10.1)', () => {
  it('compte d’une seule société : périmètre fixé à sa société, jamais « Toutes mes sociétés », même avec un cookie forgé', () => {
    const chef = session({ companies: [A] });
    expect(resolveCompanyScope(chef, undefined)).toEqual({ companyId: A.id, canSeeAll: false });
    expect(resolveCompanyScope(chef, ALL_COMPANIES)).toEqual({ companyId: A.id, canSeeAll: false });
    expect(resolveCompanyScope(chef, B.id)).toEqual({ companyId: A.id, canSeeAll: false });
  });

  it('administrateur ou compte de plusieurs sociétés : « Toutes mes sociétés » par défaut, bascule sur l’une de ses sociétés seulement', () => {
    const admin = session({ isAdmin: true, companies: [A, B] });
    expect(resolveCompanyScope(admin, undefined)).toEqual({ companyId: null, canSeeAll: true });
    expect(resolveCompanyScope(admin, ALL_COMPANIES)).toEqual({ companyId: null, canSeeAll: true });
    expect(resolveCompanyScope(admin, B.id)).toEqual({ companyId: B.id, canSeeAll: true });
    const multi = session({ companies: [A, B] });
    expect(resolveCompanyScope(multi, A.id)).toEqual({ companyId: A.id, canSeeAll: true });
    // Société inconnue du compte (autre organisation, cookie forgé) : ignorée.
    expect(resolveCompanyScope(multi, '0199a000-0000-7000-8000-0000000000ff')).toEqual({ companyId: null, canSeeAll: true });
  });

  it('compte sans société : aucun périmètre de société', () => {
    expect(resolveCompanyScope(session({ companies: [] }), ALL_COMPANIES)).toEqual({ companyId: null, canSeeAll: false });
  });
});
