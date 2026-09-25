import type { ParcAutoPrismaClient } from '@parc-auto/db';
import type { Clock } from '../../../common/clock.js';
import type { WebhookInbox, WebhookInboxStatus } from '../telemetry-provider.interface.js';

const DAY_MS = 86_400_000;
/** Fenêtre et nombre de lots relus pour lister les unités vues (découverte manuelle). */
const DISCOVERY_WINDOW_DAYS = 7;
const DISCOVERY_MAX_DELIVERIES = 200;

/**
 * Lecture seule de la file des lots webhook d'un fournisseur (TelemetryWebhookDelivery) pour
 * l'adaptateur du registre : unités vues dans les lots récents et état de réception. N'ingère rien.
 */
export function createWebhookInbox(client: ParcAutoPrismaClient, clock: Clock, provider: { id: string }): WebhookInbox {
  return {
    async recentPayloads(): Promise<unknown[]> {
      const since = new Date(clock.now().getTime() - DISCOVERY_WINDOW_DAYS * DAY_MS);
      const rows = await client.telemetryWebhookDelivery.findMany({
        where: { providerId: provider.id, receivedAt: { gte: since }, unitCount: { gt: 0 } },
        orderBy: { receivedAt: 'desc' },
        take: DISCOVERY_MAX_DELIVERIES,
        select: { payload: true },
      });
      return rows.map((r) => r.payload);
    },
    async status(): Promise<WebhookInboxStatus> {
      return webhookInboxStatus(client, clock, provider.id);
    },
  };
}

export async function webhookInboxStatus(client: ParcAutoPrismaClient, clock: Clock, providerId: string): Promise<WebhookInboxStatus> {
  const now = clock.now();
  const since = new Date(now.getTime() - DAY_MS);
  const [secret, received, pending, failed, last] = await Promise.all([
    client.telemetryCredential.count({ where: { providerId, kind: 'SIGNATURE_WEBHOOK', active: true } }),
    client.telemetryWebhookDelivery.count({ where: { providerId, receivedAt: { gte: since } } }),
    client.telemetryWebhookDelivery.count({ where: { providerId, status: { in: ['EN_ATTENTE', 'EN_COURS'] } } }),
    client.telemetryWebhookDelivery.count({ where: { providerId, status: 'ECHEC', processedAt: { gte: since } } }),
    client.telemetryWebhookDelivery.findFirst({ where: { providerId }, orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } }),
  ]);
  return { signingSecretConfigured: secret > 0, receivedLast24h: received, pending, failedLast24h: failed, lastReceivedAt: last?.receivedAt ?? null };
}
