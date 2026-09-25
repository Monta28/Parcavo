import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@parc-auto/api';
import { raiseCriticalIncident, resetDatabase, seedFixture, startWorker, type TestWorker, type WorkerFixture } from '../../test/support/fixtures.js';
import { OUTBOX_TASK } from './outbox-dispatcher.job.js';

const MAILPIT_API = process.env['MAILPIT_API_URL'] ?? 'http://localhost:8025/api/v1';
const MAILPIT_SMTP = { host: process.env['MAILPIT_SMTP_HOST'] ?? 'localhost', port: Number(process.env['MAILPIT_SMTP_PORT'] ?? 1025) };
/** Port fermé : connexion refusée immédiatement (panne SMTP réelle, sans simulation). */
const SMTP_DOWN = { host: 'localhost', port: 1, user: 'parc-auto-smtp', password: 'Tres-Secret-SMTP-42' };

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

async function mailpitMessages(subjectFragment: string): Promise<MailpitMessage[]> {
  const res = await fetch(`${MAILPIT_API}/search?query=${encodeURIComponent(`subject:"${subjectFragment}"`)}&limit=50`);
  if (!res.ok) throw new Error(`Mailpit indisponible : HTTP ${res.status}`);
  const body = (await res.json()) as { messages: MailpitMessage[] };
  return body.messages.filter((m) => m.Subject.includes(subjectFragment));
}

describe('Outbox e-mail, panne SMTP et redémarrage du worker (CDC 9.4 — T29 ; D-261 à D-263)', () => {
  const clock = new FixedClock('2026-09-24T10:00:00.000Z');
  const workers: TestWorker[] = [];
  let f: WorkerFixture;

  async function worker(smtp: typeof SMTP_DOWN | typeof MAILPIT_SMTP | null): Promise<TestWorker> {
    const w = await startWorker(clock, { smtp });
    workers.push(w);
    return w;
  }

  beforeEach(async () => {
    clock.set('2026-09-24T10:00:00.000Z');
  });
  afterEach(async () => {
    for (const w of workers.splice(0)) await w.close();
  });

  it('(a) SMTP absent : alertes internes disponibles, rien mis en file, aucun envoi ni succès prétendu', async () => {
    const w = await worker(null);
    await resetDatabase(w.prisma);
    f = await seedFixture(w.prisma);
    const { alertId } = await raiseCriticalIncident(w, f, new Date('2026-09-24T09:30:00Z'));

    // Le centre d'alertes fonctionne sans SMTP ; aucune ligne d'outbox n'est créée (D-263).
    expect(await w.prisma.client.alert.findUniqueOrThrow({ where: { id: alertId } })).toMatchObject({ status: 'ACTIVE', severity: 'CRITIQUE', companyId: f.companyA });
    expect(await w.prisma.client.notificationOutbox.count({ where: { organizationId: f.organizationId } })).toBe(0);
    expect(w.notifications.emailChannelConfigured()).toBe(false);

    // Une ligne laissée par une configuration antérieure reste intacte : le distributeur ne fait rien.
    const leftover = await w.prisma.client.notificationOutbox.create({
      data: { organizationId: f.organizationId, companyId: f.companyA, kind: 'ALERTE_CRITIQUE', recipientUserId: f.chefAId, recipientEmail: f.chefAEmail, subject: '[Parc Auto] Alerte antérieure', bodyText: 'Texte', dedupeKey: `test:${alertId}`, alertId, nextAttemptAt: clock.now() },
    });
    const run = await w.scheduler.runTask(OUTBOX_TASK);
    expect(run).toMatchObject({ status: 'EXECUTE', summary: { canalConfigure: false, message: 'Canal e-mail non configuré', reservees: 0, envoyees: 0, echecs: 0 } });
    expect(await w.prisma.client.notificationOutbox.findUniqueOrThrow({ where: { id: leftover.id } })).toMatchObject({ status: 'EN_ATTENTE', attempts: 0, lastError: null, sentAt: null, lockedBy: null });

    // Récapitulatif : rien sans canal configuré.
    clock.set('2026-09-24T08:30:00.000Z');
    const digest = await w.scheduler.runTask('recapitulatif-quotidien');
    expect(digest).toMatchObject({ status: 'EXECUTE', summary: { crees: 0, issue_CANAL_NON_CONFIGURE: 1 } });
    expect(await w.prisma.client.notificationOutbox.count({ where: { organizationId: f.organizationId } })).toBe(1);
  });

  it('(b) panne SMTP : ECHEC, prochaine tentative croissante, erreur expurgée, puis ABANDONNE après 8 tentatives', async () => {
    const w = await worker(SMTP_DOWN);
    await resetDatabase(w.prisma);
    f = await seedFixture(w.prisma);
    const { alertId } = await raiseCriticalIncident(w, f, new Date('2026-09-24T09:30:00Z'));
    // Mise en file réelle par l'écouteur d'alertes : administrateur et chef de parc de la société A.
    const queued = await w.prisma.client.notificationOutbox.findMany({ where: { alertId }, orderBy: { recipientEmail: 'asc' } });
    expect(queued.map((q) => q.recipientEmail).sort()).toEqual([f.adminEmail, f.chefAEmail].sort());
    expect(queued.every((q) => q.status === 'EN_ATTENTE' && q.attempts === 0 && q.maxAttempts === 8)).toBe(true);

    const first = await w.scheduler.runTask(OUTBOX_TASK);
    expect(first).toMatchObject({ status: 'EXECUTE', summary: { canalConfigure: true, reservees: 2, echecs: 2, envoyees: 0 } });
    let rows = await w.prisma.client.notificationOutbox.findMany({ where: { alertId } });
    for (const row of rows) {
      expect(row).toMatchObject({ status: 'ECHEC', attempts: 1, sentAt: null, lockedBy: null, lockedUntil: null });
      expect(row.nextAttemptAt.toISOString()).toBe('2026-09-24T10:01:00.000Z');
      expect(row.lastError).toMatch(/ECONNREFUSED/);
      expect(row.lastError).not.toContain(SMTP_DOWN.password);
    }

    // Avant l'échéance : aucune nouvelle tentative.
    clock.advance(30_000);
    expect(await w.scheduler.runTask(OUTBOX_TASK)).toMatchObject({ summary: { reservees: 0 } });
    expect((await w.prisma.client.notificationOutbox.findFirstOrThrow({ where: { alertId } })).attempts).toBe(1);

    // Tentatives suivantes : délais 2, 4, 8, 16, 32, 60 min, puis abandon à la 8e.
    const delays: number[] = [];
    for (let attempt = 2; attempt <= 8; attempt += 1) {
      const before = await w.prisma.client.notificationOutbox.findFirstOrThrow({ where: { alertId } });
      clock.set(before.nextAttemptAt);
      await w.scheduler.runTask(OUTBOX_TASK);
      const after = await w.prisma.client.notificationOutbox.findFirstOrThrow({ where: { id: before.id } });
      expect(after.attempts).toBe(attempt);
      if (attempt < 8) {
        expect(after.status).toBe('ECHEC');
        delays.push((after.nextAttemptAt.getTime() - clock.now().getTime()) / 60_000);
      } else {
        expect(after.status).toBe('ABANDONNE');
      }
      expect(after.lastError).not.toContain(SMTP_DOWN.password);
    }
    expect(delays).toEqual([2, 4, 8, 16, 32, 60]);
    rows = await w.prisma.client.notificationOutbox.findMany({ where: { alertId } });
    expect(rows.map((r) => r.status)).toEqual(['ABANDONNE', 'ABANDONNE']);
    // Plus rien n'est tenté sur une ligne abandonnée.
    clock.advance(24 * 3_600_000);
    expect(await w.scheduler.runTask(OUTBOX_TASK)).toMatchObject({ summary: { reservees: 0 } });
  });

  it('(c) arrêt brutal pendant l’envoi puis redémarrage avec SMTP disponible : reprise après expiration du verrou, envoi réel (Mailpit), statut ENVOYE ; droits revérifiés', async () => {
    const down = await worker(SMTP_DOWN);
    await resetDatabase(down.prisma);
    f = await seedFixture(down.prisma);
    const { alertId } = await raiseCriticalIncident(down, f, new Date('2026-09-24T09:30:00Z'));
    expect(await down.prisma.client.notificationOutbox.count({ where: { alertId } })).toBe(2);

    // Le premier worker réserve les lignes (EN_COURS, verrou de 2 min) puis s'arrête sans rien écrire.
    const claimed = await down.dispatcher.claim(clock.now(), 10);
    expect(claimed).toHaveLength(2);
    const locked = await down.prisma.client.notificationOutbox.findMany({ where: { alertId } });
    expect(locked.every((r) => r.status === 'EN_COURS' && r.lockedBy === down.leases.holderId && r.lockedUntil?.toISOString() === '2026-09-24T10:02:00.000Z')).toBe(true);
    await down.close();
    workers.splice(workers.indexOf(down), 1);

    // Redémarrage : nouvelle instance du module, SMTP disponible (Mailpit).
    const up = await worker(MAILPIT_SMTP);
    expect(up.leases.holderId).not.toBe(down.leases.holderId);
    // Verrou encore valide : la ligne n'est ni reprise ni envoyée (pas de double traitement).
    expect(await up.scheduler.runTask(OUTBOX_TASK)).toMatchObject({ status: 'EXECUTE', summary: { reprises: 0, reservees: 0, envoyees: 0 } });

    // Le chef de parc perd son habilitation avant l'envoi : sa ligne est annulée (droits revérifiés).
    await up.prisma.client.membership.deleteMany({ where: { userId: f.chefAId } });

    clock.set('2026-09-24T10:02:01.000Z');
    const resumed = await up.scheduler.runTask(OUTBOX_TASK);
    expect(resumed).toMatchObject({ status: 'EXECUTE', summary: { reprises: 2, reservees: 2, envoyees: 1, annulees: 1, echecs: 0 } });
    const adminRow = await up.prisma.client.notificationOutbox.findFirstOrThrow({ where: { alertId, recipientUserId: f.adminId } });
    expect(adminRow).toMatchObject({ status: 'ENVOYE', attempts: 1, lastError: null, lockedBy: null, lockedUntil: null });
    expect(adminRow.sentAt?.toISOString()).toBe('2026-09-24T10:02:01.000Z');
    expect(adminRow.providerMessageId).toBeTruthy();
    const chefRow = await up.prisma.client.notificationOutbox.findFirstOrThrow({ where: { alertId, recipientUserId: f.chefAId } });
    expect(chefRow).toMatchObject({ status: 'ANNULE', attempts: 0, sentAt: null });
    expect(chefRow.lastError).toMatch(/^Droits révoqués/);

    // Réception réelle par le serveur SMTP de test.
    const received = await mailpitMessages(f.vehicleCode);
    expect(received).toHaveLength(1);
    expect(received[0]?.To.map((t) => t.Address)).toEqual([f.adminEmail]);

    // Rien n'est renvoyé ensuite.
    clock.advance(60_000);
    expect(await up.scheduler.runTask(OUTBOX_TASK)).toMatchObject({ summary: { reservees: 0, envoyees: 0 } });
    expect(await mailpitMessages(f.vehicleCode)).toHaveLength(1);
  });
});
