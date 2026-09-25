import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@parc-auto/api';
import { resetDatabase, seedFixture, startWorker, type TestWorker, type WorkerFixture } from '../../test/support/fixtures.js';
import { ALERT_CATCH_UP_JOB_TYPE, ALERT_CATCH_UP_TASK } from '../jobs/alert-catch-up.job.js';

describe('Planificateur : élection par bail JobLease et rattrapage des alertes (CDC 9.3, 14.4 ; D-200, D-254, D-257)', () => {
  const clock = new FixedClock('2026-09-24T10:03:00.000Z');
  const workers: TestWorker[] = [];
  let f: WorkerFixture;

  async function worker(): Promise<TestWorker> {
    const w = await startWorker(clock, { smtp: null });
    workers.push(w);
    return w;
  }

  beforeEach(() => {
    clock.set('2026-09-24T10:03:00.000Z');
  });
  afterEach(async () => {
    for (const w of workers.splice(0)) await w.close();
  });

  async function catchUpRuns(organizationId: string): Promise<Array<{ dedupeKey: string | null; status: string }>> {
    return (await workers[0]!.prisma.client.job.findMany({ where: { type: ALERT_CATCH_UP_JOB_TYPE, organizationId }, orderBy: { createdAt: 'asc' }, select: { dedupeKey: true, status: true } }));
  }

  it('deux instances simultanées : une seule exécute la tâche ; l’autre la reprend quand le bail expire', async () => {
    const w1 = await worker();
    const w2 = await worker();
    await resetDatabase(w1.prisma);
    f = await seedFixture(w1.prisma);

    const [r1, r2] = await Promise.all([w1.scheduler.runTask(ALERT_CATCH_UP_TASK), w2.scheduler.runTask(ALERT_CATCH_UP_TASK)]);
    expect([r1.status, r2.status].sort()).toEqual(['BAIL_DETENU_AILLEURS', 'EXECUTE']);
    const [leader, follower] = r1.status === 'EXECUTE' ? [w1, w2] : [w2, w1];
    expect(await catchUpRuns(f.organizationId)).toEqual([{ dedupeKey: `planifie:alertes-rattrapage:${f.organizationId}:2026-09-24T10:00:00.000Z`, status: 'TERMINE' }]);
    const lease = await leader.leases.state(ALERT_CATCH_UP_TASK);
    expect(lease).toMatchObject({ holder: leader.leases.holderId });
    expect(lease?.expiresAt.toISOString()).toBe('2026-09-24T10:08:00.000Z');

    // Le suiveur reste écarté tant que le bail est valide ; le titulaire ne rejoue pas le créneau.
    expect((await follower.scheduler.runTask(ALERT_CATCH_UP_TASK)).status).toBe('BAIL_DETENU_AILLEURS');
    expect(await leader.scheduler.runTask(ALERT_CATCH_UP_TASK)).toMatchObject({ status: 'EXECUTE', summary: { executed: 0, skipped: 1 } });
    expect(await catchUpRuns(f.organizationId)).toHaveLength(1);

    // Arrêt brutal du titulaire (aucune libération) : reprise par l'autre instance après expiration du bail.
    await leader.close();
    workers.splice(workers.indexOf(leader), 1);
    clock.set('2026-09-24T10:07:59.000Z');
    expect((await follower.scheduler.runTask(ALERT_CATCH_UP_TASK)).status).toBe('BAIL_DETENU_AILLEURS');
    clock.set('2026-09-24T10:15:00.000Z');
    expect(await follower.scheduler.runTask(ALERT_CATCH_UP_TASK)).toMatchObject({ status: 'EXECUTE', summary: { executed: 1 } });
    expect((await follower.leases.state(ALERT_CATCH_UP_TASK))?.holder).toBe(follower.leases.holderId);
    expect((await catchUpRuns(f.organizationId)).map((r) => r.dedupeKey)).toEqual([`planifie:alertes-rattrapage:${f.organizationId}:2026-09-24T10:00:00.000Z`, `planifie:alertes-rattrapage:${f.organizationId}:2026-09-24T10:15:00.000Z`]);
  });

  it('arrêt propre : les baux sont libérés et repris immédiatement par un autre worker', async () => {
    const w1 = await worker();
    const w2 = await worker();
    await resetDatabase(w1.prisma);
    expect((await w1.scheduler.runTask('outbox-envoi')).status).toBe('EXECUTE');
    expect((await w2.scheduler.runTask('outbox-envoi')).status).toBe('BAIL_DETENU_AILLEURS');
    await w1.scheduler.stop();
    expect((await w1.scheduler.runTask('outbox-envoi')).status).toBe('ARRETE');
    expect((await w2.scheduler.runTask('outbox-envoi')).status).toBe('EXECUTE');
  });

  it('rattrapage : alertes temporelles et réservations non honorées, une fois par créneau ; créneau manqué rattrapé au redémarrage', async () => {
    const w = await worker();
    await resetDatabase(w.prisma);
    f = await seedFixture(w.prisma);
    const reservation = await w.prisma.client.reservation.create({ data: { organizationId: f.organizationId, companyId: f.companyA, vehicleId: f.vehicleId, driverId: f.driverId, startAt: new Date('2026-09-24T07:00:00Z'), endAt: new Date('2026-09-24T09:00:00Z'), purpose: 'Livraison' } });

    const run = await w.scheduler.runTask(ALERT_CATCH_UP_TASK);
    expect(run).toMatchObject({ status: 'EXECUTE', summary: { organizations: 1, executed: 1, failed: 0 } });
    // Véhicule sans relevé accepté : alerte « kilométrage absent » (5.5) ; réservation échue non convertie.
    expect(await w.prisma.client.alert.count({ where: { organizationId: f.organizationId, vehicleId: f.vehicleId, type: 'KILOMETRAGE_ABSENT', status: 'ACTIVE' } })).toBe(1);
    expect((await w.prisma.client.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).status).toBe('NON_HONOREE');
    const [job] = await w.prisma.client.job.findMany({ where: { type: ALERT_CATCH_UP_JOB_TYPE, organizationId: f.organizationId } });
    expect(job).toMatchObject({ status: 'TERMINE', progress: 100, lastError: null });
    expect(job?.result).toMatchObject({ vehiculesFraicheurEvalues: 1, reservationsNonHonorees: 1, plansRecalcules: 0 });

    // Même créneau : rien n'est rejoué ; dix recalculs ne créent aucun doublon d'alerte.
    for (let i = 0; i < 3; i += 1) await w.scheduler.runTask(ALERT_CATCH_UP_TASK);
    expect(await w.prisma.client.job.count({ where: { type: ALERT_CATCH_UP_JOB_TYPE, organizationId: f.organizationId } })).toBe(1);
    // Worker arrêté de 10:15 à 11:20 : au redémarrage, seul le créneau courant (11:15) est exécuté.
    await w.close();
    workers.splice(0);
    clock.set('2026-09-24T11:20:00.000Z');
    const restarted = await worker();
    expect(await restarted.scheduler.runTask(ALERT_CATCH_UP_TASK)).toMatchObject({ status: 'EXECUTE', summary: { executed: 1 } });
    expect((await catchUpRuns(f.organizationId)).map((r) => r.dedupeKey?.slice(-24))).toEqual(['2026-09-24T10:00:00.000Z', '2026-09-24T11:15:00.000Z']);
    expect(await restarted.prisma.client.alert.count({ where: { organizationId: f.organizationId, type: 'KILOMETRAGE_ABSENT' } })).toBe(1);
  });

  it('intervalle de rattrapage paramétrable par organisation (alerts.catchUpIntervalMinutes)', async () => {
    const w = await worker();
    await resetDatabase(w.prisma);
    f = await seedFixture(w.prisma);
    await w.prisma.client.settingValue.create({ data: { organizationId: f.organizationId, companyId: null, key: 'alerts.catchUpIntervalMinutes', value: 30, settingVersion: 1, isCurrent: true } });
    clock.set('2026-09-24T10:29:00.000Z');
    await w.scheduler.runTask(ALERT_CATCH_UP_TASK);
    clock.set('2026-09-24T10:31:00.000Z');
    await w.scheduler.runTask(ALERT_CATCH_UP_TASK);
    expect((await catchUpRuns(f.organizationId)).map((r) => r.dedupeKey?.slice(-24))).toEqual(['2026-09-24T10:00:00.000Z', '2026-09-24T10:30:00.000Z']);
  });
});
