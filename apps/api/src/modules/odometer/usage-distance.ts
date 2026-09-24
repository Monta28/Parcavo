import { Decimal } from 'decimal.js';
import type { DistanceStatus } from '@parc-auto/db';
import { distanceBetween } from '../../domain/odometer-rules.js';
import type { Tx } from '../../infra/prisma.service.js';

/**
 * Distance d'une utilisation (CDC 4.4, 11.3) : différence de kilomètres cumulés entre deux relevés
 * acceptés. Départ sans relevé : distance indéterminée ; retour sans relevé valide : distance non validée
 * jusqu'à régularisation.
 */
export async function recomputeUsageDistance(tx: Tx, usageId: string): Promise<{ distanceStatus: DistanceStatus; distanceKm: string | null }> {
  const usage = await tx.vehicleUsage.findUniqueOrThrow({
    where: { id: usageId },
    include: { checkoutReading: true, returnReading: true },
  });
  let distanceStatus: DistanceStatus = 'INDETERMINEE';
  let distanceKm: string | null = null;
  const start = usage.checkoutReading?.status === 'ACCEPTE' && usage.checkoutReading.cumulativeKm ? new Decimal(usage.checkoutReading.cumulativeKm.toString()) : null;
  const end = usage.returnReading?.status === 'ACCEPTE' && usage.returnReading.cumulativeKm ? new Decimal(usage.returnReading.cumulativeKm.toString()) : null;
  if (usage.status === 'TERMINEE') {
    if (!usage.checkoutReadingId || usage.checkoutWithoutReading) distanceStatus = 'INDETERMINEE';
    else if (start && end) {
      const d = distanceBetween(start, end);
      distanceStatus = d ? 'VALIDEE' : 'NON_VALIDEE';
      distanceKm = d?.toString() ?? null;
    } else distanceStatus = 'NON_VALIDEE';
  } else {
    distanceStatus = usage.checkoutWithoutReading || !start ? 'INDETERMINEE' : 'NON_VALIDEE';
  }
  await tx.vehicleUsage.update({ where: { id: usageId }, data: { distanceStatus, distanceKm } });
  return { distanceStatus, distanceKm };
}

/** Recalcule les utilisations qui référencent un relevé (approbation, rejet, correction) ; renvoie leur nouvel état. */
export async function recomputeUsagesForReading(tx: Tx, readingId: string): Promise<Array<{ id: string; organizationId: string; distanceStatus: DistanceStatus; distanceKm: string | null }>> {
  const usages = await tx.vehicleUsage.findMany({ where: { OR: [{ checkoutReadingId: readingId }, { returnReadingId: readingId }] }, select: { id: true, organizationId: true } });
  const out: Array<{ id: string; organizationId: string; distanceStatus: DistanceStatus; distanceKm: string | null }> = [];
  for (const u of usages) out.push({ id: u.id, organizationId: u.organizationId, ...(await recomputeUsageDistance(tx, u.id)) });
  return out;
}
