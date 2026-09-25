import type { Prisma } from '@parc-auto/db';

type HintDb = Pick<Prisma.TransactionClient, 'telemetryVehicleMapping' | 'telemetryOdometerSample' | 'odometerReading'>;

export interface TelematicsHint {
  /**
   * Kilométrage à 3 décimales (chaîne décimale) comparable au compteur affiché : valeur CAN telle que reçue
   * du fournisseur ; pour une DISTANCE_GPS, estimation calibrée (« estimé GPS ») ramenée au compteur physique
   * du segment, jamais la distance brute du boîtier.
   */
  valueKm: string;
  kind: 'COMPTEUR_CAN' | 'DISTANCE_GPS';
  observedAt: string;
}

/**
 * Aide télématique d'une remise, d'une restitution ou du compteur courant (CDC 5.6 ; R-5.6-17, R-5.6-X01) — règle
 * unique, appelée par GET /vehicles/:id/odometer et l'aperçu de remise : dernière valeur automatique de la nature
 * retenue par l'association en cours (odometerKind), observée depuis sa date d'effet. Jamais une valeur d'un
 * boîtier réutilisé observée sur son véhicule précédent, ni une valeur d'une nature non retenue ; aucune aide
 * sans association confirmée ouverte, pour une association sans kilométrage (AUCUN) ou quand le module est
 * désactivé pour la société du véhicule (régime manuel, CDC 14.3).
 *  - COMPTEUR_CAN : dernier échantillon CAN de l'unité (compteur physique).
 *  - DISTANCE_GPS : dernière estimation acceptée calibrée sur une référence de l'association en cours, ramenée au
 *    compteur physique de son segment encore ouvert. Une distance GPS brute n'est jamais présentée comme un
 *    kilométrage (CDC 5.6) : sans référence manuelle pour ce boîtier, ou après un changement de compteur, aucune
 *    aide.
 * Indication seulement : la valeur enregistrée reste celle lue sur le tableau de bord et saisie par l'utilisateur.
 */
export async function currentTelematicsHint(db: HintDb, vehicleId: string): Promise<TelematicsHint | null> {
  // Module désactivé pour la société du véhicule (14.3) : régime manuel, aucune aide télématique.
  const mapping = await db.telemetryVehicleMapping.findFirst({
    where: { vehicleId, status: 'CONFIRME', validTo: null, vehicle: { company: { telemetryEnabled: true } } },
    select: { id: true, unitId: true, validFrom: true, odometerKind: true },
  });
  if (!mapping?.validFrom || mapping.odometerKind === 'AUCUN') return null;
  if (mapping.odometerKind === 'DISTANCE_GPS') {
    const estimate = await db.odometerReading.findFirst({
      where: {
        vehicleId,
        source: 'TELEMATICS',
        measurementKind: 'DISTANCE_GPS',
        isEstimate: true,
        status: 'ACCEPTE',
        observedAt: { gte: mapping.validFrom },
        calibration: { mappingId: mapping.id },
      },
      orderBy: [{ observedAt: 'desc' }, { enteredAt: 'desc' }],
      select: { cumulativeKm: true, observedAt: true, segment: { select: { endedAt: true, startCumulativeKm: true, startPhysicalKm: true } } },
    });
    if (!estimate?.cumulativeKm || estimate.segment.endedAt !== null) return null;
    const physicalKm = estimate.cumulativeKm.minus(estimate.segment.startCumulativeKm).plus(estimate.segment.startPhysicalKm);
    return { valueKm: physicalKm.toFixed(3), kind: 'DISTANCE_GPS', observedAt: estimate.observedAt.toISOString() };
  }
  const sample = await db.telemetryOdometerSample.findFirst({
    where: { unitId: mapping.unitId, kind: mapping.odometerKind, observedAt: { gte: mapping.validFrom } },
    orderBy: { observedAt: 'desc' },
    select: { valueKm: true, observedAt: true },
  });
  if (!sample) return null;
  return { valueKm: sample.valueKm.toFixed(3), kind: mapping.odometerKind, observedAt: sample.observedAt.toISOString() };
}
