/**
 * Jeu de dimensionnement (CDC 17.2) — hypothèse de test, jamais un volume annoncé par le client, jamais en
 * production.
 *
 * Usage (après `pnpm --filter @parc-auto/api build`) :
 *   DATABASE_URL=… LOAD_PASSWORD=… node apps/api/dist/cli/seed-load.js [--scale 1]
 *
 * Volumes à l'échelle 1 (cible initiale du CDC 17.2) : 3 sociétés, 500 véhicules, 1 000 conducteurs,
 * 300 000 relevés kilométriques, 50 comptes pour 50 sessions actives ; en plus, sur deux ans d'historique :
 * environ 50 000 utilisations (remise et restitution avec leurs relevés), 37 000 pleins, 58 000 dépenses,
 * 2 000 incidents, 500 immobilisations, 1 000 plans d'entretien, 2 700 versions de documents.
 *
 * Garde-fous :
 *  - NODE_ENV=production : refus immédiat (code 1), aucune connexion à la base ;
 *  - base non vide (au moins une organisation) : refus (code 1), rien n'est écrit ;
 *  - mot de passe commun des 50 comptes : LOAD_PASSWORD (12 caractères au moins), jamais écrit en dur ni
 *    journalisé ; seule son empreinte Argon2id est stockée.
 *
 * Insertion par lots (createMany, 2 000 lignes par requête) dans l'ordre des dépendances ; les contraintes
 * de la base (exclusions, uniques partielles, CHECK) s'appliquent à chaque ligne. Les données sont
 * cohérentes entre elles : cumul = compteur sur un segment unique, relevés strictement chronologiques,
 * une seule utilisation ouverte par véhicule et par conducteur, dépense CARBURANT liée à chaque plein
 * validé (même montant, jour local), immobilisations sans chevauchement, références d'incident suivies par
 * la séquence. Les statuts d'entretien matérialisés restent à calculer (statusComputedAt vide) : la
 * première lecture des plans ou le recalcul quotidien du worker les matérialise par la règle unique.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createPrismaClient, type ParcAutoPrismaClient, type Prisma } from '@parc-auto/db';
import { describeErrorSafely } from '../common/secret-redaction.js';
import { addDays, localDate, toDbDate, type CivilDate } from '../domain/civil-date.js';
import { normalizeRegistration } from '../domain/registration.js';
import { PasswordService } from '../infra/password.service.js';

// ---------------------------------------------------------------------------------------------
// Volumes et conventions publiques (utilisées par le test de charge et les tests)
// ---------------------------------------------------------------------------------------------

/** Cible initiale du CDC 17.2 (hypothèse de dimensionnement). */
export const CDC_LOAD_TARGET = { companies: 3, vehicles: 500, drivers: 1_000, readings: 300_000, sessions: 50 } as const;

/** Domaine des comptes du jeu de charge : charge.001@… à charge.050@… (mot de passe LOAD_PASSWORD). */
export const LOAD_EMAIL_DOMAIN = 'charge.parc-auto.test';
export const LOAD_ORGANIZATION_CODE = 'CHARGE';
export const LOAD_TIMEZONE = 'Africa/Tunis';
const LOAD_USERS = 50;
const COMPANY_CODES = ['CH-A', 'CH-B', 'CH-C'] as const;
const COMPANY_SHARES = [0.4, 0.35, 0.25] as const;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const HISTORY_DAYS = 730;
const BATCH = 2_000;

export function loadUserEmail(n: number): string {
  return `charge.${String(n).padStart(3, '0')}@${LOAD_EMAIL_DOMAIN}`;
}

/** Rôle du compte n (1 à 50) : 5 administrateurs, puis 15 chefs de parc, 15 opérateurs, 15 lecteurs répartis sur les sociétés. */
export function loadUserRole(n: number): { role: 'ADMIN' | 'CHEF_PARC' | 'OPERATEUR' | 'LECTEUR'; companyIndex: number | null } {
  if (n <= 5) return { role: 'ADMIN', companyIndex: null };
  if (n <= 20) return { role: 'CHEF_PARC', companyIndex: (n - 6) % 3 };
  if (n <= 35) return { role: 'OPERATEUR', companyIndex: (n - 21) % 3 };
  return { role: 'LECTEUR', companyIndex: (n - 36) % 3 };
}

export interface LoadSeedOptions {
  vehicles: number;
  /** Relevés au total, répartis sur les véhicules dont le compteur est initialisé. */
  readings: number;
  now: Date;
  passwordHash: string;
  progress?: (line: string) => void;
}

export interface LoadSeedReport {
  organizationId: string;
  companyIds: string[];
  counts: Record<string, number>;
  durationMs: number;
}

/** Volumes d'une échelle (1 = cible du CDC ; au moins 6 véhicules, 2 conducteurs et 600 relevés par véhicule en moyenne). */
export function volumesForScale(scale: number): { vehicles: number; readings: number } {
  const vehicles = Math.max(6, Math.round(CDC_LOAD_TARGET.vehicles * scale));
  return { vehicles, readings: vehicles * (CDC_LOAD_TARGET.readings / CDC_LOAD_TARGET.vehicles) };
}

// ---------------------------------------------------------------------------------------------
// Entrée de la commande
// ---------------------------------------------------------------------------------------------

const USAGE = [
  'Usage : seed-load [--scale <0 < s ≤ 1>]',
  '  Charge le jeu de dimensionnement du CDC 17.2 sur une base vierge (migrations appliquées).',
  '  --scale  fraction des volumes (défaut 1 : 3 sociétés, 500 véhicules, 1 000 conducteurs, 300 000 relevés).',
  'Variables : DATABASE_URL (base cible), LOAD_PASSWORD (mot de passe commun des 50 comptes, 12 caractères au moins).',
  '',
].join('\n');

export const LOAD_PRODUCTION_REFUSAL = 'Refus : le jeu de dimensionnement n’est jamais chargé en production (NODE_ENV=production). Aucune donnée n’a été écrite.';

export class LoadSeedRefusedError extends Error {}

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

/** Point d'entrée testable : 0 succès, 1 refus ou échec, 2 usage. La production est refusée avant toute connexion. */
export async function runSeedLoadCli(argv: readonly string[], source: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const args = argv.filter((a) => a !== '--');
  if (args.includes('--help') || args.includes('-h')) {
    io.out(USAGE);
    return 0;
  }
  let scale = 1;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--scale' && args[i + 1] !== undefined) {
      scale = Number(args[i + 1]);
      i += 1;
      continue;
    }
    io.err(`Argument inconnu : ${arg}\n${USAGE}`);
    return 2;
  }
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
    io.err(`Échelle invalide : ${String(scale)} (attendu : 0 < s ≤ 1).\n`);
    return 2;
  }
  if ((source['NODE_ENV'] ?? '').trim().toLowerCase() === 'production') {
    io.err(`${LOAD_PRODUCTION_REFUSAL}\n`);
    return 1;
  }
  const password = source['LOAD_PASSWORD'] ?? '';
  if (password.length < 12) {
    io.err('Refus : LOAD_PASSWORD (12 caractères au moins) est requis pour les comptes du jeu de charge.\n');
    return 1;
  }
  const databaseUrl = source['DATABASE_URL'];
  if (!databaseUrl) {
    io.err('Refus : DATABASE_URL est requis.\n');
    return 1;
  }
  const prisma = createPrismaClient({ databaseUrl, maxConnections: 4 });
  try {
    const passwordHash = await new PasswordService().hash(password);
    const report = await seedLoad(prisma, { ...volumesForScale(scale), now: new Date(), passwordHash, progress: (line) => io.out(`${line}\n`) });
    io.out(formatReport(report));
    return 0;
  } catch (error) {
    if (error instanceof LoadSeedRefusedError) io.err(`${error.message}\n`);
    else io.err(`Jeu de dimensionnement interrompu : ${describeErrorSafely(error)}\n`);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

function formatReport(report: LoadSeedReport): string {
  const lines = Object.entries(report.counts).map(([k, v]) => `  ${k.padEnd(26)} ${String(v).padStart(8)}`);
  return [`Jeu de dimensionnement chargé en ${(report.durationMs / 1000).toFixed(1)} s (organisation ${LOAD_ORGANIZATION_CODE}) :`, ...lines, `Comptes : ${loadUserEmail(1)} à ${loadUserEmail(LOAD_USERS)} (mot de passe : LOAD_PASSWORD).`, ''].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Génération
// ---------------------------------------------------------------------------------------------

/** Générateur pseudo-aléatoire déterministe (mulberry32) : même jeu à chaque exécution, hors horodatage de référence. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** UUID v7 horodaté par l'événement (localité d'index comparable aux identifiants générés par la base). */
function uuid7(ms: number): string {
  const b = randomBytes(16);
  b.writeUIntBE(Math.max(0, Math.floor(ms)), 0, 6);
  b[6] = ((b[6] as number) & 0x0f) | 0x70;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const money = (value: number): string => (Math.round(value * 1000) / 1000).toFixed(3);
const civil = (instant: Date): CivilDate => localDate(instant, LOAD_TIMEZONE);
const dbDate = (date: CivilDate): Date => toDbDate(date) as Date;

const FIRST_NAMES = ['Ahmed', 'Mohamed', 'Amine', 'Youssef', 'Sami', 'Karim', 'Nour', 'Ines', 'Rania', 'Salma', 'Hela', 'Walid', 'Hatem', 'Imen', 'Oussama', 'Bilel', 'Maha', 'Sonia', 'Fares', 'Lotfi'];
const LAST_NAMES = ['Ben Salah', 'Trabelsi', 'Gharbi', 'Jebali', 'Hammami', 'Ayari', 'Mejri', 'Khelifi', 'Chaabane', 'Bouazizi', 'Sassi', 'Dridi', 'Mansouri', 'Zouari', 'Baccouche', 'Ferchichi'];
const MAKES = [
  ['Peugeot', '208'],
  ['Renault', 'Clio'],
  ['Volkswagen', 'Polo'],
  ['Toyota', 'Hilux'],
  ['Isuzu', 'D-Max'],
  ['Citroën', 'Berlingo'],
  ['Kia', 'Picanto'],
  ['Hyundai', 'i20'],
] as const;
const PURPOSES = ['Tournée commerciale', 'Livraison clients', 'Mission chantier', 'Rendez-vous fournisseur', 'Déplacement administratif', 'Transfert de matériel'];
const INCIDENT_TYPES = ['PANNE', 'DOMMAGE', 'ACCIDENT', 'CREVAISON', 'AUTRE'] as const;
const SEVERITIES = ['FAIBLE', 'MOYENNE', 'ELEVEE', 'CRITIQUE'] as const;

type Context = 'INITIALISATION' | 'REMISE' | 'RESTITUTION' | 'RELEVE_LIBRE' | 'CARBURANT';

interface CompanySeed {
  id: string;
  code: string;
  siteIds: string[];
  stationIds: string[];
  garageIds: string[];
  insurerId: string;
  staffIds: string[];
  driverIds: string[];
}

interface VehicleSeed {
  index: number;
  local: number;
  id: string;
  company: CompanySeed;
  categoryCode: 'VP' | 'VU' | 'PL';
  energy: 'DIESEL' | 'ESSENCE';
  lifecycle: 'ACTIF' | 'HORS_SERVICE';
  initialKm: number;
  open: boolean;
  activeImmobilization: boolean;
  /** Compteur jamais initialisé : aucun relevé (fraîcheur INCONNU). */
  noCounter: boolean;
  /** Fin de l'historique avant maintenant (12 h ; 10 ou 20 jours pour un kilométrage ancien). */
  historyEndMs: number;
}

interface Buffers {
  readings: Prisma.OdometerReadingCreateManyInput[];
  usages: Prisma.VehicleUsageCreateManyInput[];
  fuel: Prisma.FuelEntryCreateManyInput[];
  expenses: Prisma.ExpenseCreateManyInput[];
}

interface PendingIncident {
  row: Omit<Prisma.IncidentCreateManyInput, 'reference'>;
  occurredAt: Date;
}

/**
 * Charge le jeu de dimensionnement dans une base vierge (refus si une organisation existe déjà).
 * Toutes les dates sont relatives à `now` : deux ans d'historique, dernier relevé au plus tard 5 h avant.
 */
export async function seedLoad(prisma: ParcAutoPrismaClient, options: LoadSeedOptions): Promise<LoadSeedReport> {
  const started = Date.now();
  const progress = options.progress ?? (() => undefined);
  if ((await prisma.organization.count()) > 0) {
    throw new LoadSeedRefusedError('Refus : la base contient déjà des données (au moins une organisation). Le jeu de dimensionnement se charge sur une base vierge ; rien n’a été écrit.');
  }
  if (options.vehicles < 6 || options.readings < options.vehicles * 24) throw new LoadSeedRefusedError('Refus : au moins 6 véhicules et 24 relevés par véhicule.');
  const rand = prng(17_2);
  const now = options.now.getTime();
  const t0 = now - HISTORY_DAYS * DAY_MS;
  const today = civil(options.now);
  const counts: Record<string, number> = {};
  const add = (key: string, n: number) => {
    counts[key] = (counts[key] ?? 0) + n;
  };
  const insert = async <T>(key: string, rows: T[], run: (chunk: T[]) => Promise<unknown>) => {
    for (let i = 0; i < rows.length; i += BATCH) await run(rows.slice(i, i + BATCH));
    add(key, rows.length);
  };

  // --- Organisation, sociétés, sites, catégories, fournisseurs, paramètres -----------------------
  const organizationId = uuid7(t0);
  await prisma.organization.create({ data: { id: organizationId, code: LOAD_ORGANIZATION_CODE, name: 'Groupe fictif — jeu de dimensionnement', timezone: LOAD_TIMEZONE, currency: 'TND', currencyDecimals: 3, createdAt: new Date(t0) } });
  const companies: CompanySeed[] = COMPANY_CODES.map((code) => ({ id: uuid7(t0), code, siteIds: [uuid7(t0), uuid7(t0)], stationIds: [uuid7(t0), uuid7(t0), uuid7(t0)], garageIds: [uuid7(t0), uuid7(t0)], insurerId: uuid7(t0), staffIds: [], driverIds: [] }));
  await prisma.company.createMany({ data: companies.map((c, i) => ({ id: c.id, organizationId, code: c.code, legalName: `Société fictive ${String.fromCharCode(65 + i)} (charge)`, createdAt: new Date(t0) })) });
  await prisma.site.createMany({ data: companies.flatMap((c) => [{ id: c.siteIds[0] as string, organizationId, companyId: c.id, name: 'Siège', createdAt: new Date(t0) }, { id: c.siteIds[1] as string, organizationId, companyId: c.id, name: 'Dépôt', createdAt: new Date(t0) }]) });
  add('sociétés', companies.length);
  const categories = { VP: uuid7(t0), VU: uuid7(t0), PL: uuid7(t0) } as const;
  await prisma.vehicleCategory.createMany({
    data: [
      { id: categories.VP, organizationId, code: 'VP', label: 'Véhicule particulier', requiredPermitCategories: ['B'] },
      { id: categories.VU, organizationId, code: 'VU', label: 'Véhicule utilitaire', requiredPermitCategories: ['B'] },
      { id: categories.PL, organizationId, code: 'PL', label: 'Poids lourd', requiredPermitCategories: ['C'] },
    ],
  });
  await prisma.supplier.createMany({
    data: companies.flatMap((c) => [
      ...c.stationIds.map((id, i) => ({ id, organizationId, companyId: c.id, name: `Station ${['Agil', 'Shell', 'Total'][i] ?? 'Station'} ${c.code}`, category: 'STATION' as const })),
      ...c.garageIds.map((id, i) => ({ id, organizationId, companyId: c.id, name: `Garage ${['Central', 'du Port'][i] ?? 'Garage'} ${c.code}`, category: 'GARAGE' as const })),
      { id: c.insurerId, organizationId, companyId: c.id, name: `Assurances ${c.code}`, category: 'ASSURANCE' as const },
    ]),
  });
  add('fournisseurs', companies.length * 6);
  // Paramètres surchargés par société : tolérance de retard (B) et seuil d'ancienneté du kilométrage (C).
  await prisma.settingValue.createMany({
    data: [
      { organizationId, companyId: (companies[1] as CompanySeed).id, key: 'usage.lateReturnToleranceMinutes', value: 30, settingVersion: 1, reason: 'Jeu de dimensionnement' },
      { organizationId, companyId: (companies[2] as CompanySeed).id, key: 'odometer.staleAfterDays', value: 14, settingVersion: 1, reason: 'Jeu de dimensionnement' },
    ],
  });

  // --- Comptes (50 sessions) --------------------------------------------------------------------
  const users: Prisma.UserCreateManyInput[] = [];
  const memberships: Prisma.MembershipCreateManyInput[] = [];
  for (let n = 1; n <= LOAD_USERS; n += 1) {
    const id = uuid7(t0);
    const { role, companyIndex } = loadUserRole(n);
    users.push({ id, organizationId, email: loadUserEmail(n), firstName: FIRST_NAMES[n % FIRST_NAMES.length] as string, lastName: `Charge ${String(n).padStart(3, '0')}`, passwordHash: options.passwordHash, passwordChangedAt: new Date(now) });
    const company = companyIndex === null ? null : (companies[companyIndex] as CompanySeed);
    memberships.push({ organizationId, userId: id, companyId: company?.id ?? null, role });
    if (company && (role === 'CHEF_PARC' || role === 'OPERATEUR')) company.staffIds.push(id);
  }
  await prisma.user.createMany({ data: users });
  await prisma.membership.createMany({ data: memberships });
  add('comptes', users.length);

  // --- Véhicules et conducteurs -------------------------------------------------------------------
  const perCompany = COMPANY_SHARES.map((share) => Math.round(options.vehicles * share));
  perCompany[2] = options.vehicles - (perCompany[0] as number) - (perCompany[1] as number);
  const vehicles: VehicleSeed[] = [];
  const vehicleRows: Prisma.VehicleCreateManyInput[] = [];
  const driverRows: Prisma.DriverCreateManyInput[] = [];
  const permitRows: Prisma.DriverPermitCreateManyInput[] = [];
  let index = 0;
  companies.forEach((company, ci) => {
    for (let local = 0; local < (perCompany[ci] as number); local += 1, index += 1) {
      const categoryCode = index % 20 === 19 ? 'PL' : index % 5 === 4 ? 'VU' : 'VP';
      const lifecycle = index % 40 === 39 ? 'HORS_SERVICE' : 'ACTIF';
      // Fraîcheur variée : compteur jamais initialisé (INCONNU), dernier relevé il y a 10 ou 20 jours (seuils 7 j et 14 j).
      const noCounter = index % 50 === 11;
      const historyEndMs = index % 50 === 23 ? 20 * DAY_MS : index % 50 === 24 ? 10 * DAY_MS : 12 * HOUR_MS;
      const open = lifecycle === 'ACTIF' && !noCounter && historyEndMs < DAY_MS && index % 10 < 3;
      const v: VehicleSeed = { index, local, id: uuid7(t0), company, categoryCode, energy: index % 3 === 2 ? 'ESSENCE' : 'DIESEL', lifecycle, initialKm: 15_000 + ((index * 7_919) % 90_000), open, activeImmobilization: lifecycle === 'ACTIF' && !open && !noCounter && index % 25 === 7, noCounter, historyEndMs };
      vehicles.push(v);
      const [make, model] = MAKES[index % MAKES.length] as readonly [string, string];
      const registration = `${100 + (index % 150)} TU ${String(1000 + index).padStart(4, '0')}`;
      vehicleRows.push({
        id: v.id,
        organizationId,
        companyId: company.id,
        code: `${company.code}-V${String(local + 1).padStart(4, '0')}`,
        registration,
        registrationNormalized: normalizeRegistration(registration),
        make,
        model,
        categoryId: categories[categoryCode],
        lifecycleStatus: lifecycle,
        year: 2015 + (index % 10),
        commissioningDate: dbDate(civil(new Date(t0 - (index % 365) * DAY_MS))),
        energy: v.energy,
        tankCapacityLiters: categoryCode === 'PL' ? '300.000' : categoryCode === 'VU' ? '75.000' : '55.000',
        siteId: company.siteIds[local % 2],
        qrToken: randomUUID(),
        createdAt: new Date(t0),
      });
      for (const k of [0, 1]) {
        const id = uuid7(t0);
        company.driverIds.push(id);
        const d = 2 * local + k;
        driverRows.push({
          id,
          organizationId,
          companyId: company.id,
          code: `${company.code}-D${String(d + 1).padStart(4, '0')}`,
          firstName: FIRST_NAMES[(index * 2 + k) % FIRST_NAMES.length] as string,
          lastName: `${LAST_NAMES[(index + k * 7) % LAST_NAMES.length] as string} ${String(d + 1).padStart(4, '0')}`,
          siteId: company.siteIds[local % 2],
          createdAt: new Date(t0),
        });
        permitRows.push({ organizationId, driverId: id, number: `P-${company.code}-${String(d + 1).padStart(5, '0')}`, categories: categoryCode === 'PL' ? ['B', 'C'] : ['B'], issuedOn: dbDate(addDays(today, -3_000 - d)), expiresOn: dbDate(addDays(today, 1_500 + (d % 700))) });
      }
    }
  });
  await insert('véhicules', vehicleRows, (chunk) => prisma.vehicle.createMany({ data: chunk }));
  await insert('conducteurs', driverRows, (chunk) => prisma.driver.createMany({ data: chunk }));
  await insert('permis', permitRows, (chunk) => prisma.driverPermit.createMany({ data: chunk }));
  await insert(
    'historique des sociétés',
    vehicles.map((v) => ({ organizationId, vehicleId: v.id, fromCompanyId: null, toCompanyId: v.company.id, effectiveAt: new Date(t0), reason: 'Création du dossier (jeu de dimensionnement)', createdById: v.company.staffIds[0] ?? null, createdAt: new Date(t0) })),
    (chunk) => prisma.vehicleCompanyHistory.createMany({ data: chunk }),
  );
  progress(`Référentiel : ${vehicles.length} véhicules, ${driverRows.length} conducteurs, ${users.length} comptes.`);

  // --- Responsables habituels ---------------------------------------------------------------------
  const assignments: Prisma.VehicleResponsibleAssignmentCreateManyInput[] = [];
  for (const v of vehicles) {
    const main = v.company.driverIds[2 * v.local] as string;
    const second = v.company.driverIds[2 * v.local + 1] as string;
    if (v.index % 10 === 9) {
      const switchAt = new Date(t0 + 200 * DAY_MS);
      assignments.push({ organizationId, companyId: v.company.id, vehicleId: v.id, driverId: second, startsAt: new Date(t0), endsAt: switchAt, endReason: 'Changement d’affectation', createdAt: new Date(t0) });
      assignments.push({ organizationId, companyId: v.company.id, vehicleId: v.id, driverId: main, startsAt: switchAt, createdAt: switchAt });
    } else {
      assignments.push({ organizationId, companyId: v.company.id, vehicleId: v.id, driverId: main, startsAt: new Date(t0), createdAt: new Date(t0) });
    }
  }
  await insert('affectations habituelles', assignments, (chunk) => prisma.vehicleResponsibleAssignment.createMany({ data: chunk }));

  // --- Segments de compteur -----------------------------------------------------------------------
  const segmentIds = new Map<string, string>();
  const segments: Prisma.OdometerSegmentCreateManyInput[] = vehicles.filter((v) => !v.noCounter).map((v) => {
    const id = uuid7(t0);
    segmentIds.set(v.id, id);
    return { id, organizationId, vehicleId: v.id, sequence: 1, startedAt: new Date(t0), startPhysicalKm: `${v.initialKm}.000`, startCumulativeKm: `${v.initialKm}.000`, cumulativeKnown: true, replacementReason: 'Initialisation ordinaire (cumul égal au compteur).', createdById: v.company.staffIds[0] ?? null, createdAt: new Date(t0) };
  });
  await insert('segments de compteur', segments, (chunk) => prisma.odometerSegment.createMany({ data: chunk }));

  // --- Historique par véhicule : relevés, utilisations, pleins, dépenses, incidents -----------------
  const buffers: Buffers = { readings: [], usages: [], fuel: [], expenses: [] };
  const flush = async () => {
    await insert('relevés kilométriques', buffers.readings.splice(0), (chunk) => prisma.odometerReading.createMany({ data: chunk }));
    await insert('utilisations', buffers.usages.splice(0), (chunk) => prisma.vehicleUsage.createMany({ data: chunk }));
    await insert('pleins', buffers.fuel.splice(0), (chunk) => prisma.fuelEntry.createMany({ data: chunk }));
    await insert('dépenses', buffers.expenses.splice(0), (chunk) => prisma.expense.createMany({ data: chunk }));
  };
  const counted = vehicles.filter((v) => !v.noCounter);
  const perVehicle = Math.floor(options.readings / counted.length);
  const remainder = options.readings - perVehicle * counted.length;
  const readingsOf = new Map(counted.map((v, k) => [v.id, perVehicle + (k < remainder ? 1 : 0)]));
  const incidents: PendingIncident[] = [];
  const immobilizations: Prisma.ImmobilizationCreateManyInput[] = [];
  const causes: Prisma.ImmobilizationCauseCreateManyInput[] = [];
  const plans: Prisma.VehicleMaintenancePlanCreateManyInput[] = [];
  for (const v of vehicles) {
    if (v.noCounter) {
      // Véhicule mis en service sans initialisation du compteur : plans d'entretien incomplets, aucun historique.
      buffers.expenses.push(...directExpenses(v, { organizationId, t0, now, rand }));
      plans.push({ organizationId, companyId: v.company.id, vehicleId: v.id, maintenanceTypeId: '', intervalKm: '10000.000', intervalMonths: 12, noticeKm: '1000.000', noticeDays: 30, baseMode: 'AUCUNE', createdById: v.company.staffIds[0] ?? null, createdAt: new Date(t0) });
      plans.push({ organizationId, companyId: v.company.id, vehicleId: v.id, maintenanceTypeId: '', intervalKm: '40000.000', noticeKm: '2000.000', baseMode: 'AUCUNE', createdById: v.company.staffIds[0] ?? null, createdAt: new Date(t0) });
      continue;
    }
    const history = vehicleHistory(v, { organizationId, segmentId: segmentIds.get(v.id) as string, t0, now, rand, readingsPerVehicle: readingsOf.get(v.id) as number });
    buffers.readings.push(...history.readings);
    buffers.usages.push(...history.usages);
    buffers.fuel.push(...history.fuel);
    buffers.expenses.push(...history.fuelExpenses, ...directExpenses(v, { organizationId, t0, now, rand }));
    // Incidents : quatre par véhicule, après une restitution (véhicule libre) ; immobilisation sur un véhicule sur deux.
    const gaps = history.freeGaps;
    for (let n = 0; n < 4 && gaps.length > 0; n += 1) {
      const gap = gaps[Math.floor(((n + 0.5) * gaps.length) / 4)] as { start: number; end: number };
      const occurredAt = new Date(gap.start + 2 * HOUR_MS);
      const old = occurredAt.getTime() < now - 30 * DAY_MS;
      const status = old ? (n % 10 === 3 ? 'RESOLU' : 'CLOTURE') : n % 2 === 0 ? 'OUVERT' : 'EN_TRAITEMENT';
      const incidentId = uuid7(occurredAt.getTime());
      const type = INCIDENT_TYPES[(v.index + n) % INCIDENT_TYPES.length] as (typeof INCIDENT_TYPES)[number];
      incidents.push({
        occurredAt,
        row: {
          id: incidentId,
          organizationId,
          companyId: v.company.id,
          vehicleId: v.id,
          driverId: v.company.driverIds[2 * v.local],
          type,
          severity: SEVERITIES[(v.index * 3 + n) % SEVERITIES.length] as (typeof SEVERITIES)[number],
          status,
          occurredAt,
          siteId: v.company.siteIds[v.local % 2],
          description: `Incident ${type.toLowerCase()} constaté après restitution (jeu de dimensionnement).`,
          reportedById: v.company.staffIds[n % v.company.staffIds.length] ?? null,
          resolvedAt: status === 'RESOLU' || status === 'CLOTURE' ? new Date(occurredAt.getTime() + 2 * DAY_MS) : null,
          closedAt: status === 'CLOTURE' ? new Date(occurredAt.getTime() + 3 * DAY_MS) : null,
          createdAt: occurredAt,
        },
      });
      if (v.index % 2 === 0 && (n === 0 || n === 2)) {
        const start = occurredAt.getTime();
        const end = Math.min(start + (6 + ((v.index + n) % 15)) * HOUR_MS, gap.end - HOUR_MS);
        if (end > start + HOUR_MS) {
          const immobilizationId = uuid7(start);
          immobilizations.push({ id: immobilizationId, organizationId, companyId: v.company.id, vehicleId: v.id, status: 'TERMINEE', startedAt: new Date(start), endedAt: new Date(end), siteId: v.company.siteIds[v.local % 2], garageSupplierId: v.company.garageIds[n % 2], createdAt: new Date(start) });
          causes.push({ organizationId, immobilizationId, kind: 'INCIDENT', reason: `Réparation suite à ${type.toLowerCase()}`, incidentId, startedAt: new Date(start), endedAt: new Date(end), createdAt: new Date(start) });
          if ((v.index + n) % 4 === 0) {
            // Cause qui chevauche la première ; une sur trois reste ouverte et s'arrête avec l'immobilisation.
            const causeEnd = (v.index + n) % 12 === 0 ? null : new Date(end);
            causes.push({ organizationId, immobilizationId, kind: 'AUTRE', reason: 'Attente de pièces', startedAt: new Date(start + HOUR_MS), endedAt: causeEnd, createdAt: new Date(start + HOUR_MS) });
          }
        }
      }
    }
    if (v.activeImmobilization) {
      const start = history.lastInstant + 30 * 60_000;
      const immobilizationId = uuid7(start);
      immobilizations.push({ id: immobilizationId, organizationId, companyId: v.company.id, vehicleId: v.id, status: 'ACTIVE', startedAt: new Date(start), expectedEndAt: new Date(now + 3 * DAY_MS), siteId: v.company.siteIds[v.local % 2], garageSupplierId: v.company.garageIds[0], createdAt: new Date(start) });
      causes.push({ organizationId, immobilizationId, kind: 'AUTRE', reason: 'Carrosserie en attente d’expertise', startedAt: new Date(start), endedAt: null, createdAt: new Date(start) });
    }
    // Plans d'entretien : vidange (10 000 km / 12 mois) et pneumatiques (40 000 km), bases techniques variées.
    const lastKm = history.lastPhysicalKm;
    plans.push({ organizationId, companyId: v.company.id, vehicleId: v.id, maintenanceTypeId: '', intervalKm: '10000.000', intervalMonths: 12, noticeKm: '1000.000', noticeDays: 30, baseMode: 'BASE_TECHNIQUE', initialBaseKm: `${Math.max(v.initialKm, lastKm - ((v.index * 97) % 12_000))}.000`, initialBaseDate: dbDate(addDays(today, -((v.index * 13) % 400))), createdById: v.company.staffIds[0] ?? null, createdAt: new Date(t0) });
    plans.push({ organizationId, companyId: v.company.id, vehicleId: v.id, maintenanceTypeId: '', intervalKm: '40000.000', noticeKm: '2000.000', baseMode: 'BASE_TECHNIQUE', initialBaseKm: `${Math.max(v.initialKm, lastKm - ((v.index * 331) % 45_000))}.000`, initialBaseDate: dbDate(addDays(today, -((v.index * 17) % 700))), createdById: v.company.staffIds[0] ?? null, createdAt: new Date(t0) });
    if (buffers.readings.length >= 20_000) {
      await flush();
      progress(`Historique : ${counts['relevés kilométriques'] ?? 0} relevés insérés.`);
    }
  }
  await flush();
  progress(`Historique : ${counts['relevés kilométriques'] ?? 0} relevés, ${counts['utilisations'] ?? 0} utilisations, ${counts['pleins'] ?? 0} pleins.`);

  // Dépenses de flotte sans véhicule (ligne « Non ventilé ») et achats exclus du coût d'exploitation.
  const fleetExpenses: Prisma.ExpenseCreateManyInput[] = [];
  for (const c of companies) {
    for (let m = 0; m < 24; m += 1) {
      const at = new Date(t0 + (m + 0.5) * 30 * DAY_MS);
      fleetExpenses.push({ id: uuid7(at.getTime()), organizationId, companyId: c.id, occurredOn: dbDate(civil(at)), category: 'AUTRE', amount: money(300 + rand() * 900), reference: `FG-${c.code}-${m + 1}`, notes: 'Frais de gestion de flotte', createdAt: at });
    }
    for (let y = 0; y < 2; y += 1) {
      const at = new Date(t0 + (y * 365 + 10) * DAY_MS);
      fleetExpenses.push({ id: uuid7(at.getTime()), organizationId, companyId: c.id, occurredOn: dbDate(civil(at)), category: 'ASSURANCE', supplierId: c.insurerId, amount: money(12_000 + rand() * 6_000), reference: `ASF-${c.code}-${y + 1}`, createdAt: at });
      fleetExpenses.push({ id: uuid7(at.getTime() + HOUR_MS), organizationId, companyId: c.id, occurredOn: dbDate(civil(new Date(at.getTime() + HOUR_MS))), category: 'TAXES', amount: money(2_000 + rand() * 1_500), reference: `TX-${c.code}-${y + 1}`, createdAt: new Date(at.getTime() + HOUR_MS) });
    }
  }
  await insert('dépenses', fleetExpenses, (chunk) => prisma.expense.createMany({ data: chunk }));

  // --- Incidents (références chronologiques par année locale), immobilisations et causes -------------
  incidents.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const sequences = new Map<number, number>();
  const incidentRows: Prisma.IncidentCreateManyInput[] = incidents.map(({ row, occurredAt }) => {
    const year = Number(civil(occurredAt).slice(0, 4));
    const value = (sequences.get(year) ?? 0) + 1;
    sequences.set(year, value);
    return { ...row, reference: `INC-${year}-${String(value).padStart(6, '0')}` };
  });
  await insert('incidents', incidentRows, (chunk) => prisma.incident.createMany({ data: chunk }));
  await prisma.referenceSequence.createMany({ data: [...sequences].map(([year, lastValue]) => ({ organizationId, scope: 'INC', year, lastValue })) });
  await insert('immobilisations', immobilizations, (chunk) => prisma.immobilization.createMany({ data: chunk }));
  await insert('causes d’immobilisation', causes, (chunk) => prisma.immobilizationCause.createMany({ data: chunk }));

  // --- Entretien ------------------------------------------------------------------------------------
  const vidange = uuid7(t0);
  const pneus = uuid7(t0);
  await prisma.maintenanceType.createMany({
    data: [
      { id: vidange, organizationId, code: 'VIDANGE', label: 'Vidange moteur' },
      { id: pneus, organizationId, code: 'PNEUS', label: 'Pneumatiques' },
    ],
  });
  await insert('plans d’entretien', plans.map((p, i) => ({ ...p, maintenanceTypeId: i % 2 === 0 ? vidange : pneus })), (chunk) => prisma.vehicleMaintenancePlan.createMany({ data: chunk }));

  // --- Documents --------------------------------------------------------------------------------------
  const docTypes = { assurance: uuid7(t0), visite: uuid7(t0), carteGrise: uuid7(t0), medicale: uuid7(t0) } as const;
  await prisma.documentType.createMany({
    data: [
      { id: docTypes.assurance, organizationId, code: 'ASSURANCE', label: 'Attestation d’assurance', ownerType: 'VEHICULE', hasExpiry: true, required: true, blocksCheckout: true, noticeDays: [30, 15, 7] },
      { id: docTypes.visite, organizationId, code: 'VISITE_TECHNIQUE', label: 'Visite technique', ownerType: 'VEHICULE', hasExpiry: true, required: true, blocksCheckout: false, noticeDays: [30, 15] },
      { id: docTypes.carteGrise, organizationId, code: 'CARTE_GRISE', label: 'Carte grise', ownerType: 'VEHICULE', hasExpiry: false, required: true, blocksCheckout: false, noticeDays: [] },
      { id: docTypes.medicale, organizationId, code: 'VISITE_MEDICALE', label: 'Visite médicale', ownerType: 'CONDUCTEUR', hasExpiry: true, required: false, blocksCheckout: false, noticeDays: [30] },
    ],
  });
  const versions: Prisma.DocumentVersionCreateManyInput[] = [];
  const version = (owner: { companyId: string; vehicleId?: string; driverId?: string }, typeId: string, from: CivilDate | null, to: CivilDate | null, number: string): Prisma.DocumentVersionCreateManyInput => ({
    organizationId,
    companyId: owner.companyId,
    documentTypeId: typeId,
    ownerType: owner.vehicleId ? 'VEHICULE' : 'CONDUCTEUR',
    vehicleId: owner.vehicleId ?? null,
    driverId: owner.driverId ?? null,
    number,
    validFrom: from ? dbDate(from) : null,
    validTo: to ? dbDate(to) : null,
    issuedOn: from ? dbDate(from) : null,
  });
  for (const v of vehicles) {
    const owner = { companyId: v.company.id, vehicleId: v.id };
    const r = v.index % 20;
    if (r !== 2) {
      // Assurance : version précédente puis version courante (expirée, à renouveler, renouvelée ou valide).
      const currentTo = r === 0 ? -12 : r === 1 || r === 4 ? 10 : 165;
      versions.push(version(owner, docTypes.assurance, addDays(today, currentTo - 730), addDays(today, currentTo - 366), `ASS-${v.index}-1`));
      versions.push(version(owner, docTypes.assurance, addDays(today, currentTo - 365), addDays(today, currentTo), `ASS-${v.index}-2`));
      if (r === 4) versions.push(version(owner, docTypes.assurance, addDays(today, currentTo + 1), addDays(today, currentTo + 366), `ASS-${v.index}-3`));
    }
    const visiteTo = ((v.index * 37) % 400) - 30;
    versions.push(version(owner, docTypes.visite, addDays(today, visiteTo - 365), addDays(today, visiteTo), `VT-${v.index}`));
    if (v.index % 33 !== 5) versions.push(version(owner, docTypes.carteGrise, civil(new Date(t0)), null, `CG-${v.index}`));
  }
  for (const c of companies) {
    c.driverIds.forEach((driverId, d) => {
      if (d % 10 < 7) {
        const to = ((d * 53) % 500) - 40;
        versions.push(version({ companyId: c.id, driverId }, docTypes.medicale, addDays(today, to - 730), addDays(today, to), `VM-${c.code}-${d}`));
      }
    });
  }
  await insert('versions de documents', versions, (chunk) => prisma.documentVersion.createMany({ data: chunk }));

  return { organizationId, companyIds: companies.map((c) => c.id), counts, durationMs: Date.now() - started };
}

interface HistoryInput {
  organizationId: string;
  segmentId: string;
  t0: number;
  now: number;
  rand: () => number;
  readingsPerVehicle: number;
}

interface VehicleHistory {
  readings: Prisma.OdometerReadingCreateManyInput[];
  usages: Prisma.VehicleUsageCreateManyInput[];
  fuel: Prisma.FuelEntryCreateManyInput[];
  fuelExpenses: Prisma.ExpenseCreateManyInput[];
  /** Intervalles sans utilisation (après une restitution) : incidents et immobilisations y sont placés. */
  freeGaps: Array<{ start: number; end: number }>;
  lastInstant: number;
  lastPhysicalKm: number;
}

/** Correction d'un relevé libre (relevé REMPLACE + correction ACCEPTE au même instant) : positions k ≡ 77 (mod 150). */
const isCorrectionSlot = (k: number) => k % 150 === 77;

/**
 * Chronologie d'un véhicule : `readingsPerVehicle` lignes de relevé exactement. Motif de six instants :
 * remise, restitution, relevé libre, plein (trois cycles sur quatre), deux relevés libres ; le dernier instant
 * est une remise pour un véhicule dont l'utilisation est en cours.
 */
function vehicleHistory(v: VehicleSeed, input: HistoryInput): VehicleHistory {
  const { organizationId, segmentId, t0, now, rand } = input;
  // Nombre d'instants N tel que N + corrections(N) = relevés par véhicule.
  let n = input.readingsPerVehicle;
  const corrections = (count: number) => Array.from({ length: count }, (_, k) => k).filter((k) => k > 0 && isCorrectionSlot(k)).length;
  while (n + corrections(n) > input.readingsPerVehicle) n -= 1;
  const extraRow = n + corrections(n) < input.readingsPerVehicle;
  const contexts: Context[] = Array.from({ length: n }, (_, k) => {
    if (k === 0) return 'INITIALISATION';
    const p = k % 6;
    return p === 0 ? 'REMISE' : p === 1 ? 'RESTITUTION' : p === 3 && Math.floor(k / 6) % 4 !== 3 ? 'CARBURANT' : 'RELEVE_LIBRE';
  });
  if (v.open) contexts[n - 1] = 'REMISE';
  for (let k = 1; k < n; k += 1) {
    if (contexts[k] === 'REMISE' && contexts[k + 1] !== 'RESTITUTION' && !(v.open && k === n - 1)) contexts[k] = 'RELEVE_LIBRE';
    if (contexts[k] === 'RESTITUTION' && contexts[k - 1] !== 'REMISE') contexts[k] = 'RELEVE_LIBRE';
  }
  const end = now - v.historyEndMs;
  const step = (end - t0) / (n - 1);
  const times = contexts.map((_, k) => {
    if (k === 0) return t0;
    const jitter = k === n - 1 ? -rand() * (step / 4) : (rand() - 0.5) * (step / 2);
    return Math.round((t0 + k * step + jitter) / 1000) * 1000;
  });
  const staff = v.company.staffIds;
  const drivers = [v.company.driverIds[2 * v.local] as string, v.company.driverIds[2 * v.local + 1] as string];
  const readings: Prisma.OdometerReadingCreateManyInput[] = [];
  const readingIds: string[] = [];
  const km: number[] = [];
  let lastAccepted = v.initialKm;
  const pendingFrom = v.index % 20 === 5 ? n - 3 : n;
  let extraUsed = !extraRow;
  for (let k = 0; k < n; k += 1) {
    const at = times[k] as number;
    const context = contexts[k] as Context;
    const author = staff[k % staff.length] ?? null;
    const base = { organizationId, companyId: v.company.id, vehicleId: v.id, segmentId, measurementKind: 'COMPTEUR_AFFICHE' as const, observedAt: new Date(at), enteredAt: new Date(at + 5 * 60_000), createdAt: new Date(at + 5 * 60_000), createdById: author };
    if (k === 0) {
      const id = uuid7(at);
      readings.push({ ...base, id, source: 'MANUAL', context: 'INITIALISATION', status: 'ACCEPTE', physicalKm: `${v.initialKm}.000`, cumulativeKm: `${v.initialKm}.000` });
      readingIds.push(id);
      km.push(v.initialKm);
      continue;
    }
    const value = lastAccepted + 20 + Math.floor(rand() * 140);
    if (context === 'RELEVE_LIBRE' && k % 50 === 22 && k < pendingFrom) {
      // Relevé rejeté (diminution) : conservé avec son motif, sans effet sur la chaîne acceptée.
      const rejected = Math.max(0, lastAccepted - 800);
      readings.push({ ...base, id: uuid7(at), source: 'MANUAL', context, status: 'REJETE', physicalKm: `${rejected}.000`, cumulativeKm: `${rejected}.000`, statusReason: 'Kilométrage inférieur au relevé précédent.', decidedAt: new Date(at + HOUR_MS), decidedById: author, decisionReason: 'Diminution sans remplacement de compteur.' });
      readingIds.push('');
      km.push(lastAccepted);
      continue;
    }
    if (context === 'RELEVE_LIBRE' && k >= pendingFrom) {
      readings.push({ ...base, id: uuid7(at), source: 'MANUAL', context, status: 'EN_ATTENTE', physicalKm: `${value}.000`, cumulativeKm: `${value}.000`, statusReason: 'Soumission à valider par le chef de parc.' });
      readingIds.push('');
      km.push(lastAccepted);
      continue;
    }
    const id = uuid7(at);
    const source = context === 'RELEVE_LIBRE' && k % 7 === 3 ? 'IMPORT' : 'MANUAL';
    if (context === 'RELEVE_LIBRE' && (isCorrectionSlot(k) || (!extraUsed && k === n - 2))) {
      extraUsed = true;
      // Relevé corrigé : l'original reste visible (REMPLACE), la correction motivée le remplace au même instant.
      const original = uuid7(at);
      readings.push({ ...base, id: original, source, context, status: 'REMPLACE', physicalKm: `${value + 1000}.000`, cumulativeKm: `${value + 1000}.000`, statusReason: 'Remplacé par une correction.' });
      readings.push({ ...base, id, source: 'MANUAL', context, status: 'ACCEPTE', physicalKm: `${value}.000`, cumulativeKm: `${value}.000`, replacesReadingId: original, correctionReason: 'Erreur de saisie (chiffre en trop).', enteredAt: new Date(at + HOUR_MS), createdAt: new Date(at + HOUR_MS) });
    } else {
      readings.push({ ...base, id, source, context: context === 'RELEVE_LIBRE' ? 'RELEVE_LIBRE' : context, status: 'ACCEPTE', physicalKm: `${value}.000`, cumulativeKm: `${value}.000` });
    }
    readingIds.push(id);
    km.push(value);
    lastAccepted = value;
  }

  const usages: Prisma.VehicleUsageCreateManyInput[] = [];
  const fuel: Prisma.FuelEntryCreateManyInput[] = [];
  const fuelExpenses: Prisma.ExpenseCreateManyInput[] = [];
  const freeGaps: Array<{ start: number; end: number }> = [];
  let u = 0;
  let f = 0;
  const price = v.energy === 'DIESEL' ? 2.205 : 2.525;
  const [minL, maxL] = v.categoryCode === 'PL' ? [120, 280] : v.categoryCode === 'VU' ? [35, 70] : [25, 50];
  for (let k = 1; k < n; k += 1) {
    const at = times[k] as number;
    const context = contexts[k] as Context;
    if (context === 'REMISE') {
      const openUsage = k === n - 1;
      const driverId = drivers[u % 2] as string;
      const by = staff[u % staff.length] ?? null;
      const returnAt = openUsage ? null : (times[k + 1] as number);
      const expectedReturnAt = openUsage ? (v.index % 3 === 0 ? at + HOUR_MS : now + DAY_MS) : u % 9 === 4 ? (returnAt as number) - 2 * HOUR_MS : (returnAt as number) + 3 * HOUR_MS;
      usages.push({
        id: uuid7(at),
        organizationId,
        companyId: v.company.id,
        vehicleId: v.id,
        driverId,
        status: openUsage ? 'EN_COURS' : 'TERMINEE',
        purpose: PURPOSES[(v.index + u) % PURPOSES.length] as string,
        checkedOutAt: new Date(at),
        expectedReturnAt: new Date(expectedReturnAt),
        returnedAt: returnAt === null ? null : new Date(returnAt),
        checkoutReadingId: readingIds[k],
        returnReadingId: openUsage ? null : (readingIds[k + 1]),
        checkoutFuelGauge: 'TROIS_QUARTS',
        returnFuelGauge: openUsage ? null : 'DEMI',
        distanceStatus: openUsage ? 'NON_VALIDEE' : 'VALIDEE',
        distanceKm: openUsage ? null : `${(km[k + 1] as number) - (km[k] as number)}.000`,
        checkedOutById: by,
        returnedById: openUsage ? null : by,
        createdById: by,
        createdAt: new Date(at),
      });
      u += 1;
    }
    if (context === 'RESTITUTION' && k + 1 < n) freeGaps.push({ start: at, end: times[k + 1] as number });
    if (context === 'CARBURANT') {
      const id = uuid7(at);
      const liters = minL + rand() * (maxL - minL);
      const total = money(Math.round(liters * 1000) / 1000 * price);
      const status = f % 97 === 13 ? 'REJETE' : f % 89 === 7 ? 'ANNULE' : 'VALIDE';
      const station = v.company.stationIds[f % v.company.stationIds.length] as string;
      const by = staff[f % staff.length] ?? null;
      fuel.push({
        id,
        organizationId,
        companyId: v.company.id,
        vehicleId: v.id,
        driverId: drivers[0],
        supplierId: station,
        filledAt: new Date(at),
        liters: liters.toFixed(3),
        unitPrice: price.toFixed(3),
        totalAmount: total,
        energy: v.energy,
        isFullTank: f % 7 !== 3,
        declaredPhysicalKm: `${km[k] as number}.000`,
        readingId: readingIds[k],
        status,
        submittedById: by,
        decidedAt: new Date(at + 10 * 60_000),
        decidedById: by,
        decisionReason: status === 'VALIDE' ? null : status === 'REJETE' ? 'Ticket illisible.' : 'Saisie en double.',
        createdAt: new Date(at),
      });
      if (status !== 'REJETE') {
        fuelExpenses.push({
          id: uuid7(at + 10 * 60_000),
          organizationId,
          companyId: v.company.id,
          vehicleId: v.id,
          occurredOn: dbDate(civil(new Date(at))),
          category: 'CARBURANT',
          supplierId: station,
          amount: total,
          sourceType: 'PLEIN',
          sourceId: id,
          status: status === 'VALIDE' ? 'VALIDEE' : 'ANNULEE',
          cancelledAt: status === 'ANNULE' ? new Date(at + DAY_MS) : null,
          cancelledById: status === 'ANNULE' ? by : null,
          cancelReason: status === 'ANNULE' ? 'Annulation du plein : saisie en double.' : null,
          createdById: by,
          createdAt: new Date(at + 10 * 60_000),
        });
      }
      f += 1;
    }
  }
  return { readings, usages, fuel, fuelExpenses, freeGaps, lastInstant: times[n - 1] as number, lastPhysicalKm: lastAccepted };
}

/** Dépenses saisies d'un véhicule sur deux ans : entretien (avec avoirs), péages, stationnement, assurance, achat exclu. */
function directExpenses(v: VehicleSeed, input: { organizationId: string; t0: number; now: number; rand: () => number }): Prisma.ExpenseCreateManyInput[] {
  const { organizationId, t0, rand } = input;
  const out: Prisma.ExpenseCreateManyInput[] = [];
  const span = HISTORY_DAYS * DAY_MS;
  const author = v.company.staffIds[0] ?? null;
  const push = (at: number, row: Omit<Prisma.ExpenseCreateManyInput, 'organizationId' | 'companyId' | 'vehicleId' | 'occurredOn' | 'createdAt'>) => {
    const instant = new Date(Math.round(at / 1000) * 1000);
    out.push({ organizationId, companyId: v.company.id, vehicleId: v.id, occurredOn: dbDate(civil(instant)), createdAt: instant, createdById: author, ...row });
  };
  const series = (count: number, offset: number, make: (m: number, at: number) => void) => {
    for (let m = 0; m < count; m += 1) make(m, t0 + ((m + offset) * span) / count);
  };
  let serial = 0;
  const cancelled = () => {
    serial += 1;
    return (v.index + serial) % 50 === 0;
  };
  series(12, 0.3, (m, at) => {
    const amount = 120 + rand() * 1_680;
    const isCancelled = cancelled();
    push(at, { id: uuid7(at), category: 'ENTRETIEN_REPARATION', supplierId: v.company.garageIds[m % 2], amount: money(amount), reference: `FAC-${v.index}-${m + 1}`, status: isCancelled ? 'ANNULEE' : 'VALIDEE', cancelledAt: isCancelled ? new Date(at + DAY_MS) : null, cancelReason: isCancelled ? 'Facture saisie en double.' : null });
    if (m % 10 === (v.index % 10)) push(at + 5 * DAY_MS, { id: uuid7(at + 5 * DAY_MS), category: 'ENTRETIEN_REPARATION', kind: 'AVOIR', supplierId: v.company.garageIds[m % 2], amount: money(amount * 0.1), reference: `AV-${v.index}-${m + 1}` });
  });
  series(16, 0.6, (m, at) => push(at, { id: uuid7(at), category: 'PEAGE', amount: money(2.5 + rand() * 15.5), reference: `PG-${v.index}-${m + 1}` }));
  series(12, 0.1, (m, at) => push(at, { id: uuid7(at), category: 'STATIONNEMENT', amount: money(1 + rand() * 9), reference: `ST-${v.index}-${m + 1}`, status: cancelled() ? 'ANNULEE' : 'VALIDEE' }));
  series(2, 0.05, (m, at) => push(at, { id: uuid7(at), category: 'ASSURANCE', supplierId: v.company.insurerId, amount: money(900 + rand() * 1_500), reference: `POL-${v.index}-${m + 1}` }));
  if (v.index % 20 === 3) push(t0 + DAY_MS, { id: uuid7(t0 + DAY_MS), category: 'ACHAT_VEHICULE', amount: money(45_000 + rand() * 45_000), reference: `ACH-${v.index}`, excludedFromOperatingCost: true });
  return out;
}

// Exécution directe (node dist/cli/seed-load.js) ; l'import par les tests ne lance rien.
const invoked = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invoked) {
  const code = await runSeedLoadCli(process.argv.slice(2), process.env, { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) });
  process.exit(code);
}
