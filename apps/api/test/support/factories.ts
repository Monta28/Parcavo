import type { MembershipRole, Permission } from '@parc-auto/db';
import { randomUUID } from 'node:crypto';
import { PasswordService } from '../../src/infra/password.service.js';
import type { PrismaService } from '../../src/infra/prisma.service.js';

export const DEFAULT_PASSWORD = 'MotDePasse-Test-123';

const passwords = new PasswordService();
let cachedHash: string | null = null;
async function passwordHash(): Promise<string> {
  cachedHash ??= await passwords.hash(DEFAULT_PASSWORD);
  return cachedHash;
}

export interface Fixture {
  organizationId: string;
  companies: Record<'A' | 'B' | 'C', string>;
  categoryId: string;
  users: { admin: string; chefA: string; chefB: string; operateurA: string; lecteurA: string; conducteurA: string };
  drivers: { a1: string; a2: string; b1: string };
  emails: Record<'admin' | 'chefA' | 'chefB' | 'operateurA' | 'lecteurA' | 'conducteurA', string>;
}

/**
 * Jeu de données de test : une organisation, trois sociétés (A, B, C), un administrateur,
 * un chef par société A et B, un opérateur, un lecteur et un conducteur avec compte (société A).
 */
export async function seedFixture(prisma: PrismaService): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const org = await prisma.client.organization.create({ data: { code: `ORG-${suffix}`, name: 'Groupe Test' } });
  const companies = {} as Fixture['companies'];
  for (const code of ['A', 'B', 'C'] as const) {
    const c = await prisma.client.company.create({ data: { organizationId: org.id, code, legalName: `Société ${code}` } });
    companies[code] = c.id;
  }
  const category = await prisma.client.vehicleCategory.create({ data: { organizationId: org.id, code: 'VP', label: 'Véhicule particulier', requiredPermitCategories: ['B'] } });
  const hash = await passwordHash();
  const emails: Fixture['emails'] = {
    admin: `admin.${suffix}@test.local`,
    chefA: `chef.a.${suffix}@test.local`,
    chefB: `chef.b.${suffix}@test.local`,
    operateurA: `op.a.${suffix}@test.local`,
    lecteurA: `lecteur.a.${suffix}@test.local`,
    conducteurA: `cond.a.${suffix}@test.local`,
  };
  const mk = async (email: string, first: string, last: string, memberships: Array<{ companyId: string | null; role: MembershipRole; granted?: Permission[] }>) => {
    const u = await prisma.client.user.create({
      data: {
        organizationId: org.id,
        email,
        firstName: first,
        lastName: last,
        passwordHash: hash,
        memberships: { create: memberships.map((m) => ({ companyId: m.companyId, role: m.role, grantedPermissions: m.granted ?? [] })) },
      },
    });
    return u.id;
  };
  const admin = await mk(emails.admin, 'Alice', 'Admin', [{ companyId: null, role: 'ADMIN' }]);
  const chefA = await mk(emails.chefA, 'Chaima', 'Chef-A', [{ companyId: companies.A, role: 'CHEF_PARC' }]);
  const chefB = await mk(emails.chefB, 'Bilel', 'Chef-B', [{ companyId: companies.B, role: 'CHEF_PARC' }]);
  const operateurA = await mk(emails.operateurA, 'Omar', 'Opérateur-A', [{ companyId: companies.A, role: 'OPERATEUR' }]);
  const lecteurA = await mk(emails.lecteurA, 'Lina', 'Lecteur-A', [{ companyId: companies.A, role: 'LECTEUR' }]);
  const conducteurA = await mk(emails.conducteurA, 'Karim', 'Conducteur-A', [{ companyId: companies.A, role: 'CONDUCTEUR' }]);

  const a1 = await prisma.client.driver.create({ data: { organizationId: org.id, companyId: companies.A, code: `D-A1-${suffix}`, firstName: 'Karim', lastName: 'Conducteur-A', userId: conducteurA } });
  const a2 = await prisma.client.driver.create({ data: { organizationId: org.id, companyId: companies.A, code: `D-A2-${suffix}`, firstName: 'Sami', lastName: 'Deux' } });
  const b1 = await prisma.client.driver.create({ data: { organizationId: org.id, companyId: companies.B, code: `D-B1-${suffix}`, firstName: 'Nour', lastName: 'Bé' } });

  return {
    organizationId: org.id,
    companies,
    categoryId: category.id,
    users: { admin, chefA, chefB, operateurA, lecteurA, conducteurA },
    drivers: { a1: a1.id, a2: a2.id, b1: b1.id },
    emails,
  };
}

export async function createVehicle(
  prisma: PrismaService,
  fixture: Fixture,
  company: 'A' | 'B' | 'C',
  overrides: Partial<{ code: string; registration: string; make: string; model: string }> = {},
): Promise<string> {
  const suffix = randomUUID().slice(0, 6);
  const registration = overrides.registration ?? `${suffix.toUpperCase()} TU 1`;
  const v = await prisma.client.vehicle.create({
    data: {
      organizationId: fixture.organizationId,
      companyId: fixture.companies[company],
      code: overrides.code ?? `V-${company}-${suffix}`,
      registration,
      registrationNormalized: registration.replace(/[^A-Z0-9]/gi, '').toUpperCase(),
      make: overrides.make ?? 'Peugeot',
      model: overrides.model ?? '208',
      categoryId: fixture.categoryId,
      qrToken: randomUUID(),
    },
  });
  return v.id;
}
