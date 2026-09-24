export interface VehicleView {
  id: string;
  companyId: string;
  companyCode: string;
  code: string;
  registration: string;
  provisionalRegistration: boolean;
  make: string;
  model: string;
  categoryId: string;
  categoryLabel: string;
  lifecycleStatus: 'ACTIF' | 'HORS_SERVICE' | 'CEDE' | 'ARCHIVE';
  operationalStatus: 'IMMOBILISE' | 'EN_UTILISATION' | 'DISPONIBLE' | null;
  vin: string | null;
  year: number | null;
  commissioningDate: string | null;
  energy: string | null;
  tankCapacityLiters: string | null;
  siteId: string | null;
  departmentId: string | null;
  ownershipMode: string | null;
  contractSupplierId: string | null;
  contractEndDate: string | null;
  notes: string | null;
  currentUsage: { id: string; driverId: string; driverName: string; checkedOutAt: string; expectedReturnAt: string } | null;
  activeImmobilizationId: string | null;
  createdAt: string;
  version: number;
}

export interface LocationReportView {
  id: string;
  siteId: string | null;
  siteName: string | null;
  placeLabel: string | null;
  observedAt: string;
  comment: string | null;
  context: string;
  createdById: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface VehicleSynthesis extends VehicleView {
  responsible: { assignmentId: string; driverId: string; driverName: string; since: string } | null;
  lastLocation: LocationReportView | null;
  odometer: {
    readingId: string;
    physicalKm: string | null;
    cumulativeKm: string | null;
    cumulativeKnown: boolean;
    isEstimate: boolean;
    measurementKind: string;
    source: string;
    observedAt: string;
    freshness: string;
    ageDays: number | null;
  } | null;
  freshness: 'INCONNU' | 'A_ACTUALISER' | 'A_JOUR';
  upcomingMaintenance: Array<{ planId: string; maintenanceTypeLabel: string; status: string; nextDueKm: string | null; nextDueDate: string | null }>;
  documentCompliance: { blocking: number; missing: number; expired: number; expiringSoon: number };
  openIncidents: number;
  pendingReadings: number;
  photoAttachmentIds: string[];
  qrToken: string;
}

export interface VehicleCategory {
  id: string;
  code: string;
  label: string;
  requiredPermitCategories: string[];
  status: string;
  version: number;
}

export interface SiteView {
  id: string;
  companyId: string;
  name: string;
  address: string | null;
  managerName: string | null;
  status: string;
  version: number;
}
