import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProviderDetail } from '@/app/(app)/administration/telematique/provider-detail';
import { SyncTab } from '@/app/(app)/telematique/sync-tab';
import { SessionProvider } from '@/components/layout/session-context';
import type { SessionInfo } from '@/lib/api-types';
import type { CompanyTelemetryView, ProviderView, WebhookView } from '@/lib/telemetry-types';

// Rendu réel (serveur, sans navigateur) de la réception webhook (D-298) à partir de réponses de l'API
// placées dans le cache de requêtes : aucun appel réseau, aucune valeur calculée par le test.

const COMPANY = '0199a000-0000-7000-8000-00000000000a';
const PROVIDER = '0199a000-0000-7000-8000-0000000000f1';

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    userId: '0199a000-0000-7000-8000-000000000011',
    email: 'admin@exemple.tn',
    firstName: 'Admin',
    lastName: 'Groupe',
    organizationId: '0199a000-0000-7000-8000-000000000001',
    organizationName: 'Groupe',
    timezone: 'Africa/Tunis',
    currency: 'TND',
    currencyDecimals: 3,
    isAdmin: true,
    isDriverOnly: false,
    driverId: null,
    grants: [],
    companies: [{ id: COMPANY, code: 'A', name: 'Société A', status: 'ACTIF' }],
    sessionExpiresAt: '2026-09-25T00:00:00.000Z',
    emailChannelConfigured: false,
    ...overrides,
  };
}

function render(element: ReactElement, cache: Array<[readonly unknown[], unknown]>, s: SessionInfo = session()): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const [key, data] of cache) client.setQueryData(key, data);
  const scopeProps = { value: { session: s, companyId: null, canSeeAll: true } } as ComponentProps<typeof SessionProvider>;
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(SessionProvider, scopeProps, element)));
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/[  ]/g, ' ')
    .replace(/\s+/g, ' ');
}

const EMPTY_RUNS = { items: [], total: 0, page: 1, pageSize: 10 };

const WEBHOOK_PROVIDER: ProviderView = {
  id: PROVIDER,
  name: 'Plateforme GPS',
  kind: 'WEBHOOK_GENERIQUE',
  kindLabel: 'Webhook générique (lots signés HMAC-SHA256)',
  channel: 'WEBHOOK',
  status: 'ACTIF',
  isSimulator: false,
  notice: null,
  syncIntervalMinutes: 15,
  lastSyncAt: '2026-09-24T10:00:10.000Z',
  lastSuccessAt: '2026-09-24T10:00:10.000Z',
  consecutiveFailures: 0,
  circuitOpenUntil: null,
  lastErrorSummary: null,
  companyIds: [COMPANY],
  version: 3,
  configurationVisible: true,
  baseUrl: null,
  settings: {},
  backfillDays: 7,
  credentials: [{ kind: 'SIGNATURE_WEBHOOK', configured: true, rotatedAt: '2026-09-24T11:00:00.000Z', previousValidUntil: '2026-09-25T11:00:00.000Z' }],
  createdAt: '2026-09-24T09:00:00.000Z',
};

const VIEW: WebhookView = {
  providerId: PROVIDER,
  url: `https://parc.exemple.tn/api/v1/telemetry/webhooks/${PROVIDER}`,
  method: 'POST',
  timestampHeader: 'X-Webhook-Timestamp',
  signatureHeader: 'X-Webhook-Signature',
  signedContent: '<horodatage>.<corps brut>',
  formatVersion: 1,
  maxBodyBytes: 1048576,
  maxSamplesPerList: 5000,
  maxRequestsPerMinute: 60,
  toleranceSeconds: 300,
  rotationOverlapHours: 24,
  secret: { kind: 'SIGNATURE_WEBHOOK', configured: true, rotatedAt: '2026-09-24T11:00:00.000Z', previousValidUntil: '2026-09-25T11:00:00.000Z' },
  counts: { pending: 1, receivedLast24h: 3, processedLast24h: 1, ignoredLast24h: 1, failedLast24h: 0, lastReceivedAt: '2026-09-24T11:05:00.000Z' },
  recent: [
    { id: 'd3', status: 'EN_ATTENTE', signedAt: '2026-09-24T11:05:00.000Z', receivedAt: '2026-09-24T11:05:00.000Z', sizeBytes: 2048, units: 1, odometers: 4, fuel: 5, attempts: 0, processedAt: null, lastError: null, syncRunIds: [] },
    { id: 'd2', status: 'IGNORE', signedAt: '2026-09-24T10:10:00.000Z', receivedAt: '2026-09-24T10:10:00.000Z', sizeBytes: 512, units: 1, odometers: 1, fuel: 0, attempts: 1, processedAt: '2026-09-24T10:10:10.000Z', lastError: 'Fournisseur non actif au moment du traitement : lot non ingéré.', syncRunIds: [] },
    { id: 'd1', status: 'TRAITE', signedAt: '2026-09-24T10:00:00.000Z', receivedAt: '2026-09-24T10:00:00.000Z', sizeBytes: 300, units: 1, odometers: 0, fuel: 0, attempts: 1, processedAt: '2026-09-24T10:00:10.000Z', lastError: null, syncRunIds: ['r1'] },
  ],
  notice: null,
};

describe('Réception webhook sur la fiche fournisseur de l’administration (rendu, D-298)', () => {
  it('URL et règles de signature à communiquer, état du secret sans sa valeur, rotation, derniers lots ; aucune synchronisation manuelle', () => {
    const html = render(createElement(ProviderDetail, { id: PROVIDER, onBack: () => undefined }), [
      [['telemetry', 'provider', PROVIDER], WEBHOOK_PROVIDER],
      [['telemetry', 'provider', PROVIDER, 'webhook'], VIEW],
      [['telemetry', 'sync-runs', `?providerId=${PROVIDER}&page=1&pageSize=10`], EMPTY_RUNS],
    ]);
    const t = text(html);
    expect(t).toContain('Réception webhook');
    expect(html).toContain(`value="https://parc.exemple.tn/api/v1/telemetry/webhooks/${PROVIDER}"`);
    expect(t).toContain('URL à communiquer au fournisseur (méthode POST)');
    expect(t).toContain('HMAC-SHA256 de <horodatage>.<corps brut> , en-tête X-Webhook-Signature: sha256=<hex>');
    expect(t).toContain('tolérance ± 300 s');
    expect(t).toContain('60 lot(s) par minute au plus (429 au-delà)');
    expect(t).toContain('Configuré le 24/09/2026 12:00 ; jamais réaffiché (chiffré au repos).');
    expect(t).toContain('Ancien secret encore accepté jusqu’au 25/09/2026 12:00 (recouvrement de 24 h).');
    expect(t).toContain('Générer un nouveau secret (rotation)');
    expect(t).toContain('En attente 1');
    expect(t).toContain('Ignoré (non ingéré)');
    expect(t).toContain('Fournisseur non actif au moment du traitement : lot non ingéré.');
    expect(t).toContain('1 unité(s), 4 kilométrage(s), 5 carburant (2 Kio)');
    expect(t).toContain('canal Webhook (envoi signé du fournisseur)');
    expect(t).not.toContain('Synchroniser maintenant');
    // Aucun champ ne relit un secret : la valeur n'est jamais présente dans l'écran.
    expect(html).not.toMatch(/whsec_/);
    expect(html).not.toMatch(/type="password"/);
  });

  it('sans secret : avertissement de l’API et génération proposée', () => {
    const view: WebhookView = { ...VIEW, secret: { kind: 'SIGNATURE_WEBHOOK', configured: false, rotatedAt: null, previousValidUntil: null }, recent: [], notice: 'Aucun secret de signature : tout lot est refusé (401) tant qu’un secret n’est pas généré et communiqué au fournisseur.' };
    const t = text(
      render(createElement(ProviderDetail, { id: PROVIDER, onBack: () => undefined }), [
        [['telemetry', 'provider', PROVIDER], { ...WEBHOOK_PROVIDER, status: 'BROUILLON', credentials: [view.secret] }],
        [['telemetry', 'provider', PROVIDER, 'webhook'], view],
        [['telemetry', 'sync-runs', `?providerId=${PROVIDER}&page=1&pageSize=10`], EMPTY_RUNS],
      ]),
    );
    expect(t).toContain('Aucun secret de signature : tout lot est refusé (401)');
    expect(t).toContain('Générer le secret de signature');
    expect(t).toContain('Aucun lot reçu');
  });

  it('page /telematique du chef : lots ingérés automatiquement, pas de bouton de synchronisation manuelle', () => {
    const companies: CompanyTelemetryView[] = [{ companyId: COMPANY, code: 'A', legalName: 'Société A', telemetryEnabled: true, providers: [{ id: PROVIDER, name: 'Plateforme GPS', kind: 'WEBHOOK_GENERIQUE', kindLabel: 'Webhook générique', status: 'ACTIF' }], version: 2 }];
    const visible: ProviderView = { ...WEBHOOK_PROVIDER, configurationVisible: false, baseUrl: undefined, settings: undefined, credentials: undefined, backfillDays: undefined, createdAt: undefined };
    const chef = session({ isAdmin: false, grants: [{ companyId: COMPANY, companyCode: 'A', companyName: 'Société A', role: 'CHEF_PARC', permissions: [] }] });
    const t = text(
      render(
        createElement(SyncTab),
        [
          [['telemetry', 'companies'], companies],
          [['telemetry', 'providers', 'scope', null], { items: [visible], total: 1, page: 1, pageSize: 100 }],
          [['telemetry', 'sync-runs', '?page=1&pageSize=10'], EMPTY_RUNS],
        ],
        chef,
      ),
    );
    expect(t).toContain('Données poussées par le fournisseur (webhook signé) : chaque lot reçu est ingéré automatiquement');
    expect(t).not.toContain('Synchroniser maintenant');
    expect(t).toContain('Découvrir les unités');
  });
});
