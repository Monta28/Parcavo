import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProviderDetail } from '@/app/(app)/administration/telematique/provider-detail';
import { UnitTableRow, unitDecider } from '@/app/(app)/telematique/associations-tab';
import TelemetryFuelEventLink from '@/app/(app)/telematique/carburant/page';
import { useManagedCompanies } from '@/app/(app)/telematique/mapping-fields';
import TelemetryUnmappedUnitsLink from '@/app/(app)/telematique/unites/page';
import { SyncTab } from '@/app/(app)/telematique/sync-tab';
import { VehicleTelemetryPanel } from '@/app/(app)/vehicules/[id]/telemetry-panel';
import { SessionProvider } from '@/components/layout/session-context';
import { Table, TableBody } from '@/components/ui/table';
import type { SessionInfo } from '@/lib/api-types';
import type { Page } from '@/lib/api-types';
import type { CompanyTelemetryView, ProviderView, SyncRunView, UnitCategory, UnitRow, UnitView, VehicleTelemetryView } from '@/lib/telemetry-types';
import { ProviderSyncState } from './telemetry-display';

// Rendu réel (serveur, sans navigateur) des composants télématiques à partir de réponses de l'API
// placées dans le cache de requêtes : aucun appel réseau, aucune valeur calculée par le test.

const COMPANY = '0199a000-0000-7000-8000-00000000000a';
const VEHICLE = '0199a000-0000-7000-8000-000000000001';

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    userId: '0199a000-0000-7000-8000-000000000011',
    email: 'chef@exemple.tn',
    firstName: 'Chef',
    lastName: 'A',
    organizationId: '0199a000-0000-7000-8000-000000000001',
    organizationName: 'Groupe',
    timezone: 'Africa/Tunis',
    currency: 'TND',
    currencyDecimals: 3,
    isAdmin: false,
    isDriverOnly: false,
    driverId: null,
    grants: [{ companyId: COMPANY, companyCode: 'A', companyName: 'Société A', role: 'CHEF_PARC', permissions: [] }],
    companies: [{ id: COMPANY, code: 'A', name: 'Société A', status: 'ACTIF' }],
    sessionExpiresAt: '2026-09-25T00:00:00.000Z',
    emailChannelConfigured: false,
    ...overrides,
  };
}

function render(element: ReactElement, cache: Array<[readonly unknown[], unknown]> = [], s: SessionInfo = session()): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const [key, data] of cache) client.setQueryData(key, data);
  // Les enfants passent en troisième argument de createElement (le type de SessionProvider les déclare en propriété).
  const scopeProps = { value: { session: s, companyId: null, canSeeAll: true } } as ComponentProps<typeof SessionProvider>;
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(SessionProvider, scopeProps, element)));
}

/** Texte visible, espaces insécables (séparateurs fr-FR) normalisés. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/[  ]/g, ' ')
    .replace(/\s+/g, ' ');
}

const GPS_VIEW: VehicleTelemetryView = {
  vehicleId: VEHICLE,
  vehicleCode: 'V-GPS',
  companyId: COMPANY,
  telemetryEnabled: true,
  mapping: {
    id: 'm1',
    providerId: 'p1',
    providerName: 'Simulateur panneau',
    isSimulator: true,
    unitId: 'u1',
    unitExternalId: 'U-G',
    unitLabel: 'SIMULATEUR — Boîtier G',
    unitDeclaredRegistration: null,
    vehicle: { id: VEHICLE, code: 'V-GPS', registration: '123 TU 4567', companyId: COMPANY, lifecycleStatus: 'ACTIF' },
    companyId: COMPANY,
    status: 'CONFIRME',
    odometerKind: 'DISTANCE_GPS',
    fuelKinds: [],
    validFrom: '2026-09-17T09:52:00.000Z',
    validTo: null,
    proposedAt: '2026-09-24T09:52:00.000Z',
    proposalReason: null,
    decidedAt: '2026-09-24T09:52:00.000Z',
    decidedById: 'x',
    closedReason: null,
    version: 2,
  },
  pendingProposals: 0,
  provider: {
    id: 'p1',
    name: 'Simulateur panneau',
    kind: 'SIMULATEUR',
    kindLabel: 'SIMULATEUR — données fictives',
    isSimulator: true,
    status: 'ACTIF',
    lastSuccessAt: '2026-09-25T08:00:00.000Z',
    consecutiveFailures: 0,
    circuitOpenUntil: null,
  },
  lastObservation: {
    odometerKm: '13000.000',
    odometerKind: 'DISTANCE_GPS',
    odometerObservedAt: '2026-09-25T07:55:00.000Z',
    fuelKind: null,
    fuelLiters: null,
    fuelPercent: null,
    fuelObservedAt: null,
    receivedAt: '2026-09-25T08:00:00.000Z',
  },
  lastEstimate: {
    readingId: 'r1',
    cumulativeKm: '80450.000',
    gpsDistanceKm: '12450.000',
    observedAt: '2026-09-24T19:55:00.000Z',
    label: 'Estimé GPS (réf. manuelle du 24/09/2026, 80 000 km)',
    referenceAt: '2026-09-24T10:00:00.000Z',
    referenceKm: '80000.000',
  },
  lastCalibration: {
    id: 'c2',
    status: 'CALIBRE',
    referenceAt: '2026-09-25T08:00:00.000Z',
    referenceKm: '80960.000',
    estimatedKmAtReference: '81000.000',
    distanceSincePreviousKm: '960.000',
    deviationKm: '40.000',
    deviationPercent: '4.167',
    deviationPercentLabel: '4,2',
    driftAlertRaised: true,
    statusReason: null,
  },
  lastDrift: null,
};

describe('Panneau télématique du véhicule (rendu)', () => {
  it('DISTANCE_GPS : estimation « estimé GPS » avec sa référence, distance brute distincte du compteur, dérive 4,2 %, simulateur signalé, lien vers /telematique', () => {
    const html = render(createElement(VehicleTelemetryPanel, { vehicleId: VEHICLE, companyId: COMPANY }), [[['telemetry', 'vehicle', VEHICLE], { ...GPS_VIEW, lastDrift: GPS_VIEW.lastCalibration }]]);
    const t = text(html);
    expect(t).toContain('≈ 80 450 km (estimé GPS)');
    expect(t).toContain('Référence manuelle du 24/09/2026 11:00 (80 000 km)');
    expect(t).toContain('Distance GPS brute (odomètre virtuel) 13 000 km Distance GPS brute du fournisseur, non calibrée');
    expect(t).not.toMatch(/13 000 km Distance GPS \(estimation calibrée\)/);
    expect(t).not.toMatch(/Compteur 13 000 km/);
    expect(t).toContain('Dérive de 4,2 %');
    expect(t).toContain('Alerte dérive GPS');
    expect(t).toContain('SIMULATEUR — données fictives');
    expect(html).toContain('href="/telematique?onglet=associations&amp;categorie=ASSOCIEES&amp;q=V-GPS"');
    expect(t).toContain('Gérer l’association dans Télématique');
    // Dernière dérive identique au dernier calibrage : affichée une seule fois.
    expect(t.match(/Dérive de 4,2 %/g)).toHaveLength(1);
    // Aucun suivi en direct (T31) : ni position, ni coordonnées, ni carte.
    expect(t).toContain('Aucun suivi en direct');
    expect(t).not.toMatch(/latitude|longitude|position|carte/i);
  });

  it('sans unité : régime manuel, propositions en attente, lien vers les propositions ; lecteur : lien de consultation', () => {
    const empty: VehicleTelemetryView = { ...GPS_VIEW, mapping: null, provider: null, lastObservation: null, lastEstimate: null, lastCalibration: null, lastDrift: null, pendingProposals: 2, telemetryEnabled: false };
    const reader = session({ grants: [{ companyId: COMPANY, companyCode: 'A', companyName: 'Société A', role: 'LECTEUR', permissions: [] }] });
    const html = render(createElement(VehicleTelemetryPanel, { vehicleId: VEHICLE, companyId: COMPANY }), [[['telemetry', 'vehicle', VEHICLE], empty]], reader);
    const t = text(html);
    expect(t).toContain('Module télématique désactivé pour la société du véhicule');
    expect(t).toContain('Aucune unité associée : le kilométrage de ce véhicule est saisi manuellement. 2 proposition(s) d’association attendent une confirmation.');
    expect(t).toContain('Sans objet : le véhicule n’est pas associé en distance GPS.');
    expect(t).toContain('Aucun calibrage enregistré.');
    expect(html).toContain('href="/telematique?onglet=associations&amp;categorie=PROPOSEES&amp;q=V-GPS"');
    expect(t).toContain('Voir dans Télématique');
    expect(t).not.toContain('Confirmer la proposition');
  });
});

describe('État de synchronisation d’un fournisseur (rendu)', () => {
  const provider: ProviderView = {
    id: 'p1',
    name: 'Traccar',
    kind: 'TRACCAR',
    kindLabel: 'Traccar',
    channel: 'API',
    status: 'ACTIF',
    isSimulator: false,
    notice: null,
    syncIntervalMinutes: 15,
    lastSyncAt: '2026-09-24T09:00:00.000Z',
    lastSuccessAt: null,
    consecutiveFailures: 5,
    circuitOpenUntil: '2999-01-01T00:00:00.000Z',
    lastErrorSummary: 'Fournisseur injoignable : délai dépassé',
    companyIds: [COMPANY],
    version: 3,
    configurationVisible: false,
  };

  it('affiche les échecs, la suspension des appels jusqu’à l’échéance fournie par l’API et l’erreur expurgée', () => {
    const t = text(render(createElement(ProviderSyncState, { provider })));
    expect(t).toContain('Échecs consécutifs 5');
    expect(t).toContain('Appels suspendus jusqu’au 01/01/2999 01:00');
    expect(t).toContain('Dernière réussite Aucune');
    expect(t).toContain('Dernière erreur (expurgée) Fournisseur injoignable : délai dépassé');
  });

  it('échéance passée : aucune suspension affichée', () => {
    const t = text(render(createElement(ProviderSyncState, { provider: { ...provider, consecutiveFailures: 0, circuitOpenUntil: '2000-01-01T00:00:00.000Z', lastErrorSummary: null } })));
    expect(t).toContain('Coupe-circuit ou report de quota Aucune suspension');
    expect(t).toContain('Échecs consécutifs 0');
  });
});

const EMPTY_RUNS: Page<SyncRunView> = { items: [], total: 0, page: 1, pageSize: 10 };

const SIMULATOR: ProviderView = {
  id: 'p-sim',
  name: 'Simulateur recette',
  kind: 'SIMULATEUR',
  kindLabel: 'SIMULATEUR — données fictives',
  channel: 'API',
  status: 'ACTIF',
  isSimulator: true,
  notice: 'SIMULATEUR — données fictives : aucune donnée issue de ce fournisseur ne correspond à un véhicule réel.',
  syncIntervalMinutes: 15,
  lastSyncAt: null,
  lastSuccessAt: null,
  consecutiveFailures: 0,
  circuitOpenUntil: null,
  lastErrorSummary: null,
  companyIds: [COMPANY],
  version: 4,
  configurationVisible: true,
  baseUrl: null,
  settings: { scenario: { units: [] } },
  backfillDays: 7,
  credentials: [{ kind: 'JETON_API', configured: true, rotatedAt: '2026-09-24T10:00:00.000Z' }],
  createdAt: '2026-09-24T09:00:00.000Z',
};

describe('Fiche fournisseur de l’administration (rendu)', () => {
  const admin = session({ isAdmin: true, grants: [] });

  it('simulateur actif : mention obligatoire, secret en écriture seule (« Configuré le … »), actions du statut ACTIF uniquement', () => {
    const html = render(
      createElement(ProviderDetail, { id: SIMULATOR.id, onBack: () => undefined }),
      [
        [['telemetry', 'provider', SIMULATOR.id], SIMULATOR],
        [['telemetry', 'sync-runs', `?providerId=${SIMULATOR.id}&page=1&pageSize=10`], EMPTY_RUNS],
      ],
      admin,
    );
    const t = text(html);
    expect(t.match(/SIMULATEUR — données fictives/g)?.length).toBeGreaterThanOrEqual(2);
    expect(t).toContain('Jeton d’API Configuré le 24/09/2026 11:00');
    expect(t).toContain('Remplacer');
    expect(t).toContain('Révoquer');
    for (const action of ['Modifier la configuration', 'Tester la connexion', 'Découvrir les unités', 'Synchroniser maintenant', 'Suspendre', 'Désactiver']) expect(t).toContain(action);
    expect(t).not.toContain('Supprimer le brouillon');
    expect(html).not.toMatch(/>Activer<\/button>/);
    // Aucun champ ne relit un secret : seul l'état est affiché.
    expect(html).not.toMatch(/type="password"/);
  });

  it('brouillon : activation et suppression proposées, ni synchronisation ni suspension', () => {
    const draft: ProviderView = { ...SIMULATOR, status: 'BROUILLON', credentials: [{ kind: 'JETON_API', configured: false, rotatedAt: null }] };
    const html = render(
      createElement(ProviderDetail, { id: draft.id, onBack: () => undefined }),
      [
        [['telemetry', 'provider', draft.id], draft],
        [['telemetry', 'sync-runs', `?providerId=${draft.id}&page=1&pageSize=10`], EMPTY_RUNS],
      ],
      admin,
    );
    const t = text(html);
    expect(t).toContain('Jeton d’API Non configuré');
    expect(t).toContain('Déposer');
    expect(t).toContain('Supprimer le brouillon');
    expect(html).toMatch(/>Activer<\/button>/);
    expect(t).not.toContain('Synchroniser maintenant');
    expect(t).not.toContain('Suspendre');
  });
});

describe('Onglet Synchronisation de /telematique (rendu, droits D-112)', () => {
  const companies: CompanyTelemetryView[] = [{ companyId: COMPANY, code: 'A', legalName: 'Société A', telemetryEnabled: true, providers: [{ id: 'p-t', name: 'Traccar', kind: 'TRACCAR', kindLabel: 'Traccar', status: 'ACTIF' }], version: 2 }];
  const provider: ProviderView = { ...SIMULATOR, id: 'p-t', name: 'Traccar', kind: 'TRACCAR', kindLabel: 'Traccar', isSimulator: false, notice: null, configurationVisible: false, baseUrl: undefined, settings: undefined, credentials: undefined, backfillDays: undefined, createdAt: undefined };
  const cache = (list: CompanyTelemetryView[]): Array<[readonly unknown[], unknown]> => [
    [['telemetry', 'companies'], list],
    [['telemetry', 'providers', 'scope', null], { items: [provider], total: 1, page: 1, pageSize: 100 }],
    [['telemetry', 'sync-runs', '?page=1&pageSize=10'], EMPTY_RUNS],
  ];

  it('chef de la société activée : synchronisation manuelle et découverte ; aucune configuration affichée', () => {
    const t = text(render(createElement(SyncTab), cache(companies)));
    expect(t).toContain('A — Société A Module activé Traccar');
    expect(t).toContain('Synchroniser maintenant');
    expect(t).toContain('Découvrir les unités');
    expect(t).not.toMatch(/URL de base|Secrets|Jeton/);
  });

  it('opérateur : consultation seule ; chef d’une société non activée : aucune action', () => {
    const operator = session({ grants: [{ companyId: COMPANY, companyCode: 'A', companyName: 'Société A', role: 'OPERATEUR', permissions: [] }] });
    const asOperator = text(render(createElement(SyncTab), cache(companies), operator));
    expect(asOperator).toContain('Dernière réussite');
    expect(asOperator).not.toContain('Synchroniser maintenant');
    expect(asOperator).not.toContain('Découvrir les unités');
    const disabled = text(render(createElement(SyncTab), cache([{ ...companies[0]!, telemetryEnabled: false }])));
    expect(disabled).toContain('Module désactivé');
    expect(disabled).not.toContain('Synchroniser maintenant');
  });
});

/** Cible d'une redirection Next (redirect() lève une erreur dont le digest porte l'URL). */
async function redirectTarget(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT')) return digest.split(';')[2] ?? '';
    throw error;
  }
  throw new Error('Aucune redirection');
}

describe('Liens d’action des alertes F11 (actionPath fourni par l’API)', () => {
  const EVENT = '0199a000-0000-7000-8000-0000000000e1';

  it('/telematique/carburant?evenement=… ouvre l’onglet carburant sur l’événement ; identifiant non conforme ignoré', async () => {
    expect(await redirectTarget(() => TelemetryFuelEventLink({ searchParams: Promise.resolve({ evenement: EVENT }) }))).toBe(`/telematique?onglet=carburant&evenement=${EVENT}`);
    expect(await redirectTarget(() => TelemetryFuelEventLink({ searchParams: Promise.resolve({ evenement: 'javascript:alert(1)' }) }))).toBe('/telematique?onglet=carburant');
    expect(await redirectTarget(() => TelemetryFuelEventLink({ searchParams: Promise.resolve({}) }))).toBe('/telematique?onglet=carburant');
  });

  it('/telematique/unites ouvre la liste des unités non associées', async () => {
    expect(await redirectTarget(() => TelemetryUnmappedUnitsLink())).toBe('/telematique?onglet=associations&categorie=NON_ASSOCIEES');
  });
});

describe('Unités ignorées de l’onglet Associations (rendu, D-249)', () => {
  const unit: UnitView = {
    id: 'u-rem',
    providerId: SIMULATOR.id,
    providerName: SIMULATOR.name,
    providerKind: 'SIMULATEUR',
    isSimulator: true,
    externalId: 'REM-1',
    label: 'SIMULATEUR — Remorque 1',
    declaredRegistration: null,
    registrationNormalized: null,
    presentAtProvider: true,
    firstSeenAt: '2026-09-24T09:00:00.000Z',
    lastSeenAt: '2026-09-24T09:00:00.000Z',
    ignoredAt: null,
    ignoredById: null,
    ignoredReason: null,
  };
  const ignored: UnitView = { ...unit, ignoredAt: '2026-09-24T10:00:00.000Z', ignoredById: 'x', ignoredReason: 'Remorque sans véhicule tracteur' };

  /** Ligne réelle, droits calculés depuis la session comme dans l'onglet (fournisseur couvrant la société A). */
  function Row({ row, category }: { row: UnitRow; category: UnitCategory }) {
    const { canManage, managedIds } = useManagedCompanies();
    const tableRow = createElement(UnitTableRow, {
      row,
      category,
      timezone: 'Africa/Tunis',
      companyCode: () => 'A',
      canManage,
      managesAny: managedIds.length > 0,
      canDecideUnit: unitDecider([SIMULATOR], canManage),
      onDialog: () => undefined,
    });
    return createElement(Table, null, createElement(TableBody, null, tableRow));
  }
  const unmappedRow: UnitRow = { category: 'NON_ASSOCIEES', unit, mapping: null, vehicle: null, unmappedReason: 'IMMATRICULATION_ABSENTE' };
  const ignoredRow: UnitRow = { category: 'IGNOREES', unit: ignored, mapping: null, vehicle: null, unmappedReason: 'IGNOREE' };

  it('chef de parc d’une société couverte : « Ignorer cette unité » sur une unité non associée, « Ne plus ignorer » avec date et motif', () => {
    const unmapped = text(render(createElement(Row, { row: unmappedRow, category: 'NON_ASSOCIEES' })));
    expect(unmapped).toContain('Associer à un véhicule');
    expect(unmapped).toContain('Ignorer cette unité');
    const done = text(render(createElement(Row, { row: ignoredRow, category: 'IGNOREES' })));
    expect(done).toContain('Ne plus ignorer');
    expect(done).toContain('Motif : Remorque sans véhicule tracteur');
    expect(done).toContain('24/09/2026');
    expect(done).not.toContain('Ignorer cette unité');
  });

  it('opérateur ou chef d’une société non couverte : aucune action sur l’unité', () => {
    const operator = session({ grants: [{ companyId: COMPANY, companyCode: 'A', companyName: 'Société A', role: 'OPERATEUR', permissions: [] }] });
    expect(text(render(createElement(Row, { row: unmappedRow, category: 'NON_ASSOCIEES' }), [], operator))).not.toContain('Ignorer cette unité');
    expect(text(render(createElement(Row, { row: ignoredRow, category: 'IGNOREES' }), [], operator))).not.toContain('Ne plus ignorer');
    const other = '0199a000-0000-7000-8000-00000000000b';
    const chefB = session({ grants: [{ companyId: other, companyCode: 'B', companyName: 'Société B', role: 'CHEF_PARC', permissions: [] }] });
    expect(text(render(createElement(Row, { row: unmappedRow, category: 'NON_ASSOCIEES' }), [], chefB))).not.toContain('Ignorer cette unité');
    expect(text(render(createElement(Row, { row: ignoredRow, category: 'IGNOREES' }), [], chefB))).not.toContain('Ne plus ignorer');
  });
});
