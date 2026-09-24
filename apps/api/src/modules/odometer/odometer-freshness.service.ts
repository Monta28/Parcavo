import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { AfterCommit } from '../../common/after-commit.js';
import { Clock } from '../../common/clock.js';
import { computeFreshness } from '../../domain/freshness.js';
import { PrismaService, type Tx } from '../../infra/prisma.service.js';
import { AlertsService } from '../alerts/alerts.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { OdometerEventsService } from './odometer-events.service.js';

/**
 * Alertes de fraîcheur du kilométrage (CDC 5.5) : aucun relevé accepté → KILOMETRAGE_ABSENT ;
 * dernière observation acceptée plus ancienne que le seuil paramétré → KILOMETRAGE_ANCIEN. Résolues
 * dès qu'un relevé accepté rafraîchit l'observation ; aucune alerte pour un véhicule non ACTIF (D-171).
 * Réévaluées après chaque relevé accepté et par le rattrapage périodique (idempotent).
 */
@Injectable()
export class OdometerFreshnessService implements OnModuleInit {
  private readonly logger = new Logger(OdometerFreshnessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly alerts: AlertsService,
    private readonly events: OdometerEventsService,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.events.onAccepted('fraicheur', async (event) => {
      await this.evaluateVehicle(event.vehicleId);
    });
    // Correction d'un relevé accepté (5.3, 13.3) : la date d'observation corrigée change la fraîcheur, réévaluée
    // avec ses alertes dans la transaction de correction.
    this.events.onDependentsInTx('fraicheur', async (tx, event, after) => {
      await this.evaluateVehicle(event.vehicleId, tx, after);
    });
  }

  /** Avec `tx` : lectures et alertes dans la transaction de l'appelant, notifications après validation (after). */
  async evaluateVehicle(vehicleId: string, tx?: Tx, after?: AfterCommit): Promise<void> {
    const db = tx ?? this.prisma.client;
    const v = await db.vehicle.findUnique({ where: { id: vehicleId }, select: { id: true, organizationId: true, companyId: true, code: true, lifecycleStatus: true } });
    if (!v) return;
    const absentKey = { organizationId: v.organizationId, type: 'KILOMETRAGE_ABSENT' as const, objectType: 'Vehicle', objectId: v.id };
    const staleKey = { organizationId: v.organizationId, type: 'KILOMETRAGE_ANCIEN' as const, objectType: 'Vehicle', objectId: v.id };
    if (v.lifecycleStatus !== 'ACTIF') {
      const reason = v.lifecycleStatus === 'HORS_SERVICE' ? 'véhicule hors service' : 'véhicule cédé ou archivé';
      await this.alerts.resolve(absentKey, reason, tx);
      await this.alerts.resolve(staleKey, reason, tx);
      return;
    }
    const last = await db.odometerReading.findFirst({ where: { vehicleId, status: 'ACCEPTE' }, orderBy: [{ observedAt: 'desc' }, { enteredAt: 'desc' }], select: { observedAt: true } });
    const staleDays = await this.settings.get(v.organizationId, 'odometer.staleAfterDays', v.companyId, tx);
    const freshness = computeFreshness(last?.observedAt ?? null, this.clock.now(), staleDays);
    const actionPath = `/vehicules/${v.id}?onglet=kilometrage`;
    if (freshness.status === 'INCONNU') {
      await this.alerts.resolve(staleKey, 'aucun relevé', tx);
      await this.alerts.raise({ ...absentKey, companyId: v.companyId, severity: 'ATTENTION', vehicleId: v.id, occurrenceKey: 'aucun', title: `Kilométrage inconnu — ${v.code}`, message: 'Aucun relevé de compteur accepté : l’état du kilométrage est inconnu.', condition: { freshness: 'INCONNU' }, actionPath }, tx, after);
      return;
    }
    await this.alerts.resolve(absentKey, 'relevé enregistré', tx);
    if (freshness.status === 'A_JOUR') {
      await this.alerts.resolve(staleKey, 'relevé récent', tx);
      return;
    }
    const since = (last?.observedAt as Date).toISOString().slice(0, 10);
    const occurrenceKey = `depuis:${since}`;
    await this.alerts.resolveOtherOccurrences(staleKey, occurrenceKey, 'nouvelle observation', tx);
    await this.alerts.raise({ ...staleKey, companyId: v.companyId, severity: 'ATTENTION', vehicleId: v.id, occurrenceKey, title: `Kilométrage à actualiser — ${v.code}`, message: `Dernière observation acceptée il y a ${freshness.ageDays ?? '?'} jours (seuil ${staleDays} jours).`, condition: { freshness: 'A_ACTUALISER', lastObservedAt: last?.observedAt.toISOString(), staleDays }, actionPath }, tx, after);
  }

  /** Rattrapage : tous les véhicules (ou ceux d'une organisation). */
  async evaluateAll(organizationId?: string): Promise<number> {
    const vehicles = await this.prisma.client.vehicle.findMany({ where: organizationId ? { organizationId } : {}, select: { id: true } });
    for (const v of vehicles) {
      try {
        await this.evaluateVehicle(v.id);
      } catch (error) {
        this.logger.error(`Fraîcheur du véhicule ${v.id} : ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return vehicles.length;
  }
}
