import { Injectable } from '@nestjs/common';
import { AfterCommit } from '../../common/after-commit.js';
import { PrismaService, isRetryable, isUniqueViolation, type Tx } from '../../infra/prisma.service.js';

export interface ReadingAcceptedEvent {
  organizationId: string;
  companyId: string;
  vehicleId: string;
  readingId: string;
  origin: 'MANUAL' | 'IMPORT' | 'TELEMATICS';
  measurementKind: 'COMPTEUR_AFFICHE' | 'COMPTEUR_CAN' | 'DISTANCE_GPS';
  isEstimate: boolean;
}

export type ReadingAcceptedListener = (event: ReadingAcceptedEvent) => Promise<void>;

/**
 * Recalcul d'une donnée dépendante dans la transaction qui a changé un relevé accepté (correction, CDC 5.3 et
 * 13.3) : lectures et écritures passent par `tx` ; les effets externes (notifications) sont différés dans `after`.
 */
export type ReadingDependentsListener = (tx: Tx, event: ReadingAcceptedEvent, after: AfterCommit) => Promise<void>;

/**
 * Point d'extension : les modules dépendants du kilométrage (entretien, alertes, calibrage GPS)
 * s'abonnent aux relevés acceptés ou remplacés. Exécuté après validation de la transaction.
 */
@Injectable()
export class OdometerEventsService {
  private readonly listeners: Array<{ name: string; listener: ReadingAcceptedListener }> = [];
  private readonly inTx: Array<{ name: string; listener: ReadingDependentsListener }> = [];

  constructor(private readonly prisma: PrismaService) {}

  onAccepted(name: string, listener: ReadingAcceptedListener): void {
    this.listeners.push({ name, listener });
  }

  subscribers(): ReadonlyArray<{ name: string; listener: ReadingAcceptedListener }> {
    return this.listeners;
  }

  /** Abonne un recalcul transactionnel (échéances d'entretien, fraîcheur et leurs alertes). */
  onDependentsInTx(name: string, listener: ReadingDependentsListener): void {
    this.inTx.push({ name, listener });
  }

  /**
   * Exécute les recalculs dépendants dans la transaction appelante (correction d'un relevé accepté) : une
   * erreur annule toute la correction, aucune donnée dépendante n'est laissée désalignée.
   */
  async recomputeDependentsInTx(tx: Tx, event: ReadingAcceptedEvent, after: AfterCommit): Promise<string[]> {
    for (const { listener } of this.inTx) await listener(tx, event, after);
    return this.inTx.map((l) => l.name);
  }

  /**
   * Relevé accepté hors correction, après validation de son ingestion : les mêmes recalculs dépendants
   * (fraîcheur, échéances d'entretien et leurs alertes) regroupés dans une seule transaction (lectures et
   * écritures groupées par chaque abonné) au lieu d'une transaction par plan et d'écritures unitaires ; les
   * notifications partent après validation. Une création concurrente de la même occurrence d'alerte (index
   * unique) ou un interblocage rejoue la transaction (deux reprises au plus) ; un échec est journalisé par
   * l'appelant (AfterCommit) et rattrapé par la tâche périodique, sans remettre en cause le relevé validé.
   */
  async recomputeDependents(event: ReadingAcceptedEvent): Promise<string[]> {
    if (this.inTx.length === 0) return [];
    for (let attempt = 0; ; attempt += 1) {
      const after = new AfterCommit();
      try {
        const names = await this.prisma.transaction((tx) => this.recomputeDependentsInTx(tx, event, after));
        await after.run();
        return names;
      } catch (error) {
        if ((isUniqueViolation(error) || isRetryable(error)) && attempt < 2) continue;
        throw error;
      }
    }
  }
}
