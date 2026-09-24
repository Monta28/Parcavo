// Types des réponses API de l'administration (CDC 2.1, 2.2, 10.2). Source : DTO du module organizations et users.
import type { PermissionKey, RoleKey } from '@parc-auto/contracts';

export type { SiteView, VehicleCategory } from './vehicles-types';

export type ArchivableStatus = 'ACTIF' | 'ARCHIVE';
export type UserStatus = 'ACTIF' | 'DESACTIVE';

export interface OrganizationView {
  id: string;
  code: string;
  name: string;
  timezone: string;
  currency: string;
  currencyDecimals: number;
  version: number;
}

export interface CompanyView {
  id: string;
  code: string;
  legalName: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  taxIdentifier: string | null;
  logoAttachmentId: string | null;
  status: ArchivableStatus;
  telemetryEnabled: boolean;
  archivedAt: string | null;
  createdAt: string;
  version: number;
}

export interface DepartmentView {
  id: string;
  companyId: string;
  name: string;
  status: ArchivableStatus;
  version: number;
}

export interface MembershipView {
  id: string;
  companyId: string | null;
  companyCode: string | null;
  companyName: string | null;
  role: RoleKey;
  grantedPermissions: PermissionKey[];
  revokedPermissions: PermissionKey[];
  effectivePermissions: PermissionKey[];
}

export interface UserView {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: UserStatus;
  lastLoginAt: string | null;
  driverId: string | null;
  hasPassword: boolean;
  memberships: MembershipView[];
  createdAt: string;
  version: number;
}

/** Habilitation envoyée à POST/PATCH /users : companyId null pour le rôle ADMIN (niveau groupe). */
export interface MembershipInput {
  companyId: string | null;
  role: RoleKey;
  grantedPermissions: PermissionKey[];
  revokedPermissions: PermissionKey[];
}

/** Sous-ensemble de la fiche conducteur (GET /drivers) utile à la liaison d'un compte. */
export interface LinkableDriver {
  id: string;
  companyId: string;
  code: string;
  firstName: string;
  lastName: string;
  status: string;
  userId: string | null;
}

export interface RevokeSessionsResult {
  revoked: number;
}

export interface OkResult {
  ok: boolean;
}

/** Objet d'un lien d'accès à usage unique (POST /users/:id/access-link). */
export type AccessLinkPurpose = 'INVITATION' | 'REINITIALISATION';

/** Lien d'accès renvoyé une seule fois par l'API (seule son empreinte est conservée). */
export interface AccessLink {
  link: string;
  expiresAt: string;
}
