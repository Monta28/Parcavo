import type { SessionInfo } from '@/lib/api-types';

export interface CostRights {
  /** costs.read sur la société : consultation (et réponse des opérations sur une dépense existante). */
  read: boolean;
  /** costs.write sur la société : saisie, bascule du coût d'exploitation. */
  write: boolean;
  /** Chef de parc ou administrateur : correction et annulation d'une dépense validée. */
  manager: boolean;
}

/**
 * Droits d'affichage sur les coûts d'une société, lus dans la session. Ils ne font que masquer des
 * actions : l'API revérifie chaque permission et renvoie 403/404 sinon.
 */
export function costRightsIn(session: SessionInfo, companyId: string): CostRights {
  if (session.isAdmin) return { read: true, write: true, manager: true };
  const grant = session.grants.find((g) => g.companyId === companyId);
  return {
    read: Boolean(grant?.permissions.includes('costs.read')),
    write: Boolean(grant?.permissions.includes('costs.write')),
    manager: grant?.role === 'CHEF_PARC',
  };
}

/** Sociétés actives où l'utilisateur détient la permission (toutes pour l'administrateur). */
export function companiesWith(session: SessionInfo, permission: 'costs.read' | 'costs.write'): Array<{ id: string; code: string; name: string }> {
  const active = session.companies.filter((c) => c.status !== 'ARCHIVE');
  if (session.isAdmin) return active;
  const ids = new Set(session.grants.filter((g) => g.permissions.includes(permission)).map((g) => g.companyId));
  return active.filter((c) => ids.has(c.id));
}
