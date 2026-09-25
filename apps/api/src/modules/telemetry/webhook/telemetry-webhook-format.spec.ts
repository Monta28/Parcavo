import { describe, expect, it } from 'vitest';
import { ProviderError } from '../telemetry-provider.interface.js';
import { WEBHOOK_MAX_SAMPLES, batchFuelSamples, batchOdometerSamples, batchUnits, parseWebhookBatch, parseWebhookSettings } from './telemetry-webhook-format.js';

describe('Format des lots webhook (D-298, R-14.4-02)', () => {
  it('normalise un lot conforme : champs prévus seulement, instants en UTC, nombres convertis en décimaux', () => {
    const parsed = parseWebhookBatch({
      version: 1,
      emetteur: 'plateforme', // champ non prévu : ignoré et non conservé
      units: [{ externalId: ' U-1 ', label: 'Camion 12', registration: '123 TU 4567', odometerKinds: ['COMPTEUR_CAN'], position: { lat: 36.8, lon: 10.1 } }],
      odometers: [{ unitExternalId: 'U-1', kind: 'COMPTEUR_CAN', valueKm: '50120.5', observedAt: '2026-09-24T09:00:00+01:00', sourceReference: 'pos-9' }],
      fuel: [{ unitExternalId: 'U-1', kind: 'NIVEAU_SONDE', liters: 42.25, engineOn: false, speedKmh: '0', observedAt: '2026-09-24T08:05:00Z' }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.batch).toEqual({
      version: 1,
      units: [{ externalId: 'U-1', label: 'Camion 12', registration: '123 TU 4567', odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] }],
      odometers: [{ unitExternalId: 'U-1', kind: 'COMPTEUR_CAN', valueKm: '50120.5', observedAt: '2026-09-24T08:00:00.000Z', sourceReference: 'pos-9' }],
      fuel: [{ unitExternalId: 'U-1', kind: 'NIVEAU_SONDE', liters: '42.25', percent: null, engineOn: false, speedKmh: '0', observedAt: '2026-09-24T08:05:00.000Z', sourceReference: null }],
    });
    expect(JSON.stringify(parsed.batch)).not.toContain('lat');
    expect(batchOdometerSamples(parsed.batch)[0]?.observedAt).toEqual(new Date('2026-09-24T08:00:00Z'));
    expect(batchFuelSamples(parsed.batch)[0]).toMatchObject({ liters: '42.25', percent: null, engineOn: false });
    expect(batchUnits([parsed.batch])).toEqual([{ externalId: 'U-1', label: 'Camion 12', declaredRegistration: '123 TU 4567', odometerKinds: ['COMPTEUR_CAN'], fuelKinds: ['NIVEAU_SONDE'] }]);
  });

  it('accepte un lot vide (signal de vie) et refuse les lots non conformes avec des erreurs par champ', () => {
    expect(parseWebhookBatch({ version: 1 })).toEqual({ ok: true, batch: { version: 1, units: [], odometers: [], fuel: [] } });
    expect(parseWebhookBatch([])).toEqual({ ok: false, fieldErrors: { body: ['Le lot doit être un objet JSON.'] } });
    const invalid = parseWebhookBatch({
      version: 2,
      odometers: [
        { unitExternalId: 'U-1', kind: 'COMPTEUR_CAN', valueKm: '-5', observedAt: '2026-09-24T08:00:00Z' },
        { unitExternalId: 'U-1', kind: 'COMPTEUR', valueKm: '10.1234', observedAt: '2026-09-24 08:00:00' },
      ],
      fuel: [{ unitExternalId: 'U-1', kind: 'NIVEAU_CAN', percent: '120', observedAt: '2026-09-24T08:00:00Z' }, { unitExternalId: 'U-1', kind: 'NIVEAU_CAN', observedAt: '2026-09-24T08:00:00Z' }],
    });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(Object.keys(invalid.fieldErrors).sort()).toEqual(['fuel[0].percent', 'fuel[1]', 'odometers[0].valueKm', 'odometers[1].kind', 'odometers[1].observedAt', 'odometers[1].valueKm', 'version'].sort());
  });

  it('borne le nombre d’éléments par liste', () => {
    const many = Array.from({ length: WEBHOOK_MAX_SAMPLES + 1 }, () => ({ unitExternalId: 'U-1', kind: 'COMPTEUR_CAN', valueKm: '1', observedAt: '2026-09-24T08:00:00Z' }));
    const parsed = parseWebhookBatch({ version: 1, odometers: many });
    expect(parsed).toEqual({ ok: false, fieldErrors: { odometers: [`${WEBHOOK_MAX_SAMPLES} éléments au plus par lot : découpez l’envoi.`] } });
  });

  it('paramètres du canal : valeurs par défaut, bornes et clés inconnues refusées', () => {
    expect(parseWebhookSettings({})).toEqual({ maxRequestsPerMinute: 60, toleranceSeconds: 300, rotationOverlapHours: 24 });
    expect(parseWebhookSettings({ maxRequestsPerMinute: 2, toleranceSeconds: 60, rotationOverlapHours: 0 })).toEqual({ maxRequestsPerMinute: 2, toleranceSeconds: 60, rotationOverlapHours: 0 });
    expect(() => parseWebhookSettings({ maxRequestsPerMinute: 0 })).toThrow(ProviderError);
    expect(() => parseWebhookSettings({ toleranceSeconds: 3600 })).toThrow(ProviderError);
    expect(() => parseWebhookSettings({ url: 'https://exemple.tn' })).toThrow(/Paramètres inconnus/);
  });
});
