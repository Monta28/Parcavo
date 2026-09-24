import { Injectable, Logger } from '@nestjs/common';
import type { AlertSeverity, AlertType, Prisma } from '@parc-auto/db';
import { Clock } from '../../common/clock.js';
import { PrismaService, type Tx } from '../../infra/prisma.service.js';

export interface AlertCondition {
  organizationId: string;
  companyId: string;
  type: AlertType;
  severity: AlertSeverity;
  objectType: string;
  objectId: string;
  vehicleId?: string | null;
  /** Identifie l'occurrence (ex. échéance ciblée) : une récurrence suivante crée une nouvelle alerte. */
  occurrenceKey: string;
  title: string;
  message: string;
  condition: Record<string, unknown>;
  actionPath: string;
  responsibleUserId?: string | null;
}

export interface AlertKey {
  organizationId: string;
  companyId?: string;
  type: AlertType;
  objectType: string;
  objectId: string;
  occurrenceKey?: string;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { INFO: 0, ATTENTION: 1, URGENT: 2, CRITIQUE: 3 };

export type AlertRaisedListener = (alert: { id: string; organizationId: string; companyId: string; severity: AlertSeverity; type: AlertType; created: boolean; escalated: boolean }) => Promise<void>;

/**
 * Cœur des alertes métier (CDC 9.1, 9.2) : création dédupliquée par (organisation, société, type, objet,
 * occurrence), évolution de gravité sur la même alerte, résolution uniquement quand la condition cesse.
 * « Lu » et « reporté » sont des états par destinataire (AlertRecipientState), sans effet sur la résolution.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly listeners: AlertRaisedListener[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  onRaised(listener: AlertRaisedListener): void {
    this.listeners.push(listener);
  }

  /** Crée ou met à jour l'alerte active de cette occurrence ; renvoie son identifiant. */
  async raise(condition: AlertCondition, tx?: Tx): Promise<string> {
    const client = tx ?? this.prisma.client;
    const now = this.clock.now();
    const unique = {
      organizationId: condition.organizationId,
      companyId: condition.companyId,
      type: condition.type,
      objectType: condition.objectType,
      objectId: condition.objectId,
      occurrenceKey: condition.occurrenceKey,
    };
    const existing = await client.alert.findUnique({ where: { organizationId_companyId_type_objectType_objectId_occurrenceKey: unique } });
    let id: string;
    let created = false;
    let escalated = false;
    if (!existing) {
      const alert = await client.alert.create({
        data: {
          ...unique,
          severity: condition.severity,
          status: 'ACTIVE',
          vehicleId: condition.vehicleId ?? null,
          title: condition.title,
          message: condition.message,
          condition: condition.condition as Prisma.InputJsonValue,
          actionPath: condition.actionPath,
          responsibleUserId: condition.responsibleUserId ?? null,
          triggeredAt: now,
          lastEvaluatedAt: now,
        },
      });
      id = alert.id;
      created = true;
    } else {
      escalated = SEVERITY_RANK[condition.severity] > SEVERITY_RANK[existing.severity] || existing.status === 'RESOLUE';
      const changed =
        existing.status !== 'ACTIVE' || existing.severity !== condition.severity || existing.message !== condition.message || existing.title !== condition.title;
      await client.alert.update({
        where: { id: existing.id },
        data: {
          severity: condition.severity,
          status: 'ACTIVE',
          resolvedAt: null,
          resolutionReason: null,
          title: condition.title,
          message: condition.message,
          condition: condition.condition as Prisma.InputJsonValue,
          actionPath: condition.actionPath,
          lastEvaluatedAt: now,
          ...(existing.status === 'RESOLUE' ? { triggeredAt: now } : {}),
          ...(changed ? { version: { increment: 1 } } : {}),
        },
      });
      id = existing.id;
    }
    if ((created || escalated) && !tx) await this.notify(id, condition, created, escalated);
    return id;
  }

  /** Résout les alertes actives correspondant à la clé (condition disparue). */
  async resolve(key: AlertKey, reason: string, tx?: Tx): Promise<number> {
    const client = tx ?? this.prisma.client;
    const result = await client.alert.updateMany({
      where: {
        organizationId: key.organizationId,
        ...(key.companyId ? { companyId: key.companyId } : {}),
        type: key.type,
        objectType: key.objectType,
        objectId: key.objectId,
        ...(key.occurrenceKey ? { occurrenceKey: key.occurrenceKey } : {}),
        status: 'ACTIVE',
      },
      data: { status: 'RESOLUE', resolvedAt: this.clock.now(), resolutionReason: reason, version: { increment: 1 } },
    });
    return result.count;
  }

  /** Résout les autres occurrences actives d'un même objet (ex. nouvelle échéance après entretien). */
  async resolveOtherOccurrences(key: Omit<AlertKey, 'occurrenceKey'>, keepOccurrenceKey: string, reason: string, tx?: Tx): Promise<number> {
    const client = tx ?? this.prisma.client;
    const result = await client.alert.updateMany({
      where: {
        organizationId: key.organizationId,
        ...(key.companyId ? { companyId: key.companyId } : {}),
        type: key.type,
        objectType: key.objectType,
        objectId: key.objectId,
        occurrenceKey: { not: keepOccurrenceKey },
        status: 'ACTIVE',
      },
      data: { status: 'RESOLUE', resolvedAt: this.clock.now(), resolutionReason: reason, version: { increment: 1 } },
    });
    return result.count;
  }

  /** Notifie les écouteurs (e-mail critique, lot D) après validation de la transaction. */
  async notifyAfterCommit(id: string): Promise<void> {
    const alert = await this.prisma.client.alert.findUnique({ where: { id } });
    if (!alert) return;
    for (const listener of this.listeners) {
      try {
        await listener({ id: alert.id, organizationId: alert.organizationId, companyId: alert.companyId, severity: alert.severity, type: alert.type, created: true, escalated: false });
      } catch (error) {
        this.logger.error(`Écouteur d'alerte en échec : ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async notify(id: string, condition: AlertCondition, created: boolean, escalated: boolean): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener({ id, organizationId: condition.organizationId, companyId: condition.companyId, severity: condition.severity, type: condition.type, created, escalated });
      } catch (error) {
        this.logger.error(`Écouteur d'alerte en échec : ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
