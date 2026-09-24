import { Injectable } from '@nestjs/common';
import type { IncidentSeverity, IncidentType } from '@parc-auto/db';
import type { RequestContext } from '../../common/request-context.js';
import { localDate } from '../../domain/civil-date.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, type Tx } from '../../infra/prisma.service.js';
import { ReferenceService } from '../../infra/reference.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { AlertsService } from '../alerts/alerts.service.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import { eventCompany } from '../vehicles/event-company.js';

/**
 * Incidents (CDC 7.3, D-215 à D-218) — partie livrée avec le lot B : écriture d'un incident dans la transaction
 * de la restitution (dommage constaté, 4.4) et alerte « incident critique non traité ». Les routes /incidents
 * (déclaration, suivi, commentaires, interventions, immobilisations) sont livrées avec le lot C.
 */
@Injectable()
export class IncidentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly attachments: AttachmentsService,
    private readonly alerts: AlertsService,
    private readonly references: ReferenceService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Écriture unique d'un incident dans une transaction existante (déclaration directe ou dommage constaté à
   * la restitution, 4.4) : référence INC-AAAA-NNNNNN de l'année locale, photos rattachées, audit. L'appelant
   * synchronise l'alerte d'incident critique après validation (syncCriticalAlert).
   */
  async insertInTx(
    tx: Tx,
    ctx: RequestContext,
    input: {
      companyId: string;
      vehicleId: string;
      driverId: string | null;
      usageId: string | null;
      type: IncidentType;
      severity: IncidentSeverity;
      occurredAt: Date;
      timezone: string;
      locationLabel: string | null;
      siteId: string | null;
      description: string;
      followUpUserId: string | null;
      photoAttachmentIds: readonly string[];
      audit: Record<string, unknown>;
    },
  ): Promise<{ id: string; reference: string }> {
    // Société à la date du fait (D-121) : un incident antérieur à un transfert appartient à la société d'origine.
    const companyId = await eventCompany(tx, this.access, ctx, { id: input.vehicleId, companyId: input.companyId }, input.occurredAt, 'un incident');
    const reference = await this.references.next(tx, ctx.organizationId, 'INC', Number(localDate(input.occurredAt, input.timezone).slice(0, 4)));
    const incident = await tx.incident.create({
      data: {
        organizationId: ctx.organizationId,
        reference,
        companyId,
        vehicleId: input.vehicleId,
        driverId: input.driverId,
        usageId: input.usageId,
        type: input.type,
        severity: input.severity,
        occurredAt: input.occurredAt,
        locationLabel: input.locationLabel,
        siteId: input.siteId,
        description: input.description,
        followUpUserId: input.followUpUserId,
        reportedById: ctx.userId,
        createdById: ctx.userId,
      },
    });
    for (const photo of input.photoAttachmentIds) await this.attachments.attach(ctx, tx, photo, 'INCIDENT', incident.id, companyId);
    await this.audit.record(ctx, { action: 'incident.declaration', objectType: 'Incident', objectId: incident.id, companyId, after: { reference, type: input.type, severity: input.severity, ...input.audit } }, tx);
    return { id: incident.id, reference };
  }

  /** Alerte « incident critique non traité » (D-218) : CRITIQUE et OUVERT ; résolue au passage en traitement ou si la gravité baisse. */
  async syncCriticalAlert(id: string): Promise<void> {
    const i = await this.prisma.client.incident.findUniqueOrThrow({ where: { id }, include: { vehicle: { select: { code: true } } } });
    const key = { organizationId: i.organizationId, type: 'INCIDENT_CRITIQUE' as const, objectType: 'Incident', objectId: i.id };
    if (i.severity === 'CRITIQUE' && i.status === 'OUVERT') {
      await this.alerts.raise({ ...key, companyId: i.companyId, severity: 'CRITIQUE', vehicleId: i.vehicleId, occurrenceKey: 'ouvert', title: `Incident critique non traité — ${i.vehicle.code}`, message: `${i.reference} : ${i.description.slice(0, 180)}`, condition: { incidentId: i.id, status: i.status, severity: i.severity }, actionPath: `/incidents/${i.id}`, responsibleUserId: i.followUpUserId });
    } else {
      await this.alerts.resolve(key, i.status !== 'OUVERT' ? 'incident pris en charge' : 'gravité abaissée');
    }
  }
}
