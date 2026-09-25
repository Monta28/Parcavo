import { Injectable } from '@nestjs/common';
import type { AlertType } from '@parc-auto/db';
import { Clock } from '../../common/clock.js';
import { PrismaService, type Tx } from '../../infra/prisma.service.js';
import { AlertsService } from '../alerts/alerts.service.js';
import { kindLabel } from './telemetry-settings.js';

/** Types d'alertes propres au module F11 (CDC 9.1). */
export const F11_ALERT_TYPES: readonly AlertType[] = [
  'GPS_SOURCE_MUETTE',
  'GPS_DERIVE',
  'GPS_UNITE_NON_MAPPEE',
  'GPS_SYNCHRO_EN_ECHEC',
  'CARBURANT_BAISSE_ANORMALE',
  'CARBURANT_ECART_TICKET',
  'CARBURANT_REMPLISSAGE_DETECTE',
];

export const UNIT_ALERT_OBJECT = 'TelemetryUnit';
export const MAPPING_ALERT_OBJECT = 'TelemetryVehicleMapping';
export const PROVIDER_ALERT_OBJECT = 'TelemetryProvider';
const UNMAPPED_OCCURRENCE = 'non-associee';

/**
 * Alertes F11 tenues par le cœur du connecteur (D-101, D-249, D-295) :
 *  - GPS_UNITE_NON_MAPPEE (INFO) : unité présente chez un fournisseur ACTIF, non ignorée, sans association
 *    confirmée ni proposition en attente ; une alerte par société couverte où le module est activé ; résolue
 *    dès qu'une association est proposée/confirmée, que l'unité est ignorée (D-249) ou disparaît, ou que la
 *    société sort du module ;
 *  - résolution de toutes les alertes F11 d'une société lorsque le module y est désactivé ;
 *  - résolution des alertes rattachées à une association clôturée ou à un fournisseur suspendu/désactivé.
 */
@Injectable()
export class TelemetryAlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
    private readonly clock: Clock,
  ) {}

  /** Recalcule les alertes « unité non associée » d'un fournisseur (idempotent, dédupliqué). */
  async refreshUnmappedUnitAlerts(organizationId: string, providerId: string): Promise<{ raised: number; resolved: number }> {
    const provider = await this.prisma.client.telemetryProvider.findFirst({
      where: { id: providerId, organizationId },
      select: { id: true, name: true, kind: true, status: true, companies: { select: { companyId: true } } },
    });
    if (!provider) return { raised: 0, resolved: 0 };
    const coveredIds = provider.companies.map((c) => c.companyId);
    const enabledCompanies =
      provider.status === 'ACTIF' && coveredIds.length > 0
        ? await this.prisma.client.company.findMany({ where: { organizationId, id: { in: coveredIds }, telemetryEnabled: true, status: 'ACTIF' }, select: { id: true } })
        : [];
    const units = await this.prisma.client.telemetryUnit.findMany({
      where: { providerId },
      select: {
        id: true,
        externalId: true,
        label: true,
        declaredRegistration: true,
        presentAtProvider: true,
        ignoredAt: true,
        mappings: { where: { OR: [{ status: 'PROPOSE' }, { status: 'CONFIRME', validTo: null }] }, select: { id: true } },
      },
    });
    const wanted = new Set<string>();
    let raised = 0;
    for (const unit of units) {
      // Unité ignorée (remorque, boîtier de rechange ; D-249) : aucune alerte.
      if (!unit.presentAtProvider || unit.ignoredAt !== null || unit.mappings.length > 0) continue;
      for (const company of enabledCompanies) {
        wanted.add(`${unit.id}|${company.id}`);
        await this.alerts.raise({
          organizationId,
          companyId: company.id,
          type: 'GPS_UNITE_NON_MAPPEE',
          severity: 'INFO',
          objectType: UNIT_ALERT_OBJECT,
          objectId: unit.id,
          occurrenceKey: UNMAPPED_OCCURRENCE,
          title: 'Unité télématique non associée',
          message: `L’unité « ${unit.label} » (${kindLabel(provider.kind)}, fournisseur « ${provider.name} »${unit.declaredRegistration ? `, immatriculation déclarée ${unit.declaredRegistration}` : ''}) n’est associée à aucun véhicule : aucune donnée n’est ingérée tant qu’une association n’est pas confirmée.`,
          condition: { providerId, unitExternalId: unit.externalId, declaredRegistration: unit.declaredRegistration },
          actionPath: '/telematique/unites',
        });
        raised += 1;
      }
    }
    const active = await this.prisma.client.alert.findMany({
      where: { organizationId, type: 'GPS_UNITE_NON_MAPPEE', objectType: UNIT_ALERT_OBJECT, objectId: { in: units.map((u) => u.id) }, status: 'ACTIVE' },
      select: { id: true, objectId: true, companyId: true },
    });
    const stale = active.filter((a) => !wanted.has(`${a.objectId}|${a.companyId}`)).map((a) => a.id);
    let resolved = 0;
    if (stale.length > 0) {
      const result = await this.prisma.client.alert.updateMany({
        where: { id: { in: stale }, status: 'ACTIVE' },
        data: { status: 'RESOLUE', resolvedAt: this.clock.now(), resolutionReason: 'Unité associée ou ignorée, absente chez le fournisseur, ou module inactif pour la société.', version: { increment: 1 } },
      });
      resolved = result.count;
    }
    return { raised, resolved };
  }

  /** Unité ignorée (D-249) : alertes « unité non associée » actives de l'unité résolues, avec le motif. */
  async resolveUnmappedUnitAlerts(organizationId: string, unitId: string, reason: string, tx?: Tx): Promise<number> {
    const client = tx ?? this.prisma.client;
    const result = await client.alert.updateMany({
      where: { organizationId, type: 'GPS_UNITE_NON_MAPPEE', objectType: UNIT_ALERT_OBJECT, objectId: unitId, status: 'ACTIVE' },
      data: { status: 'RESOLUE', resolvedAt: this.clock.now(), resolutionReason: reason, version: { increment: 1 } },
    });
    return result.count;
  }

  /** Désactivation du module pour une société (D-101, D-295) : alertes F11 actives résolues. */
  async resolveCompanyAlerts(organizationId: string, companyId: string, reason: string, tx?: Tx): Promise<number> {
    const client = tx ?? this.prisma.client;
    const result = await client.alert.updateMany({
      where: { organizationId, companyId, type: { in: [...F11_ALERT_TYPES] }, status: 'ACTIVE' },
      data: { status: 'RESOLUE', resolvedAt: this.clock.now(), resolutionReason: reason, version: { increment: 1 } },
    });
    return result.count;
  }

  /** Alertes rattachées à un objet F11 (association clôturée, fournisseur suspendu ou désactivé). */
  async resolveObjectAlerts(organizationId: string, objectType: string, objectId: string, reason: string, tx?: Tx): Promise<number> {
    const client = tx ?? this.prisma.client;
    const result = await client.alert.updateMany({
      where: { organizationId, objectType, objectId, type: { in: [...F11_ALERT_TYPES] }, status: 'ACTIVE' },
      data: { status: 'RESOLUE', resolvedAt: this.clock.now(), resolutionReason: reason, version: { increment: 1 } },
    });
    return result.count;
  }
}
