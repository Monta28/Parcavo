import { Injectable } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Clock } from '../../common/clock.js';
import { ForbiddenActionError } from '../../common/errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { currentAssignmentWhere, submissionTargets, type SubmissionBasis, type SubmissionTarget } from '../../domain/responsible-assignment.js';
import { PrismaService, type Tx } from '../../infra/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';

export type { SubmissionBasis, SubmissionTarget } from '../../domain/responsible-assignment.js';

export class SubmissionTargetDto {
  @ApiProperty() vehicleId!: string;
  @ApiProperty() vehicleCode!: string;
  @ApiProperty() registration!: string;
  @ApiProperty({ enum: ['UTILISATION_EN_COURS', 'RESPONSABLE_HABITUEL'], description: 'Base du droit de soumission : utilisation EN_COURS, ou responsable habituel en cours si le paramètre drivers.allowHabitualVehicleSubmissions est actif (D-268).' })
  basis!: SubmissionBasis;
  @ApiProperty({ nullable: true, type: String }) usageId!: string | null;
}

/**
 * Véhicule sur lequel un conducteur peut soumettre (relevé, incident, ticket carburant ; CDC 2.3, 10.3 ;
 * D-116, D-268) : le véhicule de son utilisation EN_COURS ; sinon, si le paramètre de groupe
 * drivers.allowHabitualVehicleSubmissions est actif, le véhicule dont il est responsable habituel en cours.
 * Point d'entrée unique pour les modules relevés, incidents et carburant ; la règle vit dans
 * domain/responsible-assignment.ts (submissionTargets).
 */
@Injectable()
export class DriverSubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  /** Véhicules sur lesquels le conducteur lié au compte peut soumettre maintenant (liste vide sinon). */
  async targets(ctx: RequestContext, tx?: Tx): Promise<SubmissionTarget[]> {
    if (!ctx.driverId) return [];
    return this.targetsForDriver(ctx.organizationId, ctx.driverId, this.clock.now(), tx);
  }

  /**
   * Base du droit de soumettre sur ce véhicule pour le conducteur lié au compte. À appeler après le
   * chargement du véhicule par VehiclesService.load (404 hors du périmètre de lecture) : un véhicule
   * lisible mais hors de ce droit est une action interdite (403, D-118), comme pour les relevés.
   */
  async requireTarget(ctx: RequestContext, vehicleId: string, tx?: Tx): Promise<SubmissionTarget> {
    const target = (await this.targets(ctx, tx)).find((t) => t.vehicleId === vehicleId);
    if (!target) {
      throw new ForbiddenActionError('Vous ne pouvez soumettre que pour le véhicule de votre utilisation en cours, ou pour celui dont vous êtes responsable habituel si l’organisation l’autorise.');
    }
    return target;
  }

  /** Même règle pour un conducteur donné et un instant donné (traitements serveur). */
  async targetsForDriver(organizationId: string, driverId: string, now: Date, tx?: Tx): Promise<SubmissionTarget[]> {
    const db = tx ?? this.prisma.client;
    const driver = await db.driver.findFirst({ where: { id: driverId, organizationId }, select: { status: true, companyId: true } });
    if (!driver) return [];
    // Lectures successives : elles peuvent s'exécuter dans la transaction de l'appelant (une seule connexion).
    const openUsage = await db.vehicleUsage.findFirst({ where: { organizationId, driverId, status: 'EN_COURS' }, select: { id: true, vehicleId: true, companyId: true } });
    const allowHabitualVehicleSubmissions = await this.settings.get(organizationId, 'drivers.allowHabitualVehicleSubmissions', null, tx);
    const assignments = await db.vehicleResponsibleAssignment.findMany({
      where: { organizationId, driverId, ...currentAssignmentWhere(now) },
      select: { id: true, vehicleId: true, companyId: true, startsAt: true, endsAt: true, vehicle: { select: { companyId: true, lifecycleStatus: true } } },
      orderBy: { startsAt: 'asc' },
    });
    return submissionTargets({ driver, openUsage, assignments, allowHabitualVehicleSubmissions, now });
  }

  /** Vue HTTP du conducteur connecté (écran /mon-vehicule : actions actives ou désactivées). */
  async myTargets(ctx: RequestContext): Promise<SubmissionTargetDto[]> {
    const targets = await this.targets(ctx);
    if (targets.length === 0) return [];
    const vehicles = await this.prisma.client.vehicle.findMany({ where: { id: { in: targets.map((t) => t.vehicleId) }, organizationId: ctx.organizationId }, select: { id: true, code: true, registration: true } });
    const byId = new Map(vehicles.map((v) => [v.id, v]));
    return targets.flatMap((t) => {
      const v = byId.get(t.vehicleId);
      return v ? [{ vehicleId: t.vehicleId, vehicleCode: v.code, registration: v.registration, basis: t.basis, usageId: t.usageId }] : [];
    });
  }
}
