import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@parc-auto/api';
import { raiseCriticalIncident, resetDatabase, seedFixture, startWorker, type TestWorker, type WorkerFixture } from '../../test/support/fixtures.js';
import { DAILY_DIGEST_TASK } from './daily-digest.job.js';
import { DAILY_PURGE_JOB_TYPE, DAILY_PURGE_TASK } from './daily-purge.job.js';

const MAILPIT_SMTP = { host: process.env['MAILPIT_SMTP_HOST'] ?? 'localhost', port: Number(process.env['MAILPIT_SMTP_PORT'] ?? 1025) };
const DAY = 24 * 3_600_000;

describe('Récapitulatif quotidien de 08:00 locale et purge quotidienne (CDC 9.4, 16.1, 16.2 ; D-262, D-263, D-286)', () => {
  const clock = new FixedClock('2026-09-24T05:00:00.000Z');
  const workers: TestWorker[] = [];
  let f: WorkerFixture;

  beforeEach(() => {
    clock.set('2026-09-24T05:00:00.000Z');
  });
  afterEach(async () => {
    for (const w of workers.splice(0)) await w.close();
  });

  async function digestRows(organizationId: string) {
    return workers[0]!.prisma.client.notificationOutbox.findMany({ where: { organizationId, kind: 'RECAPITULATIF_QUOTIDIEN' }, orderBy: { recipientEmail: 'asc' } });
  }

  it('dû à 08:00 heure de Tunis, rattrapé le jour même après un arrêt, jamais deux fois', async () => {
    const w = await startWorker(clock, { smtp: MAILPIT_SMTP });
    workers.push(w);
    await resetDatabase(w.prisma);
    f = await seedFixture(w.prisma);
    await raiseCriticalIncident(w, f, new Date('2026-09-24T04:00:00Z'));

    // 06:59 UTC = 07:59 à Tunis (UTC+1) : trop tôt.
    clock.set('2026-09-24T06:59:00.000Z');
    expect(await w.scheduler.runTask(DAILY_DIGEST_TASK)).toMatchObject({ status: 'EXECUTE', summary: { crees: 0, issue_TROP_TOT: 1 } });
    expect(await digestRows(f.organizationId)).toHaveLength(0);

    // Worker arrêté à 08:00 ; redémarré à 11:40 locale : rattrapage le jour même.
    await w.close();
    workers.splice(0);
    clock.set('2026-09-24T10:40:00.000Z');
    const restarted = await startWorker(clock, { smtp: MAILPIT_SMTP });
    workers.push(restarted);
    expect(await restarted.scheduler.runTask(DAILY_DIGEST_TASK)).toMatchObject({ status: 'EXECUTE', summary: { crees: 2, issue_TRAITE: 1 } });
    const rows = await digestRows(f.organizationId);
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual([`digest:${f.adminId}:2026-09-24`, `digest:${f.chefAId}:2026-09-24`].sort());
    expect(rows.every((r) => r.status === 'EN_ATTENTE')).toBe(true);

    // Exécutions suivantes du même jour : aucun doublon.
    clock.advance(60_000);
    expect(await restarted.scheduler.runTask(DAILY_DIGEST_TASK)).toMatchObject({ summary: { crees: 0, dejaEnFile: 2 } });
    clock.set('2026-09-24T22:58:00.000Z');
    expect(await restarted.scheduler.runTask(DAILY_DIGEST_TASK)).toMatchObject({ summary: { crees: 0, dejaEnFile: 2 } });
    expect(await digestRows(f.organizationId)).toHaveLength(2);

    // Le lendemain à 00:30 locale : rien avant 08:00, et le jour précédent n'est jamais renvoyé.
    clock.set('2026-09-24T23:30:00.000Z');
    expect(await restarted.scheduler.runTask(DAILY_DIGEST_TASK)).toMatchObject({ summary: { crees: 0, issue_TROP_TOT: 1 } });
    expect(await digestRows(f.organizationId)).toHaveLength(2);
  });

  it('une organisation en échec n’empêche pas le récapitulatif des autres ; l’exécution est signalée en échec, sans succès prétendu', async () => {
    clock.set('2026-09-24T10:40:00.000Z');
    const w = await startWorker(clock, { smtp: MAILPIT_SMTP });
    workers.push(w);
    await resetDatabase(w.prisma);
    // Organisation traitée en premier (créée d'abord) avec une heure d'envoi invalide : échec réel du service.
    const broken = await seedFixture(w.prisma);
    await w.prisma.client.settingValue.create({ data: { organizationId: broken.organizationId, companyId: null, key: 'email.dailyDigestLocalTime', value: '25:99', settingVersion: 1, isCurrent: true } });
    f = await seedFixture(w.prisma);
    await raiseCriticalIncident(w, f, new Date('2026-09-24T04:00:00Z'));

    const run = await w.scheduler.runTask(DAILY_DIGEST_TASK);
    expect(run.status).toBe('ECHEC');
    expect(run.status === 'ECHEC' ? run.error : '').toMatch(/1 organisation\(s\) sur 2 \(2 créé\(s\) pour les autres\)/);
    expect((await digestRows(f.organizationId)).map((r) => r.dedupeKey).sort()).toEqual([`digest:${f.adminId}:2026-09-24`, `digest:${f.chefAId}:2026-09-24`].sort());
    expect(await digestRows(broken.organizationId)).toHaveLength(0);
  });

  it('purge une fois par jour : idempotence expirée, sessions et tentatives anciennes, pièces jointes temporaires abandonnées', async () => {
    clock.set('2026-09-24T02:00:00.000Z');
    const storageDir = await mkdtemp(join(tmpdir(), 'parc-auto-worker-purge-'));
    const w = await startWorker(clock, { smtp: null, storageDir });
    workers.push(w);
    await resetDatabase(w.prisma);
    f = await seedFixture(w.prisma);
    const now = clock.now().getTime();
    const hash = createHash('sha256').update('corps').digest('hex');
    await w.prisma.client.idempotencyRecord.createMany({
      data: [
        { organizationId: f.organizationId, userId: f.adminId, operation: 'vehicle.transfer', key: randomUUID(), requestHash: hash, status: 'TERMINE', expiresAt: new Date(now - 1_000) },
        { organizationId: f.organizationId, userId: f.adminId, operation: 'vehicle.transfer', key: randomUUID(), requestHash: hash, status: 'TERMINE', expiresAt: new Date(now + DAY) },
      ],
    });
    await w.prisma.client.session.createMany({
      data: [
        { organizationId: f.organizationId, userId: f.adminId, tokenHash: randomUUID(), csrfTokenHash: 'x', expiresAt: new Date(now - 31 * DAY) },
        { organizationId: f.organizationId, userId: f.adminId, tokenHash: randomUUID(), csrfTokenHash: 'x', expiresAt: new Date(now + DAY), revokedAt: new Date(now - 31 * DAY), revokedReason: 'déconnexion' },
        { organizationId: f.organizationId, userId: f.adminId, tokenHash: randomUUID(), csrfTokenHash: 'x', expiresAt: new Date(now + DAY) },
      ],
    });
    await w.prisma.client.loginAttempt.createMany({
      data: [
        { emailNormalized: f.adminEmail, ipAddress: '10.0.0.1', success: false, createdAt: new Date(now - 31 * DAY) },
        { emailNormalized: f.adminEmail, ipAddress: '10.0.0.1', success: true, createdAt: new Date(now - 29 * DAY) },
      ],
    });
    // Fichiers réellement stockés : un temporaire abandonné (> 24 h), un temporaire récent, un rattaché ancien.
    const objectStorage = w.storage;
    const stale = await objectStorage.put(Buffer.from('%PDF-1.4 abandonné'));
    const fresh = await objectStorage.put(Buffer.from('%PDF-1.4 récent'));
    const owned = await objectStorage.put(Buffer.from('%PDF-1.4 rattaché'));
    const base = { organizationId: f.organizationId, companyId: f.companyA, originalName: 'piece.pdf', mimeType: 'application/pdf', uploadedById: f.adminId };
    const staleRow = await w.prisma.client.attachment.create({ data: { ...base, ...stale, createdAt: new Date(now - 25 * 3_600_000) } });
    const freshRow = await w.prisma.client.attachment.create({ data: { ...base, ...fresh, createdAt: new Date(now - 2 * 3_600_000) } });
    const ownedRow = await w.prisma.client.attachment.create({ data: { ...base, ...owned, ownerType: 'VEHICULE', ownerId: f.vehicleId, attachedAt: new Date(now - 40 * DAY), createdAt: new Date(now - 40 * DAY) } });

    const run = await w.scheduler.runTask(DAILY_PURGE_TASK);
    expect(run).toMatchObject({ status: 'EXECUTE', summary: { creneau: '2026-09-24T00:00:00.000Z', statut: 'TERMINE', idempotence: 1, sessions: 2, tentativesConnexion: 1, piecesJointesTemporaires: 1 } });
    expect(await w.prisma.client.idempotencyRecord.count()).toBe(1);
    expect(await w.prisma.client.session.count()).toBe(1);
    expect(await w.prisma.client.loginAttempt.count()).toBe(1);
    expect((await w.prisma.client.attachment.findUniqueOrThrow({ where: { id: staleRow.id } })).deletedAt?.toISOString()).toBe('2026-09-24T02:00:00.000Z');
    await expect(objectStorage.openRead(stale.storageKey)).rejects.toThrow();
    expect((await w.prisma.client.attachment.findUniqueOrThrow({ where: { id: freshRow.id } })).deletedAt).toBeNull();
    expect((await w.prisma.client.attachment.findUniqueOrThrow({ where: { id: ownedRow.id } })).deletedAt).toBeNull();
    (await objectStorage.openRead(fresh.storageKey)).destroy();
    (await objectStorage.openRead(owned.storageKey)).destroy();

    // Même jour : pas de seconde purge ; le lendemain : nouveau créneau.
    clock.advance(3_600_000);
    expect(await w.scheduler.runTask(DAILY_PURGE_TASK)).toMatchObject({ summary: { statut: 'DEJA_FAIT' } });
    clock.set('2026-09-25T00:05:00.000Z');
    expect(await w.scheduler.runTask(DAILY_PURGE_TASK)).toMatchObject({ summary: { creneau: '2026-09-25T00:00:00.000Z', statut: 'TERMINE', piecesJointesTemporaires: 1 } });
    expect(await w.prisma.client.job.count({ where: { type: DAILY_PURGE_JOB_TYPE } })).toBe(2);
  });
});
