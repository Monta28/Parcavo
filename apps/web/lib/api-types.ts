// Types des réponses API utilisés par le web. Source de vérité : contrats OpenAPI de l'API (docs/openapi.json).
export interface ApiError {
  code: string;
  message: string;
  fieldErrors?: Record<string, string[]>;
  details?: Record<string, unknown>;
  requestId?: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CompanyGrant {
  companyId: string;
  companyCode: string;
  companyName: string;
  role: 'ADMIN' | 'CHEF_PARC' | 'OPERATEUR' | 'CONDUCTEUR' | 'LECTEUR';
  permissions: string[];
}

export interface SessionInfo {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  organizationId: string;
  organizationName: string;
  timezone: string;
  currency: string;
  currencyDecimals: number;
  isAdmin: boolean;
  isDriverOnly: boolean;
  driverId: string | null;
  grants: CompanyGrant[];
  companies: Array<{ id: string; code: string; name: string; status: string }>;
  sessionExpiresAt: string;
  emailChannelConfigured: boolean;
}
