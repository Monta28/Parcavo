import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CurrentOdometerHint } from '@/app/(app)/utilisations/usage-form-parts';
import { ConsumptionPanel } from '@/app/(app)/vehicules/[id]/consumption-panel';
import { FuelThresholdsCard } from '@/app/(app)/vehicules/[id]/fuel-thresholds-card';
import { SessionProvider } from '@/components/layout/session-context';
import { toQuery } from '@/lib/api-client';
import type { Page, SessionInfo } from '@/lib/api-types';
import type { ConsumptionView, FuelEntryView } from '@/lib/fuel-types';
import type { VehicleFuelThresholdsView } from '@/lib/telemetry-types';
import type { CurrentOdometerView } from '@/lib/usages-types';
import { TelematicFuelEventsLink, vehicleFuelEventsPath } from './fuel-events-link';
import { TelematicConsumptionLine, formatTelematicDeviation } from './telematic-consumption';

// Rendu réel (serveur, sans navigateur) à partir de réponses de l'API placées dans le cache de requêtes :
// aucun appel réseau, aucune valeur calculée par le test ni par l'interface.

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
    grants: [{ companyId: COMPANY, companyCode: 'A', companyName: 'Société A', role: 'CHEF_PARC', permissions: ['costs.read', 'costs.write'] }],
    companies: [{ id: COMPANY, code: 'A', name: 'Société A', status: 'ACTIF' }],
    sessionExpiresAt: '2026-09-25T00:00:00.000Z',
    emailChannelConfigured: false,
    ...overrides,
  };
}

function render(element: ReactElement, cache: Array<[readonly unknown[], unknown]> = []): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const [key, data] of cache) client.setQueryData(key, data);
  const scopeProps = { value: { session: session(), companyId: null, canSeeAll: true } } as ComponentProps<typeof SessionProvider>;
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(SessionProvider, scopeProps, element)));
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[  ]/g, ' ')
    .replace(/\s+/g, ' ');
}

const EMPTY_ENTRIES: Page<FuelEntryView> = { items: [], total: 0, page: 1, pageSize: 10 };

function consumption(withTelematics: boolean): ConsumptionView {
  const telematics = {
    kind: 'NIVEAU_SONDE' as const,
    kindLabel: 'Niveau sonde',
    available: true,
    liters: '57.000',
    litersPer100Km: '14.3',
    litersPer100KmExact: '14.25',
    deviationPercent: '+14.0',
    reasons: [],
  };
  return {
    vehicleId: VEHICLE,
    from: null,
    to: null,
    unit: 'L/100 km',
    nature: 'Estimation fondée sur les pleins saisis, pas une mesure télématique.',
    available: true,
    reasons: [],
    totals: [
      {
        energy: 'DIESEL',
        available: true,
        liters: '50.000',
        distanceKm: '400.000',
        litersPer100Km: '12.5',
        litersPer100KmExact: '12.5',
        reasons: [],
        retainedIntervals: 1,
        excludedIntervals: 0,
        ...(withTelematics ? { telematics: { ...telematics, comparedIntervals: 1, distanceKm: '400.000', declaredLiters: '50.000', declaredLitersPer100Km: '12.5' } } : {}),
      },
    ],
    intervals: [
      {
        energy: 'DIESEL',
        startFuelEntryId: 'a',
        endFuelEntryId: 'b',
        startFilledAt: '2026-09-24T08:00:00.000Z',
        endFilledAt: '2026-09-24T18:00:00.000Z',
        startKm: '10000.000',
        endKm: '10400.000',
        distanceKm: '400.000',
        liters: '50.000',
        fuelEntryIds: ['m', 'b'],
        retained: true,
        litersPer100Km: '12.5',
        litersPer100KmExact: '12.5',
        reasons: [],
        ...(withTelematics ? { telematics } : {}),
      },
    ],
  };
}

function consumptionCache(view: ConsumptionView): Array<[readonly unknown[], unknown]> {
  return [
    [['vehicle', VEHICLE, 'consumption', ''], view],
    [['vehicle', VEHICLE, 'fuel-purchase-gaps'], []],
    [['fuel-entries', toQuery({ vehicleId: VEHICLE, page: 1, pageSize: 10 })], EMPTY_ENTRIES],
  ];
}

describe('Consommation télématique en parallèle (onglet Consommation du véhicule ; CDC 8.5, D-234, R-8.5-10)', () => {
  it('affiche à côté de la consommation déclarée la nature, le L/100 km et l’écart calculés par l’API', () => {
    const html = text(render(createElement(ConsumptionPanel, { vehicleId: VEHICLE, companyId: COMPANY }), consumptionCache(consumption(true))));
    expect(html).toContain('12,5 L/100 km');
    expect(html).toContain('Télématique (Niveau sonde) : 14,3 L/100 km, écart +14,0 % par rapport à la consommation déclarée');
    expect(html).toContain('Sur 1 intervalle comparé (mêmes pleins, mêmes kilomètres) : consommation déclarée de ces intervalles 12,5 L/100 km.');
    // Ligne d'intervalle, compacte, dans la colonne Consommation.
    expect(html).toContain('Télématique (Niveau sonde) : 14,3 L/100 km, écart +14,0 %');
  });

  it('sans mesure télématique exploitable (F11 absent) : consommation déclarée seule, aucune mention télématique', () => {
    const html = text(render(createElement(ConsumptionPanel, { vehicleId: VEHICLE, companyId: COMPANY }), consumptionCache(consumption(false))));
    expect(html).toContain('12,5 L/100 km');
    expect(html).not.toContain('Télématique');
  });

  it('N/D télématique avec ses motifs, jamais remplacé par un chiffre ; écart formaté signé', () => {
    const html = text(
      render(
        createElement(TelematicConsumptionLine, {
          unit: 'L/100 km',
          value: {
            kind: 'NIVEAU_SONDE',
            kindLabel: 'Niveau sonde',
            available: false,
            liters: null,
            litersPer100Km: null,
            litersPer100KmExact: null,
            deviationPercent: null,
            reasons: [{ code: 'TROU_ECHANTILLONS', label: 'Trou d’échantillons de plus de 60 minutes dans l’intervalle.' }],
            comparedIntervals: 0,
            distanceKm: null,
            declaredLiters: null,
            declaredLitersPer100Km: null,
          },
        }),
      ),
    );
    expect(html).toContain('Télématique (Niveau sonde) : N/D');
    expect(html).toContain('Trou d’échantillons de plus de 60 minutes dans l’intervalle.');
    expect(html).not.toContain('écart');
    expect([formatTelematicDeviation('+14.0'), formatTelematicDeviation('-3.0'), formatTelematicDeviation('0.0'), formatTelematicDeviation(null)].map((v) => (v === null ? null : v.replace(/[  ]/g, ' ')))).toEqual(['+14,0 %', '-3,0 %', '0,0 %', null]);
  });
});

const THRESHOLDS: VehicleFuelThresholdsView = {
  vehicleId: VEHICLE,
  vehicleCode: 'V-SONDE',
  companyId: COMPANY,
  version: 2,
  reason: 'Véhicule exposé au siphonnage',
  updatedAt: '2026-09-24T09:00:00.000Z',
  updatedByName: 'Chaima Chef-A',
  canEdit: true,
  thresholds: [
    { field: 'dropLiters', key: 'telemetry.fuelDropLiters', label: 'Baisse carburant à l’arrêt (litres)', unit: 'L', vehicleValue: 2, companyValue: 12, companySource: 'societe', effectiveValue: 2, source: 'vehicule', min: 0.5, max: 500 },
    { field: 'dropPercent', key: 'telemetry.fuelDropPercent', label: 'Baisse carburant à l’arrêt (pourcentage)', unit: '%', vehicleValue: null, companyValue: 5, companySource: 'defaut', effectiveValue: 5, source: 'defaut', min: 0.5, max: 100 },
  ],
};

describe('Seuils carburant du véhicule (CDC 8.5, 17.1 ; D-240 ; R-8.5-07, R-17.1-14)', () => {
  it('valeur de la société avec son origine, surcharge du véhicule et valeur appliquée ; modification offerte au chef', () => {
    const html = text(render(createElement(FuelThresholdsCard, { vehicleId: VEHICLE }), [[['telemetry', 'vehicle', VEHICLE, 'fuel-thresholds'], THRESHOLDS]]));
    expect(html).toContain('Baisse carburant à l’arrêt (litres) 12 L Surcharge de la société 2 L 2 L Propre au véhicule');
    expect(html).toContain('Baisse carburant à l’arrêt (pourcentage) 5 % Valeur initiale — 5 % Valeur initiale');
    expect(html).toContain('Surcharge du véhicule : « Véhicule exposé au siphonnage », par Chaima Chef-A, le 24/09/2026');
    expect(html).toContain('Modifier les seuils du véhicule');
  });

  it('lecture seule sans droit de modification ; sans surcharge, les seuils de la société s’appliquent', () => {
    const html = text(render(createElement(FuelThresholdsCard, { vehicleId: VEHICLE }), [[['telemetry', 'vehicle', VEHICLE, 'fuel-thresholds'], { ...THRESHOLDS, version: 0, reason: null, updatedAt: null, updatedByName: null, canEdit: false }]]));
    expect(html).toContain('Aucun seuil propre à ce véhicule : les seuils de la société s’appliquent.');
    expect(html).not.toContain('Modifier les seuils du véhicule');
  });
});

describe('Pages carburant → événements carburant télématiques (CDC 8.5 ; R-8.5-X01)', () => {
  const key = (params: Record<string, string | number | undefined>) => ['telemetry', 'fuel-events', toQuery(params)] as const;

  it('lien vers l’onglet carburant de /telematique filtré sur le véhicule, avec le nombre à qualifier', () => {
    const html = render(createElement(TelematicFuelEventsLink, { vehicleId: VEHICLE }), [
      [key({ vehicleId: VEHICLE, pageSize: 1 }), { items: [], total: 3, page: 1, pageSize: 1 }],
      [key({ vehicleId: VEHICLE, status: 'A_QUALIFIER', pageSize: 1 }), { items: [], total: 1, page: 1, pageSize: 1 }],
    ]);
    expect(text(html)).toContain('Événements carburant télématiques de ce véhicule : 3, dont 1 à qualifier. Anomalies à qualifier, jamais des dépenses.');
    expect(html).toContain(`href="/telematique?onglet=carburant&amp;vehicule=${VEHICLE}&amp;statut=__all__"`);
    expect(vehicleFuelEventsPath(null)).toBe('/telematique?onglet=carburant');
  });

  it('aucun événement (module désactivé ou rien détecté) : rien n’est affiché, la page carburant reste complète', () => {
    const html = render(createElement(TelematicFuelEventsLink, { vehicleId: VEHICLE }), [
      [key({ vehicleId: VEHICLE, pageSize: 1 }), { items: [], total: 0, page: 1, pageSize: 1 }],
      [key({ vehicleId: VEHICLE, status: 'A_QUALIFIER', pageSize: 1 }), { items: [], total: 0, page: 1, pageSize: 1 }],
    ]);
    expect(html).toBe('');
  });

  it('périmètre du chef sans filtre véhicule : lien vers l’onglet carburant', () => {
    const html = render(createElement(TelematicFuelEventsLink, { vehicleId: null, companyId: COMPANY }), [
      [key({ companyId: COMPANY, pageSize: 1 }), { items: [], total: 2, page: 1, pageSize: 1 }],
      [key({ companyId: COMPANY, status: 'A_QUALIFIER', pageSize: 1 }), { items: [], total: 2, page: 1, pageSize: 1 }],
    ]);
    expect(text(html)).toContain('Événements carburant télématiques du périmètre : 2, dont 2 à qualifier.');
    expect(html).toContain('href="/telematique?onglet=carburant"');
  });
});

describe('Aide télématique de la remise et de la restitution (CDC 5.6 ; R-5.6-17)', () => {
  const current = (hint: CurrentOdometerView['lastTelematicsHint']): CurrentOdometerView => ({
    reading: { id: 'r', physicalKm: '12000.000', cumulativeKm: '12000.000', isEstimate: false, source: 'MANUAL', measurementKind: 'COMPTEUR_AFFICHE', status: 'ACCEPTE', observedAt: '2026-09-24T08:00:00.000Z' },
    freshness: 'A_JOUR',
    ageDays: 0,
    cumulativeKnown: true,
    openSegmentId: 's',
    pendingCount: 0,
    lastTelematicsHint: hint,
  });

  it('valeur proposée par l’API comme simple indication, la saisie restant celle du tableau de bord', () => {
    const html = text(render(createElement(CurrentOdometerHint, { vehicleId: VEHICLE }), [[['vehicle', VEHICLE, 'odometer'], current({ valueKm: '12050.000', kind: 'COMPTEUR_CAN', observedAt: '2026-09-24T11:00:00.000Z' })]]));
    expect(html).toContain('Aide télématique : 12 050 km');
    expect(html).toContain('Indication seulement : saisissez la valeur lue sur le tableau de bord.');
  });

  it('aucune aide quand l’API n’en propose pas (boîtier réutilisé sans donnée depuis sa pose, pas d’association)', () => {
    const html = text(render(createElement(CurrentOdometerHint, { vehicleId: VEHICLE }), [[['vehicle', VEHICLE, 'odometer'], current(null)]]));
    expect(html).toContain('Compteur courant : 12 000 km');
    expect(html).not.toContain('Aide télématique');
  });
});
