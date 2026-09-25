import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { TelemetryCalibration } from '@parc-auto/db';
import { NotFoundOrOutOfScopeError } from '../../common/errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { formatPercent } from '../../domain/telemetry/gps-calibration.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { MappingsQueryDto } from './dto/telemetry.dto.js';
import type { VehicleCalibrationDto, VehicleTelemetryViewDto } from './dto/telemetry-vehicle.dto.js';
import { TelemetryProvidersService } from './telemetry-providers.service.js';
import { kindLabel } from './telemetry-settings.js';
import { TelemetryUnitsService } from './telemetry-units.service.js';

/**
 * État télématique d'un véhicule (CDC 5.6, 14.5 ; D-101, D-112, D-147, D-178, D-190) : association en
 * cours et natures retenues, fournisseur (sans configuration ni secret), dernière observation reçue,
 * dernière estimation « estimé GPS » historisée avec sa référence manuelle et dernier calibrage.
 * Lecture seule, dans le périmètre de lecture de la télématique (404 hors périmètre, 403 conducteur).
 * Aucune valeur n'est calculée ici : tout provient des données enregistrées par la synchronisation et
 * le calibrage (fonctions uniques de domain/telemetry).
 */
@Injectable()
export class TelemetryVehicleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: TelemetryProvidersService,
    private readonly units: TelemetryUnitsService,
  ) {}

  async status(ctx: RequestContext, vehicleId: string): Promise<VehicleTelemetryViewDto> {
    const scope = this.providers.readScope(ctx);
    const vehicle = await this.prisma.client.vehicle.findFirst({
      where: { id: vehicleId, organizationId: ctx.organizationId },
      select: { id: true, code: true, companyId: true, company: { select: { telemetryEnabled: true } } },
    });
    if (!vehicle || (scope && !scope.includes(vehicle.companyId))) throw new NotFoundOrOutOfScopeError('Véhicule');

    const mappingQuery = (status: 'CONFIRME' | 'PROPOSE') => Object.assign(new MappingsQueryDto(), { vehicleId, status, page: 1, pageSize: 1 });
    const [open, proposals, estimate, lastCalibration, lastDrift] = await Promise.all([
      this.units.listMappings(ctx, mappingQuery('CONFIRME')),
      this.units.listMappings(ctx, mappingQuery('PROPOSE')),
      this.prisma.client.odometerReading.findFirst({
        where: { vehicleId, isEstimate: true, status: 'ACCEPTE' },
        orderBy: [{ observedAt: 'desc' }, { enteredAt: 'desc' }],
        select: { id: true, cumulativeKm: true, gpsDistanceKm: true, observedAt: true, note: true, calibration: { select: { referenceAt: true, referenceKm: true } } },
      }),
      this.prisma.client.telemetryCalibration.findFirst({ where: { vehicleId }, orderBy: [{ referenceAt: 'desc' }, { createdAt: 'desc' }] }),
      this.prisma.client.telemetryCalibration.findFirst({ where: { vehicleId, deviationPercent: { not: null } }, orderBy: [{ referenceAt: 'desc' }, { createdAt: 'desc' }] }),
    ]);
    const mapping = open.items[0] ?? null;

    let provider: VehicleTelemetryViewDto['provider'] = null;
    let lastObservation: VehicleTelemetryViewDto['lastObservation'] = null;
    if (mapping) {
      const [row, state, fuel] = await Promise.all([
        this.prisma.client.telemetryProvider.findUniqueOrThrow({
          where: { id: mapping.providerId },
          select: { id: true, name: true, kind: true, status: true, lastSuccessAt: true, consecutiveFailures: true, circuitOpenUntil: true },
        }),
        this.prisma.client.telemetryUnitState.findUnique({ where: { unitId: mapping.unitId } }),
        this.prisma.client.fuelLevelSample.findFirst({ where: { unitId: mapping.unitId, vehicleId }, orderBy: { observedAt: 'desc' }, select: { kind: true, liters: true, percent: true, observedAt: true } }),
      ]);
      provider = {
        id: row.id,
        name: row.name,
        kind: row.kind,
        kindLabel: kindLabel(row.kind),
        isSimulator: row.kind === 'SIMULATEUR',
        status: row.status,
        lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
        consecutiveFailures: row.consecutiveFailures,
        circuitOpenUntil: row.circuitOpenUntil?.toISOString() ?? null,
      };
      // L'état est tenu par unité : un boîtier réutilisé garde les dernières valeurs de son véhicule
      // précédent jusqu'à sa prochaine donnée. Seules les observations de l'association en cours (à
      // partir de sa date d'effet) sont restituées pour ce véhicule.
      const since = mapping.validFrom ? new Date(mapping.validFrom).getTime() : null;
      const current = (at: Date | null | undefined): at is Date => at instanceof Date && (since === null || at.getTime() >= since);
      const odometer = state && current(state.lastOdometerObservedAt) ? state : null;
      const fuelState = state && current(state.lastFuelObservedAt) ? state : null;
      const received = state && current(state.lastReceivedAt) ? state.lastReceivedAt : null;
      if (odometer || fuel || fuelState) {
        lastObservation = {
          odometerKm: odometer?.lastOdometerValueKm?.toFixed(3) ?? null,
          odometerKind: odometer?.lastOdometerKind ?? null,
          odometerObservedAt: odometer?.lastOdometerObservedAt?.toISOString() ?? null,
          fuelKind: fuel?.kind ?? fuelState?.lastFuelKind ?? null,
          fuelLiters: fuel?.liters?.toFixed(3) ?? null,
          fuelPercent: fuel?.percent?.toFixed(3) ?? null,
          fuelObservedAt: fuel?.observedAt.toISOString() ?? fuelState?.lastFuelObservedAt?.toISOString() ?? null,
          receivedAt: received?.toISOString() ?? null,
        };
      }
    }

    return {
      vehicleId: vehicle.id,
      vehicleCode: vehicle.code,
      companyId: vehicle.companyId,
      telemetryEnabled: vehicle.company.telemetryEnabled,
      mapping,
      pendingProposals: proposals.total,
      provider,
      lastObservation,
      lastEstimate:
        estimate && estimate.cumulativeKm
          ? {
              readingId: estimate.id,
              cumulativeKm: estimate.cumulativeKm.toFixed(3),
              gpsDistanceKm: estimate.gpsDistanceKm?.toFixed(3) ?? null,
              observedAt: estimate.observedAt.toISOString(),
              label: estimate.note,
              referenceAt: estimate.calibration?.referenceAt.toISOString() ?? null,
              referenceKm: estimate.calibration?.referenceKm.toFixed(3) ?? null,
            }
          : null,
      lastCalibration: lastCalibration ? calibrationView(lastCalibration) : null,
      lastDrift: lastDrift ? calibrationView(lastDrift) : null,
    };
  }
}

function calibrationView(c: TelemetryCalibration): VehicleCalibrationDto {
  return {
    id: c.id,
    status: c.status,
    referenceAt: c.referenceAt.toISOString(),
    referenceKm: c.referenceKm.toFixed(3),
    estimatedKmAtReference: c.estimatedKmAtReference?.toFixed(3) ?? null,
    distanceSincePreviousKm: c.distanceSincePreviousKm?.toFixed(3) ?? null,
    deviationKm: c.deviationKm?.toFixed(3) ?? null,
    deviationPercent: c.deviationPercent?.toFixed(3) ?? null,
    deviationPercentLabel: c.deviationPercent ? formatPercent(new Decimal(c.deviationPercent.toString())) : null,
    driftAlertRaised: c.driftAlertRaised,
    statusReason: c.statusReason,
  };
}
