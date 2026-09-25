import { Injectable } from '@nestjs/common';
import type { Prisma, VehicleLifecycle } from '@parc-auto/db';
import { FRESHNESS_LABELS, MEASUREMENT_KIND_LABELS, READING_SOURCE_LABELS, VEHICLE_LIFECYCLE_LABELS, VEHICLE_OPERATIONAL_STATUS_LABELS, type VehicleOperationalStatus } from '@parc-auto/contracts';
import { computeFreshness } from '../../../domain/freshness.js';
import { normalizeRegistration } from '../../../domain/registration.js';
import { currentAssignmentWhere } from '../../../domain/responsible-assignment.js';
import { operationalStatus } from '../../../domain/vehicle-status.js';
import { PrismaService } from '../../../infra/prisma.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { operationalStatusWhere } from '../../vehicles/vehicle-conditions.js';
import { decOrNull, isEstimateReading, personName } from '../report-support.js';
import { type ReportColumn, type ReportProvider, type ReportResult, type ReportRow, type ReportRun, type ReportViewDefinition, type ReportWindow, scopeWhere } from '../report-types.js';

interface CurrentReading {
  vehicleId: string;
  physicalKm: Prisma.Decimal | null;
  cumulativeKm: Prisma.Decimal | null;
  isEstimate: boolean;
  measurementKind: 'COMPTEUR_AFFICHE' | 'COMPTEUR_CAN' | 'DISTANCE_GPS';
  source: 'MANUAL' | 'IMPORT' | 'TELEMATICS';
  observedAt: Date;
}

const DEFAULT_LIFECYCLES: VehicleLifecycle[] = ['ACTIF', 'HORS_SERVICE'];

/**
 * Inventaire du parc (CDC 11.2) : dossier, société, site, cycle de vie, état opérationnel (partition de
 * vehicle-status.ts), compteur courant (dernier relevé accepté par date d'observation) avec sa source,
 * sa nature et sa fraîcheur (freshness.ts), responsable habituel et utilisateur actuel.
 */
@Injectable()
export class InventoryReportService implements ReportProvider {
  readonly code = 'inventaire' as const;
  readonly label = 'Inventaire du parc';
  readonly description = 'Véhicules, état opérationnel, compteur courant et fraîcheur, responsable habituel.';
  readonly costsRequired = false;
  readonly views: readonly ReportViewDefinition[] = [
    { code: 'vehicules', label: 'Véhicules', period: false, filters: ['companyId', 'siteId', 'categoryId', 'vehicleId', 'lifecycleStatus', 'operationalStatus', 'q'] },
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  columns(): ReportColumn[] {
    return [
      { key: 'code', label: 'Code', unit: null, kind: 'text' },
      { key: 'registration', label: 'Immatriculation', unit: null, kind: 'text' },
      { key: 'make', label: 'Marque', unit: null, kind: 'text' },
      { key: 'model', label: 'Modèle', unit: null, kind: 'text' },
      { key: 'category', label: 'Catégorie', unit: null, kind: 'text' },
      { key: 'company', label: 'Société', unit: null, kind: 'text' },
      { key: 'site', label: 'Site', unit: null, kind: 'text' },
      { key: 'lifecycleStatus', label: 'Cycle de vie', unit: null, kind: 'enum', labels: VEHICLE_LIFECYCLE_LABELS },
      { key: 'operationalStatus', label: 'État opérationnel', unit: null, kind: 'enum', labels: VEHICLE_OPERATIONAL_STATUS_LABELS, missing: 'Sans objet (véhicule non actif)' },
      { key: 'currentKm', label: 'Kilométrage cumulé', unit: 'km', kind: 'decimal', decimals: 0, missing: 'Inconnu' },
      { key: 'physicalKm', label: 'Compteur affiché', unit: 'km', kind: 'decimal', decimals: 0 },
      { key: 'odometerSource', label: 'Source du relevé', unit: null, kind: 'enum', labels: READING_SOURCE_LABELS },
      { key: 'odometerNature', label: 'Nature de la mesure', unit: null, kind: 'enum', labels: MEASUREMENT_KIND_LABELS, estimates: ['DISTANCE_GPS'] },
      { key: 'odometerObservedAt', label: 'Relevé observé le', unit: null, kind: 'datetime' },
      { key: 'freshness', label: 'Fraîcheur du kilométrage', unit: null, kind: 'enum', labels: FRESHNESS_LABELS },
      { key: 'freshnessAgeDays', label: 'Âge du dernier relevé', unit: 'jours', kind: 'integer' },
      { key: 'cumulativeKnown', label: 'Cumul complet', unit: null, kind: 'boolean' },
      { key: 'responsible', label: 'Responsable habituel', unit: null, kind: 'text' },
      { key: 'currentDriver', label: 'Utilisateur actuel', unit: null, kind: 'text' },
    ];
  }

  notes(): string[] {
    return [
      'État opérationnel des véhicules actifs : immobilisé, en utilisation ou disponible (groupes exclusifs) ; les véhicules hors service, cédés ou archivés n’en ont pas.',
      'Compteur courant : dernier relevé accepté selon la date d’observation ; une distance GPS est une estimation.',
      'Sans filtre de cycle de vie : véhicules actifs et hors service (les véhicules cédés ou archivés s’obtiennent par ce filtre).',
    ];
  }

  async fetch(run: ReportRun, window: ReportWindow): Promise<ReportResult> {
    const f = run.filters;
    const q = f.q?.trim();
    const registration = q ? normalizeRegistration(q) : '';
    const where: Prisma.VehicleWhereInput = {
      ...scopeWhere(run.scope),
      lifecycleStatus: f.lifecycleStatus ? (f.lifecycleStatus as VehicleLifecycle) : { in: DEFAULT_LIFECYCLES },
      ...(f.categoryId ? { categoryId: f.categoryId } : {}),
      ...(f.siteId ? { siteId: f.siteId } : {}),
      ...(f.vehicleId ? { id: f.vehicleId } : {}),
      ...(q
        ? {
            OR: [
              { code: { contains: q, mode: 'insensitive' } },
              ...(registration ? [{ registrationNormalized: { contains: registration } }] : []),
              { make: { contains: q, mode: 'insensitive' } },
              { model: { contains: q, mode: 'insensitive' } },
              { vin: { contains: q.toUpperCase() } },
            ],
          }
        : {}),
    };
    // Statut opérationnel filtré et page découpée en base (même partition que operationalStatus()).
    const paged: Prisma.VehicleWhereInput = f.operationalStatus ? { AND: [where, operationalStatusWhere(f.operationalStatus as VehicleOperationalStatus)] } : where;
    const [vehicles, total] = await Promise.all([
      this.prisma.client.vehicle.findMany({
        where: paged,
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
        skip: window.skip,
        take: window.take,
        select: {
          id: true,
          companyId: true,
          code: true,
          registration: true,
          make: true,
          model: true,
          lifecycleStatus: true,
          category: { select: { label: true } },
          company: { select: { code: true } },
          site: { select: { name: true } },
          usages: { where: { status: 'EN_COURS' }, select: { driver: { select: { firstName: true, lastName: true } } } },
          immobilizations: { where: { status: 'ACTIVE' }, select: { id: true } },
        },
      }),
      this.prisma.client.vehicle.count({ where: paged }),
    ]);
    const page = vehicles.map((v) => ({ v, status: operationalStatus({ lifecycle: v.lifecycleStatus, hasActiveImmobilization: v.immobilizations.length > 0, hasOpenUsage: v.usages.length > 0 }) }));
    const ids = page.map((x) => x.v.id);
    const [readings, segments, assignments] = ids.length
      ? await Promise.all([
          this.prisma.client.$queryRaw<CurrentReading[]>`
            SELECT DISTINCT ON ("vehicleId") "vehicleId", "physicalKm", "cumulativeKm", "isEstimate", "measurementKind"::text AS "measurementKind", "source"::text AS "source", "observedAt"
            FROM "OdometerReading"
            WHERE "vehicleId" = ANY(${ids}::uuid[]) AND "status" = 'ACCEPTE'
            ORDER BY "vehicleId", "observedAt" DESC, "enteredAt" DESC`,
          this.prisma.client.odometerSegment.findMany({ where: { vehicleId: { in: ids }, endedAt: null }, select: { vehicleId: true, cumulativeKnown: true } }),
          this.prisma.client.vehicleResponsibleAssignment.findMany({
            where: { vehicleId: { in: ids }, ...currentAssignmentWhere(run.now) },
            orderBy: { startsAt: 'desc' },
            select: { vehicleId: true, driver: { select: { firstName: true, lastName: true } } },
          }),
        ])
      : [[], [], []];
    const staleDays = new Map<string, number>();
    for (const companyId of new Set(page.map((x) => x.v.companyId))) staleDays.set(companyId, await this.settings.get(run.scope.organizationId, 'odometer.staleAfterDays', companyId));

    const rows: ReportRow[] = page.map(({ v, status }) => {
      const reading = readings.find((r) => r.vehicleId === v.id) ?? null;
      const freshness = computeFreshness(reading?.observedAt ?? null, run.now, staleDays.get(v.companyId) ?? 0);
      const segment = segments.find((s) => s.vehicleId === v.id);
      const responsible = assignments.find((a) => a.vehicleId === v.id);
      return {
        id: v.id,
        companyId: v.companyId,
        values: {
          code: v.code,
          registration: v.registration,
          make: v.make,
          model: v.model,
          category: v.category.label,
          company: v.company.code,
          site: v.site?.name ?? null,
          lifecycleStatus: v.lifecycleStatus,
          operationalStatus: status,
          currentKm: decOrNull(reading?.cumulativeKm),
          physicalKm: decOrNull(reading?.physicalKm),
          odometerSource: reading?.source ?? null,
          odometerNature: reading ? (isEstimateReading(reading) ? 'DISTANCE_GPS' : reading.measurementKind) : null,
          odometerObservedAt: reading?.observedAt ?? null,
          freshness: freshness.status,
          freshnessAgeDays: freshness.ageDays,
          cumulativeKnown: segment ? segment.cumulativeKnown : null,
          responsible: personName(responsible?.driver),
          currentDriver: personName(v.usages[0]?.driver),
        },
      };
    });
    return { rows, total };
  }
}
