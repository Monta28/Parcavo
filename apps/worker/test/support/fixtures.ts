import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedClock, IncidentsService, NotificationsService, ObjectStorage, PrismaService, loadEnv, type AppEnv } from '@parc-auto/api';
import { AlertCatchUpJob } from '../../src/jobs/alert-catch-up.job.js';
import { DailyDigestJob } from '../../src/jobs/daily-digest.job.js';
import { DailyPurgeJob } from '../../src/jobs/daily-purge.job.js';
import { OutboxDispatcherJob } from '../../src/jobs/outbox-dispatcher.job.js';
import { JobLeaseService } from '../../src/scheduler/job-lease.service.js';
import { WorkerScheduler } from '../../src/scheduler/worker-scheduler.service.js';
import { WorkerModule } from '../../src/worker.module.js';

export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? 'postgresql://parc_auto:parc_auto_test@localhost:5433/parc_auto_test';

export interface SmtpTestConfig {
  host: string;
  port: number;
  user?: string;
  password?: string;
}

export interface TestWorker {
  env: AppEnv;
  prisma: PrismaService;
  scheduler: WorkerScheduler;
  leases: JobLeaseService;
  dispatcher: OutboxDispatcherJob;
  catchUp: AlertCatchUpJob;
  digest: DailyDigestJob;
  purge: DailyPurgeJob;
  incidents: IncidentsService;
  notifications: NotificationsService;
  storage: ObjectStorage;
  /** Fermeture du contexte sans libérer les baux : simule un arrêt brutal du processus. */
  close(): Promise<void>;
}

/**
 * Démarre une instance du module worker (nouveau processus logique : identifiant de bail propre) sur la
 * base de test réelle, sans minuteurs (les tâches sont déclenchées par le test), avec l'horloge fournie.
 */
export async function startWorker(clock: FixedClock, options: { smtp?: SmtpTestConfig | null; storageDir?: string; envOverrides?: Record<string, string> } = {}): Promise<TestWorker> {
  const storageDir = options.storageDir ?? (await mkdtemp(join(tmpdir(), 'parc-auto-worker-')));
  const smtp = options.smtp ?? null;
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    APP_ORIGIN: 'http://localhost:3000',
    STORAGE_DIR: storageDir,
    APP_VERSION: 'test-worker',
    LOG_LEVEL: 'error',
    ...(smtp ? { SMTP_HOST: smtp.host, SMTP_PORT: String(smtp.port), SMTP_FROM: 'parc-auto@test.local', ...(smtp.user ? { SMTP_USER: smtp.user } : {}), ...(smtp.password ? { SMTP_PASSWORD: smtp.password } : {}) } : {}),
    ...options.envOverrides,
  });
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule.register({ env, clock, schedule: false })] }).compile();
  moduleRef.useLogger(['error']);
  await moduleRef.init();
  return {
    env,
    prisma: moduleRef.get(PrismaService),
    scheduler: moduleRef.get(WorkerScheduler),
    leases: moduleRef.get(JobLeaseService),
    dispatcher: moduleRef.get(OutboxDispatcherJob),
    catchUp: moduleRef.get(AlertCatchUpJob),
    digest: moduleRef.get(DailyDigestJob),
    purge: moduleRef.get(DailyPurgeJob),
    incidents: moduleRef.get(IncidentsService, { strict: false }),
    notifications: moduleRef.get(NotificationsService, { strict: false }),
    storage: moduleRef.get(ObjectStorage, { strict: false }),
    close: () => moduleRef.close(),
  };
}

/** Vide toutes les tables (même préparation que les tests d'intégration de l'API). */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  const tables = await prisma.client.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations')
      AND tablename NOT LIKE '%\\_default' AND tablename !~ '_[0-9]{6}$'`;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  if (list.length > 0) await prisma.client.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

export interface WorkerFixture {
  organizationId: string;
  companyA: string;
  companyB: string;
  adminId: string;
  chefAId: string;
  adminEmail: string;
  chefAEmail: string;
  vehicleId: string;
  vehicleCode: string;
  driverId: string;
}

/**
 * Organisation de test : deux sociétés, un administrateur groupe et un chef de parc de la société A (seuls
 * destinataires d'e-mails, D-244), un conducteur et un véhicule de la société A (code unique).
 */
export async function seedFixture(prisma: PrismaService): Promise<WorkerFixture> {
  const suffix = randomUUID().slice(0, 8);
  const org = await prisma.client.organization.create({ data: { code: `ORG-${suffix}`, name: 'Groupe worker' } });
  const companyA = await prisma.client.company.create({ data: { organizationId: org.id, code: 'A', legalName: 'Société A' } });
  const companyB = await prisma.client.company.create({ data: { organizationId: org.id, code: 'B', legalName: 'Société B' } });
  const category = await prisma.client.vehicleCategory.create({ data: { organizationId: org.id, code: 'VP', label: 'Véhicule particulier', requiredPermitCategories: ['B'] } });
  const adminEmail = `admin.${suffix}@test.local`;
  const chefAEmail = `chef.a.${suffix}@test.local`;
  const admin = await prisma.client.user.create({ data: { organizationId: org.id, email: adminEmail, firstName: 'Alice', lastName: 'Admin', memberships: { create: [{ companyId: null, role: 'ADMIN' }] } } });
  const chefA = await prisma.client.user.create({ data: { organizationId: org.id, email: chefAEmail, firstName: 'Chaima', lastName: 'Chef', memberships: { create: [{ companyId: companyA.id, role: 'CHEF_PARC' }] } } });
  const driver = await prisma.client.driver.create({ data: { organizationId: org.id, companyId: companyA.id, code: `D-${suffix}`, firstName: 'Karim', lastName: 'Conducteur' } });
  const vehicleCode = `V-${suffix.toUpperCase()}`;
  const registration = `${suffix.slice(0, 4).toUpperCase()} TU 1`;
  const vehicle = await prisma.client.vehicle.create({
    data: { organizationId: org.id, companyId: companyA.id, code: vehicleCode, registration, registrationNormalized: registration.replace(/[^A-Z0-9]/gi, '').toUpperCase(), make: 'Peugeot', model: '208', categoryId: category.id, qrToken: randomUUID() },
  });
  return { organizationId: org.id, companyA: companyA.id, companyB: companyB.id, adminId: admin.id, chefAId: chefA.id, adminEmail, chefAEmail, vehicleId: vehicle.id, vehicleCode, driverId: driver.id };
}

/** Incident critique ouvert, déclaré par la voie métier (IncidentsService.syncCriticalAlert) : alerte CRITIQUE. */
export async function raiseCriticalIncident(worker: TestWorker, f: WorkerFixture, occurredAt: Date): Promise<{ incidentId: string; alertId: string }> {
  const incident = await worker.prisma.client.incident.create({
    data: { organizationId: f.organizationId, companyId: f.companyA, vehicleId: f.vehicleId, reference: `INC-2026-${randomUUID().slice(0, 6)}`, type: 'ACCIDENT', severity: 'CRITIQUE', status: 'OUVERT', occurredAt, description: 'Choc avant, véhicule non roulant' },
  });
  await worker.incidents.syncCriticalAlert(incident.id);
  const alert = await worker.prisma.client.alert.findFirstOrThrow({ where: { objectType: 'Incident', objectId: incident.id, type: 'INCIDENT_CRITIQUE' } });
  return { incidentId: incident.id, alertId: alert.id };
}
