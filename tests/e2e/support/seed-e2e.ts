import { hash } from '@node-rs/argon2';
import { createPrismaClient } from '@parc-auto/db';

/** Données fictives des parcours navigateur (jamais des comptes réels). */
export const E2E = {
  password: 'Parcours-E2E-2026',
  admin: 'admin.e2e@parc-auto.test',
  chefA: 'chef.a.e2e@parc-auto.test',
  conducteur: 'conducteur.e2e@parc-auto.test',
  companyA: 'E2E-A',
  companyB: 'E2E-B',
};

export async function seedE2E(databaseUrl: string): Promise<void> {
  const prisma = createPrismaClient({ databaseUrl, log: ['error'] });
  try {
    const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
        AND tablename NOT LIKE '%\\_default' AND tablename !~ '_[0-9]{6}$'`;
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
    const org = await prisma.organization.create({ data: { code: 'E2E', name: 'Groupe E2E' } });
    const a = await prisma.company.create({ data: { organizationId: org.id, code: E2E.companyA, legalName: 'Société E2E A' } });
    const b = await prisma.company.create({ data: { organizationId: org.id, code: E2E.companyB, legalName: 'Société E2E B' } });
    const category = await prisma.vehicleCategory.create({ data: { organizationId: org.id, code: 'VP', label: 'Véhicule particulier', requiredPermitCategories: ['B'] } });
    await prisma.site.create({ data: { organizationId: org.id, companyId: a.id, name: 'Dépôt Tunis', address: 'Zone industrielle' } });
    const passwordHash = await hash(E2E.password, { algorithm: 2, memoryCost: 65536, timeCost: 3, parallelism: 1 });
    await prisma.user.create({ data: { organizationId: org.id, email: E2E.admin, firstName: 'Amel', lastName: 'Admin', passwordHash, memberships: { create: [{ companyId: null, role: 'ADMIN' }] } } });
    await prisma.user.create({ data: { organizationId: org.id, email: E2E.chefA, firstName: 'Chaima', lastName: 'Chef', passwordHash, memberships: { create: [{ companyId: a.id, role: 'CHEF_PARC' }] } } });
    const condUser = await prisma.user.create({ data: { organizationId: org.id, email: E2E.conducteur, firstName: 'Karim', lastName: 'Conducteur', passwordHash, memberships: { create: [{ companyId: a.id, role: 'CONDUCTEUR' }] } } });
    await prisma.driver.create({ data: { organizationId: org.id, companyId: a.id, code: 'D-E2E-1', firstName: 'Karim', lastName: 'Conducteur', userId: condUser.id } });
    await prisma.driver.create({ data: { organizationId: org.id, companyId: a.id, code: 'D-E2E-2', firstName: 'Sami', lastName: 'Second' } });
    const mkVehicle = (companyId: string, code: string, registration: string) =>
      prisma.vehicle.create({ data: { organizationId: org.id, companyId, code, registration, registrationNormalized: registration.replace(/\s/g, '').toUpperCase(), make: 'Peugeot', model: '208', categoryId: category.id, qrToken: `qr-${code}` } });
    await mkVehicle(a.id, 'E2E-VA1', '101 TU 2026');
    await mkVehicle(a.id, 'E2E-VA2', '102 TU 2026');
    await mkVehicle(b.id, 'E2E-VB1', '201 TU 2026');
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith('seed-e2e.ts')) {
  const url = process.env['TEST_DATABASE_URL'] ?? 'postgresql://parc_auto:parc_auto_test@localhost:5433/parc_auto_test';
  seedE2E(url)
    .then(() => process.stdout.write('Seed e2e appliqué.\n'))
    .catch((error: unknown) => {
      process.stderr.write(`Seed e2e en échec : ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
