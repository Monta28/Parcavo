import { afterEach, describe, expect, it } from 'vitest';
import type { Readable } from 'node:stream';
import { FixedClock, REPORT_EXPORT_JOB, type ObjectStorage } from '@parc-auto/api';
import { resetDatabase, seedFixture, startWorker, type TestWorker } from '../../test/support/fixtures.js';
import { JOB_QUEUE_TASK } from './job-queue.job.js';

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
});
