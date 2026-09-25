import type { Prisma } from '@parc-auto/db';
import type { FreshnessStatus, VehicleOperationalStatus } from '@parc-auto/contracts';
import type { RequestContext } from '../../common/request-context.js';
import { fromDbDate, localDate, type CivilDate } from '../../domain/civil-date.js';
import { blockingNonCompliantTypeIds } from '../../domain/document-compliance.js';
import { staleBefore } from '../../domain/freshness.js';
import type { PrismaService } from '../../infra/prisma.service.js';
import type { SettingsService } from '../settings/settings.service.js';

/**
 * Conditions d'un véhicule calculées à la lecture (CDC 5.5, 7.2, 11.1 ; D-269) : fraîcheur du
 * kilométrage et non-conformité documentaire bloquante. Partagées par la liste des véhicules (filtres
 * justificatifs) et le tableau de bord, avec les règles uniques du domaine (freshness.ts,
 * document-compliance.ts) : un indicateur et sa liste justificative donnent le même total.
 */
export interface VehicleConditionFilters {
  companyId?: string;
  freshness?: FreshnessStatus;
  blockingDocuments?: 'true' | 'false';
}

interface VehicleFacts {
  id: string;
  companyId: string;
  categoryId: string;
}

/** Seuil odometer.staleAfterDays effectif par société (surcharge société, sinon groupe, sinon défaut). */
export async function staleAfterDaysByCompany(settings: SettingsService, organizationId: string, companyIds: readonly string[]): Promise<Map<string, number>> {
  const entries = await Promise.all([...new Set(companyIds)].map(async (companyId) => [companyId, await settings.get(organizationId, 'odometer.staleAfterDays', companyId)] as const));
  return new Map(entries);
}

/**
 * Filtre Prisma d'un état de fraîcheur : INCONNU = aucun relevé accepté ; A_ACTUALISER = relevés
 * acceptés, tous strictement antérieurs à la limite staleBefore de la société ; A_JOUR = au moins un
 * relevé accepté à partir de cette limite. Même définition que computeFreshness.
 */
export function freshnessWhere(status: FreshnessStatus, staleDaysByCompany: ReadonlyMap<string, number>, now: Date): Prisma.VehicleWhereInput {
  if (status === 'INCONNU') return { odometerReadings: { none: { status: 'ACCEPTE' } } };
  const companiesByDays = new Map<number, string[]>();
  for (const [companyId, days] of staleDaysByCompany) companiesByDays.set(days, [...(companiesByDays.get(days) ?? []), companyId]);
  const clauses: Prisma.VehicleWhereInput[] = [...companiesByDays].map(([days, companyIds]) => {
    const recent: Prisma.OdometerReadingWhereInput = { status: 'ACCEPTE', observedAt: { gte: staleBefore(now, days) } };
    return status === 'A_JOUR'
      ? { companyId: { in: companyIds }, odometerReadings: { some: recent } }
      : { companyId: { in: companyIds }, AND: [{ odometerReadings: { some: { status: 'ACCEPTE' } } }, { odometerReadings: { none: recent } }] };
  });
  return clauses.length > 0 ? { OR: clauses } : { id: { in: [] } };
}

/**
 * Filtre Prisma d'un statut opérationnel, même partition que operationalStatus() (vehicle-status.ts) :
 * IMMOBILISE = actif avec une immobilisation active ; EN_UTILISATION = actif, sans immobilisation active,
 * avec une utilisation en cours ; DISPONIBLE = actif, sans l'une ni l'autre.
 */
export function operationalStatusWhere(status: VehicleOperationalStatus): Prisma.VehicleWhereInput {
  if (status === 'IMMOBILISE') return { lifecycleStatus: 'ACTIF', immobilizations: { some: { status: 'ACTIVE' } } };
  if (status === 'EN_UTILISATION') return { lifecycleStatus: 'ACTIF', immobilizations: { none: { status: 'ACTIVE' } }, usages: { some: { status: 'EN_COURS' } } };
  return { lifecycleStatus: 'ACTIF', immobilizations: { none: { status: 'ACTIVE' } }, usages: { none: { status: 'EN_COURS' } } };
}

/** Véhicules dont au moins un document bloquant applicable est manquant ou expiré au jour local `today`. */
export async function nonCompliantVehicleIds(prisma: PrismaService, organizationId: string, vehicles: readonly VehicleFacts[], today: CivilDate): Promise<Set<string>> {
  const result = new Set<string>();
  if (vehicles.length === 0) return result;
  const types = await prisma.client.documentType.findMany({
    where: { organizationId, ownerType: 'VEHICULE', status: 'ACTIF', blocksCheckout: true },
    select: { id: true, ownerType: true, required: true, blocksCheckout: true, hasExpiry: true, noticeDays: true, vehicleCategoryIds: true, companyIds: true },
  });
  if (types.length === 0) return result;
  const versions = await prisma.client.documentVersion.findMany({
    where: { archivedAt: null, documentTypeId: { in: types.map((t) => t.id) }, vehicleId: { in: vehicles.map((v) => v.id) } },
    select: { id: true, documentTypeId: true, vehicleId: true, validFrom: true, validTo: true },
  });
  const byVehicle = new Map<string, Array<{ id: string; documentTypeId: string; validFrom: CivilDate | null; validTo: CivilDate | null }>>();
  for (const v of versions) {
    if (!v.vehicleId) continue;
    const list = byVehicle.get(v.vehicleId) ?? [];
    list.push({ id: v.id, documentTypeId: v.documentTypeId, validFrom: fromDbDate(v.validFrom), validTo: fromDbDate(v.validTo) });
    byVehicle.set(v.vehicleId, list);
  }
  for (const vehicle of vehicles) {
    const blocking = blockingNonCompliantTypeIds(types, byVehicle.get(vehicle.id) ?? [], { ownerType: 'VEHICULE', companyId: vehicle.companyId, categoryId: vehicle.categoryId }, today);
    if (blocking.length > 0) result.add(vehicle.id);
  }
  return result;
}

/**
 * Clauses supplémentaires de la liste des véhicules pour les filtres « fraîcheur » et « documents
 * bloquants », appliquées en plus du filtre déjà construit (périmètre, cycle de vie, statut).
 */
export async function vehicleConditionClauses(deps: { prisma: PrismaService; settings: SettingsService }, ctx: RequestContext, query: VehicleConditionFilters, baseWhere: Prisma.VehicleWhereInput, now: Date): Promise<Prisma.VehicleWhereInput[]> {
  const clauses: Prisma.VehicleWhereInput[] = [];
  if (query.freshness) {
    const companyIds = query.companyId ? [query.companyId] : ctx.visibleCompanyIds;
    clauses.push(freshnessWhere(query.freshness, await staleAfterDaysByCompany(deps.settings, ctx.organizationId, companyIds), now));
  }
  if (query.blockingDocuments) {
    const [candidates, org] = await Promise.all([
      deps.prisma.client.vehicle.findMany({ where: { AND: [baseWhere, ...clauses] }, select: { id: true, companyId: true, categoryId: true } }),
      deps.prisma.client.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } }),
    ]);
    const nonCompliant = [...(await nonCompliantVehicleIds(deps.prisma, ctx.organizationId, candidates, localDate(now, org.timezone)))];
    clauses.push(query.blockingDocuments === 'true' ? { id: { in: nonCompliant } } : { id: { notIn: nonCompliant } });
  }
  return clauses;
}
