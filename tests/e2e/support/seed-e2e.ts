import { hash } from '@node-rs/argon2';
import { createPrismaClient } from '@parc-auto/db';

/** Données fictives des parcours navigateur (jamais des comptes réels). */
export const E2E = {
  password: 'Parcours-E2E-2026',
  admin: 'admin.e2e@parc-auto.test',
  chefA: 'chef.a.e2e@parc-auto.test',
  conducteur: 'conducteur.e2e@parc-auto.test',
  /** Conducteur dédié aux parcours relevés (lot B), avec une utilisation en cours sur E2E-KM1 (relevé de remise 20 000 km). */
  conducteurReleves: 'conducteur.releves.e2e@parc-auto.test',
  /** Conductrice dédiée aux signalements (lot C), avec une utilisation en cours sur E2E-INC1 (relevé de remise 30 000 km). */
  conducteurIncidents: 'conducteur.incidents.e2e@parc-auto.test',
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
    // Lot B (specs/utilisations.spec.ts, specs/releves.spec.ts, specs/reservations.spec.ts) : véhicules et
    // conducteurs dédiés de la société A, conducteurs titulaires d'un permis B valide (aucun blocage ni
    // dérogation au départ ou à la réservation), pour ne dépendre d'aucune autre spec ni la gêner.
    const mkDriverWithPermit = async (code: string, firstName: string, lastName: string, userId: string | null = null) => {
      const driver = await prisma.driver.create({ data: { organizationId: org.id, companyId: a.id, code, firstName, lastName, userId } });
      await prisma.driverPermit.create({ data: { organizationId: org.id, driverId: driver.id, number: `P-${code}`, categories: ['B'], issuedOn: new Date('2015-03-01'), expiresOn: new Date('2035-02-28') } });
      return driver;
    };
    const lotBAt = Date.now();
    const chefUser = await prisma.user.findFirstOrThrow({ where: { organizationId: org.id, email: E2E.chefA } });
    // Remise et retour (utilisations.spec.ts) : véhicule jamais relevé, deux conducteurs pour la double remise.
    await mkVehicle(a.id, 'E2E-UT1', '501 TU 2026');
    await mkDriverWithPermit('D-E2E-UT1', 'Ines', 'Remise');
    await mkDriverWithPermit('D-E2E-UT2', 'Omar', 'Relais');
    // Localisation déclarative (utilisations.spec.ts) : véhicule sans localisation.
    await mkVehicle(a.id, 'E2E-LOC1', '506 TU 2026');
    // Relevés (releves.spec.ts) : utilisation en cours de la conductrice sur E2E-KM1, remise il y a 2 h avec un
    // relevé accepté de 20 000 km, dans l'état exact produit par l'API (segment 1 d'initialisation ordinaire) ;
    // E2E-KM2 sans relevé pour la saisie et la correction par le chef.
    const readingVehicle = await mkVehicle(a.id, 'E2E-KM1', '502 TU 2026');
    await mkVehicle(a.id, 'E2E-KM2', '503 TU 2026');
    const readingUser = await prisma.user.create({ data: { organizationId: org.id, email: E2E.conducteurReleves, firstName: 'Rania', lastName: 'Releve', passwordHash, memberships: { create: [{ companyId: a.id, role: 'CONDUCTEUR' }] } } });
    const readingDriver = await mkDriverWithPermit('D-E2E-KM', 'Rania', 'Releve', readingUser.id);
    const readingCheckoutAt = new Date(lotBAt - 2 * 3600_000);
    const readingSegment = await prisma.odometerSegment.create({
      data: {
        organizationId: org.id,
        vehicleId: readingVehicle.id,
        sequence: 1,
        startedAt: readingCheckoutAt,
        startPhysicalKm: '20000',
        startCumulativeKm: '20000',
        cumulativeKnown: true,
        replacementReason: 'Initialisation ordinaire au premier relevé (cumul égal au compteur physique).',
        lastPhysicalKm: '20000',
        createdById: chefUser.id,
      },
    });
    const checkoutReading = await prisma.odometerReading.create({
      data: {
        organizationId: org.id,
        companyId: a.id,
        vehicleId: readingVehicle.id,
        segmentId: readingSegment.id,
        source: 'MANUAL',
        context: 'REMISE',
        measurementKind: 'COMPTEUR_AFFICHE',
        status: 'ACCEPTE',
        physicalKm: '20000',
        cumulativeKm: '20000',
        observedAt: readingCheckoutAt,
        enteredAt: readingCheckoutAt,
        decidedAt: readingCheckoutAt,
        decidedById: chefUser.id,
        createdById: chefUser.id,
      },
    });
    await prisma.vehicleUsage.create({
      data: {
        organizationId: org.id,
        companyId: a.id,
        vehicleId: readingVehicle.id,
        driverId: readingDriver.id,
        purpose: 'Tournée commerciale Cap Bon',
        checkedOutAt: readingCheckoutAt,
        expectedReturnAt: new Date(lotBAt + 3 * 24 * 3600_000),
        checkoutReadingId: checkoutReading.id,
        distanceStatus: 'NON_VALIDEE',
        checkedOutById: chefUser.id,
        createdById: chefUser.id,
      },
    });
    // Réservations (reservations.spec.ts) : véhicule libre et deux conducteurs.
    await mkVehicle(a.id, 'E2E-RS1', '504 TU 2026');
    await mkDriverWithPermit('D-E2E-RS1', 'Walid', 'Reserve');
    await mkDriverWithPermit('D-E2E-RS2', 'Leila', 'Creneau');
    // Responsable habituel (reservations.spec.ts, T08) : utilisation ponctuelle en cours d'une autre conductrice.
    const responsibleVehicle = await mkVehicle(a.id, 'E2E-RH1', '505 TU 2026');
    await mkDriverWithPermit('D-E2E-RH1', 'Hedi', 'Habituel');
    await mkDriverWithPermit('D-E2E-RH3', 'Slim', 'Suppleant');
    const occasionalDriver = await mkDriverWithPermit('D-E2E-RH2', 'Mouna', 'Ponctuelle');
    await prisma.vehicleUsage.create({
      data: {
        organizationId: org.id,
        companyId: a.id,
        vehicleId: responsibleVehicle.id,
        driverId: occasionalDriver.id,
        purpose: 'Livraison ponctuelle à Sousse',
        checkedOutAt: new Date(lotBAt - 3600_000),
        expectedReturnAt: new Date(lotBAt + 2 * 24 * 3600_000),
        checkoutWithoutReading: true,
        checkoutExceptionReason: 'Données de démonstration du parcours responsable habituel',
        checkedOutById: chefUser.id,
        createdById: chefUser.id,
      },
    });
    // Lot C (specs/entretien.spec.ts, specs/documents-incidents.spec.ts) : données dédiées de la société A.
    // Catalogue et modèle de plan paramétrés par l'administrateur (aucun plan copié : le parcours applique le
    // modèle) et garage de la société A. E2E-ENT1 relevé à 89 500 km il y a 2 jours (segment 1 d'initialisation
    // ordinaire, état produit par l'API). E2E-DOC1 est le seul véhicule de la catégorie « Fourgon », à laquelle
    // est restreinte l'attestation d'assurance requise et bloquante : la conformité des autres véhicules et leurs
    // départs ne changent pas. E2E-INC1 remis il y a 3 h (relevé de remise 30 000 km) à la conductrice des
    // signalements.
    const lotCAt = Date.now();
    const adminUser = await prisma.user.findFirstOrThrow({ where: { organizationId: org.id, email: E2E.admin } });
    const oilChange = await prisma.maintenanceType.create({ data: { organizationId: org.id, code: 'E2E-VIDANGE', label: 'Vidange moteur', createdById: adminUser.id } });
    const battery = await prisma.maintenanceType.create({ data: { organizationId: org.id, code: 'E2E-BATTERIE', label: 'Remplacement batterie', createdById: adminUser.id } });
    const maintenanceTemplate = await prisma.maintenancePlanTemplate.create({ data: { organizationId: org.id, name: 'Entretien courant E2E', description: 'Vidange et batterie des véhicules légers', createdById: adminUser.id } });
    await prisma.maintenancePlanTemplateItem.createMany({
      data: [
        { organizationId: org.id, templateId: maintenanceTemplate.id, maintenanceTypeId: oilChange.id, intervalKm: '10000', intervalMonths: 12 },
        { organizationId: org.id, templateId: maintenanceTemplate.id, maintenanceTypeId: battery.id, intervalMonths: 48 },
      ],
    });
    await prisma.supplier.create({ data: { organizationId: org.id, companyId: a.id, name: 'Lafayette Auto Services E2E', category: 'GARAGE', phone: '+216 71 000 111', createdById: adminUser.id } });
    const mkFirstAcceptedReading = async (vehicleId: string, physicalKm: string, observedAt: Date, context: 'RELEVE_LIBRE' | 'REMISE') => {
      const segment = await prisma.odometerSegment.create({
        data: { organizationId: org.id, vehicleId, sequence: 1, startedAt: observedAt, startPhysicalKm: physicalKm, startCumulativeKm: physicalKm, cumulativeKnown: true, replacementReason: 'Initialisation ordinaire au premier relevé (cumul égal au compteur physique).', lastPhysicalKm: physicalKm, createdById: chefUser.id },
      });
      return prisma.odometerReading.create({
        data: { organizationId: org.id, companyId: a.id, vehicleId, segmentId: segment.id, source: 'MANUAL', context, measurementKind: 'COMPTEUR_AFFICHE', status: 'ACCEPTE', physicalKm, cumulativeKm: physicalKm, observedAt, enteredAt: observedAt, decidedAt: observedAt, decidedById: chefUser.id, createdById: chefUser.id },
      });
    };
    const maintenanceVehicle = await mkVehicle(a.id, 'E2E-ENT1', '601 TU 2026');
    await mkFirstAcceptedReading(maintenanceVehicle.id, '89500', new Date(lotCAt - 2 * 24 * 3600_000), 'RELEVE_LIBRE');
    const vanCategory = await prisma.vehicleCategory.create({ data: { organizationId: org.id, code: 'FG', label: 'Fourgon', requiredPermitCategories: ['B'] } });
    await prisma.vehicle.create({ data: { organizationId: org.id, companyId: a.id, code: 'E2E-DOC1', registration: '602 TU 2026', registrationNormalized: '602TU2026', make: 'Renault', model: 'Trafic', categoryId: vanCategory.id, qrToken: 'qr-E2E-DOC1' } });
    await prisma.documentType.create({
      data: { organizationId: org.id, code: 'E2E-ASSURANCE', label: 'Attestation d’assurance', ownerType: 'VEHICULE', hasExpiry: true, required: true, blocksCheckout: true, noticeDays: [30, 15, 7], vehicleCategoryIds: [vanCategory.id], createdById: adminUser.id },
    });
    const incidentVehicle = await mkVehicle(a.id, 'E2E-INC1', '603 TU 2026');
    const incidentUser = await prisma.user.create({ data: { organizationId: org.id, email: E2E.conducteurIncidents, firstName: 'Nadia', lastName: 'Signalement', passwordHash, memberships: { create: [{ companyId: a.id, role: 'CONDUCTEUR' }] } } });
    const incidentDriver = await mkDriverWithPermit('D-E2E-INC', 'Nadia', 'Signalement', incidentUser.id);
    const incidentCheckoutAt = new Date(lotCAt - 3 * 3600_000);
    const incidentCheckoutReading = await mkFirstAcceptedReading(incidentVehicle.id, '30000', incidentCheckoutAt, 'REMISE');
    await prisma.vehicleUsage.create({
      data: {
        organizationId: org.id,
        companyId: a.id,
        vehicleId: incidentVehicle.id,
        driverId: incidentDriver.id,
        purpose: 'Tournée des agences de l’Ariana',
        checkedOutAt: incidentCheckoutAt,
        expectedReturnAt: new Date(lotCAt + 2 * 24 * 3600_000),
        checkoutReadingId: incidentCheckoutReading.id,
        distanceStatus: 'NON_VALIDEE',
        checkedOutById: chefUser.id,
        createdById: chefUser.id,
      },
    });
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
