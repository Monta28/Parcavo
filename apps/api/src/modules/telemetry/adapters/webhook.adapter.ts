import type { Clock } from '../../../common/clock.js';
import { type AdapterConfig, type FuelSample, type OdometerSample, ProviderError, type ProviderHealth, type ProviderUnit, type TelemetryProvider } from '../telemetry-provider.interface.js';
import { type WebhookBatch, batchFuelSamples, batchOdometerSamples, batchUnits, parseWebhookSettings, storedBatch } from '../webhook/telemetry-webhook-format.js';

export const WEBHOOK_PROVIDER = 'Webhook générique';

const PULL_REFUSED = 'Canal webhook : les données sont poussées par le fournisseur et ingérées par le worker dès leur réception ; aucune lecture à la demande.';

/**
 * Adaptateurs du canal WEBHOOK (CDC 14.3, 14.4 ; D-298). Le fournisseur pousse des lots signés, déposés
 * dans une file persistante par l'API ; aucun appel sortant n'est fait vers le fournisseur.
 *  - createWebhookInboxAdapter : adaptateur du registre (test de connexion, découverte manuelle des
 *    unités vues dans les lots récents) ; la lecture des mesures à la demande est refusée ;
 *  - createWebhookBatchAdapter : lots réservés par le worker, présentés à la synchronisation comme les
 *    données d'un adaptateur (même contrat, même ingestion, mêmes contrôles). Liste d'unités partielle :
 *    une unité absente d'un lot n'a pas disparu chez le fournisseur.
 */
export function createWebhookInboxAdapter(config: AdapterConfig): TelemetryProvider {
  parseWebhookSettings(config.settings);
  const inbox = config.webhookInbox;
  if (!inbox) throw new ProviderError('CONFIGURATION', 'File des lots webhook indisponible pour ce fournisseur.');
  return {
    partialUnitList: true,
    async listUnits(): Promise<ProviderUnit[]> {
      const batches = (await inbox.recentPayloads()).map(storedBatch).filter((b): b is WebhookBatch => b !== null);
      return batchUnits(batches);
    },
    getOdometers(): Promise<OdometerSample[]> {
      return Promise.reject(new ProviderError('CONFIGURATION', PULL_REFUSED));
    },
    getFuel(): Promise<FuelSample[]> {
      return Promise.reject(new ProviderError('CONFIGURATION', PULL_REFUSED));
    },
    async healthCheck(): Promise<ProviderHealth> {
      const status = await inbox.status();
      const checkedAt = config.clock?.now() ?? new Date();
      const volume = `${status.receivedLast24h} lot(s) reçu(s) en 24 h${status.lastReceivedAt ? `, dernier le ${status.lastReceivedAt.toISOString()}` : ''} ; ${status.pending} en attente de traitement ; ${status.failedLast24h} en échec en 24 h.`;
      if (!status.signingSecretConfigured) {
        return { ok: false, message: `${WEBHOOK_PROVIDER} : secret de signature non déposé, aucun lot ne peut être authentifié. ${volume}`, latencyMs: null, checkedAt };
      }
      return { ok: true, message: `${WEBHOOK_PROVIDER} : secret de signature configuré ; ${volume}`, latencyMs: null, checkedAt };
    },
  };
}

export function createWebhookBatchAdapter(batches: readonly WebhookBatch[], clock?: Clock): TelemetryProvider {
  const odometers = batches.flatMap(batchOdometerSamples);
  const fuel = batches.flatMap(batchFuelSamples);
  const byInstant = <T extends { observedAt: Date }>(a: T, b: T) => a.observedAt.getTime() - b.observedAt.getTime();
  return {
    partialUnitList: true,
    listUnits: () => Promise.resolve(batchUnits(batches)),
    getOdometers(unitExternalIds: string[]): Promise<OdometerSample[]> {
      const wanted = new Set(unitExternalIds);
      return Promise.resolve(odometers.filter((s) => wanted.has(s.unitExternalId)).sort(byInstant));
    },
    getFuel(unitExternalIds: string[], from: Date, to: Date): Promise<FuelSample[]> {
      // Même fenêtre que le canal RAPPORT : depuis le dernier échantillon reçu de l'unité (ou la date d'effet).
      const wanted = new Set(unitExternalIds);
      return Promise.resolve(fuel.filter((s) => wanted.has(s.unitExternalId) && s.observedAt >= from && s.observedAt <= to).sort(byInstant));
    },
    healthCheck: () => Promise.resolve({ ok: true, message: `${WEBHOOK_PROVIDER} : lots en cours de traitement.`, latencyMs: null, checkedAt: clock?.now() ?? new Date() }),
  };
}
