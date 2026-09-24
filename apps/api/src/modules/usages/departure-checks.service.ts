import { Injectable } from '@nestjs/common';
import type { Driver, Vehicle } from '@parc-auto/db';
import { Clock } from '../../common/clock.js';
import { formatLocalDateTime, fromDbDate, localDate } from '../../domain/civil-date.js';
import { computeDocumentStatus } from '../../domain/document-status.js';
import { canStartUsage } from '../../domain/vehicle-status.js';
import type { Tx } from '../../infra/prisma.service.js';

/**
 * Code du blocage « véhicule non ACTIF » (cycle de vie HORS_SERVICE, CEDE ou ARCHIVE, CDC 3.2) : refus 409
 * (conflit d'état, CDC 15.1) de la confirmation d'une réservation comme d'une remise ; la restitution reste possible.
 */
export const VEHICLE_NOT_ACTIVE = 'VEHICULE_NON_ACTIF';

export interface DepartureBlocker {
  code: string;
  message: string;
  /** Levable par dérogation motivée (exceptions.override) : documents et permis uniquement. */
  overridable: boolean;
}

/**
 * Contrôles d'un nouveau départ (CDC 3.2, 4.2, 4.3, 4.5, 7.2) : cycle de vie, immobilisation, utilisation
 * ouverte, conducteur actif de la même société, permis couvrant la catégorie, documents bloquants.
 * Utilisé à la confirmation d'une réservation et refait au départ. Un retour n'est jamais bloqué.
 */
@Injectable()
export class DepartureChecksService {
  constructor(private readonly clock: Clock) {}

  async check(tx: Tx, vehicle: Vehicle, driver: Driver, at: Date, options: { ignoreUsageId?: string; timezone: string }): Promise<DepartureBlocker[]> {
    const blockers: DepartureBlocker[] = [];
    // Possession réelle sans chevauchement, même saisie après coup (4.3, 4.5, 13.3 ; T04, T05) : un départ ne peut
    // pas précéder la dernière restitution du véhicule ni celle du conducteur.
    const returnedAfter = { status: 'TERMINEE' as const, returnedAt: { gt: at }, ...(options.ignoreUsageId ? { id: { not: options.ignoreUsageId } } : {}) };
    const [activeImmobilization, openUsage, driverOpenUsage, vehicleLaterReturn, driverLaterReturn] = await Promise.all([
      tx.immobilization.findFirst({ where: { vehicleId: vehicle.id, status: 'ACTIVE' }, select: { id: true } }),
      tx.vehicleUsage.findFirst({ where: { vehicleId: vehicle.id, status: 'EN_COURS', ...(options.ignoreUsageId ? { id: { not: options.ignoreUsageId } } : {}) }, select: { id: true } }),
      tx.vehicleUsage.findFirst({ where: { driverId: driver.id, status: 'EN_COURS', ...(options.ignoreUsageId ? { id: { not: options.ignoreUsageId } } : {}) }, select: { id: true } }),
      tx.vehicleUsage.findFirst({ where: { vehicleId: vehicle.id, ...returnedAfter }, orderBy: { returnedAt: 'desc' }, select: { returnedAt: true } }),
      tx.vehicleUsage.findFirst({ where: { driverId: driver.id, ...returnedAfter }, orderBy: { returnedAt: 'desc' }, select: { returnedAt: true } }),
    ]);
    const status = canStartUsage({ lifecycle: vehicle.lifecycleStatus, hasActiveImmobilization: Boolean(activeImmobilization), hasOpenUsage: Boolean(openUsage) });
    if (!status.ok) blockers.push({ code: status.code, message: status.reason, overridable: false });
    if (driverOpenUsage) blockers.push({ code: 'CONDUCTEUR_DEJA_EN_UTILISATION', message: 'Le conducteur a déjà une utilisation en cours.', overridable: false });
    if (vehicleLaterReturn?.returnedAt && !blockers.some((b) => b.code === 'VEHICULE_DEJA_EN_UTILISATION')) {
      const when = formatLocalDateTime(vehicleLaterReturn.returnedAt, options.timezone, { sentence: true });
      blockers.push({ code: 'VEHICULE_DEJA_EN_UTILISATION', message: `Le véhicule était encore en utilisation à cette date : il a été restitué le ${when}. Le départ ne peut pas précéder cette restitution.`, overridable: false });
    }
    if (driverLaterReturn?.returnedAt && !driverOpenUsage) {
      const when = formatLocalDateTime(driverLaterReturn.returnedAt, options.timezone, { sentence: true });
      blockers.push({ code: 'CONDUCTEUR_DEJA_EN_UTILISATION', message: `Le conducteur avait encore un véhicule à cette date : il l’a restitué le ${when}. Le départ ne peut pas précéder cette restitution.`, overridable: false });
    }
    if (driver.status !== 'ACTIF') blockers.push({ code: 'CONDUCTEUR_INACTIF', message: 'Le conducteur est inactif : il ne peut pas recevoir de véhicule.', overridable: false });
    if (driver.companyId !== vehicle.companyId) blockers.push({ code: 'SOCIETE_DIFFERENTE', message: 'Le conducteur et le véhicule n’appartiennent pas à la même société.', overridable: false });

    const today = localDate(at, options.timezone);
    // Permis : catégories exigées par la catégorie du véhicule (paramétrage client, 3.3).
    const category = await tx.vehicleCategory.findUnique({ where: { id: vehicle.categoryId }, select: { requiredPermitCategories: true, label: true } });
    const required = category?.requiredPermitCategories ?? [];
    if (required.length > 0) {
      const permits = await tx.driverPermit.findMany({ where: { driverId: driver.id } });
      const covering = permits.find((p) => p.categories.some((c) => required.includes(c)) && (!p.expiresOn || (fromDbDate(p.expiresOn) as string) >= today));
      if (!covering) {
        blockers.push({
          code: 'PERMIS_NON_CONFORME',
          message: `Le conducteur ne dispose pas d’un permis valide couvrant la catégorie exigée (${required.join(', ')}) pour « ${category?.label ?? 'cette catégorie'} ».`,
          overridable: true,
        });
      }
    }

    // Documents bloquants du véhicule et du conducteur (7.2).
    const types = await tx.documentType.findMany({ where: { organizationId: vehicle.organizationId, status: 'ACTIF', blocksCheckout: true } });
    if (types.length > 0) {
      const versions = await tx.documentVersion.findMany({
        where: { archivedAt: null, documentTypeId: { in: types.map((t) => t.id) }, OR: [{ vehicleId: vehicle.id }, { driverId: driver.id }] },
        select: { id: true, documentTypeId: true, vehicleId: true, driverId: true, validFrom: true, validTo: true },
      });
      for (const type of types) {
        const own = versions.filter((v) => v.documentTypeId === type.id && (type.ownerType === 'VEHICULE' ? v.vehicleId === vehicle.id : v.driverId === driver.id));
        const result = computeDocumentStatus(type, own.map((v) => ({ id: v.id, validFrom: fromDbDate(v.validFrom), validTo: fromDbDate(v.validTo) })), today);
        if (result.blocksCheckout) {
          blockers.push({
            code: 'DOCUMENT_BLOQUANT',
            message: `${type.label} (${type.ownerType === 'VEHICULE' ? 'véhicule' : 'conducteur'}) : ${result.status === 'MANQUANT' ? 'manquant' : 'expiré'}. ${result.detail}`,
            overridable: true,
          });
        }
      }
    }
    void this.clock;
    return blockers;
  }
}
