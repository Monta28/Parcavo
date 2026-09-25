import { afterEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@parc-auto/api';
import { resetDatabase, seedFixture, startWorker, type TestWorker } from '../../test/support/fixtures.js';
import { TELEMETRY_WEBHOOK_TASK } from './telemetry-webhook.job.js';

/** Lot normalisé tel que l'API le dépose dans la file après vérification de la signature (D-298). */
function payload(unit: string, samples: Array<[string, string]>) {
  return {
    version: 1,
    units: [{ externalId: unit, label: `Boîtier ${unit}`, registration: null, odometerKinds: ['COMPTEUR_CAN'], fuelKinds: [] }],
    odometers: samples.map(([valueKm, observedAt]) => ({ unitExternalId: unit, kind: 'COMPTEUR_CAN', valueKm, observedAt, sourceReference: null })),
    fuel: [],
  };
}

describe('Worker : ingestion des lots webhook (CDC 14.4 ; D-298 ; R-14.4-02, R-14.4-X01)', () => {
  const clock = new FixedClock('2026-09-24T10:00:00.000Z');
  const workers: TestWorker[] = [];

  afterEach(async () => {
    for (const w of workers.splice(0)) await w.close();
  });

  it('la tâche planifiée ingère les lots déposés par l’API (run WEBHOOK, ingestion unique), un lot renvoyé sans doublon, un lot d’un fournisseur suspendu jamais ingéré ; sans fournisseur : aucune écriture télématique', async () => {
    clock.set('2026-09-24T10:00:00.000Z');
    const w = await startWorker(clock);
    workers.push(w);
    await resetDatabase(w.prisma);
    const f = await seedFixture(w.prisma);

    // F11 désactivé (aucun fournisseur) : la tâche ne fait rien.
    const telemetryRows = () =>
      Promise.all([
        w.prisma.client.telemetrySyncRun.count(),
        w.prisma.client.telemetryWebhookDelivery.count(),
        w.prisma.client.telemetryUnit.count(),
        w.prisma.client.telemetryCredential.count(),
        w.prisma.client.odometerReading.count({ where: { source: 'TELEMATICS' } }),
        w.prisma.client.alert.count(),
        w.prisma.client.auditEvent.count(),
      ]);
    const before = await telemetryRows();
    expect(await w.scheduler.runTask(TELEMETRY_WEBHOOK_TASK)).toMatchObject({ status: 'EXECUTE', summary: { lotsTraites: 0, lotsIgnores: 0, lotsEnEchec: 0, lotsPurges: 0, secretsExpiresSupprimes: 0, runs: 0 } });
    expect(await telemetryRows()).toEqual(before);
    expect(before.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);

    await w.prisma.client.company.update({ where: { id: f.companyA }, data: { telemetryEnabled: true } });
    await w.prisma.client.odometerSegment.create({ data: { organizationId: f.organizationId, vehicleId: f.vehicleId, sequence: 1, startedAt: new Date('2026-09-01T08:00:00Z'), startPhysicalKm: '14000', startCumulativeKm: '14000' } });
    const provider = await w.prisma.client.telemetryProvider.create({
      data: { organizationId: f.organizationId, name: 'Webhook worker', kind: 'WEBHOOK_GENERIQUE', channel: 'WEBHOOK', status: 'ACTIF', companies: { create: [{ companyId: f.companyA }] } },
    });
    const at = new Date('2026-09-24T08:00:00Z');
    const unit = await w.prisma.client.telemetryUnit.create({ data: { organizationId: f.organizationId, providerId: provider.id, externalId: 'U-W1', label: 'Boîtier U-W1', firstSeenAt: at, lastSeenAt: at } });
    await w.prisma.client.telemetryVehicleMapping.create({
      data: { organizationId: f.organizationId, companyId: f.companyA, providerId: provider.id, unitId: unit.id, vehicleId: f.vehicleId, status: 'CONFIRME', odometerKind: 'COMPTEUR_CAN', validFrom: at, proposedAt: at, decidedAt: at, decidedById: f.chefAId },
    });
    const deposit = (signedAt: string, content: object, sha: string) =>
      w.prisma.client.telemetryWebhookDelivery.create({
        data: { organizationId: f.organizationId, providerId: provider.id, signedAt: new Date(signedAt), receivedAt: new Date(signedAt), bodySha256: sha.repeat(64), sizeBytes: 512, payload: content, unitCount: 1, odometerCount: 2, nextAttemptAt: new Date(signedAt) },
      });
    const content = payload('U-W1', [
      ['15000', '2026-09-24T08:30:00.000Z'],
      ['15100', '2026-09-24T09:45:00.000Z'],
    ]);
    const first = await deposit('2026-09-24T09:59:00Z', content, 'a');

    const run1 = await w.scheduler.runTask(TELEMETRY_WEBHOOK_TASK);
    expect(run1).toMatchObject({ status: 'EXECUTE', summary: { lotsTraites: 1, lotsIgnores: 0, lotsEnEchec: 0, runs: 1 } });
    expect(await w.prisma.client.telemetryWebhookDelivery.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: 'TRAITE', attempts: 1, lockedBy: null });
    const runs = await w.prisma.client.telemetrySyncRun.findMany({ where: { providerId: provider.id, companyId: f.companyA } });
    expect(runs).toEqual([expect.objectContaining({ trigger: 'WEBHOOK', status: 'SUCCES', odometerSamples: 2, readingsCreated: 2 })]);
    const readings = await w.prisma.client.odometerReading.findMany({ where: { vehicleId: f.vehicleId, source: 'TELEMATICS' }, orderBy: { observedAt: 'asc' } });
    expect(readings.map((r) => [r.physicalKm?.toString(), r.status, r.channel, r.createdById])).toEqual([
      ['15000', 'ACCEPTE', 'WEBHOOK', null],
      ['15100', 'ACCEPTE', 'WEBHOOK', null],
    ]);
    expect(await w.prisma.client.telemetryOdometerSample.count({ where: { unitId: unit.id } })).toBe(2);

    // Même lot renvoyé par le fournisseur (autre horodatage signé) : traité, aucun doublon.
    clock.set('2026-09-24T10:01:00.000Z');
    await deposit('2026-09-24T10:00:30Z', content, 'b');
    expect(await w.scheduler.runTask(TELEMETRY_WEBHOOK_TASK)).toMatchObject({ summary: { lotsTraites: 1, runs: 1 } });
    expect(await w.prisma.client.odometerReading.count({ where: { vehicleId: f.vehicleId, source: 'TELEMATICS' } })).toBe(2);
    expect(await w.prisma.client.telemetryOdometerSample.count({ where: { unitId: unit.id } })).toBe(2);
    const replayRun = await w.prisma.client.telemetrySyncRun.findFirstOrThrow({ where: { providerId: provider.id, companyId: f.companyA }, orderBy: { startedAt: 'desc' } });
    expect(replayRun).toMatchObject({ trigger: 'WEBHOOK', status: 'SUCCES', readingsCreated: 0 });
    expect(replayRun.duplicatesIgnored).toBeGreaterThan(0);

    // Fournisseur suspendu avant le traitement : lot ignoré, jamais ingéré.
    clock.set('2026-09-24T11:30:00.000Z');
    await deposit('2026-09-24T11:29:00Z', payload('U-W1', [['15300', '2026-09-24T11:20:00.000Z']]), 'c');
    await w.prisma.client.telemetryProvider.update({ where: { id: provider.id }, data: { status: 'SUSPENDU' } });
    expect(await w.scheduler.runTask(TELEMETRY_WEBHOOK_TASK)).toMatchObject({ summary: { lotsTraites: 0, lotsIgnores: 1, runs: 0 } });
    expect(await w.prisma.client.odometerReading.count({ where: { vehicleId: f.vehicleId, source: 'TELEMATICS' } })).toBe(2);
    expect(await w.prisma.client.telemetryOdometerSample.count({ where: { unitId: unit.id } })).toBe(2);
  });
});
