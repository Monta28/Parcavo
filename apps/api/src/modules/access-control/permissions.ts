import type { MembershipRole, Permission } from '@parc-auto/db';
import { DEFAULT_ROLE_PERMISSIONS, type PermissionKey } from '@parc-auto/contracts';

/** Correspondance entre les clés fonctionnelles (CDC 2.2) et l'énumération Prisma. */
export const PERMISSION_TO_ENUM: Record<PermissionKey, Permission> = {
  'costs.read': 'COSTS_READ',
  'costs.write': 'COSTS_WRITE',
  'reports.export': 'REPORTS_EXPORT',
  'readings.approve': 'READINGS_APPROVE',
  'readings.correct': 'READINGS_CORRECT',
  'maintenance.complete': 'MAINTENANCE_COMPLETE',
  'documents.manage': 'DOCUMENTS_MANAGE',
  'exceptions.override': 'EXCEPTIONS_OVERRIDE',
  'users.manage': 'USERS_MANAGE',
};

export const ENUM_TO_PERMISSION: Record<Permission, PermissionKey> = Object.fromEntries(
  Object.entries(PERMISSION_TO_ENUM).map(([k, v]) => [v, k]),
) as Record<Permission, PermissionKey>;

/** Permissions effectives d'une habilitation : défauts du rôle + accordées − retirées. */
export function effectivePermissions(
  role: MembershipRole,
  granted: readonly Permission[],
  revoked: readonly Permission[],
): Set<Permission> {
  const defaults = DEFAULT_ROLE_PERMISSIONS[role].map((k) => PERMISSION_TO_ENUM[k]);
  const set = new Set<Permission>([...defaults, ...granted]);
  for (const p of revoked) set.delete(p);
  return set;
}

/** Rôles autorisés à gérer le parc au quotidien (hors lecture seule et conducteur). */
export const OPERATIONAL_ROLES: readonly MembershipRole[] = ['ADMIN', 'CHEF_PARC', 'OPERATEUR'];
export const MANAGER_ROLES: readonly MembershipRole[] = ['ADMIN', 'CHEF_PARC'];
export const READ_ROLES: readonly MembershipRole[] = ['ADMIN', 'CHEF_PARC', 'OPERATEUR', 'LECTEUR'];
