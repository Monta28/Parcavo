import type { SessionInfo } from './api-types';

export const COMPANY_COOKIE = 'pa_company';
export const ALL_COMPANIES = 'toutes';

/** Société courante choisie dans l'interface : simple filtre d'affichage, jamais une autorisation. */
export function resolveCompanyScope(session: SessionInfo, cookieValue: string | undefined): { companyId: string | null; canSeeAll: boolean } {
  const canSeeAll = session.isAdmin || session.companies.length > 1;
  if (cookieValue === ALL_COMPANIES && canSeeAll) return { companyId: null, canSeeAll };
  const known = session.companies.find((c) => c.id === cookieValue);
  if (known) return { companyId: known.id, canSeeAll };
  if (session.companies.length === 1) return { companyId: session.companies[0]!.id, canSeeAll };
  return { companyId: canSeeAll ? null : (session.companies[0]?.id ?? null), canSeeAll };
}
