import type { SessionInfo } from '@/lib/api-types';

/** Chef de parc de la société ou administrateur : création, modification et désactivation des plans. */
export function isManagerOf(session: SessionInfo, companyId: string | null): boolean {
  if (session.isAdmin) return true;
  if (!companyId) return false;
  return session.grants.some((g) => g.companyId === companyId && (g.role === 'ADMIN' || g.role === 'CHEF_PARC'));
}

/** Au moins une société gérée dans le périmètre courant (société choisie ou toutes). */
export function managesAnyIn(session: SessionInfo, companyId: string | null): boolean {
  if (session.isAdmin) return true;
  if (companyId) return isManagerOf(session, companyId);
  return session.grants.some((g) => g.role === 'ADMIN' || g.role === 'CHEF_PARC');
}

/** Rôles opérationnels (création d'intervention) : administrateur, chef de parc, opérateur. */
export function isOperationalIn(session: SessionInfo, companyId: string | null): boolean {
  if (session.isAdmin) return true;
  if (!companyId) return false;
  return session.grants.some((g) => g.companyId === companyId && (g.role === 'ADMIN' || g.role === 'CHEF_PARC' || g.role === 'OPERATEUR'));
}

export function hasPermissionIn(session: SessionInfo, companyId: string | null, permission: string): boolean {
  if (session.isAdmin) return true;
  if (!companyId) return false;
  return session.grants.some((g) => g.companyId === companyId && g.permissions.includes(permission));
}
