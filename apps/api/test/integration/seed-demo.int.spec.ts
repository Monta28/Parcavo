import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedDemoCli, type CliIo } from '../../src/cli/seed-demo.js';
import { loadEnv } from '../../src/infra/env.js';
import { PasswordService } from '../../src/infra/password.service.js';
import { PrismaService } from '../../src/infra/prisma.service.js';
import { resetDatabase } from '../support/test-app.js';

/**
 * Jeu de démonstration (CDC 19.2, D-324) exécuté réellement sur la base de test : refus en production et
 * sur base non vide, volumes (3 sociétés, 12 véhicules, rôles), cas métier produits par les services de
 * l'API (utilisation ouverte, relevé en attente, document expiré, alertes) et remise à zéro explicite.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? 'postgresql://parc_auto:parc_auto_test@localhost:5433/parc_auto_test';
const DEMO_PASSWORD = 'Demo-Recette-2026-Parc';
const SEED_TIMEOUT_MS = 300_000;

function captureIo(): CliIo & { stdout: () => string; stderr: () => string } {
  let out = '';
  let err = '';
  return { out: (t) => void (out += t), err: (t) => void (err += t), stdout: () => out, stderr: () => err };
}

describe('Jeu de démonstration (seed-demo)', () => {
  let prisma: PrismaService;
  let storageDir: string;
  const passwords = new PasswordService();

  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    NODE_ENV: 'test',
    DATABASE_URL,
    STORAGE_DIR: storageDir,
    LOG_LEVEL: 'error',
    TELEMETRY_SIMULATOR_ENABLED: 'false',
    ...extra,
  });

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'parc-auto-demo-'));
    prisma = new PrismaService(loadEnv({ NODE_ENV: 'test', DATABASE_URL }));
    await prisma.client.$connect();
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await prisma.client.$disconnect();
    await rm(storageDir, { recursive: true, force: true });
  });

  it('refuse de s’exécuter en production, même avec --reset, sans rien écrire', async () => {
    for (const argv of [[], ['--reset']]) {
      const io = captureIo();
      const code = await runSeedDemoCli(argv, env({ NODE_ENV: 'production', DEMO_PASSWORD }), io);
      expect(code).toBe(1);
      expect(io.stderr()).toContain('jamais chargé en production');
      expect(io.stdout()).toBe('');
    }
    expect(await prisma.client.organization.count()).toBe(0);
  });

  it('refuse un DEMO_PASSWORD trop faible et un argument inconnu', async () => {
    const weak = captureIo();
    expect(await runSeedDemoCli([], env({ DEMO_PASSWORD: 'faible' }), weak)).toBe(1);
    expect(weak.stderr()).toContain('DEMO_PASSWORD trop faible');
    const unknown = captureIo();
    expect(await runSeedDemoCli(['--force'], env({ DEMO_PASSWORD }), unknown)).toBe(2);
    expect(unknown.stderr()).toContain('Argument inconnu');
    expect(await prisma.client.organization.count()).toBe(0);
  });

  it(
    'charge le jeu complet sur une base vierge par les services métier',
    async () => {
      const io = captureIo();
      const code = await runSeedDemoCli([], env({ DEMO_PASSWORD }), io);
      expect(code, io.stderr()).toBe(0);
      // Mot de passe fourni : jamais réaffiché.
      expect(io.stdout()).not.toContain(DEMO_PASSWORD);
      expect(io.stdout()).toContain('Mot de passe : celui fourni dans DEMO_PASSWORD.');
      const client = prisma.client;
      const org = await client.organization.findFirstOrThrow({ where: { code: 'DEMO' } });

      // Volumes : 3 sociétés, 12 véhicules (4 par société après le transfert), 1 admin, 3 chefs, conducteurs.
      const companies = await client.company.findMany({ where: { organizationId: org.id }, include: { _count: { select: { vehicles: true } } }, orderBy: { code: 'asc' } });
      expect(companies.map((c) => [c.code, c._count.vehicles])).toEqual([['ATLAS', 4], ['CARTHAGE', 4], ['OASIS', 4]]);
      expect(await client.vehicle.count({ where: { organizationId: org.id } })).toBe(12);
      const roles = await client.membership.groupBy({ by: ['role'], where: { organizationId: org.id }, _count: { _all: true } });
      const byRole = Object.fromEntries(roles.map((r) => [r.role, r._count._all]));
      expect(byRole).toMatchObject({ ADMIN: 1, CHEF_PARC: 3, CONDUCTEUR: 3 });
      expect(await client.membership.count({ where: { organizationId: org.id, role: 'CHEF_PARC', companyId: null } })).toBe(0);
      expect(await client.driver.count({ where: { organizationId: org.id } })).toBe(10);
      const admin = await client.user.findFirstOrThrow({ where: { organizationId: org.id, email: 'admin@demo.parc-auto.test' } });
      expect(await passwords.verify(admin.passwordHash, DEMO_PASSWORD)).toBe(true);
      const chef = await client.user.findFirstOrThrow({ where: { organizationId: org.id, email: 'chef.oasis@demo.parc-auto.test' } });
      expect(await passwords.verify(chef.passwordHash, DEMO_PASSWORD)).toBe(true);

      // Utilisations : ouvertes (dont une en retard) et clôturées.
      const vehicle = async (code: string) => client.vehicle.findFirstOrThrow({ where: { organizationId: org.id, code } });
      const open = await client.vehicleUsage.findMany({ where: { organizationId: org.id, status: 'EN_COURS' }, include: { vehicle: { select: { code: true } } } });
      expect(open.map((u) => u.vehicle.code).sort()).toEqual(['VH-01', 'VH-02', 'VH-10']);
      expect(open.find((u) => u.vehicle.code === 'VH-02')?.expectedReturnAt.getTime()).toBeLessThan(Date.now());
      expect(await client.vehicleUsage.count({ where: { organizationId: org.id, status: 'TERMINEE', distanceStatus: 'VALIDEE' } })).toBeGreaterThanOrEqual(7);

      // Relevés : en attente au-delà du seuil, validé, corrigé, remplacement de compteur.
      const vh03 = await vehicle('VH-03');
      const pending = await client.odometerReading.findMany({ where: { organizationId: org.id, status: 'EN_ATTENTE' } });
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ vehicleId: vh03.id, anomalyCode: 'HAUSSE_IMPLAUSIBLE' });
      expect(await client.odometerReading.count({ where: { organizationId: org.id, status: 'REMPLACE' } })).toBe(1);
      expect(await client.odometerReading.count({ where: { organizationId: org.id, replacesReadingId: { not: null }, status: 'ACCEPTE' } })).toBe(1);
      const vh07 = await vehicle('VH-07');
      expect(await client.odometerSegment.count({ where: { vehicleId: vh07.id } })).toBe(2);
      const vh01 = await vehicle('VH-01');
      expect(await client.odometerReading.count({ where: { vehicleId: vh01.id, status: 'ACCEPTE', decidedById: { not: null }, physicalKm: '38610' } })).toBe(1);

      // Documents : assurance expirée (bloquante) de VH-05, visite technique à renouveler de VH-06.
      const vh05 = await vehicle('VH-05');
      const insurance = await client.documentType.findFirstOrThrow({ where: { organizationId: org.id, code: 'ASSURANCE' } });
      expect(insurance).toMatchObject({ required: true, blocksCheckout: true });
      const expired = await client.documentVersion.findFirstOrThrow({ where: { vehicleId: vh05.id, documentTypeId: insurance.id } });
      expect(expired.validTo?.getTime()).toBeLessThan(Date.now());

      // Plans : à jour, bientôt dû, en retard ; interventions ouverte et clôturée ; immobilisation active.
      const planStatuses = await client.vehicleMaintenancePlan.groupBy({ by: ['computedStatus'], where: { organizationId: org.id, active: true }, _count: { _all: true } });
      const statuses = new Set(planStatuses.map((p) => p.computedStatus));
      for (const s of ['A_JOUR', 'A_PREVOIR', 'EN_RETARD']) expect(statuses.has(s as never), s).toBe(true);
      // CDC 19.2 : vidange proche (VH-07) et vidange en retard (VH-03).
      const oilChanges = await client.vehicleMaintenancePlan.findMany({ where: { organizationId: org.id, active: true, maintenanceType: { code: 'VIDANGE_MOTEUR' } }, select: { computedStatus: true, vehicle: { select: { code: true } } } });
      const oilStatus = Object.fromEntries(oilChanges.map((p) => [p.vehicle.code, p.computedStatus]));
      expect(oilStatus).toMatchObject({ 'VH-03': 'EN_RETARD', 'VH-07': 'A_PREVOIR', 'VH-08': 'A_JOUR' });
      expect(await client.intervention.count({ where: { organizationId: org.id, status: 'TERMINEE', costStatus: 'SAISI' } })).toBe(1);
      expect(await client.intervention.count({ where: { organizationId: org.id, status: 'PLANIFIEE' } })).toBe(1);
      expect(await client.immobilization.count({ where: { organizationId: org.id, status: 'ACTIVE' } })).toBe(1);

      // Incidents mineur et critique ; pleins normal, écart en attente, doublon rejeté ; dépenses.
      expect(await client.incident.count({ where: { organizationId: org.id, severity: 'CRITIQUE', status: 'OUVERT' } })).toBe(1);
      expect(await client.incident.count({ where: { organizationId: org.id, severity: 'FAIBLE', status: 'RESOLU' } })).toBe(1);
      expect(await client.fuelEntry.count({ where: { organizationId: org.id, status: 'SOUMIS', amountMismatch: true } })).toBe(1);
      expect(await client.fuelEntry.count({ where: { organizationId: org.id, status: 'REJETE' } })).toBe(1);
      expect(await client.fuelEntry.count({ where: { organizationId: org.id, status: 'VALIDE' } })).toBe(4);
      expect(await client.expense.count({ where: { organizationId: org.id, status: 'VALIDEE' } })).toBe(8);

      // Réservations future et non honorée ; responsables habituels ; transfert ; lot d'import confirmé.
      expect(await client.reservation.count({ where: { organizationId: org.id, status: 'NON_HONOREE' } })).toBe(1);
      expect(await client.reservation.count({ where: { organizationId: org.id, status: 'CONFIRMEE', startAt: { gt: new Date() } } })).toBe(2);
      expect(await client.vehicleResponsibleAssignment.count({ where: { organizationId: org.id, endsAt: null } })).toBe(2);
      const vh09 = await vehicle('VH-09');
      const oasis = companies.find((c) => c.code === 'OASIS');
      expect(vh09.companyId).toBe(oasis?.id);
      expect(await client.vehicleCompanyHistory.count({ where: { vehicleId: vh09.id, fromCompanyId: { not: null } } })).toBe(1);
      expect(await client.importBatch.count({ where: { organizationId: org.id, status: 'CONFIRME', kind: 'CONDUCTEURS' } })).toBe(1);

      // Alertes ouvertes produites par les règles de l'API.
      const alerts = await client.alert.findMany({ where: { organizationId: org.id, status: 'ACTIVE' }, select: { type: true, vehicleId: true, severity: true } });
      const alertTypes = new Set(alerts.map((a) => a.type));
      for (const type of ['RETOUR_DEPASSE', 'RESERVATION_COMPROMISE', 'RELEVE_A_VALIDER', 'ENTRETIEN_ECHEANCE', 'DOCUMENT_ECHEANCE', 'KILOMETRAGE_ANCIEN', 'INCIDENT_CRITIQUE']) {
        expect(alertTypes.has(type as never), type).toBe(true);
      }
      expect(alerts.find((a) => a.type === 'DOCUMENT_ECHEANCE' && a.vehicleId === vh05.id)?.severity).toBe('CRITIQUE');
      // CDC 19.2 : relevé ancien (VH-06, 25 jours), retour tardif (VH-02), immobilisation (VH-04).
      const vh02 = await vehicle('VH-02');
      const vh04 = await vehicle('VH-04');
      const vh06 = await vehicle('VH-06');
      expect(alerts.filter((a) => a.type === 'KILOMETRAGE_ANCIEN').map((a) => a.vehicleId)).toEqual([vh06.id]);
      expect(alerts.filter((a) => a.type === 'RETOUR_DEPASSE').map((a) => a.vehicleId)).toEqual([vh02.id]);
      expect(await client.immobilization.count({ where: { vehicleId: vh04.id, status: 'ACTIVE' } })).toBe(1);

      // Historique d'alertes vraisemblable : les étapes datées sont évaluées à leur heure, aucune alerte
      // « Kilométrage à actualiser » n'est levée puis résolue par les relevés historiques du chargement, et
      // aucune alerte n'est résolue avant d'avoir été levée.
      expect(await client.alert.count({ where: { organizationId: org.id, type: 'KILOMETRAGE_ANCIEN', status: 'RESOLUE' } })).toBe(0);
      const resolved = await client.alert.findMany({ where: { organizationId: org.id, status: 'RESOLUE' }, select: { type: true, triggeredAt: true, resolvedAt: true } });
      for (const a of resolved) expect(a.resolvedAt?.getTime() ?? 0, a.type).toBeGreaterThanOrEqual(a.triggeredAt.getTime());
      const vh08 = await vehicle('VH-08');
      const done = await client.alert.findFirstOrThrow({ where: { vehicleId: vh08.id, type: 'ENTRETIEN_ECHEANCE' } });
      expect(done.status).toBe('RESOLUE');
      expect(done.resolvedAt?.getTime()).toBeLessThan(Date.now() - 6 * 86_400_000);

      // Audit : chaque écriture tracée ; F11 laissé désactivé sans simulateur.
      expect(await client.auditEvent.count({ where: { organizationId: org.id, action: 'cli.jeu_demonstration', actorType: 'SYSTEME' } })).toBe(1);
      expect(await client.auditEvent.count({ where: { organizationId: org.id, actorType: 'UTILISATEUR' } })).toBeGreaterThan(100);
      expect(await client.telemetryProvider.count()).toBe(0);
      expect(await client.company.count({ where: { telemetryEnabled: true } })).toBe(0);
    },
    SEED_TIMEOUT_MS,
  );

  it('refuse une base non vide sans --reset', async () => {
    const before = await prisma.client.vehicle.count();
    const io = captureIo();
    expect(await runSeedDemoCli([], env({ DEMO_PASSWORD }), io)).toBe(1);
    expect(io.stderr()).toContain('la base n’est pas vide');
    expect(await prisma.client.organization.count()).toBe(1);
    expect(await prisma.client.vehicle.count()).toBe(before);
  });

  it('refuse --reset sur une base qui contient une autre organisation que DEMO, sans rien supprimer', async () => {
    const client = prisma.client;
    const other = await client.organization.create({ data: { code: 'GROUPE', name: 'Organisation réelle (test)', timezone: 'Africa/Tunis' } });
    try {
      const vehicles = await client.vehicle.count();
      const audit = await client.auditEvent.count();
      const io = captureIo();
      expect(await runSeedDemoCli(['--reset'], env({ DEMO_PASSWORD }), io)).toBe(1);
      expect(io.stderr()).toContain('--reset ne vide qu’une base de démonstration');
      expect(await client.organization.count()).toBe(2);
      expect(await client.vehicle.count()).toBe(vehicles);
      expect(await client.auditEvent.count()).toBe(audit);
      // Sans --reset, le refus ne propose pas de vider une base qui porte d'autres organisations.
      const plain = captureIo();
      expect(await runSeedDemoCli([], env({ DEMO_PASSWORD }), plain)).toBe(1);
      expect(plain.stderr()).toContain('la base n’est pas vide');
      expect(plain.stderr()).not.toContain('--reset');
    } finally {
      await client.organization.delete({ where: { id: other.id } });
    }
  });
});
