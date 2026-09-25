import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { type EnergyType, Prisma } from '@parc-auto/db';
import { ENERGY_LABELS } from '@parc-auto/contracts';
import { CONSUMPTION_NATURE, CONSUMPTION_UNIT } from '../../../domain/consumption.js';
import { PrismaService } from '../../../infra/prisma.service.js';
import type { ConsumptionViewDto } from '../../fuel/dto/consumption.dto.js';
import { FuelService } from '../../fuel/fuel.service.js';
import { NOT_AVAILABLE, dec, decOrNull, instantRange, personName, vehicleRelation } from '../report-support.js';
import { TEXT_ORDER, and, enumEq, scopeSql, uuidEq, vehicleRelationSql, windowSql } from '../report-sql.js';
import { type ReportColumn, type ReportProvider, type ReportResult, type ReportRow, type ReportRun, type ReportViewDefinition, type ReportWindow, scopeWhere } from '../report-types.js';

const entrySelect = {
  id: true,
  companyId: true,
  vehicleId: true,
  filledAt: true,
  liters: true,
  unitPrice: true,
  totalAmount: true,
  energy: true,
  isFullTank: true,
  declaredPhysicalKm: true,
  amountMismatch: true,
  vehicle: { select: { code: true, registration: true } },
  driver: { select: { firstName: true, lastName: true } },
  supplier: { select: { name: true } },
} satisfies Prisma.FuelEntrySelect;

type EntryRow = Prisma.FuelEntryGetPayload<{ select: typeof entrySelect }>;

/** Consommation d'un véhicule sur la période, ou le motif pour lequel elle n'est pas consultable. */
type VehicleConsumption = { view: ConsumptionViewDto } | { unavailable: string };

/**
 * Carburant (CDC 11.2, 8.2, 8.3) : pleins VALIDE de la période (litres, montants avec costs.read, plein
 * complet) et consommation L/100 km de l'intervalle qui se termine sur chaque plein complet, calculée par
 * le service carburant (consumption.ts) — N/D avec motif quand elle n'est pas calculable. Vue « véhicules » :
 * volumes et montants de la période, consommation de la période par énergie.
 */
@Injectable()
export class FuelReportService implements ReportProvider {
  readonly code = 'carburant' as const;
  readonly label = 'Carburant';
  readonly description = 'Pleins validés de la période, montants (costs.read) et consommation estimée L/100 km, par plein ou par véhicule.';
  readonly costsRequired = false;
  readonly views: readonly ReportViewDefinition[] = [
    { code: 'pleins', label: 'Pleins', period: true, filters: ['companyId', 'siteId', 'vehicleId', 'driverId', 'categoryId', 'supplierId', 'energy', 'from', 'to'] },
    { code: 'vehicules', label: 'Par véhicule', period: true, filters: ['companyId', 'siteId', 'vehicleId', 'categoryId', 'supplierId', 'energy', 'from', 'to'] },
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly fuel: FuelService,
  ) {}

  columns(view: string): ReportColumn[] {
    if (view === 'vehicules') {
      return [
        { key: 'vehicle', label: 'Véhicule', unit: null, kind: 'text' },
        { key: 'registration', label: 'Immatriculation', unit: null, kind: 'text' },
        { key: 'company', label: 'Société', unit: null, kind: 'text' },
        { key: 'energy', label: 'Carburant', unit: null, kind: 'enum', labels: ENERGY_LABELS },
        { key: 'entries', label: 'Pleins validés', unit: null, kind: 'integer' },
        { key: 'liters', label: 'Litres', unit: 'L', kind: 'decimal', decimals: 3 },
        { key: 'totalAmount', label: 'Montant TTC', unit: null, kind: 'money', cost: true },
        { key: 'consumption', label: 'Consommation estimée', unit: CONSUMPTION_UNIT, kind: 'decimal', decimals: 1, exportDecimals: 2, missing: NOT_AVAILABLE },
        { key: 'consumptionNote', label: 'Motif N/D', unit: null, kind: 'text' },
      ];
    }
    return [
      { key: 'filledAt', label: 'Date du plein', unit: null, kind: 'datetime' },
      { key: 'vehicle', label: 'Véhicule', unit: null, kind: 'text' },
      { key: 'registration', label: 'Immatriculation', unit: null, kind: 'text' },
      { key: 'company', label: 'Société', unit: null, kind: 'text' },
      { key: 'driver', label: 'Conducteur', unit: null, kind: 'text' },
      { key: 'supplier', label: 'Station', unit: null, kind: 'text' },
      { key: 'energy', label: 'Carburant', unit: null, kind: 'enum', labels: ENERGY_LABELS },
      { key: 'liters', label: 'Litres', unit: 'L', kind: 'decimal', decimals: 3 },
      { key: 'fullTank', label: 'Plein complet', unit: null, kind: 'boolean' },
      { key: 'declaredKm', label: 'Compteur saisi', unit: 'km', kind: 'decimal', decimals: 0 },
      { key: 'unitPrice', label: 'Prix unitaire', unit: null, kind: 'money', perUnit: 'L', cost: true },
      { key: 'totalAmount', label: 'Montant TTC', unit: null, kind: 'money', cost: true },
      { key: 'amountMismatch', label: 'Écart litres × prix signalé', unit: null, kind: 'boolean', cost: true },
      { key: 'consumption', label: 'Consommation estimée', unit: CONSUMPTION_UNIT, kind: 'decimal', decimals: 1, exportDecimals: 2, missing: NOT_AVAILABLE },
      { key: 'consumptionNote', label: 'Motif N/D', unit: null, kind: 'text' },
    ];
  }

  notes(view: string): string[] {
    return [
      CONSUMPTION_NATURE,
      view === 'vehicules'
        ? 'Consommation de la période : litres et kilomètres des seuls intervalles retenus entre pleins complets dont le second tombe dans la période ; jamais additionnée entre carburants.'
        : 'Consommation de l’intervalle qui se termine sur ce plein complet (pleins complets consécutifs de même carburant) ; plein partiel ou intervalle non fiable : N/D avec motif.',
    ];
  }

  async fetch(run: ReportRun, window: ReportWindow): Promise<ReportResult> {
    return run.view === 'vehicules' ? this.byVehicle(run, window) : this.entries(run, window);
  }

  private where(run: ReportRun): Prisma.FuelEntryWhereInput {
    const f = run.filters;
    return {
      ...scopeWhere(run.scope),
      status: 'VALIDE',
      filledAt: instantRange(run.period),
      ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}),
      ...(f.driverId ? { driverId: f.driverId } : {}),
      ...(f.supplierId ? { supplierId: f.supplierId } : {}),
      ...(f.energy ? { energy: f.energy as EnergyType } : {}),
      ...vehicleRelation(f),
    };
  }

  private async entries(run: ReportRun, window: ReportWindow): Promise<ReportResult> {
    const where = this.where(run);
    const [items, total] = await Promise.all([
      this.prisma.client.fuelEntry.findMany({ where, orderBy: [{ filledAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }], skip: window.skip, take: window.take, select: entrySelect }),
      this.prisma.client.fuelEntry.count({ where }),
    ]);
    const consumptions = await this.consumptions(run, [...new Set(items.map((e) => e.vehicleId))]);
    return { total, rows: items.map((e) => this.entryRow(e, consumptions.get(e.vehicleId))) };
  }

  private entryRow(e: EntryRow, consumption: VehicleConsumption | undefined): ReportRow {
    let ratio: Decimal | null = null;
    let note: string | null = null;
    if (!e.isFullTank) note = 'Plein partiel : pas de borne de consommation.';
    else if (!consumption) note = 'Consommation non calculée.';
    else if ('unavailable' in consumption) note = consumption.unavailable;
    else {
      const interval = consumption.view.intervals.find((i) => i.endFuelEntryId === e.id);
      if (!interval) note = 'Aucun intervalle de consommation ne se termine sur ce plein.';
      else if (interval.retained && interval.litersPer100KmExact) ratio = new Decimal(interval.litersPer100KmExact);
      else note = interval.reasons.map((r) => r.label).join(' ') || 'Intervalle non retenu.';
    }
    return {
      id: e.id,
      companyId: e.companyId,
      values: {
        filledAt: e.filledAt,
        vehicle: e.vehicle.code,
        registration: e.vehicle.registration,
        company: null,
        driver: personName(e.driver),
        supplier: e.supplier?.name ?? null,
        energy: e.energy,
        liters: dec(e.liters),
        fullTank: e.isFullTank,
        declaredKm: decOrNull(e.declaredPhysicalKm),
        unitPrice: decOrNull(e.unitPrice),
        totalAmount: dec(e.totalAmount),
        amountMismatch: e.amountMismatch,
        consumption: ratio,
        consumptionNote: note,
      },
    };
  }

  /** Même sélection que where(), en SQL (alias f : plein, v : véhicule courant). */
  private whereSql(run: ReportRun): Prisma.Sql {
    const f = run.filters;
    return and([
      scopeSql('f', run.scope),
      Prisma.sql`"f"."status" = 'VALIDE'::"FuelEntryStatus"`,
      run.period ? Prisma.sql`"f"."filledAt" BETWEEN ${run.period.start}::timestamptz AND ${run.period.end}::timestamptz` : null,
      uuidEq('f', 'vehicleId', f.vehicleId),
      uuidEq('f', 'driverId', f.driverId),
      uuidEq('f', 'supplierId', f.supplierId),
      enumEq('f', 'energy', 'EnergyType', f.energy),
      ...vehicleRelationSql('v', f),
    ]);
  }

  /**
   * Volumes par véhicule, société et carburant : groupes, ordre (code du véhicule, carburant, société) et
   * page calculés par PostgreSQL ; consommation des seuls véhicules de la page.
   */
  private async byVehicle(run: ReportRun, window: ReportWindow): Promise<ReportResult> {
    const filtered = Prisma.sql`FROM "FuelEntry" "f" JOIN "Vehicle" "v" ON "v"."id" = "f"."vehicleId" WHERE ${this.whereSql(run)}`;
    const groupBy = Prisma.sql`"f"."companyId", "f"."vehicleId", "f"."energy", "v"."code", "v"."registration"`;
    const [page, counted] = await Promise.all([
      this.prisma.client.$queryRaw<Array<{ companyId: string; vehicleId: string; energy: EnergyType; vehicle: string; registration: string; entries: number; liters: string; amount: string }>>`
        SELECT "f"."companyId", "f"."vehicleId", "f"."energy"::text AS "energy", "v"."code" AS "vehicle", "v"."registration", COUNT(*)::int AS "entries", SUM("f"."liters")::text AS "liters", SUM("f"."totalAmount")::text AS "amount"
        ${filtered} GROUP BY ${groupBy}
        ORDER BY "v"."code" ${TEXT_ORDER}, "f"."energy"::text ${TEXT_ORDER}, "f"."companyId" ${windowSql(window)}`,
      this.prisma.client.$queryRaw<Array<{ total: number }>>`SELECT COUNT(*)::int AS "total" FROM (SELECT 1 ${filtered} GROUP BY ${groupBy}) "g"`,
    ]);
    const consumptions = await this.consumptions(run, [...new Set(page.map((g) => g.vehicleId))]);
    return {
      total: counted[0]?.total ?? 0,
      rows: page.map((g) => {
        const c = consumptions.get(g.vehicleId);
        const total = c && 'view' in c ? c.view.totals.find((t) => t.energy === g.energy) : undefined;
        const note = !c ? 'Consommation non calculée.' : 'unavailable' in c ? c.unavailable : !total ? 'Historique insuffisant : aucun couple de pleins complets dans la période.' : total.available ? null : total.reasons.map((r) => r.label).join(' ');
        return {
          id: `${g.companyId}:${g.vehicleId}:${g.energy}`,
          companyId: g.companyId,
          values: {
            vehicle: g.vehicle,
            registration: g.registration,
            company: null,
            energy: g.energy,
            entries: g.entries,
            liters: new Decimal(g.liters),
            totalAmount: new Decimal(g.amount),
            consumption: total?.available && total.litersPer100KmExact ? new Decimal(total.litersPer100KmExact) : null,
            consumptionNote: note,
          },
        };
      }),
    };
  }

  /**
   * Consommations des véhicules de la page par le service carburant (périmètre et règle unique du module 8.3,
   * FuelService.consumptionMany) : lectures groupées pour tous les véhicules de la page (la page reste bornée,
   * 25 véhicules au plus par défaut). Véhicule sorti du périmètre courant : consommation non calculable.
   */
  private async consumptions(run: ReportRun, vehicleIds: string[]): Promise<Map<string, VehicleConsumption>> {
    const out = new Map<string, VehicleConsumption>();
    const period = run.period ? { from: run.period.from, to: run.period.to } : {};
    const views = await this.fuel.consumptionMany(run.ctx, vehicleIds, period);
    for (const vehicleId of vehicleIds) {
      const view = views.get(vehicleId);
      out.set(vehicleId, view ? { view } : { unavailable: 'Consommation non calculable : le véhicule n’est plus dans votre périmètre courant.' });
    }
    return out;
  }
}
