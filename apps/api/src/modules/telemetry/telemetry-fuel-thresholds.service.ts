import { Injectable } from '@nestjs/common';
import type { Prisma } from '@parc-auto/db';
import { SETTING_DESCRIPTORS } from '@parc-auto/contracts';
import { BusinessRuleError, ConflictError, ErrorCodes, type FieldErrors, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { VEHICLE_FUEL_THRESHOLD_FIELDS, type VehicleFuelThresholdField, type VehicleFuelThresholdValues, hasVehicleFuelThresholds } from '../../domain/telemetry/fuel-thresholds.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, isUniqueViolation } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { MANAGER_ROLES } from '../access-control/permissions.js';
import { SettingsService } from '../settings/settings.service.js';
import type { UpdateVehicleFuelThresholdsDto, VehicleFuelThresholdsViewDto } from './dto/telemetry-fuel-thresholds.dto.js';
import { TelemetryProvidersService } from './telemetry-providers.service.js';

const AUDIT_OBJECT = 'VehicleFuelThresholds';
const THREE_DECIMALS = /^\d+(\.\d{1,3})?$/;

type Row = Prisma.VehicleFuelThresholdsGetPayload<Record<string, never>>;

/**
 * Seuils carburant propres à un véhicule (CDC 8.5, 17.1 ; D-238, D-240 ; R-8.5-07, R-17.1-14) : lecture dans le
 * périmètre télématique (personnel de la société ; 404 hors périmètre, 403 conducteur), modification par le
 * chef de parc de la société ou l'administrateur, motif obligatoire, verrou optimiste et audit avant/après.
 * La détection (TelemetryFuelService) applique la même règle (applyVehicleFuelThresholds).
 */
@Injectable()
export class TelemetryFuelThresholdsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly providers: TelemetryProvidersService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async view(ctx: RequestContext, vehicleId: string): Promise<VehicleFuelThresholdsViewDto> {
    const vehicle = await this.loadVehicle(ctx, vehicleId);
    return this.build(ctx, vehicle);
  }

  async update(ctx: RequestContext, vehicleId: string, dto: UpdateVehicleFuelThresholdsDto): Promise<VehicleFuelThresholdsViewDto> {
    const vehicle = await this.loadVehicle(ctx, vehicleId);
    this.access.requireManager(ctx, vehicle.companyId);
    const values = validateThresholds(dto);
    const reason = dto.reason.trim();
    if (reason.length < 3) throw new BusinessRuleError('MOTIF_REQUIS', 'Indiquez un motif (3 caractères minimum).', { fieldErrors: { reason: ['Motif requis (3 caractères minimum).'] } });
    const filled = hasVehicleFuelThresholds(values);
    const data = Object.fromEntries(VEHICLE_FUEL_THRESHOLD_FIELDS.map(({ field }) => [field, values[field] ?? null])) as Record<VehicleFuelThresholdField, number | null>;
    try {
      await this.prisma.transaction(async (tx) => {
        const current = await tx.vehicleFuelThresholds.findUnique({ where: { vehicleId } });
        const currentVersion = current?.version ?? 0;
        if (currentVersion !== dto.expectedVersion) {
          throw new ConflictError(ErrorCodes.VERSION_OBSOLETE, `Les seuils de ce véhicule ont été modifiés entre-temps : version ${currentVersion} enregistrée, version ${dto.expectedVersion} attendue. Rechargez puis réessayez.`, {
            currentVersion,
            expectedVersion: dto.expectedVersion,
          });
        }
        if (!current && !filled) throw new BusinessRuleError('SURCHARGE_VIDE', 'Renseignez au moins un seuil propre au véhicule.');
        const before = current ? snapshot(current) : null;
        if (current && !filled) {
          await tx.vehicleFuelThresholds.delete({ where: { vehicleId, version: current.version } });
          await this.audit.record(ctx, { action: 'telemetrie.seuils_carburant.suppression', objectType: AUDIT_OBJECT, objectId: vehicleId, companyId: vehicle.companyId, reason, before, after: null }, tx);
          return;
        }
        // Surcharge (re)créée : sa version suit le nombre de modifications déjà auditées, pour qu'une version
        // lue avant un retrait ne soit jamais réattribuée (sinon une saisie périmée écraserait la nouvelle
        // surcharge sans conflit). « 0 » reste réservé à l'absence de surcharge.
        const written = current
          ? await tx.vehicleFuelThresholds.update({ where: { vehicleId, version: current.version }, data: { ...data, reason, updatedById: ctx.userId, version: { increment: 1 } } })
          : await tx.vehicleFuelThresholds.create({
              data: { vehicleId, organizationId: ctx.organizationId, ...data, reason, updatedById: ctx.userId, version: 1 + (await tx.auditEvent.count({ where: { organizationId: ctx.organizationId, objectType: AUDIT_OBJECT, objectId: vehicleId } })) },
            });
        await this.audit.record(ctx, { action: 'telemetrie.seuils_carburant.modification', objectType: AUDIT_OBJECT, objectId: vehicleId, companyId: vehicle.companyId, reason, before, after: snapshot(written) }, tx);
      });
    } catch (error) {
      // Deux premières surcharges simultanées : la seconde bute sur la clé primaire (409, jamais 500).
      if (isUniqueViolation(error)) throw new ConflictError(ErrorCodes.VERSION_OBSOLETE, 'Les seuils de ce véhicule viennent d’être modifiés par ailleurs. Rechargez puis réessayez.');
      throw error;
    }
    return this.build(ctx, vehicle);
  }

  private async loadVehicle(ctx: RequestContext, vehicleId: string): Promise<{ id: string; code: string; companyId: string }> {
    const scope = this.providers.readScope(ctx);
    const vehicle = await this.prisma.client.vehicle.findFirst({ where: { id: vehicleId, organizationId: ctx.organizationId }, select: { id: true, code: true, companyId: true } });
    if (!vehicle || (scope && !scope.includes(vehicle.companyId))) throw new NotFoundOrOutOfScopeError('Véhicule');
    return vehicle;
  }

  private async build(ctx: RequestContext, vehicle: { id: string; code: string; companyId: string }): Promise<VehicleFuelThresholdsViewDto> {
    const [row, company] = await Promise.all([this.prisma.client.vehicleFuelThresholds.findUnique({ where: { vehicleId: vehicle.id } }), this.settings.list(ctx, vehicle.companyId)]);
    const author = row?.updatedById ? await this.prisma.client.user.findFirst({ where: { id: row.updatedById, organizationId: ctx.organizationId }, select: { firstName: true, lastName: true } }) : null;
    const own = row ? snapshot(row) : {};
    return {
      vehicleId: vehicle.id,
      vehicleCode: vehicle.code,
      companyId: vehicle.companyId,
      version: row?.version ?? 0,
      reason: row?.reason ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedByName: author ? `${author.firstName} ${author.lastName}`.trim() : null,
      canEdit: this.access.hasRole(ctx, vehicle.companyId, MANAGER_ROLES),
      thresholds: VEHICLE_FUEL_THRESHOLD_FIELDS.map(({ field, key }) => {
        const d = SETTING_DESCRIPTORS[key];
        const setting = company.find((s) => s.key === key);
        const companyValue = Number(setting?.value);
        const vehicleValue = own[field] ?? null;
        return {
          field,
          key,
          label: d.label,
          unit: d.unit ?? null,
          vehicleValue,
          companyValue,
          companySource: setting?.source ?? 'defaut',
          effectiveValue: vehicleValue ?? companyValue,
          source: vehicleValue !== null ? 'vehicule' : (setting?.source ?? 'defaut'),
          min: d.min ?? null,
          max: d.max ?? null,
        };
      }),
    };
  }
}

function snapshot(row: Row): VehicleFuelThresholdValues {
  const num = (v: { toString(): string } | null) => (v === null ? null : Number(v.toString()));
  return {
    dropLiters: num(row.dropLiters),
    dropPercent: num(row.dropPercent),
    dropWindowMinutes: row.dropWindowMinutes,
    fillLiters: num(row.fillLiters),
    fillPercent: num(row.fillPercent),
    fillWindowMinutes: row.fillWindowMinutes,
  };
}

/** Bornes et nature des paramètres société correspondants ; 3 décimales au plus ; erreurs par champ (422). */
function validateThresholds(dto: UpdateVehicleFuelThresholdsDto): VehicleFuelThresholdValues {
  const errors: FieldErrors = {};
  const values: VehicleFuelThresholdValues = {};
  for (const { field, key } of VEHICLE_FUEL_THRESHOLD_FIELDS) {
    const value = dto[field];
    if (value === undefined || value === null) {
      values[field] = null;
      continue;
    }
    const d = SETTING_DESCRIPTORS[key];
    const unit = d.unit ? ` ${d.unit}` : '';
    if (d.kind === 'integer' && !Number.isInteger(value)) errors[field] = ['Un entier est attendu.'];
    else if (d.kind === 'number' && !THREE_DECIMALS.test(String(value))) errors[field] = ['Nombre positif à 3 décimales au plus attendu.'];
    else if (d.min !== undefined && value < d.min) errors[field] = [`Valeur minimale ${d.min}${unit}.`];
    else if (d.max !== undefined && value > d.max) errors[field] = [`Valeur maximale ${d.max}${unit}.`];
    else values[field] = value;
  }
  if (Object.keys(errors).length > 0) throw new BusinessRuleError('SEUIL_INVALIDE', 'Certains seuils sont hors des bornes admises.', { fieldErrors: errors });
  return values;
}
