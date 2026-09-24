// Types des réponses de l'API conducteurs (apps/api/src/modules/drivers) et des référentiels associés.

export type DriverStatus = 'ACTIF' | 'INACTIF';

export const DRIVER_STATUS_LABELS: Record<DriverStatus, string> = {
  ACTIF: 'Actif',
  INACTIF: 'Inactif',
};

export interface PermitView {
  id: string;
  number: string;
  categories: string[];
  issuedOn: string | null;
  expiresOn: string | null;
  attachmentId: string | null;
}

export interface DriverView {
  id: string;
  companyId: string;
  code: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  status: DriverStatus;
  siteId: string | null;
  departmentId: string | null;
  userId: string | null;
  notes: string | null;
  permits: PermitView[];
  /** Utilisation EN_COURS du conducteur, si elle existe. */
  currentUsageId: string | null;
  createdAt: string;
  version: number;
}

export interface DepartmentView {
  id: string;
  companyId: string;
  name: string;
  status: string;
  version: number;
}

/** Pièce jointe téléversée (POST /attachments). */
export interface AttachmentView {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  ownerType: string | null;
  ownerId: string | null;
  createdAt: string;
  downloadPath: string;
}

/** Compte utilisateur lié (GET /users/:id, réservé à l'administrateur). */
export interface LinkedUserView {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: 'ACTIF' | 'DESACTIVE';
  lastLoginAt: string | null;
  driverId: string | null;
}

/** Sous-ensemble de la vue utilisation (GET /usages?driverId=) affiché sur la fiche conducteur. */
export interface DriverUsageView {
  id: string;
  companyId: string;
  vehicleId: string;
  vehicleCode: string;
  vehicleRegistration: string;
  driverId: string;
  status: 'EN_COURS' | 'TERMINEE';
  purpose: string;
  checkedOutAt: string;
  expectedReturnAt: string;
  returnedAt: string | null;
  isLate: boolean;
  distanceStatus: 'VALIDEE' | 'NON_VALIDEE' | 'INDETERMINEE';
  distanceKm: string | null;
}
