/**
 * Jeu de démonstration fictif (CDC 19.2, D-324) — jamais en production.
 *
 * Usage (variables d'environnement de l'API exportées : DATABASE_URL, STORAGE_DIR…) :
 *   pnpm --filter @parc-auto/api seed:demo            base vierge (migrations appliquées) uniquement
 *   pnpm --filter @parc-auto/api seed:demo -- --reset vide d'abord une base de démonstration (hors production uniquement)
 *
 * Garde-fous :
 *  - NODE_ENV=production : refus immédiat (code de sortie 1), aucune connexion à la base ;
 *  - base non vide (au moins une organisation) : refus, sauf --reset explicite (hors production) sur une base
 *    qui ne contient que l'organisation de démonstration (jamais une base portant d'autres organisations) ;
 *  - mot de passe commun des comptes : DEMO_PASSWORD, ou généré aléatoirement et affiché une seule fois à
 *    la fin ; jamais écrit en dur, jamais journalisé ni audité (seule son empreinte Argon2id est stockée).
 *
 * Les données passent par les services métier de l'API (contexte applicatif Nest, comme le worker) sous le
 * contexte d'autorisation réel de l'administrateur, des chefs de parc ou des conducteurs : références,
 * audit, alertes, relevés, contrôles de chronologie et contraintes s'appliquent comme depuis l'interface.
 * Seuls l'organisation et son premier administrateur sont écrits directement (aucun service ne crée
 * d'organisation, et tout service exige un acteur déjà habilité) — exactement comme la commande
 * create-admin — avec une trace d'audit système. Les dates sont relatives à l'instant d'exécution.
 */
import 'reflect-metadata';
import { type DynamicModule, Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomInt, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DateTime } from 'luxon';
import { ROLE_LABELS, type RoleKey } from '@parc-auto/contracts';
import { FEATURE_MODULES } from '../app.module.js';
import { Clock } from '../common/clock.js';
import { toCsv } from '../common/csv-writer.js';
import { AppError } from '../common/errors.js';
import { RedactingConsoleLogger } from '../common/redacting-logger.js';
import type { RequestContext } from '../common/request-context.js';
import { describeErrorSafely } from '../common/secret-redaction.js';
import { AuditService } from '../infra/audit.service.js';
import { loadEnv, type AppEnv } from '../infra/env.js';
import { InfraModule } from '../infra/infra.module.js';
import { PasswordService } from '../infra/password.service.js';
import { PrismaService } from '../infra/prisma.service.js';
import { AccessControlModule } from '../modules/access-control/access-control.module.js';
import { AssignmentsService } from '../modules/assignments/assignments.service.js';
import { AttachmentsService } from '../modules/attachments/attachments.service.js';
import { AuthModule } from '../modules/auth/auth.module.js';
import { ContextBuilderService } from '../modules/auth/context-builder.service.js';
import { DocumentsService } from '../modules/documents/documents.service.js';
import { DriversService } from '../modules/drivers/drivers.service.js';
import { ExpensesService } from '../modules/expenses/expenses.service.js';
import { FuelService } from '../modules/fuel/fuel.service.js';
import { ImmobilizationsService } from '../modules/immobilizations/immobilizations.service.js';
import { IMPORT_COLUMNS } from '../modules/imports/import-columns.js';
import { ImportsService } from '../modules/imports/imports.service.js';
import { IncidentsService } from '../modules/incidents/incidents.service.js';
import { InterventionsService } from '../modules/interventions/interventions.service.js';
import { MaintenanceCatalogService } from '../modules/maintenance/maintenance-catalog.service.js';
import { MaintenancePlansService } from '../modules/maintenance/maintenance-plans.service.js';
import type { CreatePlanDto } from '../modules/maintenance/dto/maintenance.dto.js';
import { OdometerFreshnessService } from '../modules/odometer/odometer-freshness.service.js';
import { OdometerService } from '../modules/odometer/odometer.service.js';
import type { ReadingViewDto } from '../modules/odometer/dto/odometer.dto.js';
import { OrganizationsService } from '../modules/organizations/organizations.service.js';
import { ReservationsService } from '../modules/reservations/reservations.service.js';
import { SettingsService } from '../modules/settings/settings.service.js';
import { SuppliersService } from '../modules/suppliers/suppliers.service.js';
import type { UsageViewDto } from '../modules/usages/dto/usages.dto.js';
import { UsagesService } from '../modules/usages/usages.service.js';
import { UsersService } from '../modules/users/users.service.js';
import { VehicleTransferService } from '../modules/vehicles/vehicle-transfer.service.js';
import { VehiclesService } from '../modules/vehicles/vehicles.service.js';

// ---------------------------------------------------------------------------------------------
// Garde-fous et entrée de la commande
// ---------------------------------------------------------------------------------------------

const USAGE = [
  'Usage : seed-demo [--reset]',
  '  Charge le jeu de démonstration fictif (3 sociétés, 12 véhicules) sur une base vierge.',
  '  --reset  vide d’abord toutes les tables d’une base de démonstration (refusé en production ou si la base',
  '           contient une autre organisation que DEMO).',
  'Mot de passe des comptes : variable DEMO_PASSWORD, sinon généré et affiché une seule fois.',
  '',
].join('\n');

export const PRODUCTION_REFUSAL = 'Refus : le jeu de démonstration n’est jamais chargé en production (NODE_ENV=production). Aucune donnée n’a été écrite.';

/** Refus explicite (production, base non vide, mot de passe trop faible) : code de sortie 1, rien n'est écrit. */
export class DemoSeedRefusedError extends Error {}

/** Échec d'une étape du chargement, avec le libellé de l'étape et le message métier de l'API. */
export class DemoSeedStepError extends Error {
  constructor(step: string, cause: unknown) {
    super(`Étape « ${step} » : ${describeStepError(cause)}`);
  }
}

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

export interface DemoPassword {
  value: string;
  generated: boolean;
}

/**
 * Point d'entrée testable de la commande : renvoie le code de sortie (0 succès, 1 refus ou échec, 2 usage).
 * La production est refusée avant toute lecture de configuration ou connexion à la base.
 */
export async function runSeedDemoCli(argv: readonly string[], source: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const args = argv.filter((a) => a !== '--');
  if (args.includes('--help') || args.includes('-h')) {
    io.out(USAGE);
    return 0;
  }
  const unknown = args.filter((a) => a !== '--reset');
  if (unknown.length > 0) {
    io.err(`Argument inconnu : ${unknown.join(' ')}\n${USAGE}`);
    return 2;
  }
  if (isProduction(source)) {
    io.err(`${PRODUCTION_REFUSAL}\n`);
    return 1;
  }
  try {
    const password = resolveDemoPassword(source);
    const env = loadEnv(source);
    const report = await seedDemo({ env, password: password.value, reset: args.includes('--reset'), progress: (line) => io.out(`${line}\n`) });
    io.out(formatReport(report, password));
    return 0;
  } catch (error) {
    if (error instanceof DemoSeedRefusedError) io.err(`${error.message}\n`);
    else io.err(`Jeu de démonstration interrompu : ${error instanceof DemoSeedStepError ? error.message : describeErrorSafely(error)}\n`);
    return 1;
  }
}

function isProduction(source: NodeJS.ProcessEnv): boolean {
  return (source['NODE_ENV'] ?? '').trim().toLowerCase() === 'production';
}

/** DEMO_PASSWORD (contrôlé comme tout mot de passe), sinon mot de passe aléatoire fort. */
export function resolveDemoPassword(source: NodeJS.ProcessEnv): DemoPassword {
  const provided = source['DEMO_PASSWORD'];
  if (provided !== undefined && provided !== '') {
    const weakness = new PasswordService().validateStrength(provided);
    if (weakness) throw new DemoSeedRefusedError(`Refus : DEMO_PASSWORD trop faible. ${weakness}`);
    return { value: provided, generated: false };
  }
  return { value: generatePassword(), generated: true };
}

/** 4 groupes de 5 caractères (lettres et chiffres, sans caractères ambigus) : minuscule, majuscule et chiffre garantis. */
function generatePassword(): string {
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = lower + upper + digits;
  const pick = (alphabet: string) => alphabet[randomInt(alphabet.length)] as string;
  const chars = [pick(lower), pick(upper), pick(digits), ...Array.from({ length: 17 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return [0, 5, 10, 15].map((start) => chars.slice(start, start + 5).join('')).join('-');
}

function describeStepError(error: unknown): string {
  if (error instanceof AppError) {
    const fields = error.fieldErrors ? ` ${JSON.stringify(error.fieldErrors)}` : '';
    const details = error.details ? ` ${JSON.stringify(error.details)}` : '';
    return describeErrorSafely(`${error.code} — ${error.message}${fields}${details}`, [], 2000);
  }
  return describeErrorSafely(error, [], 2000);
}

// ---------------------------------------------------------------------------------------------
// Contexte applicatif et horloge
// ---------------------------------------------------------------------------------------------

/**
 * Horloge du chargement : l'heure réelle, sauf pendant `during(instant, …)` où elle part de l'instant
 * indiqué (le temps continue de s'écouler). Sert à enregistrer l'historique « à son heure » par les services
 * normaux : réservation dont le créneau est aujourd'hui passé (la création refuse un début antérieur à
 * maintenant) et étapes datées (relevés, remises, restitutions, pleins, entretien réalisé), afin que les
 * évaluations qu'elles déclenchent (fraîcheur du kilométrage, échéances et leurs alertes) se fassent à cet
 * instant et non au moment du chargement.
 */
export class DemoClock extends Clock {
  private offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  async during<T>(instant: Date, work: () => Promise<T>): Promise<T> {
    this.offsetMs = instant.getTime() - Date.now();
    try {
      return await work();
    } finally {
      this.offsetMs = 0;
    }
  }
}

/** Même composition que le worker : infrastructure, contrôle d'accès, authentification et modules métier. */
@Module({})
class SeedDemoModule {
  static register(env: AppEnv, clock: Clock): DynamicModule {
    return { module: SeedDemoModule, imports: [InfraModule.forRoot(env, clock), AccessControlModule, AuthModule, ...FEATURE_MODULES] };
  }
}

export interface SeedDemoOptions {
  env: AppEnv;
  password: string;
  reset: boolean;
  progress?: (line: string) => void;
}

export interface DemoSeedReport {
  organization: { id: string; code: string; name: string };
  companies: Array<{ id: string; code: string; legalName: string }>;
  accounts: Array<{ email: string; name: string; role: RoleKey; companyCode: string | null }>;
  vehicles: number;
  drivers: number;
  openUsages: number;
  pendingReadings: number;
  activeAlerts: Array<{ type: string; count: number }>;
  importBatchId: string;
  reset: boolean;
}

/** Charge le jeu de démonstration (base vierge, ou vidée avec reset). */
export async function seedDemo(options: SeedDemoOptions): Promise<DemoSeedReport> {
  if (options.env.nodeEnv === 'production') throw new DemoSeedRefusedError(PRODUCTION_REFUSAL);
  const clock = new DemoClock();
  const app = await NestFactory.createApplicationContext(SeedDemoModule.register(options.env, clock), { logger: new RedactingConsoleLogger({ logLevels: ['error', 'warn'] }), abortOnError: false });
  try {
    await prepareDatabase(app.get(PrismaService), options.reset);
    return await new DemoSeeder(app, clock, options).run();
  } finally {
    await app.close();
  }
}

/**
 * Base vierge exigée : aucune organisation. Avec reset (hors production), toutes les tables sont vidées, mais
 * seulement si la base ne contient que l'organisation de démonstration : une base portant d'autres
 * organisations (données réelles, NODE_ENV absent ou erroné) n'est jamais vidée.
 */
async function prepareDatabase(prisma: PrismaService, reset: boolean): Promise<void> {
  let organizations: number;
  let foreign: number;
  try {
    organizations = await prisma.client.organization.count();
    foreign = await prisma.client.organization.count({ where: { code: { not: ORGANIZATION.code } } });
  } catch (error) {
    throw new DemoSeedRefusedError(`Refus : base inaccessible ou migrations non appliquées (pnpm db:migrate). ${describeErrorSafely(error)}`);
  }
  if (organizations === 0) return;
  if (!reset) {
    const hint = foreign === 0 ? ' ; relancez avec --reset pour la vider (hors production uniquement)' : '';
    throw new DemoSeedRefusedError(`Refus : la base n’est pas vide (${organizations} organisation(s)). Le jeu de démonstration se charge sur une base vierge${hint}.`);
  }
  if (foreign > 0) {
    throw new DemoSeedRefusedError(`Refus : --reset ne vide qu’une base de démonstration ; celle-ci contient ${foreign} organisation(s) autre(s) que ${ORGANIZATION.code}. Aucune donnée n’a été supprimée.`);
  }
  const tables = await prisma.client.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
      AND tablename NOT LIKE '%\\_default' AND tablename !~ '_[0-9]{6}$'`;
  if (tables.length > 0) await prisma.client.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

// ---------------------------------------------------------------------------------------------
// Données fictives
// ---------------------------------------------------------------------------------------------

type CompanyKey = 'ATLAS' | 'CARTHAGE' | 'OASIS';
type VehicleKey = 'VH-01' | 'VH-02' | 'VH-03' | 'VH-04' | 'VH-05' | 'VH-06' | 'VH-07' | 'VH-08' | 'VH-09' | 'VH-10' | 'VH-11' | 'VH-12';
type DriverKey = 'karim' | 'sami' | 'nadia' | 'youssef' | 'leila' | 'mehdi' | 'ines' | 'walid';

const ORGANIZATION = { code: 'DEMO', name: 'Groupe démonstration (données fictives)', timezone: 'Africa/Tunis' };
const EMAIL_DOMAIN = 'demo.parc-auto.test';

const COMPANIES: Record<CompanyKey, { legalName: string; address: string; site: { name: string; address: string; managerName: string }; garage: string; station: string }> = {
  ATLAS: { legalName: 'Atlas Logistique (démonstration)', address: 'Zone industrielle de la Charguia, Tunis', site: { name: 'Dépôt Charguia', address: 'Charguia II, Tunis', managerName: 'Chaima Riahi' }, garage: 'Garage Ennour', station: 'Station Charguia' },
  CARTHAGE: { legalName: 'Carthage Services (démonstration)', address: 'Avenue Léopold Sédar Senghor, Sousse', site: { name: 'Agence Sousse', address: 'Route de Monastir, Sousse', managerName: 'Bilel Sassi' }, garage: 'Garage du Sahel', station: 'Station Sousse Nord' },
  OASIS: { legalName: 'Oasis Distribution (démonstration)', address: 'Route de Gabès, Sfax', site: { name: 'Dépôt Sfax', address: 'Route de Gabès km 4, Sfax', managerName: 'Olfa Mejri' }, garage: 'Garage Sfax Auto', station: 'Station Route de Gabès' },
};

const ADMIN = { email: `admin@${EMAIL_DOMAIN}`, firstName: 'Hela', lastName: 'Ben Amor' };
const CHEFS: Record<CompanyKey, { email: string; firstName: string; lastName: string }> = {
  ATLAS: { email: `chef.atlas@${EMAIL_DOMAIN}`, firstName: 'Chaima', lastName: 'Riahi' },
  CARTHAGE: { email: `chef.carthage@${EMAIL_DOMAIN}`, firstName: 'Bilel', lastName: 'Sassi' },
  OASIS: { email: `chef.oasis@${EMAIL_DOMAIN}`, firstName: 'Olfa', lastName: 'Mejri' },
};

const DRIVERS: Record<DriverKey, { company: CompanyKey; code: string; firstName: string; lastName: string; account: boolean }> = {
  karim: { company: 'ATLAS', code: 'CD-ATL-01', firstName: 'Karim', lastName: 'Mansour', account: true },
  sami: { company: 'ATLAS', code: 'CD-ATL-02', firstName: 'Sami', lastName: 'Trabelsi', account: false },
  nadia: { company: 'ATLAS', code: 'CD-ATL-03', firstName: 'Nadia', lastName: 'Jaziri', account: false },
  youssef: { company: 'CARTHAGE', code: 'CD-CAR-01', firstName: 'Youssef', lastName: 'Gharbi', account: true },
  leila: { company: 'CARTHAGE', code: 'CD-CAR-02', firstName: 'Leila', lastName: 'Hammami', account: false },
  mehdi: { company: 'CARTHAGE', code: 'CD-CAR-03', firstName: 'Mehdi', lastName: 'Ayari', account: false },
  ines: { company: 'OASIS', code: 'CD-OAS-01', firstName: 'Ines', lastName: 'Chaabane', account: true },
  walid: { company: 'OASIS', code: 'CD-OAS-02', firstName: 'Walid', lastName: 'Ferchichi', account: false },
};

/** Conducteurs du lot d'import (CSV) de la société OASIS. */
const IMPORTED_DRIVERS = [
  { code: 'CD-OAS-03', firstName: 'Rania', lastName: 'Belhaj' },
  { code: 'CD-OAS-04', firstName: 'Anis', lastName: 'Khelifi' },
];

type Energy = 'DIESEL' | 'ESSENCE';
const VEHICLES: Record<VehicleKey, { company: CompanyKey; registration: string; make: string; model: string; category: 'VP' | 'VUL'; energy: Energy; year: number; tank: string }> = {
  'VH-01': { company: 'ATLAS', registration: '221 TU 1048', make: 'Peugeot', model: '208', category: 'VP', energy: 'ESSENCE', year: 2022, tank: '44' },
  'VH-02': { company: 'ATLAS', registration: '219 TU 5532', make: 'Renault', model: 'Kangoo', category: 'VUL', energy: 'DIESEL', year: 2021, tank: '60' },
  'VH-03': { company: 'ATLAS', registration: '214 TU 8807', make: 'Dacia', model: 'Logan', category: 'VP', energy: 'DIESEL', year: 2020, tank: '50' },
  'VH-04': { company: 'ATLAS', registration: '223 TU 3316', make: 'Toyota', model: 'Hilux', category: 'VUL', energy: 'DIESEL', year: 2019, tank: '80' },
  'VH-05': { company: 'CARTHAGE', registration: '218 TU 6621', make: 'Renault', model: 'Clio', category: 'VP', energy: 'ESSENCE', year: 2023, tank: '42' },
  'VH-06': { company: 'CARTHAGE', registration: '216 TU 2479', make: 'Volkswagen', model: 'Caddy', category: 'VUL', energy: 'DIESEL', year: 2021, tank: '55' },
  'VH-07': { company: 'CARTHAGE', registration: '212 TU 9154', make: 'Citroën', model: 'Berlingo', category: 'VUL', energy: 'DIESEL', year: 2018, tank: '53' },
  'VH-08': { company: 'CARTHAGE', registration: '224 TU 0736', make: 'Hyundai', model: 'i20', category: 'VP', energy: 'ESSENCE', year: 2022, tank: '40' },
  'VH-09': { company: 'ATLAS', registration: '220 TU 4415', make: 'Isuzu', model: 'D-Max', category: 'VUL', energy: 'DIESEL', year: 2020, tank: '76' },
  'VH-10': { company: 'OASIS', registration: '222 TU 7093', make: 'Mitsubishi', model: 'L200', category: 'VUL', energy: 'DIESEL', year: 2021, tank: '75' },
  'VH-11': { company: 'OASIS', registration: '217 TU 3862', make: 'Fiat', model: 'Doblo', category: 'VUL', energy: 'DIESEL', year: 2021, tank: '60' },
  'VH-12': { company: 'OASIS', registration: '225 TU 1287', make: 'Kia', model: 'Picanto', category: 'VP', energy: 'ESSENCE', year: 2023, tank: '35' },
};

/** Prix unitaires fictifs du carburant (TND/L, chaînes décimales) : aucun calcul ici, le service contrôle. */
const FUEL_PRICE: Record<Energy, string> = { ESSENCE: '2.525', DIESEL: '2.205' };

interface DemoVehicle {
  key: VehicleKey;
  id: string;
  code: string;
  company: CompanyKey;
  companyId: string;
}

interface DemoDriver {
  key: DriverKey;
  id: string;
  company: CompanyKey;
  userId: string | null;
}

interface Services {
  prisma: PrismaService;
  passwords: PasswordService;
  audit: AuditService;
  contexts: ContextBuilderService;
  organizations: OrganizationsService;
  users: UsersService;
  drivers: DriversService;
  vehicles: VehiclesService;
  suppliers: SuppliersService;
  settings: SettingsService;
  attachments: AttachmentsService;
  catalog: MaintenanceCatalogService;
  plans: MaintenancePlansService;
  documents: DocumentsService;
  odometer: OdometerService;
  freshness: OdometerFreshnessService;
  usages: UsagesService;
  reservations: ReservationsService;
  assignments: AssignmentsService;
  interventions: InterventionsService;
  incidents: IncidentsService;
  immobilizations: ImmobilizationsService;
  fuel: FuelService;
  expenses: ExpensesService;
  transfer: VehicleTransferService;
  imports: ImportsService;
}

// ---------------------------------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------------------------------

class DemoSeeder {
  private readonly s: Services;
  private readonly origin: Date;
  private readonly requestId = `seed-demo:${randomUUID()}`;
  private timezone = ORGANIZATION.timezone;
  private organizationId = '';
  private admin!: RequestContext;
  private readonly chefs = {} as Record<CompanyKey, RequestContext>;
  private readonly driverContexts = {} as Partial<Record<DriverKey, RequestContext>>;
  private readonly companyIds = {} as Record<CompanyKey, string>;
  private readonly siteIds = {} as Record<CompanyKey, string>;
  private readonly garages = {} as Record<CompanyKey, string>;
  private readonly stations = {} as Record<CompanyKey, string>;
  private readonly categoryIds = {} as Record<'VP' | 'VUL', string>;
  private readonly maintenanceTypes = new Map<string, string>();
  private readonly documentTypes = new Map<string, { id: string; version: number }>();
  private readonly drivers = {} as Record<DriverKey, DemoDriver>;
  private readonly vehicles = {} as Record<VehicleKey, DemoVehicle>;
  private readonly accounts: DemoSeedReport['accounts'] = [];
  private checklistLabels: string[] = [];

  constructor(
    app: INestApplicationContext,
    private readonly clock: DemoClock,
    private readonly options: SeedDemoOptions,
  ) {
    this.s = {
      prisma: app.get(PrismaService),
      passwords: app.get(PasswordService),
      audit: app.get(AuditService),
      contexts: app.get(ContextBuilderService),
      organizations: app.get(OrganizationsService),
      users: app.get(UsersService),
      drivers: app.get(DriversService),
      vehicles: app.get(VehiclesService),
      suppliers: app.get(SuppliersService),
      settings: app.get(SettingsService),
      attachments: app.get(AttachmentsService),
      catalog: app.get(MaintenanceCatalogService),
      plans: app.get(MaintenancePlansService),
      documents: app.get(DocumentsService),
      odometer: app.get(OdometerService),
      freshness: app.get(OdometerFreshnessService),
      usages: app.get(UsagesService),
      reservations: app.get(ReservationsService),
      assignments: app.get(AssignmentsService),
      interventions: app.get(InterventionsService),
      incidents: app.get(IncidentsService),
      immobilizations: app.get(ImmobilizationsService),
      fuel: app.get(FuelService),
      expenses: app.get(ExpensesService),
      transfer: app.get(VehicleTransferService),
      imports: app.get(ImportsService),
    };
    // Instant de référence : toutes les dates du jeu en découlent (D-324 : dates relatives à l'exécution).
    this.origin = clock.now();
  }

  async run(): Promise<DemoSeedReport> {
    this.progress('Organisation, administrateur et sociétés…');
    await this.bootstrap();
    await this.companiesAndReferentials();
    this.progress('Comptes, conducteurs et permis…');
    await this.people();
    this.progress('Véhicules et documents…');
    await this.fleet();
    this.progress('Historique des véhicules (relevés, utilisations, entretiens, incidents, carburant)…');
    await this.atlasHistory();
    await this.carthageHistory();
    await this.oasisHistory();
    this.progress('Transfert entre sociétés et import…');
    await this.transferBetweenCompanies();
    const importBatchId = await this.importDrivers();
    this.progress('Évaluation des alertes (rattrapage)…');
    await this.catchUp();
    return this.report(importBatchId);
  }

  // --- Amorçage ------------------------------------------------------------------------------

  /**
   * Organisation et premier administrateur : écriture directe justifiée (aucun service ne crée
   * d'organisation ; tout service exige un acteur habilité), identique à la commande create-admin.
   */
  private async bootstrap(): Promise<void> {
    const passwordHash = await this.s.passwords.hash(this.options.password);
    const now = this.clock.now();
    const created = await this.step('organisation et administrateur', () =>
      this.s.prisma.client.$transaction(async (tx) => {
        const org = await tx.organization.create({ data: { code: ORGANIZATION.code, name: ORGANIZATION.name, timezone: ORGANIZATION.timezone } });
        const user = await tx.user.create({
          data: { organizationId: org.id, email: ADMIN.email, firstName: ADMIN.firstName, lastName: ADMIN.lastName, passwordHash, passwordChangedAt: now, memberships: { create: [{ companyId: null, role: 'ADMIN' }] } },
        });
        await this.s.audit.recordSystem(org.id, { action: 'cli.jeu_demonstration', objectType: 'Organization', objectId: org.id, reason: 'Jeu de démonstration fictif (hors production, D-324).', after: { organizationCode: org.code, administrateur: user.email } }, tx);
        return { orgId: org.id, userId: user.id, timezone: org.timezone };
      }),
    );
    this.organizationId = created.orgId;
    this.timezone = created.timezone;
    this.admin = await this.context(created.userId);
    this.accounts.push({ email: ADMIN.email, name: `${ADMIN.firstName} ${ADMIN.lastName}`, role: 'ADMIN', companyCode: null });
  }

  private async companiesAndReferentials(): Promise<void> {
    for (const key of Object.keys(COMPANIES) as CompanyKey[]) {
      const c = COMPANIES[key];
      const company = await this.step(`société ${key}`, () => this.s.organizations.createCompany(this.admin, { code: key, legalName: c.legalName, address: c.address }));
      this.companyIds[key] = company.id;
    }
    // Périmètre de l'administrateur recalculé : il couvre désormais les trois sociétés.
    this.admin = await this.context(this.admin.userId);
    for (const key of Object.keys(COMPANIES) as CompanyKey[]) {
      const c = COMPANIES[key];
      const companyId = this.companyIds[key];
      this.siteIds[key] = (await this.step(`site ${c.site.name}`, () => this.s.organizations.createSite(this.admin, { companyId, name: c.site.name, address: c.site.address, managerName: c.site.managerName }))).id;
      this.garages[key] = (await this.step(`garage ${c.garage}`, () => this.s.suppliers.create(this.admin, { companyId, name: c.garage, category: 'GARAGE', address: c.site.address }))).id;
      this.stations[key] = (await this.step(`station ${c.station}`, () => this.s.suppliers.create(this.admin, { companyId, name: c.station, category: 'STATION', address: c.site.address }))).id;
    }
    this.categoryIds.VP = (await this.step('catégorie VP', () => this.s.organizations.createVehicleCategory(this.admin, { code: 'VP', label: 'Véhicule particulier', requiredPermitCategories: ['B'] }))).id;
    this.categoryIds.VUL = (await this.step('catégorie VUL', () => this.s.organizations.createVehicleCategory(this.admin, { code: 'VUL', label: 'Véhicule utilitaire léger', requiredPermitCategories: ['B'] }))).id;
    // Catalogues initiaux livrés (6.1, 7.1) : installés par l'administrateur, comme depuis l'interface.
    const maintenance = await this.step('catalogue d’entretien initial', () => this.s.catalog.installInitialTypes(this.admin, randomUUID()));
    for (const t of maintenance.created) this.maintenanceTypes.set(t.code, t.id);
    const documents = await this.step('types de documents initiaux', () => this.s.documents.installInitialTypes(this.admin, randomUUID()));
    for (const t of documents.created) this.documentTypes.set(t.code, { id: t.id, version: t.version });
    this.checklistLabels = [...(await this.s.settings.get(this.organizationId, 'usage.checklistItems'))];
  }

  // --- Personnes -----------------------------------------------------------------------------

  private async people(): Promise<void> {
    for (const key of Object.keys(CHEFS) as CompanyKey[]) {
      const chef = CHEFS[key];
      const user = await this.step(`compte chef ${key}`, () =>
        this.s.users.create(this.admin, { email: chef.email, firstName: chef.firstName, lastName: chef.lastName, password: this.options.password, memberships: [{ companyId: this.companyIds[key], role: 'CHEF_PARC' }] }),
      );
      this.chefs[key] = await this.context(user.id);
      this.accounts.push({ email: chef.email, name: `${chef.firstName} ${chef.lastName}`, role: 'CHEF_PARC', companyCode: key });
    }
    for (const key of Object.keys(DRIVERS) as DriverKey[]) {
      const d = DRIVERS[key];
      const chef = this.chefs[d.company];
      const created = await this.step(`conducteur ${d.code}`, () =>
        this.s.drivers.create(chef, { companyId: this.companyIds[d.company], code: d.code, firstName: d.firstName, lastName: d.lastName, siteId: this.siteIds[d.company], email: d.account ? this.driverEmail(key) : undefined }),
      );
      await this.step(`permis ${d.code}`, () =>
        this.s.drivers.upsertPermit(chef, created.id, { number: `PC-${d.code.replace(/[^0-9]/g, '')}-${d.lastName.slice(0, 3).toUpperCase()}`, categories: ['B'], issuedOn: this.day(-3200), expiresOn: this.day(1800) }),
      );
      let userId: string | null = null;
      if (d.account) {
        const user = await this.step(`compte conducteur ${d.code}`, () =>
          this.s.users.create(this.admin, { email: this.driverEmail(key), firstName: d.firstName, lastName: d.lastName, password: this.options.password, memberships: [{ companyId: this.companyIds[d.company], role: 'CONDUCTEUR' }], driverId: created.id }),
        );
        userId = user.id;
        this.accounts.push({ email: this.driverEmail(key), name: `${d.firstName} ${d.lastName}`, role: 'CONDUCTEUR', companyCode: d.company });
      }
      this.drivers[key] = { key, id: created.id, company: d.company, userId };
    }
    for (const key of Object.keys(DRIVERS) as DriverKey[]) {
      const userId = this.drivers[key].userId;
      if (userId) this.driverContexts[key] = await this.context(userId);
    }
  }

  private driverEmail(key: DriverKey): string {
    const d = DRIVERS[key];
    return `${d.firstName}.${d.lastName}@${EMAIL_DOMAIN}`.toLowerCase();
  }

  // --- Véhicules et documents ------------------------------------------------------------------

  private async fleet(): Promise<void> {
    for (const key of Object.keys(VEHICLES) as VehicleKey[]) {
      const v = VEHICLES[key];
      const created = await this.step(`véhicule ${key}`, () =>
        this.s.vehicles.create(this.chefs[v.company], {
          companyId: this.companyIds[v.company],
          code: key,
          registration: v.registration,
          make: v.make,
          model: v.model,
          categoryId: this.categoryIds[v.category],
          year: v.year,
          commissioningDate: `${v.year}-03-01`,
          energy: v.energy,
          tankCapacityLiters: v.tank,
          siteId: this.siteIds[v.company],
          ownershipMode: 'ACHAT',
          notes: 'Véhicule fictif du jeu de démonstration.',
        }),
      );
      this.vehicles[key] = { key, id: created.id, code: created.code, company: v.company, companyId: this.companyIds[v.company] };
    }
    const insurance = this.docType('ASSURANCE');
    const inspection = this.docType('VISITE_TECHNIQUE');
    const registration = this.docType('CARTE_GRISE');
    for (const key of Object.keys(VEHICLES) as VehicleKey[]) {
      const v = this.vehicles[key];
      // VH-05 : assurance expirée depuis 5 jours (document bloquant, nouveau départ refusé sans dérogation).
      const expired = key === 'VH-05';
      await this.document(v, insurance, { number: `POL-${key}-${this.day(expired ? -370 : -200).slice(0, 4)}`, issuer: 'Assurances fictives du groupe', validFrom: this.day(expired ? -370 : -200), validTo: this.day(expired ? -5 : 165) });
    }
    // VH-06 : visite technique à renouveler (expire dans 12 jours) ; les autres sont valides.
    await this.document(this.vehicles['VH-06'], inspection, { number: 'VT-216-2479', issuer: 'Centre de visite technique (fictif)', validFrom: this.day(-353), validTo: this.day(12) });
    for (const key of ['VH-01', 'VH-03', 'VH-08', 'VH-10'] as const) {
      await this.document(this.vehicles[key], inspection, { number: `VT-${key}`, issuer: 'Centre de visite technique (fictif)', validFrom: this.day(-100), validTo: this.day(265) });
    }
    for (const key of ['VH-01', 'VH-09', 'VH-11'] as const) {
      await this.document(this.vehicles[key], registration, { number: `CG-${VEHICLES[key].registration.replace(/\s+/g, '')}`, issuedOn: `${VEHICLES[key].year}-02-15` });
    }
    // Paramétrage documentaire (7.1, 7.2) : l'assurance devient requise et bloquante une fois les polices enregistrées.
    await this.step('type ASSURANCE requis et bloquant', () => this.s.documents.updateType(this.admin, insurance.id, { required: true, blocksCheckout: true, visibleToDriver: true, expectedVersion: insurance.version }));
  }

  private docType(code: string): { id: string; version: number } {
    const t = this.documentTypes.get(code);
    if (!t) throw new DemoSeedStepError(`type de document ${code}`, new Error('Type absent du catalogue initial installé.'));
    return t;
  }

  private async document(v: DemoVehicle, type: { id: string }, fields: { number: string; issuer?: string; issuedOn?: string; validFrom?: string; validTo?: string }): Promise<void> {
    await this.step(`document ${v.code} ${fields.number}`, () => this.s.documents.create(this.chefs[v.company], { documentTypeId: type.id, vehicleId: v.id, ...fields }, randomUUID()));
  }

  // --- ATLAS : utilisation ouverte, retour en retard, entretien en retard, incident critique ----------

  private async atlasHistory(): Promise<void> {
    const chef = this.chefs.ATLAS;
    const site = this.siteIds.ATLAS;
    const karim = this.drivers.karim;

    // VH-09 : historique dans ATLAS avant son transfert vers OASIS (enregistré avant l'utilisation en cours de
    // Sami sur VH-02 : un conducteur n'a qu'une utilisation ouverte à la fois).
    const vh09 = this.vehicles['VH-09'];
    await this.reading(chef, vh09, 97000, this.at(70, 9));
    await this.step('responsable habituel VH-09', () => this.s.assignments.create(chef, { vehicleId: vh09.id, driverId: this.drivers.sami.id, startsAt: this.at(70, 9, 30).toISOString() }));
    await this.plan(chef, vh09, 'VIDANGE_MOTEUR', { intervalKm: '10000', base: { baseMode: 'ECHEANCE_INITIALE', nextDueKm: '105000' } });
    const past09 = await this.checkout(chef, vh09, this.drivers.sami, this.at(25, 7), this.at(22, 19), 99100, 'Approvisionnement chantier Béja');
    await this.giveBack(chef, past09, this.at(22, 19), 100340);

    // VH-01 : responsable habituel, utilisation clôturée puis utilisation ouverte ; soumissions du conducteur.
    const vh01 = this.vehicles['VH-01'];
    await this.reading(chef, vh01, 32000, this.at(60, 9));
    await this.step('responsable habituel VH-01', () => this.s.assignments.create(chef, { vehicleId: vh01.id, driverId: karim.id, startsAt: this.at(60, 9, 30).toISOString(), notes: 'Véhicule de tournée attitré.' }));
    await this.plan(chef, vh01, 'VIDANGE_MOTEUR', { intervalKm: '10000', intervalMonths: 12, base: { baseMode: 'DERNIERE_OPERATION', baseKm: '30000', baseDate: this.day(-75) } });
    await this.reading(chef, vh01, 35100, this.at(30, 8));
    const past01 = await this.checkout(chef, vh01, karim, this.at(15, 8), this.at(14, 18), 36200, 'Tournée clientèle Nabeul');
    await this.giveBack(chef, past01, this.at(14, 17, 30), 36640);
    await this.expense(chef, { vehicleId: vh01.id, occurredOn: this.day(-14), category: 'STATIONNEMENT', amount: '12.000', reference: 'PARK-DEMO-0141', notes: 'Stationnement pendant la tournée de Nabeul.' });
    await this.checkout(chef, vh01, karim, this.at(1, 8), this.inDays(2, 18), 38420, 'Tournée clientèle Cap Bon');
    const karimCtx = this.driverCtx('karim');
    const submitted = await this.reading(karimCtx, vh01, 38610, this.hoursAgo(2), 'EN_ATTENTE', 'Relevé déclaré depuis le mobile');
    await this.step('validation du relevé du conducteur', () => this.s.odometer.approve(chef, submitted.id, { expectedVersion: submitted.version, reason: 'Valeur cohérente avec la tournée en cours.' }));
    // Pleins soumis par le conducteur : un validé, son doublon rejeté, un écart de montant en attente.
    const filledAt = this.at(1, 12, 30);
    const first = await this.driverFuel(karimCtx, vh01, { filledAt, liters: '30.000', unitPrice: FUEL_PRICE.ESSENCE, totalAmount: '75.750', isFullTank: true, notes: 'Plein complet pendant la tournée.' });
    const duplicate = await this.driverFuel(karimCtx, vh01, { filledAt, liters: '30.000', unitPrice: FUEL_PRICE.ESSENCE, totalAmount: '75.750', isFullTank: true, notes: 'Ticket envoyé une seconde fois.' });
    await this.step('rejet du plein en doublon', () => this.s.fuel.reject(chef, duplicate.id, { expectedVersion: duplicate.version, reason: 'Doublon : ce ticket a déjà été soumis (même date, mêmes montants).' }));
    await this.step('validation du plein', () => this.s.fuel.validate(chef, first.id, { expectedVersion: first.version, supplierId: this.stations.ATLAS }, randomUUID()));
    const mismatch = await this.driverFuel(karimCtx, vh01, { filledAt: this.hoursAgo(3), liters: '12.000', unitPrice: FUEL_PRICE.ESSENCE, totalAmount: '36.300', isFullTank: false, notes: 'Appoint avant le retour.' });
    if (mismatch.status !== 'SOUMIS') throw new DemoSeedStepError('plein avec écart', new Error(`statut ${mismatch.status} inattendu`));

    // VH-02 : réservation de demain compromise par une utilisation dont le retour prévu est dépassé.
    const vh02 = this.vehicles['VH-02'];
    await this.reading(chef, vh02, 81200, this.at(45, 10));
    await this.plan(chef, vh02, 'VIDANGE_MOTEUR', { intervalKm: '15000', intervalMonths: 12, base: { baseMode: 'DERNIERE_OPERATION', baseKm: '80000', baseDate: this.day(-60) } });
    const past02 = await this.checkout(chef, vh02, this.drivers.nadia, this.at(20, 7, 45), this.at(18, 18), 82300, 'Livraisons Bizerte');
    await this.giveBack(chef, past02, this.at(18, 18, 10), 83150);
    const upcoming = new Date(Math.ceil((this.origin.getTime() + 6 * 3_600_000) / 60_000) * 60_000);
    await this.step('réservation compromise VH-02', () =>
      this.s.reservations.create(chef, { vehicleId: vh02.id, driverId: this.drivers.nadia.id, startAt: upcoming.toISOString(), endAt: new Date(upcoming.getTime() + 4 * 3_600_000).toISOString(), purpose: 'Livraison urgente à Ben Arous', destination: 'Ben Arous', siteId: site }),
    );
    await this.checkout(chef, vh02, this.drivers.sami, this.at(4, 7, 30), this.at(1, 18), 84050, 'Chantier de Zaghouan');

    // VH-03 : vidange en retard ; relevé en attente au-delà du seuil de plausibilité.
    const vh03 = this.vehicles['VH-03'];
    await this.reading(chef, vh03, 64000, this.at(90, 9));
    await this.plan(chef, vh03, 'VIDANGE_MOTEUR', { intervalKm: '10000', intervalMonths: 12, base: { baseMode: 'DERNIERE_OPERATION', baseKm: '60000', baseDate: this.day(-200) } });
    await this.reading(chef, vh03, 67300, this.at(40, 9));
    const past03 = await this.checkout(chef, vh03, this.drivers.nadia, this.at(6, 8), this.at(5, 18), 69900, 'Rendez-vous fournisseurs Sousse');
    await this.giveBack(chef, past03, this.at(5, 17), 70420);
    await this.reading(chef, vh03, 70850, this.at(2, 17, 30));
    await this.reading(chef, vh03, 74900, this.at(1, 9), 'EN_ATTENTE', 'Valeur à vérifier : hausse inhabituelle');

    // VH-04 : accident critique, immobilisation active au garage, intervention planifiée.
    const vh04 = this.vehicles['VH-04'];
    await this.reading(chef, vh04, 118400, this.at(50, 8));
    await this.plan(chef, vh04, 'VIDANGE_MOTEUR', { intervalKm: '10000', base: { baseMode: 'ECHEANCE_INITIALE', nextDueKm: '125000' } });
    await this.reading(chef, vh04, 120900, this.at(10, 8));
    await this.reading(chef, vh04, 121180, this.at(3, 7, 45));
    const accident = await this.step('incident critique VH-04', () =>
      this.s.incidents.create(chef, {
        vehicleId: vh04.id,
        type: 'ACCIDENT',
        severity: 'CRITIQUE',
        occurredAt: this.at(3, 15, 40).toISOString(),
        locationLabel: 'Route de Bizerte, Menzel Jemil',
        description: 'Collision arrière à faible vitesse : pare-chocs et feu arrière endommagés, radiateur touché. Véhicule non roulant, remorqué au garage.',
        driverId: this.drivers.nadia.id,
        followUpUserId: chef.userId,
      }, randomUUID()),
    );
    await this.step('immobilisation VH-04', () =>
      this.s.incidents.immobilize(chef, accident.id, { reason: 'Véhicule non roulant après l’accident (radiateur).', startedAt: this.at(3, 18).toISOString(), expectedEndAt: this.inDays(5, 17).toISOString(), garageSupplierId: this.garages.ATLAS }),
    );
    await this.step('intervention VH-04', () =>
      this.s.incidents.openIntervention(chef, accident.id, {
        kind: 'CORRECTIF',
        supplierId: this.garages.ATLAS,
        plannedStartAt: this.inDays(1, 8).toISOString(),
        diagnosis: 'Radiateur percé, pare-chocs arrière et feu arrière gauche à remplacer.',
        tasks: [{ label: 'Remplacement du radiateur' }, { label: 'Carrosserie arrière et feu arrière gauche' }],
      }),
    );
  }

  // --- CARTHAGE : document expiré, relevé ancien, compteur remplacé, réservations, entretien réalisé ----

  private async carthageHistory(): Promise<void> {
    const chef = this.chefs.CARTHAGE;
    const site = this.siteIds.CARTHAGE;

    // VH-05 : assurance expirée (bloquante) ; historique antérieur à l'expiration.
    const vh05 = this.vehicles['VH-05'];
    await this.reading(chef, vh05, 22400, this.at(35, 9));
    const past05 = await this.checkout(chef, vh05, this.drivers.youssef, this.at(12, 8, 30), this.at(11, 17), 23050, 'Visite des agences de Monastir');
    await this.giveBack(chef, past05, this.at(11, 16), 23380);
    await this.reading(chef, vh05, 23510, this.at(2, 11));
    await this.plan(chef, vh05, 'VIDANGE_MOTEUR', { intervalKm: '10000', intervalMonths: 12, base: { baseMode: 'ECHEANCE_INITIALE', nextDueKm: '30000', nextDueDate: this.day(120) } });

    // VH-06 : dernier relevé vieux de 25 jours (kilométrage à actualiser), visite technique à renouveler.
    const vh06 = this.vehicles['VH-06'];
    await this.reading(chef, vh06, 54000, this.at(80, 9));
    await this.reading(chef, vh06, 56700, this.at(25, 8));
    await this.plan(chef, vh06, 'VIDANGE_MOTEUR', { intervalKm: '10000', base: { baseMode: 'DERNIERE_OPERATION', baseKm: '50000', baseDate: this.day(-150) } });

    // VH-07 : remplacement du compteur (justificatif), relevé corrigé, vidange bientôt due.
    const vh07 = this.vehicles['VH-07'];
    await this.reading(chef, vh07, 139200, this.at(120, 9));
    await this.reading(chef, vh07, 143100, this.at(60, 9));
    await this.reading(chef, vh07, 145150, this.at(31, 17));
    const justification = await this.step('justificatif du remplacement de compteur', () =>
      this.s.attachments.upload(chef, demoPdf('remplacement-compteur-VH-07.pdf', ['Attestation de remplacement du combiné d’instruments', `Véhicule VH-07 (${VEHICLES['VH-07'].registration})`, 'Ancien compteur : 145 200 km ; nouveau compteur : 12 km', 'Document fictif du jeu de démonstration']), this.companyIds.CARTHAGE),
    );
    const replacedAt = this.at(30, 10);
    await this.step('remplacement du compteur VH-07', () =>
      this.asOf(replacedAt, () => this.s.odometer.initSegment(chef, vh07.id, { mode: 'REPLACEMENT', startedAt: replacedAt.toISOString(), physicalKm: '12', oldCounterFinalKm: '145200', reason: 'Remplacement du combiné d’instruments (afficheur défaillant).', justificationAttachmentId: justification.id })),
    );
    await this.reading(chef, vh07, 1862, this.at(20, 9));
    const typo = await this.reading(chef, vh07, 3090, this.at(10, 9), 'ACCEPTE', 'Saisie au retour de tournée');
    const past07 = await this.checkout(chef, vh07, this.drivers.leila, this.at(8, 8), this.at(7, 18), 4450, 'Livraison des pièces à Kairouan');
    await this.giveBack(chef, past07, this.at(7, 17), 4980);
    await this.reading(chef, vh07, 5612, this.at(3, 9));
    await this.step('correction du relevé VH-07', () =>
      this.s.odometer.correct(chef, typo.id, { reason: 'Erreur de saisie : 3 090 saisi au lieu de 3 900 lu au compteur.', replacementReading: { physicalKm: '3900' }, expectedVersion: typo.version }, randomUUID()),
    );
    await this.plan(chef, vh07, 'VIDANGE_MOTEUR', { intervalKm: '10000', base: { baseMode: 'DERNIERE_OPERATION', baseKm: '141000', baseDate: this.day(-110) } });

    // VH-08 : vidange réalisée (intervention clôturée avec coût), utilisation clôturée, réservations.
    const vh08 = this.vehicles['VH-08'];
    await this.reading(chef, vh08, 38000, this.at(100, 9));
    // Plan, relevé, intervention : chacun à son heure, pour que l'alerte « Entretien à prévoir » soit levée puis
    // résolue par la vidange dans l'ordre réel.
    const vidange = await this.plan(chef, vh08, 'VIDANGE_MOTEUR', { intervalKm: '10000', intervalMonths: 12, base: { baseMode: 'DERNIERE_OPERATION', baseKm: '30000', baseDate: this.day(-200) } }, this.at(100, 9, 5));
    await this.reading(chef, vh08, 39600, this.at(30, 9));
    const planned = await this.step('intervention préventive VH-08', () =>
      this.asOf(this.at(7, 8, 15), () => this.s.interventions.create(chef, {
        vehicleId: vh08.id,
        kind: 'PREVENTIF',
        supplierId: this.garages.CARTHAGE,
        diagnosis: 'Vidange à l’échéance kilométrique.',
        tasks: [{ planId: vidange }, { maintenanceTypeId: this.maintenanceType('FILTRES'), label: 'Filtre à huile et filtre à air' }],
      })),
    );
    const startedAt = this.at(7, 8, 30);
    const started = await this.step('démarrage de l’intervention VH-08', () => this.asOf(startedAt, () => this.s.interventions.start(chef, planned.id, { startedAt: startedAt.toISOString(), expectedVersion: planned.version })));
    const [oil, filters] = started.tasks;
    if (!oil || !filters) throw new DemoSeedStepError('clôture de l’intervention VH-08', new Error('lignes de travail absentes'));
    const performedAt = this.at(7, 9);
    await this.step('clôture de l’intervention VH-08', () =>
      this.asOf(performedAt, () => this.s.interventions.complete(chef, started.id, {
        performedOn: this.day(-7),
        newReading: { physicalKm: '39910', observedAt: performedAt.toISOString() },
        completedTaskIds: [oil.id, filters.id],
        lines: [
          { taskId: oil.id, kind: 'PIECE', label: 'Huile moteur 5W30', quantity: '4.5', unitPrice: '18.500' },
          { taskId: filters.id, kind: 'PIECE', label: 'Filtre à huile', quantity: '1', unitPrice: '24.000' },
          { taskId: filters.id, kind: 'PIECE', label: 'Filtre à air', quantity: '1', unitPrice: '31.500' },
          { kind: 'MAIN_OEUVRE', label: 'Main-d’œuvre vidange', quantity: '1', unitPrice: '45.000' },
        ],
        workDescription: 'Vidange moteur, remplacement des filtres à huile et à air.',
        expectedVersion: started.version,
      }, randomUUID())),
    );
    const past08 = await this.checkout(chef, vh08, this.drivers.mehdi, this.at(6, 8), this.at(6, 19), 39950, 'Réunion régionale à Monastir');
    await this.giveBack(chef, past08, this.at(6, 18), 40120);
    await this.reading(chef, vh08, 40260, this.at(2, 17));
    // Réservation non honorée : enregistrée par le service normal trois jours plus tôt (horloge du chargement),
    // puis constatée par le chef aujourd'hui (délai de grâce écoulé).
    const noShowStart = this.at(3, 9);
    const missed = await this.clock.during(new Date(noShowStart.getTime() - 2 * 3_600_000), () =>
      this.step('réservation (créneau passé) VH-08', () =>
        this.s.reservations.create(chef, { vehicleId: vh08.id, driverId: this.drivers.leila.id, startAt: noShowStart.toISOString(), endAt: this.at(3, 12).toISOString(), purpose: 'Visite client à Monastir', destination: 'Monastir', siteId: site }),
      ),
    );
    await this.step('non-présentation constatée VH-08', () => this.s.reservations.markNoShow(chef, missed.id, 'Conductrice absente, mission reportée par le client.', missed.version));
    await this.step('réservation future VH-08', () =>
      this.s.reservations.create(chef, { vehicleId: vh08.id, driverId: this.drivers.mehdi.id, startAt: this.inDays(2, 8).toISOString(), endAt: this.inDays(2, 17).toISOString(), purpose: 'Formation sécurité routière à Tunis', destination: 'Tunis', siteId: site }),
    );
  }

  // --- OASIS : utilisation ouverte et incident mineur du conducteur, pleins, dépenses, plans ---------

  private async oasisHistory(): Promise<void> {
    const chef = this.chefs.OASIS;

    // VH-10 : utilisation en cours ; crevaison déclarée par la conductrice depuis son compte, résolue par le chef.
    const vh10 = this.vehicles['VH-10'];
    await this.reading(chef, vh10, 61000, this.at(40, 9));
    await this.plan(chef, vh10, 'VIDANGE_MOTEUR', { intervalKm: '10000', base: { baseMode: 'DERNIERE_OPERATION', baseKm: '55000', baseDate: this.day(-120) } });
    await this.checkout(chef, vh10, this.drivers.ines, this.at(2, 7), this.inDays(1, 18), 62480, 'Tournée des points de vente du Sud');
    const flat = await this.step('incident mineur VH-10', () =>
      this.s.incidents.create(this.driverCtx('ines'), { vehicleId: vh10.id, type: 'CREVAISON', severity: 'FAIBLE', occurredAt: this.at(1, 14, 20).toISOString(), locationLabel: 'Route de Gabès, Mahrès', description: 'Crevaison du pneu avant droit ; roue de secours posée, tournée poursuivie.' }, randomUUID()),
    );
    await this.step('résolution de l’incident mineur', () => this.s.incidents.transition(chef, flat.id, { to: 'RESOLU', note: 'Pneu réparé chez le fournisseur ; roue de secours remise en place.', expectedVersion: flat.version }));

    // VH-11 : pleins normaux saisis par le chef (relevés carburant), utilisation clôturée, dépenses, plan en temps.
    const vh11 = this.vehicles['VH-11'];
    const walid = this.drivers.walid;
    await this.reading(chef, vh11, 33500, this.at(60, 9));
    await this.staffFuel(chef, vh11, walid, this.at(40, 10), '45.000', '99.225', '34200');
    await this.staffFuel(chef, vh11, walid, this.at(20, 10), '42.000', '92.610', '34650');
    await this.expense(chef, { vehicleId: vh11.id, occurredOn: this.day(-20), category: 'PEAGE', amount: '4.300', reference: 'PEAGE-DEMO-2031', notes: 'Autoroute A1 Sfax – El Jem.' });
    const past11 = await this.checkout(chef, vh11, walid, this.at(10, 8), this.at(9, 19), 34900, 'Livraisons Kerkennah');
    await this.giveBack(chef, past11, this.at(9, 18), 35300);
    await this.staffFuel(chef, vh11, walid, this.at(5, 10), '38.500', '84.893', '35560');
    await this.plan(chef, vh11, 'CONTROLE_TECHNIQUE_INTERNE', { intervalMonths: 6, base: { baseMode: 'DERNIERE_OPERATION', baseDate: this.day(-100) } });
    await this.expense(chef, { companyId: this.companyIds.OASIS, occurredOn: this.day(-15), category: 'ASSURANCE', amount: '1850.000', reference: 'ASSUR-DEMO-T3', notes: 'Prime trimestrielle de la flotte (dépense société non affectée).' });

    // VH-12 : responsable habituel, pneus à jour, batterie bientôt due (échéance en temps).
    const vh12 = this.vehicles['VH-12'];
    await this.reading(chef, vh12, 12300, this.at(30, 9));
    await this.step('responsable habituel VH-12', () => this.s.assignments.create(chef, { vehicleId: vh12.id, driverId: walid.id, startsAt: this.at(30, 9, 30).toISOString(), notes: 'Véhicule de service du dépôt.' }));
    await this.reading(chef, vh12, 13050, this.at(4, 17));
    await this.plan(chef, vh12, 'PNEUS', { intervalKm: '20000', base: { baseMode: 'DERNIERE_OPERATION', baseKm: '5000', baseDate: this.day(-300) } });
    await this.plan(chef, vh12, 'BATTERIE', { intervalMonths: 24, base: { baseMode: 'DERNIERE_OPERATION', baseDate: this.day(-715) } });
  }

  // --- Transfert, import, télématique ----------------------------------------------------------

  /** VH-09 : transfert d'ATLAS vers OASIS avec relevé de transfert, plan conservé et documents partagés. */
  private async transferBetweenCompanies(): Promise<void> {
    const vh09 = this.vehicles['VH-09'];
    const preview = await this.step('aperçu du transfert VH-09', () => this.s.transfer.preview(this.admin, vh09.id));
    if (!preview.canTransfer) throw new DemoSeedStepError('transfert VH-09', new Error(`objets bloquants : ${preview.blockers.map((b) => b.label).join(', ')}`));
    await this.step('transfert VH-09', () =>
      this.s.transfer.transfer(this.admin, vh09.id, {
        targetCompanyId: this.companyIds.OASIS,
        expectedVersion: preview.version,
        reason: 'Renfort saisonnier du dépôt de Sfax.',
        ...(preview.assignments.length > 0 ? { assignment: { closeCurrent: true, newResponsibleDriverId: null } } : {}),
        plans: preview.plans.map((p) => ({ planId: p.id, decision: 'KEEP' as const, responsibleUserId: this.chefs.OASIS.userId })),
        siteId: this.siteIds.OASIS,
        departmentId: null,
        sharedDocumentVersionIds: preview.documents.map((d) => d.id),
        transferReading: { physicalKm: '101020', note: 'Relevé au départ du dépôt Charguia.' },
        ...(preview.warnings.length > 0 ? { acknowledgeWarnings: true } : {}),
      }, randomUUID()),
    );
    this.vehicles['VH-09'] = { ...vh09, company: 'OASIS', companyId: this.companyIds.OASIS };
  }

  /** Lot d'import de conducteurs (12.1, 12.2) : téléversement, contrôle et confirmation par le chef OASIS. */
  private async importDrivers(): Promise<string> {
    const chef = this.chefs.OASIS;
    const header = IMPORT_COLUMNS.CONDUCTEURS.map((c) => c.name);
    const rows = IMPORTED_DRIVERS.map((d) => header.map((column) => ({ company_code: 'OASIS', driver_code: d.code, first_name: d.firstName, last_name: d.lastName, active: 'oui', site: COMPANIES.OASIS.site.name })[column] ?? ''));
    const buffer = Buffer.from(toCsv(header, rows), 'utf8');
    const uploaded = await this.step('téléversement du lot d’import', () => this.s.imports.upload(chef, { originalname: 'conducteurs-oasis.csv', buffer, size: buffer.length }, 'CONDUCTEURS'));
    const checked = await this.step('contrôle du lot d’import', () => this.s.imports.validate(chef, uploaded.id, { mapping: uploaded.columnMapping ?? {}, expectedVersion: uploaded.version }));
    if (checked.errorCount > 0) throw new DemoSeedStepError('contrôle du lot d’import', new Error(`${checked.errorCount} ligne(s) en erreur`));
    const committed = await this.step('confirmation du lot d’import', () => this.s.imports.commit(chef, uploaded.id, randomUUID()));
    return committed.id;
  }

  /** Mêmes évaluations que le rattrapage du worker : les alertes sont à jour dès la fin du chargement. */
  private async catchUp(): Promise<void> {
    const org = this.organizationId;
    await this.step('recalcul des plans', () => this.s.plans.recomputeAll(org));
    await this.step('conformité documentaire', () => this.s.documents.evaluateAll(org));
    await this.step('fraîcheur du kilométrage', () => this.s.freshness.evaluateAll(org));
    await this.step('retours dépassés', () => this.s.usages.evaluateLateReturns(org));
    await this.step('réservations non honorées', () => this.s.reservations.expireUnconverted(org));
    await this.step('immobilisations actives', () => this.s.immobilizations.evaluateActive(org));
  }

  private async report(importBatchId: string): Promise<DemoSeedReport> {
    const client = this.s.prisma.client;
    const where = { organizationId: this.organizationId };
    const [companies, vehicles, drivers, openUsages, pendingReadings, alerts] = await Promise.all([
      client.company.findMany({ where, orderBy: { code: 'asc' }, select: { id: true, code: true, legalName: true } }),
      client.vehicle.count({ where }),
      client.driver.count({ where }),
      client.vehicleUsage.count({ where: { ...where, status: 'EN_COURS' } }),
      client.odometerReading.count({ where: { ...where, status: 'EN_ATTENTE' } }),
      client.alert.groupBy({ by: ['type'], where: { ...where, status: 'ACTIVE' }, _count: { _all: true }, orderBy: { type: 'asc' } }),
    ]);
    return {
      organization: { id: this.organizationId, code: ORGANIZATION.code, name: ORGANIZATION.name },
      companies,
      accounts: this.accounts,
      vehicles,
      drivers,
      openUsages,
      pendingReadings,
      activeAlerts: alerts.map((a) => ({ type: a.type, count: a._count._all })),
      importBatchId,
      reset: this.options.reset,
    };
  }

  // --- Aides ---------------------------------------------------------------------------------

  private progress(line: string): void {
    this.options.progress?.(line);
  }

  private async step<T>(label: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof DemoSeedStepError) throw error;
      throw new DemoSeedStepError(label, error);
    }
  }

  /**
   * Étape datée exécutée « à son heure » : l'horloge du chargement est placée une minute après `instant`
   * (saisie contemporaine). Sans cela, chaque relevé historique serait évalué à l'instant du chargement et
   * lèverait puis résoudrait aussitôt une alerte « Kilométrage à actualiser » (historique d'alertes fictif).
   */
  private asOf<T>(instant: Date, work: () => Promise<T>): Promise<T> {
    return this.clock.during(new Date(Math.min(instant.getTime() + 60_000, Date.now())), work);
  }

  /** Contexte d'autorisation réel d'un compte (habilitations relues en base, comme un traitement différé). */
  private async context(userId: string): Promise<RequestContext> {
    const ctx = await this.s.contexts.forUser(userId, this.organizationId, this.requestId);
    if (!ctx) throw new DemoSeedStepError('contexte utilisateur', new Error(`compte ${userId} introuvable ou inactif`));
    return ctx;
  }

  private driverCtx(key: DriverKey): RequestContext {
    const ctx = this.driverContexts[key];
    if (!ctx) throw new DemoSeedStepError(`contexte du conducteur ${key}`, new Error('conducteur sans compte'));
    return ctx;
  }

  private maintenanceType(code: string): string {
    const id = this.maintenanceTypes.get(code);
    if (!id) throw new DemoSeedStepError(`opération ${code}`, new Error('opération absente du catalogue initial installé'));
    return id;
  }

  /** Instant local (fuseau du groupe) `daysAgo` jours avant l'instant de référence ; toujours passé. */
  private at(daysAgo: number, hour: number, minute = 0): Date {
    const instant = DateTime.fromJSDate(this.origin, { zone: this.timezone }).minus({ days: daysAgo }).set({ hour, minute, second: 0, millisecond: 0 }).toJSDate();
    if (instant.getTime() >= this.origin.getTime()) throw new DemoSeedStepError('calendrier du jeu', new Error(`instant ${instant.toISOString()} non passé`));
    return instant;
  }

  /** Instant local futur, `days` jours après l'instant de référence. */
  private inDays(days: number, hour: number, minute = 0): Date {
    return DateTime.fromJSDate(this.origin, { zone: this.timezone }).plus({ days }).set({ hour, minute, second: 0, millisecond: 0 }).toJSDate();
  }

  /** Instant passé à la minute, `hours` heures avant l'instant de référence. */
  private hoursAgo(hours: number): Date {
    return new Date(Math.floor((this.origin.getTime() - hours * 3_600_000) / 60_000) * 60_000);
  }

  /** Date civile locale (AAAA-MM-JJ) décalée de `offsetDays` jours. */
  private day(offsetDays: number): string {
    return DateTime.fromJSDate(this.origin, { zone: this.timezone }).plus({ days: offsetDays }).toISODate() as string;
  }

  private async reading(ctx: RequestContext, v: DemoVehicle, km: number, observedAt: Date, expected: 'ACCEPTE' | 'EN_ATTENTE' = 'ACCEPTE', note?: string): Promise<ReadingViewDto> {
    const result = await this.step(`relevé ${v.code} ${km} km`, () => this.asOf(observedAt, () => this.s.odometer.create(ctx, v.id, { physicalKm: String(km), observedAt: observedAt.toISOString(), ...(note ? { note } : {}) }, randomUUID())));
    if (result.outcome !== expected) {
      throw new DemoSeedStepError(`relevé ${v.code} ${km} km`, new Error(`statut ${result.outcome} au lieu de ${expected}${result.anomaly ? ` (${result.anomaly.reason})` : ''}`));
    }
    return result.reading;
  }

  /** Plan créé maintenant, ou à `createdAt` quand des étapes datées postérieures en changent l'échéance. */
  private async plan(ctx: RequestContext, v: DemoVehicle, typeCode: string, dto: Omit<CreatePlanDto, 'vehicleId' | 'maintenanceTypeId'>, createdAt?: Date): Promise<string> {
    const create = () => this.s.plans.create(ctx, { ...dto, vehicleId: v.id, maintenanceTypeId: this.maintenanceType(typeCode), responsibleUserId: ctx.userId });
    const created = await this.step(`plan ${typeCode} ${v.code}`, () => (createdAt ? this.asOf(createdAt, create) : create()));
    return created.id;
  }

  private checklist(): Array<{ label: string; present: boolean }> {
    return this.checklistLabels.map((label) => ({ label, present: true }));
  }

  private async checkout(ctx: RequestContext, v: DemoVehicle, driver: DemoDriver, checkedOutAt: Date, expectedReturnAt: Date, km: number, purpose: string): Promise<UsageViewDto> {
    return this.step(`remise ${v.code}`, () =>
      this.asOf(checkedOutAt, () => this.s.usages.checkout(ctx, {
        vehicleId: v.id,
        driverId: driver.id,
        checkedOutAt: checkedOutAt.toISOString(),
        expectedReturnAt: expectedReturnAt.toISOString(),
        purpose,
        reading: { physicalKm: String(km) },
        location: { siteId: this.siteIds[v.company] },
        fuelGauge: 'TROIS_QUARTS',
        checklist: this.checklist(),
        confirmedByName: `${DRIVERS[driver.key].firstName} ${DRIVERS[driver.key].lastName}`,
      }, randomUUID())),
    );
  }

  private async giveBack(ctx: RequestContext, usage: UsageViewDto, returnedAt: Date, km: number): Promise<void> {
    const v = Object.values(this.vehicles).find((x) => x.id === usage.vehicleId) as DemoVehicle;
    await this.step(`restitution ${v.code}`, () =>
      this.asOf(returnedAt, () => this.s.usages.return(ctx, usage.id, {
        returnedAt: returnedAt.toISOString(),
        reading: { physicalKm: String(km) },
        location: { siteId: this.siteIds[v.company] },
        fuelGauge: 'DEMI',
        checklist: this.checklist(),
        expectedVersion: usage.version,
      }, randomUUID())),
    );
  }

  private async driverFuel(ctx: RequestContext, v: DemoVehicle, entry: { filledAt: Date; liters: string; unitPrice: string; totalAmount: string; isFullTank: boolean; notes: string }) {
    const ticket = await this.step(`ticket de carburant ${v.code}`, () =>
      this.s.attachments.upload(ctx, demoPdf('ticket-carburant.pdf', ['Ticket de carburant (fictif)', `Véhicule ${v.code}`, `${entry.liters} L — ${entry.totalAmount} TND`, 'Document du jeu de démonstration']), v.companyId),
    );
    return this.step(`plein soumis ${v.code}`, () =>
      this.s.fuel.create(ctx, { vehicleId: v.id, filledAt: entry.filledAt.toISOString(), liters: entry.liters, unitPrice: entry.unitPrice, totalAmount: entry.totalAmount, isFullTank: entry.isFullTank, ticketAttachmentId: ticket.id, notes: entry.notes }, randomUUID()),
    );
  }

  private async staffFuel(ctx: RequestContext, v: DemoVehicle, driver: DemoDriver, filledAt: Date, liters: string, totalAmount: string, odometerKm: string): Promise<void> {
    const entry = await this.step(`plein ${v.code}`, () =>
      this.asOf(filledAt, () => this.s.fuel.create(ctx, { vehicleId: v.id, filledAt: filledAt.toISOString(), driverId: driver.id, supplierId: this.stations[v.company], liters, unitPrice: FUEL_PRICE[VEHICLES[v.key].energy], totalAmount, isFullTank: true, odometerKm }, randomUUID())),
    );
    if (entry.status !== 'VALIDE') throw new DemoSeedStepError(`plein ${v.code}`, new Error(`statut ${entry.status} inattendu`));
  }

  private async expense(ctx: RequestContext, dto: { vehicleId?: string; companyId?: string; occurredOn: string; category: 'STATIONNEMENT' | 'PEAGE' | 'ASSURANCE'; amount: string; reference: string; notes: string }): Promise<void> {
    await this.step(`dépense ${dto.reference}`, () => this.s.expenses.create(ctx, dto, randomUUID()));
  }
}

// ---------------------------------------------------------------------------------------------
// Justificatifs fictifs et rapport
// ---------------------------------------------------------------------------------------------

/** PDF texte minimal (sans contenu actif) généré pour les justificatifs fictifs du jeu. */
export function demoPdf(fileName: string, lines: readonly string[]): { originalname: string; buffer: Buffer; size: number } {
  const escape = (text: string) => text.replace(/[’‘]/g, "'").replace(/[–—]/g, '-').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = ['BT', '/F1 13 Tf', '56 780 Td', ...lines.flatMap((line, i) => [...(i > 0 ? ['0 -22 Td'] : []), `(${escape(line)}) Tj`]), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const buffer = Buffer.from(body, 'latin1');
  return { originalname: fileName, buffer, size: buffer.length };
}

export function formatReport(report: DemoSeedReport, password: DemoPassword): string {
  const lines = [
    '',
    `Jeu de démonstration chargé${report.reset ? ' (base vidée au préalable)' : ''} — organisation ${report.organization.code} « ${report.organization.name} ».`,
    `Sociétés : ${report.companies.map((c) => `${c.code} (${c.legalName})`).join(', ')}.`,
    `Véhicules : ${report.vehicles} · conducteurs : ${report.drivers} · utilisations en cours : ${report.openUsages} · relevés en attente : ${report.pendingReadings}.`,
    `Alertes actives : ${report.activeAlerts.map((a) => `${a.type} ${a.count}`).join(', ') || 'aucune'}.`,
    '',
    'Comptes (même mot de passe pour tous) :',
    ...report.accounts.map((a) => `  ${a.email.padEnd(40)} ${ROLE_LABELS[a.role]}${a.companyCode ? ` — ${a.companyCode}` : ''} (${a.name})`),
    '',
    password.generated
      ? `Mot de passe généré (affiché une seule fois, il n’est enregistré nulle part en clair) : ${password.value}`
      : 'Mot de passe : celui fourni dans DEMO_PASSWORD.',
    'Données fictives : ne jamais charger ce jeu en production.',
    '',
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const io: CliIo = { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) };
  process.exitCode = await runSeedDemoCli(process.argv.slice(2), process.env, io);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`Jeu de démonstration interrompu : ${describeErrorSafely(error)}\n`);
    process.exitCode = 1;
  });
}
