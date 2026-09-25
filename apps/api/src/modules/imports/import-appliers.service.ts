import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Decimal } from 'decimal.js';
import type { ImportKind } from '@parc-auto/db';
import { AfterCommit } from '../../common/after-commit.js';
import { AppError } from '../../common/errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { flatten } from '../../common/validation.js';
import { type Tx, isUniqueViolation } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { MANAGER_ROLES } from '../access-control/permissions.js';
import { CreateDriverDto } from '../drivers/dto/drivers.dto.js';
import { DriversService } from '../drivers/drivers.service.js';
import { CreatePlanDto } from '../maintenance/dto/maintenance.dto.js';
import { MaintenancePlansService } from '../maintenance/maintenance-plans.service.js';
import { OdometerIngestionService } from '../odometer/odometer-ingestion.service.js';
import { OdometerService } from '../odometer/odometer.service.js';
import { CreateVehicleDto } from '../vehicles/dto/vehicles.dto.js';
import { VehiclesService } from '../vehicles/vehicles.service.js';
import { IMPORT_COLUMNS } from './import-columns.js';
import { type Cell, cellText, isEmpty, parseBoolean, parseCivilDate, parseDecimal, parseIntegerKm, parseTimestamp } from './parsers/values.js';

export interface RowMessage {
  column: string | null;
  message: string;
}

/** Erreurs de contrôle d'une ligne, par colonne (rapport ligne/colonne/message, 12.1). */
export class RowError extends Error {
  constructor(readonly messages: RowMessage[]) {
    super(messages.map((m) => m.message).join(' '));
  }
}

export interface RowOutcome {
  status: 'VALIDE' | 'IGNOREE';
  companyId: string | null;
  createdObjectId: string | null;
  notes: string[];
}

export type RowValues = Record<string, Cell>;

/** État d'une exécution de lot (contrôle ou confirmation) : référentiels chargés une fois, doublons du fichier. */
export interface ImportRunState {
  ctx: RequestContext;
  kind: ImportKind;
  batchId: string;
  timezone: string;
  after: AfterCommit;
  companies: Map<string, { id: string; code: string; status: string }>;
  categories: Map<string, string>;
  maintenanceTypes: Map<string, string>;
  sites: Map<string, Array<{ id: string; name: string }>>;
  /** Clé métier → numéro de ligne où elle apparaît pour la première fois (doublons de fichier). */
  seen: Map<string, number>;
}

/** Correspondance propriété du DTO métier → colonne du fichier, pour citer la bonne colonne. */
const VEHICLE_FIELDS: Record<string, string> = { companyId: 'company_code', code: 'vehicle_code', registration: 'registration', make: 'make', model: 'model', categoryId: 'category', vin: 'vin', year: 'year', commissioningDate: 'commissioning_date', energy: 'energy', tankCapacityLiters: 'tank_capacity_liters', siteId: 'site' };
const DRIVER_FIELDS: Record<string, string> = { companyId: 'company_code', code: 'driver_code', firstName: 'first_name', lastName: 'last_name', phone: 'phone', email: 'email', siteId: 'site' };
const READING_FIELDS: Record<string, string> = { physicalKm: 'physical_km', observedAt: 'observed_at' };
const PLAN_FIELDS: Record<string, string> = {
  vehicleId: 'vehicle_code',
  maintenanceTypeId: 'maintenance_type',
  intervalKm: 'interval_km',
  intervalMonths: 'interval_months',
  intervalDays: 'interval_days',
  noticeKm: 'notice_km',
  noticeDays: 'notice_days',
  base: 'base_mode',
  'base.baseMode': 'base_mode',
  'base.baseKm': 'base_km',
  'base.baseDate': 'base_date',
  'base.nextDueKm': 'next_due_km',
  'base.nextDueDate': 'next_due_date',
};
const FIELDS: Record<ImportKind, Record<string, string>> = { VEHICULES: VEHICLE_FIELDS, CONDUCTEURS: DRIVER_FIELDS, RELEVES: READING_FIELDS, BASES_ENTRETIEN: PLAN_FIELDS };
/** Colonne citée quand l'erreur métier ne désigne pas de champ. */
const DEFAULT_COLUMN: Record<string, string> = {
  CODE_VEHICULE_EXISTANT: 'vehicle_code',
  IMMATRICULATION_EXISTANTE: 'registration',
  VIN_EXISTANT: 'vin',
  CODE_CONDUCTEUR_EXISTANT: 'driver_code',
  PLAN_EXISTANT: 'maintenance_type',
  COMPTEUR_DEJA_INITIALISE: 'meter_reference',
  COMPTEUR_NON_INITIALISE: 'meter_reference',
  INITIALISATION_REFUSEE: 'physical_km',
};

const BASE_MODES = ['DERNIERE_OPERATION', 'BASE_TECHNIQUE', 'ECHEANCE_INITIALE', 'AUCUNE'] as const;
const EXISTING_NOTE = ' L’import crée de nouveaux dossiers et ne modifie jamais une fiche existante.';

/**
 * Application d'une ligne d'import (CDC 12.1, 12.2, D-277 à D-280). Chaque ligne passe par les mêmes
 * services métier que la saisie à l'écran (création de véhicule et de conducteur, ingestion unique des
 * relevés, création de plan) : une seule implémentation par règle. Appelée dans une transaction ; le
 * contrôle exécute exactement ce code dans une transaction annulée.
 */
@Injectable()
export class ImportAppliersService {
  constructor(
    private readonly access: AccessControlService,
    private readonly vehicles: VehiclesService,
    private readonly drivers: DriversService,
    private readonly odometer: OdometerService,
    private readonly ingestion: OdometerIngestionService,
    private readonly plans: MaintenancePlansService,
  ) {}

  async newState(tx: Tx, ctx: RequestContext, kind: ImportKind, batchId: string, timezone: string, after: AfterCommit): Promise<ImportRunState> {
    const [companies, categories, types] = await Promise.all([
      tx.company.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true, code: true, status: true } }),
      tx.vehicleCategory.findMany({ where: { organizationId: ctx.organizationId, status: 'ACTIF' }, select: { id: true, code: true } }),
      tx.maintenanceType.findMany({ where: { organizationId: ctx.organizationId, status: 'ACTIF' }, select: { id: true, code: true } }),
    ]);
    return {
      ctx,
      kind,
      batchId,
      timezone,
      after,
      companies: new Map(companies.map((c) => [c.code.toUpperCase(), c])),
      categories: new Map(categories.map((c) => [c.code.toUpperCase(), c.id])),
      maintenanceTypes: new Map(types.map((t) => [t.code.toUpperCase(), t.id])),
      sites: new Map(),
      seen: new Map(),
    };
  }

  apply(tx: Tx, state: ImportRunState, values: RowValues, line: number): Promise<RowOutcome> {
    switch (state.kind) {
      case 'VEHICULES':
        return this.vehicle(tx, state, values, line);
      case 'CONDUCTEURS':
        return this.driver(tx, state, values, line);
      case 'RELEVES':
        return this.reading(tx, state, values, line);
      case 'BASES_ENTRETIEN':
        return this.maintenanceBase(tx, state, values, line);
    }
  }

  /**
   * Traduit l'échec d'une ligne en messages ligne/colonne. Les erreurs métier et les violations
   * d'unicité deviennent des erreurs de ligne ; toute autre erreur (panne, conflit de sérialisation)
   * est relancée et fait échouer le lot entier.
   */
  describe(kind: ImportKind, error: unknown): RowMessage[] {
    if (error instanceof RowError) return error.messages;
    let failure: unknown = error;
    if (isUniqueViolation(error)) failure = kind === 'CONDUCTEURS' ? this.drivers.mapUnique(error) : this.vehicles.mapUnique(error);
    if (failure instanceof AppError) {
      const fields = FIELDS[kind];
      const keys = Object.keys(failure.fieldErrors ?? {});
      const column = keys.map((k) => fields[k]).find((c): c is string => c !== undefined) ?? DEFAULT_COLUMN[failure.code] ?? null;
      const existing = failure.code.endsWith('_EXISTANT') || failure.code.endsWith('_EXISTANTE');
      return [{ column, message: existing ? `${failure.message}${EXISTING_NOTE}` : failure.message }];
    }
    throw error;
  }

  // ---------------------------------------------------------------------------------------------
  // Véhicules
  // ---------------------------------------------------------------------------------------------

  private async vehicle(tx: Tx, state: ImportRunState, values: RowValues, line: number): Promise<RowOutcome> {
    const errs = this.required(state.kind, values);
    const company = this.company(state, values, errs);
    const categoryCode = text(values, 'category');
    const categoryId = categoryCode ? state.categories.get(categoryCode.toUpperCase()) : undefined;
    if (categoryCode && !categoryId) errs.push({ column: 'category', message: `Catégorie « ${categoryCode} » inconnue ou archivée.` });
    const siteId = company ? await this.site(tx, state, company, values, errs) : undefined;
    const year = optional(values, 'year', errs, (c) => (/^\d{4}$/.test(cellText(c)) ? { ok: true, value: Number(cellText(c)) } : { ok: false, message: `Année sur 4 chiffres attendue : « ${cellText(c)} ».` }));
    const commissioningDate = optional(values, 'commissioning_date', errs, parseCivilDate);
    const tankCapacityLiters = optional(values, 'tank_capacity_liters', errs, parseDecimal);
    this.throwIf(errs);

    const dto = {
      companyId: company?.id,
      code: text(values, 'vehicle_code'),
      registration: text(values, 'registration'),
      make: text(values, 'make'),
      model: text(values, 'model'),
      categoryId,
      ...(text(values, 'vin') ? { vin: text(values, 'vin') } : {}),
      ...(year !== undefined ? { year } : {}),
      ...(commissioningDate !== undefined ? { commissioningDate } : {}),
      ...(text(values, 'energy') ? { energy: text(values, 'energy').toUpperCase() } : {}),
      ...(tankCapacityLiters !== undefined ? { tankCapacityLiters } : {}),
      ...(siteId ? { siteId } : {}),
    };
    const valid = await this.validateDto(CreateVehicleDto, dto, VEHICLE_FIELDS);
    const data = this.vehicles.buildCreateData(state.ctx, valid);
    this.once(state, `vehicule.code:${data.code}`, line, 'vehicle_code', errs);
    this.once(state, `vehicule.immatriculation:${data.registrationNormalized}`, line, 'registration', errs);
    if (data.vin) this.once(state, `vehicule.vin:${data.vin}`, line, 'vin', errs);
    this.throwIf(errs);
    const created = await this.vehicles.insertInTx(tx, state.ctx, data, `import ${state.batchId}, ligne ${line}`);
    return { status: 'VALIDE', companyId: created.companyId, createdObjectId: created.id, notes: [] };
  }

  // ---------------------------------------------------------------------------------------------
  // Conducteurs
  // ---------------------------------------------------------------------------------------------

  private async driver(tx: Tx, state: ImportRunState, values: RowValues, line: number): Promise<RowOutcome> {
    const errs = this.required(state.kind, values);
    const company = this.company(state, values, errs);
    const active = isEmpty(values.active ?? null) ? undefined : parseBoolean(values.active ?? null);
    if (active && !active.ok) errs.push({ column: 'active', message: active.message });
    const siteId = company ? await this.site(tx, state, company, values, errs) : undefined;
    this.throwIf(errs);

    const dto = {
      companyId: company?.id,
      code: text(values, 'driver_code'),
      firstName: text(values, 'first_name'),
      lastName: text(values, 'last_name'),
      ...(text(values, 'phone') ? { phone: text(values, 'phone') } : {}),
      ...(text(values, 'email') ? { email: text(values, 'email') } : {}),
      ...(siteId ? { siteId } : {}),
    };
    const valid = await this.validateDto(CreateDriverDto, dto, DRIVER_FIELDS);
    this.once(state, `conducteur.code:${valid.code}`, line, 'driver_code', errs);
    this.throwIf(errs);
    const isActive = active?.ok ? active.value : true;
    const created = await this.drivers.insertInTx(tx, state.ctx, valid, { active: isActive, reason: `import ${state.batchId}, ligne ${line}` });
    return { status: 'VALIDE', companyId: created.companyId, createdObjectId: created.id, notes: isActive ? [] : ['Conducteur créé inactif.'] };
  }

  // ---------------------------------------------------------------------------------------------
  // Relevés (INITIAL : premier compteur ; COURANT : compteur en service), D-279, D-280
  // ---------------------------------------------------------------------------------------------

  private async reading(tx: Tx, state: ImportRunState, values: RowValues, line: number): Promise<RowOutcome> {
    const errs = this.required(state.kind, values);
    const company = this.company(state, values, errs);
    const vehicle = company ? await this.vehicleOf(tx, state, company, values, errs) : null;
    const notes: string[] = [];
    let observedAt: Date | undefined;
    if (!isEmpty(values.observed_at ?? null)) {
      const parsed = parseTimestamp(values.observed_at ?? null, state.timezone);
      if (parsed.ok) {
        observedAt = parsed.value;
        if (parsed.note) notes.push(`Horodatage : ${parsed.note} (00:00 heure locale).`);
      } else errs.push({ column: 'observed_at', message: parsed.message });
    }
    const physical = optional(values, 'physical_km', errs, parseIntegerKm);
    const reference = text(values, 'meter_reference').toUpperCase();
    if (reference && reference !== 'INITIAL' && reference !== 'COURANT') errs.push({ column: 'meter_reference', message: `Valeur « ${text(values, 'meter_reference')} » non reconnue : INITIAL ou COURANT.` });
    const initialCumulative = optional(values, 'initial_cumulative_km', errs, parseIntegerKm);
    if (initialCumulative !== undefined && reference === 'COURANT') errs.push({ column: 'initial_cumulative_km', message: 'Réservé aux lignes INITIAL (base cumulée d’un compteur déjà remplacé).' });
    this.throwIf(errs);
    if (!vehicle || observedAt === undefined || physical === undefined) throw new RowError([{ column: null, message: 'Ligne incomplète.' }]);

    const note = text(values, 'note') || null;
    if (reference === 'INITIAL') {
      this.once(state, `releve.initial:${vehicle.id}`, line, 'meter_reference', errs);
      this.throwIf(errs);
      // Même compteur initial déjà enregistré (même instant à la minute, même valeur) : ligne idempotente (D-280).
      const minute = Math.floor(observedAt.getTime() / 60_000) * 60_000;
      const same = await tx.odometerReading.findFirst({
        where: { vehicleId: vehicle.id, context: 'INITIALISATION', status: 'ACCEPTE', physicalKm: String(physical), observedAt: { gte: new Date(minute), lt: new Date(minute + 60_000) } },
        select: { companyId: true },
      });
      if (same) return { status: 'IGNOREE', companyId: same.companyId, createdObjectId: null, notes: [...notes, 'Compteur déjà initialisé avec la même valeur au même instant : ligne ignorée.'] };
      const segment = await this.odometer.initialSegmentInTx(
        tx,
        state.ctx,
        vehicle,
        {
          physicalKm: new Decimal(physical),
          startedAt: observedAt,
          cumulativeKm: initialCumulative !== undefined ? new Decimal(initialCumulative) : null,
          cumulativeKnown: true,
          reason: note ?? (initialCumulative !== undefined ? 'Initialisation par import avec base cumulée validée.' : 'Initialisation par import (cumul égal au compteur).'),
          origin: 'IMPORT',
          importBatchId: state.batchId,
        },
        state.after,
      );
      return { status: 'VALIDE', companyId: vehicle.companyId, createdObjectId: segment.id, notes };
    }

    this.once(state, `releve:${vehicle.id}:${Math.floor(observedAt.getTime() / 60_000)}`, line, 'observed_at', errs);
    this.throwIf(errs);
    const result = await this.ingestion.ingest(
      tx,
      {
        organizationId: state.ctx.organizationId,
        vehicleId: vehicle.id,
        origin: 'IMPORT',
        context: 'RELEVE_LIBRE',
        measurementKind: 'COMPTEUR_AFFICHE',
        physicalKm: new Decimal(physical),
        observedAt,
        author: { kind: 'STAFF', userId: state.ctx.userId },
        note,
        importBatchId: state.batchId,
      },
      state.after,
    );
    if (result.outcome === 'IDEMPOTENT') {
      return { status: 'IGNOREE', companyId: result.reading.companyId, createdObjectId: null, notes: [...notes, 'Relevé identique déjà présent (même instant, même valeur) : ligne ignorée.'] };
    }
    if (result.outcome === 'EN_ATTENTE') notes.push(`Relevé importé en attente de validation : ${result.anomaly?.reason ?? 'anomalie à examiner'}`);
    return { status: 'VALIDE', companyId: result.reading.companyId, createdObjectId: result.reading.id, notes };
  }

  // ---------------------------------------------------------------------------------------------
  // Bases d'entretien : création de plan, sans intervention ni dépense (12.1)
  // ---------------------------------------------------------------------------------------------

  private async maintenanceBase(tx: Tx, state: ImportRunState, values: RowValues, line: number): Promise<RowOutcome> {
    const errs = this.required(state.kind, values);
    const company = this.company(state, values, errs);
    const vehicle = company ? await this.vehicleOf(tx, state, company, values, errs) : null;
    const typeCode = text(values, 'maintenance_type');
    const typeId = typeCode ? state.maintenanceTypes.get(typeCode.toUpperCase()) : undefined;
    if (typeCode && !typeId) errs.push({ column: 'maintenance_type', message: `Opération « ${typeCode} » absente du catalogue actif.` });
    const baseMode = text(values, 'base_mode').toUpperCase();
    if (baseMode && !(BASE_MODES as readonly string[]).includes(baseMode)) errs.push({ column: 'base_mode', message: `Mode de base « ${text(values, 'base_mode')} » non reconnu (${BASE_MODES.join(', ')}).` });
    const whole = (c: Cell) => (/^\d+$/.test(cellText(c)) ? { ok: true as const, value: Number(cellText(c)) } : { ok: false as const, message: `Entier positif attendu : « ${cellText(c)} ».` });
    const intervalKm = optional(values, 'interval_km', errs, parseIntegerKm);
    const intervalMonths = optional(values, 'interval_months', errs, whole);
    const intervalDays = optional(values, 'interval_days', errs, whole);
    const noticeKm = optional(values, 'notice_km', errs, parseIntegerKm);
    const noticeDays = optional(values, 'notice_days', errs, whole);
    const baseKm = optional(values, 'base_km', errs, parseIntegerKm);
    const baseDate = optional(values, 'base_date', errs, parseCivilDate);
    const nextDueKm = optional(values, 'next_due_km', errs, parseIntegerKm);
    const nextDueDate = optional(values, 'next_due_date', errs, parseCivilDate);
    this.throwIf(errs);
    if (!vehicle || !typeId) throw new RowError([{ column: null, message: 'Ligne incomplète.' }]);

    const dto = await this.validateDto(
      CreatePlanDto,
      {
        vehicleId: vehicle.id,
        maintenanceTypeId: typeId,
        ...(intervalKm !== undefined ? { intervalKm: String(intervalKm) } : {}),
        ...(intervalMonths !== undefined ? { intervalMonths } : {}),
        ...(intervalDays !== undefined ? { intervalDays } : {}),
        ...(noticeKm !== undefined ? { noticeKm: String(noticeKm) } : {}),
        ...(noticeDays !== undefined ? { noticeDays } : {}),
        base: {
          baseMode,
          ...(baseKm !== undefined ? { baseKm: String(baseKm) } : {}),
          ...(baseDate !== undefined ? { baseDate } : {}),
          ...(nextDueKm !== undefined ? { nextDueKm: String(nextDueKm) } : {}),
          ...(nextDueDate !== undefined ? { nextDueDate } : {}),
        },
      },
      PLAN_FIELDS,
    );
    this.once(state, `plan:${vehicle.id}:${typeId}`, line, 'maintenance_type', errs);
    this.throwIf(errs);
    const { vehicleId: _vehicleId, ...planInput } = dto;
    const planId = await this.plans.createInTx(tx, state.ctx, vehicle, planInput);
    state.after.add('plan importé → alertes d’entretien', () => this.plans.syncAlerts(planId));
    return { status: 'VALIDE', companyId: vehicle.companyId, createdObjectId: planId, notes: [] };
  }

  // ---------------------------------------------------------------------------------------------
  // Contrôles communs
  // ---------------------------------------------------------------------------------------------

  private required(kind: ImportKind, values: RowValues): RowMessage[] {
    return IMPORT_COLUMNS[kind].filter((c) => c.required && isEmpty(values[c.name] ?? null)).map((c) => ({ column: c.name, message: 'Valeur obligatoire.' }));
  }

  /** Société de la ligne : connue, active et dans le périmètre d'import (chef de parc ou administrateur). */
  private company(state: ImportRunState, values: RowValues, errs: RowMessage[]): { id: string; code: string } | null {
    const code = text(values, 'company_code');
    if (!code) return null;
    const company = state.companies.get(code.toUpperCase());
    // Même message pour une société inconnue ou hors périmètre : son existence n'est pas révélée.
    if (!company || !this.access.hasRole(state.ctx, company.id, MANAGER_ROLES)) {
      errs.push({ column: 'company_code', message: `Société « ${code} » inconnue ou hors de votre périmètre d’import.` });
      return null;
    }
    if (company.status !== 'ACTIF') {
      errs.push({ column: 'company_code', message: `Société « ${company.code} » archivée : aucun import possible.` });
      return null;
    }
    return company;
  }

  private async vehicleOf(tx: Tx, state: ImportRunState, company: { id: string; code: string }, values: RowValues, errs: RowMessage[]): Promise<{ id: string; companyId: string } | null> {
    const code = text(values, 'vehicle_code');
    if (!code) return null;
    const vehicle = await tx.vehicle.findFirst({ where: { organizationId: state.ctx.organizationId, code }, select: { id: true, companyId: true } });
    if (!vehicle || vehicle.companyId !== company.id) {
      errs.push({ column: 'vehicle_code', message: `Véhicule « ${code} » introuvable dans la société ${company.code}.` });
      return null;
    }
    return vehicle;
  }

  /** Site désigné par son nom exact (casse ignorée) parmi les sites actifs de la société. */
  private async site(tx: Tx, state: ImportRunState, company: { id: string; code: string }, values: RowValues, errs: RowMessage[]): Promise<string | undefined> {
    const name = text(values, 'site');
    if (!name) return undefined;
    let sites = state.sites.get(company.id);
    if (!sites) {
      sites = await tx.site.findMany({ where: { organizationId: state.ctx.organizationId, companyId: company.id, status: 'ACTIF' }, select: { id: true, name: true } });
      state.sites.set(company.id, sites);
    }
    const matches = sites.filter((s) => s.name.trim().toLowerCase() === name.toLowerCase());
    if (matches.length === 1) return matches[0]?.id;
    errs.push({ column: 'site', message: matches.length === 0 ? `Site « ${name} » inconnu ou archivé dans la société ${company.code}.` : `Plusieurs sites actifs de ${company.code} s’appellent « ${name} » : renommez-les avant l’import.` });
    return undefined;
  }

  /** Doublon dans le fichier : la même clé métier ne peut apparaître qu'une fois par lot. */
  private once(state: ImportRunState, key: string, line: number, column: string, errs: RowMessage[]): void {
    const first = state.seen.get(key);
    if (first !== undefined && first !== line) {
      errs.push({ column, message: `Doublon dans le fichier : même valeur qu’à la ligne ${first}.` });
      return;
    }
    state.seen.set(key, line);
  }

  /** Validation par le DTO de l'écran correspondant : mêmes formats et longueurs qu'à la saisie. */
  private async validateDto<T extends object>(cls: new () => T, plain: object, fields: Record<string, string>): Promise<T> {
    const instance = plainToInstance(cls, plain);
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true, stopAtFirstError: false });
    if (errors.length > 0) {
      const flat = flatten(errors);
      throw new RowError(Object.entries(flat).map(([path, messages]) => ({ column: fields[path] ?? fields[path.split('.')[0] ?? ''] ?? null, message: messages.join(' ') })));
    }
    return instance;
  }

  private throwIf(errs: RowMessage[]): void {
    if (errs.length > 0) throw new RowError(errs);
  }
}

function text(values: RowValues, column: string): string {
  return cellText(values[column] ?? null);
}

/** Colonne facultative : absente → undefined ; présente → valeur analysée ou message d'erreur ajouté. */
function optional<T>(values: RowValues, column: string, errs: RowMessage[], parse: (cell: Cell) => { ok: true; value: T } | { ok: false; message: string }): T | undefined {
  const cell = values[column] ?? null;
  if (isEmpty(cell)) return undefined;
  const parsed = parse(cell);
  if (parsed.ok) return parsed.value;
  errs.push({ column, message: parsed.message });
  return undefined;
}
