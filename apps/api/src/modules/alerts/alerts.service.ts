import { Injectable, Logger } from '@nestjs/common';
import type { AlertSeverity, AlertType, Prisma } from '@parc-auto/db';
import type { AfterCommit } from '../../common/after-commit.js';
import { Clock } from '../../common/clock.js';
import { isEscalationOrReactivation } from '../../domain/alert-policy.js';
import { PrismaService, isUniqueViolation, type Tx } from '../../infra/prisma.service.js';

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

/**
 * Résolution d'une synchronisation groupée : même effet que resolve(key, reason) ou, avec
 * `keepOccurrenceKey`, que resolveOtherOccurrences(key, keepOccurrenceKey, reason).
 */
export interface AlertResolution {
  key: AlertKey;
  keepOccurrenceKey?: string;
  reason: string;
}

/** Alerte telle que lue pour une synchronisation groupée (colonnes utiles au calcul). */
type AlertRow = Prisma.AlertGetPayload<Record<string, never>>;

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

  /**
   * Crée ou met à jour l'alerte active de cette occurrence ; renvoie son identifiant. Idempotent : un
   * recalcul répété ne crée ni doublon ni notification (T19). Deux créations concurrentes de la même
   * occurrence se résolvent sur l'index unique : la seconde met à jour la ligne créée par la première.
   */
  async raise(condition: AlertCondition, tx?: Tx, after?: AfterCommit): Promise<string> {
    try {
      return await this.upsert(condition, tx, after);
    } catch (error) {
      if (!tx && isUniqueViolation(error)) return this.upsert(condition);
      throw error;
    }
  }

  /**
   * Dans une transaction (tx), la notification d'une création ou d'une hausse de gravité n'est émise qu'après
   * validation, par la file `after` fournie par l'appelant ; sans file, elle n'est pas émise (rattrapage).
   */
  private async upsert(condition: AlertCondition, tx?: Tx, after?: AfterCommit): Promise<string> {
    const client = tx ?? this.prisma.client;
    const now = this.clock.now();
    const existing = await client.alert.findUnique({ where: { organizationId_companyId_type_objectType_objectId_occurrenceKey: uniqueKeyOf(condition) } });
    let id: string;
    let created = false;
    let escalated = false;
    if (!existing) {
      const alert = await client.alert.create({ data: creationData(condition, now) });
      id = alert.id;
      created = true;
    } else {
      const update = updateOf(existing, condition, now);
      escalated = update.escalated;
      await client.alert.update({ where: { id: existing.id }, data: update.data });
      id = existing.id;
      if (escalated) {
        // D-252 : une hausse de gravité (ou une réactivation) annule les reports et remet la lecture à zéro.
        await client.alertRecipientState.updateMany({ where: { alertId: existing.id }, data: RECIPIENT_RESET });
      }
    }
    if ((created || escalated) && !tx) await this.notify(id, condition, created, escalated);
    else if ((created || escalated) && after) after.add(`notification de l’alerte ${id}`, () => this.notify(id, condition, created, escalated));
    return id;
  }

  /**
   * Synchronisation groupée des alertes d'un ou plusieurs objets (recalculs d'entretien, fraîcheur) : même
   * effet que les appels unitaires resolve / resolveOtherOccurrences dans l'ordre de `resolutions`, puis
   * raise pour chaque condition de `raises` (règles de création, d'évolution et de notification communes),
   * avec une seule lecture des alertes concernées et des écritures limitées aux lignes à modifier : aucune
   * écriture pour une résolution sans alerte active. Dans une transaction, les notifications partent après
   * validation (after) ; hors transaction, une création concurrente de la même occurrence (index unique)
   * est reprise une fois, comme raise().
   */
  async sync(ops: { resolutions?: readonly AlertResolution[]; raises?: readonly AlertCondition[] }, tx?: Tx, after?: AfterCommit): Promise<void> {
    const resolutions = ops.resolutions ?? [];
    const raises = ops.raises ?? [];
    if (resolutions.length === 0 && raises.length === 0) return;
    const uniqueKeys = raises.map((c) => uniqueKeyOf(c));
    if (new Set(uniqueKeys.map((k) => JSON.stringify(k))).size !== uniqueKeys.length) {
      // Deux conditions sur la même occurrence : l'ordre séquentiel des appels unitaires fait foi.
      for (const r of resolutions) await this.applyResolution(r, tx);
      for (const c of raises) await this.raise(c, tx, after);
      return;
    }
    const client = tx ?? this.prisma.client;
    const rows = await client.alert.findMany({ where: syncReadWhere(resolutions, uniqueKeys) });
    const state = new Map<string, AlertRow>(rows.map((r) => [r.id, { ...r }]));
    // Résolutions dans l'ordre : chaque alerte active est résolue par la première résolution qui la vise.
    const now = this.clock.now();
    const byReason = new Map<string, string[]>();
    for (const r of resolutions) {
      for (const row of state.values()) {
        if (row.status !== 'ACTIVE' || !matchesKey(row, r.key, r.keepOccurrenceKey)) continue;
        row.status = 'RESOLUE';
        row.version += 1;
        byReason.set(r.reason, [...(byReason.get(r.reason) ?? []), row.id]);
      }
    }
    for (const [reason, ids] of byReason) {
      await client.alert.updateMany({ where: { id: { in: ids }, status: 'ACTIVE' }, data: resolutionData(reason, now) });
    }
    if (raises.length === 0) return;
    try {
      await this.applyRaises(client, raises, [...state.values()], tx, after);
    } catch (error) {
      if (tx || !isUniqueViolation(error)) throw error;
      // Création concurrente de la même occurrence hors transaction : relecture puis mise à jour.
      const fresh = await client.alert.findMany({ where: { OR: uniqueKeys } });
      await this.applyRaises(client, raises, fresh, tx, after);
    }
  }

  /** Créations (une requête) puis mises à jour des conditions de `raises`, d'après les alertes existantes lues. */
  private async applyRaises(client: Tx | PrismaService['client'], raises: readonly AlertCondition[], existingRows: readonly AlertRow[], tx: Tx | undefined, after: AfterCommit | undefined): Promise<void> {
    const now = this.clock.now();
    const plans = raises.map((condition) => ({ condition, existing: existingRows.find((row) => sameUniqueKey(row, condition)) ?? null }));
    const toCreate = plans.filter((p) => p.existing === null).map((p) => p.condition);
    const createdRows = toCreate.length > 0 ? await client.alert.createManyAndReturn({ data: toCreate.map((c) => creationData(c, now)), select: { id: true, organizationId: true, companyId: true, type: true, objectType: true, objectId: true, occurrenceKey: true } }) : [];
    const escalatedIds: string[] = [];
    const notifications: Array<{ id: string; condition: AlertCondition; created: boolean; escalated: boolean }> = [];
    for (const { condition, existing } of plans) {
      if (!existing) {
        const row = createdRows.find((r) => sameUniqueKey(r, condition));
        if (!row) throw new Error('Alerte créée introuvable après insertion groupée.');
        notifications.push({ id: row.id, condition, created: true, escalated: false });
        continue;
      }
      const update = updateOf(existing, condition, now);
      await client.alert.update({ where: { id: existing.id }, data: update.data });
      if (update.escalated) {
        escalatedIds.push(existing.id);
        notifications.push({ id: existing.id, condition, created: false, escalated: true });
      }
    }
    // D-252 : une hausse de gravité (ou une réactivation) annule les reports et remet la lecture à zéro.
    if (escalatedIds.length > 0) await client.alertRecipientState.updateMany({ where: { alertId: { in: escalatedIds } }, data: RECIPIENT_RESET });
    for (const n of notifications) {
      if (!tx) await this.notify(n.id, n.condition, n.created, n.escalated);
      else if (after) after.add(`notification de l’alerte ${n.id}`, () => this.notify(n.id, n.condition, n.created, n.escalated));
    }
  }

  private async applyResolution(r: AlertResolution, tx?: Tx): Promise<void> {
    if (r.keepOccurrenceKey !== undefined) await this.resolveOtherOccurrences(r.key, r.keepOccurrenceKey, r.reason, tx);
    else await this.resolve(r.key, r.reason, tx);
  }

  /** Résout les alertes actives correspondant à la clé (condition disparue). */
  async resolve(key: AlertKey, reason: string, tx?: Tx): Promise<number> {
    const client = tx ?? this.prisma.client;
    const result = await client.alert.updateMany({ where: { ...keyWhere(key), status: 'ACTIVE' }, data: resolutionData(reason, this.clock.now()) });
    return result.count;
  }

  /** Résout les autres occurrences actives d'un même objet (ex. nouvelle échéance après entretien). */
  async resolveOtherOccurrences(key: Omit<AlertKey, 'occurrenceKey'>, keepOccurrenceKey: string, reason: string, tx?: Tx): Promise<number> {
    const client = tx ?? this.prisma.client;
    const result = await client.alert.updateMany({ where: { ...keyWhere(key), occurrenceKey: { not: keepOccurrenceKey }, status: 'ACTIVE' }, data: resolutionData(reason, this.clock.now()) });
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

// ---------------------------------------------------------------------------
// Règles communes aux appels unitaires et à la synchronisation groupée
// ---------------------------------------------------------------------------

const RECIPIENT_RESET = { readAt: null, snoozedUntil: null, snoozeReason: null } as const;

function uniqueKeyOf(condition: AlertCondition): { organizationId: string; companyId: string; type: AlertType; objectType: string; objectId: string; occurrenceKey: string } {
  return { organizationId: condition.organizationId, companyId: condition.companyId, type: condition.type, objectType: condition.objectType, objectId: condition.objectId, occurrenceKey: condition.occurrenceKey };
}

function sameUniqueKey(row: Pick<AlertRow, 'organizationId' | 'companyId' | 'type' | 'objectType' | 'objectId' | 'occurrenceKey'>, condition: AlertCondition): boolean {
  return row.organizationId === condition.organizationId && row.companyId === condition.companyId && row.type === condition.type && row.objectType === condition.objectType && row.objectId === condition.objectId && row.occurrenceKey === condition.occurrenceKey;
}

/**
 * Lecture groupée d'une synchronisation : par organisation et type d'objet, les alertes des objets et types
 * concernés, actives (résolutions) ou de l'occurrence visée (créations et mises à jour). Surensemble compact
 * des clés : la sélection exacte est refaite en mémoire (matchesKey, sameUniqueKey).
 */
function syncReadWhere(resolutions: readonly AlertResolution[], uniqueKeys: ReadonlyArray<ReturnType<typeof uniqueKeyOf>>): Prisma.AlertWhereInput {
  const groups = new Map<string, { organizationId: string; objectType: string; types: Set<AlertType>; objectIds: Set<string> }>();
  for (const k of [...resolutions.map((r) => r.key), ...uniqueKeys]) {
    const id = `${k.organizationId}|${k.objectType}`;
    const group = groups.get(id) ?? { organizationId: k.organizationId, objectType: k.objectType, types: new Set<AlertType>(), objectIds: new Set<string>() };
    group.types.add(k.type);
    group.objectIds.add(k.objectId);
    groups.set(id, group);
  }
  const occurrences = [...new Set(uniqueKeys.map((k) => k.occurrenceKey))];
  return {
    OR: [...groups.values()].map((g) => ({
      organizationId: g.organizationId,
      objectType: g.objectType,
      type: { in: [...g.types] },
      objectId: { in: [...g.objectIds] },
      OR: [{ status: 'ACTIVE' as const }, ...(occurrences.length > 0 ? [{ occurrenceKey: { in: occurrences } }] : [])],
    })),
  };
}

/** Filtre d'une clé (société et occurrence facultatives), commun à resolve et à la lecture groupée. */
function keyWhere(key: Omit<AlertKey, 'occurrenceKey'> & { occurrenceKey?: string }): Prisma.AlertWhereInput {
  return {
    organizationId: key.organizationId,
    ...(key.companyId ? { companyId: key.companyId } : {}),
    type: key.type,
    objectType: key.objectType,
    objectId: key.objectId,
    ...(key.occurrenceKey ? { occurrenceKey: key.occurrenceKey } : {}),
  };
}

/** Même sélection que keyWhere (et, le cas échéant, l'exclusion de l'occurrence conservée), en mémoire. */
function matchesKey(row: AlertRow, key: AlertKey, keepOccurrenceKey: string | undefined): boolean {
  return (
    row.organizationId === key.organizationId &&
    (!key.companyId || row.companyId === key.companyId) &&
    row.type === key.type &&
    row.objectType === key.objectType &&
    row.objectId === key.objectId &&
    (!key.occurrenceKey || row.occurrenceKey === key.occurrenceKey) &&
    (keepOccurrenceKey === undefined || row.occurrenceKey !== keepOccurrenceKey)
  );
}

function resolutionData(reason: string, now: Date): Prisma.AlertUpdateManyMutationInput {
  return { status: 'RESOLUE', resolvedAt: now, resolutionReason: reason, version: { increment: 1 } };
}

function creationData(condition: AlertCondition, now: Date): Prisma.AlertUncheckedCreateInput {
  return {
    ...uniqueKeyOf(condition),
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
  };
}

/** Mise à jour de l'alerte existante d'une occurrence : réactivation, gravité, textes et responsable. */
function updateOf(existing: Pick<AlertRow, 'severity' | 'status' | 'message' | 'title' | 'responsibleUserId'>, condition: AlertCondition, now: Date): { escalated: boolean; data: Prisma.AlertUpdateInput } {
  const escalated = isEscalationOrReactivation({ severity: existing.severity, active: existing.status === 'ACTIVE' }, condition.severity);
  // Responsable fourni par la condition (responsable du suivi d'un incident, du plan…) : il suit l'objet source.
  const responsibleChanged = condition.responsibleUserId !== undefined && (condition.responsibleUserId ?? null) !== existing.responsibleUserId;
  const changed = existing.status !== 'ACTIVE' || existing.severity !== condition.severity || existing.message !== condition.message || existing.title !== condition.title || responsibleChanged;
  return {
    escalated,
    data: {
      severity: condition.severity,
      status: 'ACTIVE',
      resolvedAt: null,
      resolutionReason: null,
      title: condition.title,
      message: condition.message,
      condition: condition.condition as Prisma.InputJsonValue,
      actionPath: condition.actionPath,
      ...(condition.responsibleUserId !== undefined ? { responsibleUserId: condition.responsibleUserId ?? null } : {}),
      lastEvaluatedAt: now,
      ...(existing.status === 'RESOLUE' ? { triggeredAt: now, emailNotifiedSeverity: null } : {}),
      ...(changed ? { version: { increment: 1 } } : {}),
    },
  };
}
