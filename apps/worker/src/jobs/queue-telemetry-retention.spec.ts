import { afterEach, describe, expect, it } from 'vitest';
import type { Readable } from 'node:stream';
import { FixedClock, REPORT_EXPORT_JOB, type ObjectStorage } from '@parc-auto/api';
import { resetDatabase, seedFixture, startWorker, type TestWorker } from '../../test/support/fixtures.js';
import { DAILY_RETENTION_TASK } from './daily-retention.job.js';
import { JOB_QUEUE_TASK } from './job-queue.job.js';
import { TELEMETRY_SYNC_TASK } from './telemetry-sync.job.js';

const DAY = 24 * 3_600_000;

async function readStored(storage: ObjectStorage, storageKey: string): Promise<Buffer> {
  const stream: Readable = await storage.openRead(storageKey);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

describe('Worker : file de jobs d’export, synchronisation F11 et rétention quotidienne (CDC 11.3, 12.1, 14.1, 17.2 ; D-273, D-279, D-303)', () => {
  const clock = new FixedClock('2026-09-24T10:00:00.000Z');
  const workers: TestWorker[] = [];

  afterEach(async () => {
    for (const w of workers.splice(0)) await w.close();
  });

  it('exécute un export différé en fichier privé, puis le purge après 24 h de conservation', async () => {
    clock.set('2026-09-24T10:00:00.000Z');
    const w = await startWorker(clock);
    workers.push(w);
    await resetDatabase(w.prisma);
    const f = await seedFixture(w.prisma);
    const queue = await w.prisma.client.job.create({
      data: { organizationId: f.organizationId, type: REPORT_EXPORT_JOB, payload: { code: 'inventaire', format: 'csv', filters: {}, requestedById: f.adminId }, requestedById: f.adminId, maxAttempts: 3, runAt: clock.now(), createdAt: clock.now() },
    });

    const first = await w.scheduler.runTask(JOB_QUEUE_TASK);
    expect(first).toMatchObject({ status: 'EXECUTE', summary: { termines: 1, echecs: 0, abandonnes: 0, exportsPurges: 0 } });
    const done = await w.prisma.client.job.findUniqueOrThrow({ where: { id: queue.id } });
    expect(done.status).toBe('TERMINE');
    const attachmentId = (done.result as { attachmentId: string }).attachmentId;
    const file = await w.prisma.client.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(file).toMatchObject({ ownerType: 'EXPORT', ownerId: queue.id, companyId: null, deletedAt: null });
    const content = (await readStored(w.storage, file.storageKey)).toString('utf8');
    expect(content).toContain(f.vehicleCode);

    // Aucun job en attente : rien n'est exécuté ; la purge n'est retentée qu'après 15 min.
    clock.advance(60_000);
    expect(await w.scheduler.runTask(JOB_QUEUE_TASK)).toMatchObject({ summary: { termines: 0, exportsPurges: 0 } });

    clock.advance(DAY + 60_000);
    expect(await w.scheduler.runTask(JOB_QUEUE_TASK)).toMatchObject({ summary: { exportsPurges: 1 } });
    const purged = await w.prisma.client.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(purged.deletedAt).not.toBeNull();
    await expect(readStored(w.storage, file.storageKey)).rejects.toThrow();
  });

  it('F11 désactivé : la synchronisation planifiée ne fait aucun appel et ne crée aucun run', async () => {
    clock.set('2026-09-24T10:00:00.000Z');
    const w = await startWorker(clock);
    workers.push(w);
    await resetDatabase(w.prisma);
    const f = await seedFixture(w.prisma);
    // Fournisseur configuré mais non activé pour une société : aucun appel externe (17.1, D-101).
    await w.prisma.client.telemetryProvider.create({ data: { organizationId: f.organizationId, name: 'Traccar brouillon', kind: 'TRACCAR', channel: 'API', status: 'BROUILLON', baseUrl: 'https://traccar.invalid' } });
    const result = await w.scheduler.runTask(TELEMETRY_SYNC_TASK);
    expect(result).toMatchObject({ status: 'EXECUTE', summary: { runs: 0, decouvertes: 0, runsInterrompusRepris: 0 } });
    expect(await w.prisma.client.telemetrySyncRun.count()).toBe(0);
  });

  it('refuse de démarrer en production si un fournisseur SIMULATEUR est actif (D-303)', async () => {
    clock.set('2026-09-24T10:00:00.000Z');
    const setup = await startWorker(clock);
    await resetDatabase(setup.prisma);
    const f = await seedFixture(setup.prisma);
    await setup.prisma.client.telemetryProvider.create({ data: { organizationId: f.organizationId, name: 'Simulateur', kind: 'SIMULATEUR', channel: 'API', status: 'ACTIF' } });
    await setup.close();
    const production = { NODE_ENV: 'production', SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), APP_ORIGIN: 'https://parc.example.test' };
    await expect(startWorker(clock, { envOverrides: production })).rejects.toThrow(/Démarrage refusé : 1 fournisseur\(s\) « SIMULATEUR — données fictives » actif\(s\) en production/);

    // Hors production, le même état ne bloque pas le démarrage.
    const dev = await startWorker(clock);
    workers.push(dev);
    await dev.prisma.client.telemetryProvider.updateMany({ where: { kind: 'SIMULATEUR' }, data: { status: 'DESACTIVE' } });
    const prod = await startWorker(clock, { envOverrides: production });
    workers.push(prod);
    expect(prod.env.nodeEnv).toBe('production');
  });

  it('rétention quotidienne : partitions à venir, abandon des lots à 7 jours, purge des données à 90 jours, une fois par jour', async () => {
    clock.set('2026-09-24T02:00:00.000Z');
    const w = await startWorker(clock);
    workers.push(w);
    await resetDatabase(w.prisma);
    const f = await seedFixture(w.prisma);
    const now = clock.now().getTime();
    // Les partitions survivent au vidage des tables : état initial sans partition d'octobre à décembre 2026.
    for (const table of ['FuelLevelSample', 'TelemetryOdometerSample']) {
      for (const month of ['202610', '202611', '202612']) await w.prisma.client.$executeRawUnsafe(`DROP TABLE IF EXISTS "${table}_${month}"`);
    }

    const newBatch = async (status: 'TELEVERSE' | 'CONTROLE' | 'CONFIRME' | 'ABANDONNE', createdAt: Date, committedAt: Date | null, updatedAt: Date) => {
      const stored = await w.storage.put(Buffer.from('immatriculation;kilometrage\n123 TU 4567;15000\n', 'utf8'));
      const attachment = await w.prisma.client.attachment.create({ data: { organizationId: f.organizationId, storageKey: stored.storageKey, originalName: 'releves.csv', mimeType: 'text/csv', sizeBytes: stored.sizeBytes, sha256: stored.sha256, uploadedById: f.chefAId, createdAt } });
      const batch = await w.prisma.client.importBatch.create({ data: { organizationId: f.organizationId, kind: 'RELEVES', status, fileName: 'releves.csv', fileSha256: stored.sha256, attachmentId: attachment.id, rowCount: 1, createdAt, committedAt, createdById: f.chefAId } });
      await w.prisma.client.$executeRaw`UPDATE "ImportBatch" SET "updatedAt" = ${updatedAt} WHERE "id" = ${batch.id}::uuid`;
      await w.prisma.client.attachment.update({ where: { id: attachment.id }, data: { ownerType: 'IMPORT', ownerId: batch.id, attachedAt: createdAt } });
      await w.prisma.client.importRow.create({ data: { organizationId: f.organizationId, batchId: batch.id, rowNumber: 2, data: { immatriculation: '123 TU 4567', kilometrage: '15000' }, status: status === 'CONFIRME' ? 'IMPORTEE' : 'VALIDE' } });
      return { batch, storageKey: stored.storageKey };
    };
    const stale = await newBatch('CONTROLE', new Date(now - 8 * DAY), null, new Date(now - 8 * DAY));
    const recent = await newBatch('TELEVERSE', new Date(now - 6 * DAY), null, new Date(now - 6 * DAY));
    const oldCommitted = await newBatch('CONFIRME', new Date(now - 100 * DAY), new Date(now - 91 * DAY), new Date(now - 91 * DAY));
    const youngCommitted = await newBatch('CONFIRME', new Date(now - 100 * DAY), new Date(now - 89 * DAY), new Date(now - 89 * DAY));

    const first = await w.scheduler.runTask(DAILY_RETENTION_TASK);
    expect(first).toMatchObject({ status: 'EXECUTE', summary: { statut: 'TERMINE', partitionsCreees: 6, lotsAbandonnes: 1, lotsPurges: 1, lignesPurgees: 1, fichiersSupprimes: 1, echantillonsCarburant: 0, echantillonsOdometre: 0 } });

    const abandoned = await w.prisma.client.importBatch.findUniqueOrThrow({ where: { id: stale.batch.id } });
    expect(abandoned).toMatchObject({ status: 'ABANDONNE', version: 2 });
    expect(await w.prisma.client.auditEvent.findFirst({ where: { objectId: stale.batch.id, action: 'import.abandon', actorType: 'SYSTEME' } })).not.toBeNull();
    expect((await w.prisma.client.importBatch.findUniqueOrThrow({ where: { id: recent.batch.id } })).status).toBe('TELEVERSE');

    const purgedRow = await w.prisma.client.importRow.findFirstOrThrow({ where: { batchId: oldCommitted.batch.id } });
    expect(purgedRow).toMatchObject({ data: {}, status: 'IMPORTEE' });
    expect((await w.prisma.client.attachment.findUniqueOrThrow({ where: { id: oldCommitted.batch.attachmentId } })).deletedAt).not.toBeNull();
    await expect(readStored(w.storage, oldCommitted.storageKey)).rejects.toThrow();
    const keptRow = await w.prisma.client.importRow.findFirstOrThrow({ where: { batchId: youngCommitted.batch.id } });
    expect(keptRow.data).toEqual({ immatriculation: '123 TU 4567', kilometrage: '15000' });
    expect((await readStored(w.storage, youngCommitted.storageKey)).length).toBeGreaterThan(0);

    const partitions = await w.prisma.client.$queryRaw<Array<{ relname: string }>>`SELECT relname FROM pg_class WHERE relname ~ '^(FuelLevelSample|TelemetryOdometerSample)_2026(10|11|12)$' ORDER BY relname`;
    expect(partitions.map((p) => p.relname)).toEqual(['FuelLevelSample_202610', 'FuelLevelSample_202611', 'FuelLevelSample_202612', 'TelemetryOdometerSample_202610', 'TelemetryOdometerSample_202611', 'TelemetryOdometerSample_202612']);

    // Même jour UTC : créneau déjà traité, rien n'est rejoué.
    clock.advance(3_600_000);
    expect(await w.scheduler.runTask(DAILY_RETENTION_TASK)).toMatchObject({ summary: { statut: 'DEJA_FAIT' } });
    // Lendemain (J+1 03:00) : le lot téléversé il y a 6 jours dépasse 7 jours, le lot confirmé il y a 89 jours
    // dépasse 90 jours ; les partitions existent déjà.
    clock.advance(DAY);
    expect(await w.scheduler.runTask(DAILY_RETENTION_TASK)).toMatchObject({ summary: { statut: 'TERMINE', lotsAbandonnes: 1, lotsPurges: 1, lignesPurgees: 1, fichiersSupprimes: 1, partitionsCreees: 0 } });
    expect((await w.prisma.client.importBatch.findUniqueOrThrow({ where: { id: recent.batch.id } })).status).toBe('ABANDONNE');
    expect((await w.prisma.client.importRow.findFirstOrThrow({ where: { batchId: youngCommitted.batch.id } })).data).toEqual({});
    // J+2 : idempotente, plus rien à abandonner ni à purger (les lots déjà purgés ne sont plus relus).
    clock.advance(DAY);
    expect(await w.scheduler.runTask(DAILY_RETENTION_TASK)).toMatchObject({ summary: { statut: 'TERMINE', lotsAbandonnes: 0, lotsPurges: 0, lignesPurgees: 0, fichiersSupprimes: 0, partitionsCreees: 0 } });
  });
});
