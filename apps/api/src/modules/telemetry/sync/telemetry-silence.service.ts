import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { Clock } from '../../../common/clock.js';
import { describeErrorSafely } from '../../../common/secret-redaction.js';
import { PrismaService } from '../../../infra/prisma.service.js';
import { AlertsService } from '../../alerts/alerts.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { MAPPING_ALERT_OBJECT, PROVIDER_ALERT_OBJECT } from '../telemetry-alerts.service.js';
import { kindLabel } from '../telemetry-settings.js';

const HOUR_MS = 3_600_000;
const PROVIDER_SILENCE_OCCURRENCE = 'source-muette';

export interface SilenceSummary {
  /** Associations en alerte « source GPS muette » (par unité). */
  silentMappings: number;
  /** Couples fournisseur-société sans synchronisation réussie au-delà du seuil (alerte agrégée). */
  unreachableProviders: number;
  resolved: number;
}

/**
 * Source GPS muette et fournisseur injoignable (CDC 5.6, 9.1 ; D-100, D-189, D-194, D-249 ; T31, T41) —
 * évaluée à chaque passage du traitement de synchronisation, que le fournisseur réponde ou non :
 *  - fournisseur joignable : pour chaque association ouverte d'un véhicule actif, si maintenant −
 *    max(dernière observation reçue toutes natures, date de confirmation) dépasse
 *    telemetry.silentAfterHours → GPS_SOURCE_MUETTE sur l'association (occurrence = dernière
 *    observation) ; résolue dès qu'un échantillon plus récent arrive ;
 *  - aucune synchronisation réussie du couple fournisseur-société depuis plus que ce seuil → une seule
 *    GPS_SOURCE_MUETTE agrégée sur le fournisseur pour la société (nombre d'unités), sans alertes par unité ;
 *    elle se distingue de GPS_SYNCHRO_EN_ECHEC (coupe-circuit, levée à son ouverture).
 * Le véhicule retombe dans le régime manuel : aucune saisie n'est bloquée, la fraîcheur du kilométrage
 * porte sur la dernière observation acceptée toutes sources, et aucun « suivi en direct » n'est affiché.
 */
@Injectable()
export class TelemetrySilenceService {
  private readonly logger = new Logger('TelemetrieSourceMuette');

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly alerts: AlertsService,
    private readonly clock: Clock,
  ) {}

  async evaluate(now: Date = this.clock.now(), options: { organizationId?: string } = {}): Promise<SilenceSummary> {
    const summary: SilenceSummary = { silentMappings: 0, unreachableProviders: 0, resolved: 0 };
    const providers = await this.prisma.client.telemetryProvider.findMany({
      where: { status: 'ACTIF', ...(options.organizationId ? { organizationId: options.organizationId } : {}) },
      include: { companies: { select: { companyId: true } }, organization: { select: { timezone: true } } },
    });
    const evaluatedMappings = new Set<string>();
    for (const provider of providers) {
      const companies = await this.prisma.client.company.findMany({
        where: { organizationId: provider.organizationId, id: { in: provider.companies.map((c) => c.companyId) }, telemetryEnabled: true, status: 'ACTIF' },
        select: { id: true },
      });
      for (const company of companies) {
        try {
          await this.evaluatePair(provider, company.id, now, summary, evaluatedMappings);
        } catch (error) {
          this.logger.error(`Évaluation « source muette » (fournisseur ${provider.id}, société ${company.id}) en échec : ${describeErrorSafely(error)}`);
        }
      }
    }
    // Associations clôturées, fournisseur inactif ou module désactivé : plus aucune condition active.
    const stale = await this.prisma.client.alert.findMany({
      where: { type: 'GPS_SOURCE_MUETTE', status: 'ACTIVE', objectType: MAPPING_ALERT_OBJECT, ...(options.organizationId ? { organizationId: options.organizationId } : {}) },
      select: { id: true, organizationId: true, objectId: true },
    });
    for (const a of stale) {
      if (evaluatedMappings.has(a.objectId)) continue;
      summary.resolved += await this.alerts.resolve({ organizationId: a.organizationId, type: 'GPS_SOURCE_MUETTE', objectType: MAPPING_ALERT_OBJECT, objectId: a.objectId }, 'Association close, fournisseur inactif ou module désactivé.');
    }
    const staleProviders = await this.prisma.client.alert.findMany({
      where: { type: 'GPS_SOURCE_MUETTE', status: 'ACTIVE', objectType: PROVIDER_ALERT_OBJECT, ...(options.organizationId ? { organizationId: options.organizationId } : {}) },
      select: { organizationId: true, objectId: true, companyId: true },
    });
    for (const a of staleProviders) {
      const provider = providers.find((p) => p.id === a.objectId);
      const stillCovered = provider?.companies.some((c) => c.companyId === a.companyId);
      if (provider && stillCovered) continue;
      summary.resolved += await this.alerts.resolve({ organizationId: a.organizationId, companyId: a.companyId, type: 'GPS_SOURCE_MUETTE', objectType: PROVIDER_ALERT_OBJECT, objectId: a.objectId }, 'Fournisseur inactif ou société non couverte.');
    }
    return summary;
  }

  private async evaluatePair(
    provider: { id: string; organizationId: string; name: string; kind: Parameters<typeof kindLabel>[0]; organization: { timezone: string } },
    companyId: string,
    now: Date,
    summary: SilenceSummary,
    evaluated: Set<string>,
  ): Promise<void> {
    const org = provider.organizationId;
    const silentHours = await this.settings.get(org, 'telemetry.silentAfterHours', companyId);
    const thresholdMs = silentHours * HOUR_MS;
    const mappings = await this.prisma.client.telemetryVehicleMapping.findMany({
      where: { providerId: provider.id, companyId, status: 'CONFIRME', validTo: null },
      include: { unit: { select: { label: true, externalId: true, state: { select: { lastOdometerObservedAt: true, lastFuelObservedAt: true } } } }, vehicle: { select: { id: true, code: true, lifecycleStatus: true } } },
    });
    const providerKey = { organizationId: org, companyId, type: 'GPS_SOURCE_MUETTE' as const, objectType: PROVIDER_ALERT_OBJECT, objectId: provider.id };
    const active = mappings.filter((m) => m.vehicle.lifecycleStatus === 'ACTIF');
    for (const m of mappings) evaluated.add(m.id);
    if (active.length === 0) {
      summary.resolved += await this.alerts.resolve(providerKey, 'Aucune unité associée à un véhicule actif.');
      for (const m of mappings) summary.resolved += await this.alerts.resolve({ organizationId: org, type: 'GPS_SOURCE_MUETTE', objectType: MAPPING_ALERT_OBJECT, objectId: m.id }, 'Véhicule non actif.');
      return;
    }
    const lastSuccess = await this.prisma.client.telemetrySyncRun.findFirst({
      where: { providerId: provider.id, companyId, status: { in: ['SUCCES', 'PARTIEL'] } },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    });
    const expectedSince = Math.min(...active.map((m) => (m.decidedAt ?? m.validFrom ?? m.proposedAt).getTime()));
    const reference = lastSuccess ? lastSuccess.startedAt.getTime() : expectedSince;
    const tz = provider.organization.timezone;

    if (now.getTime() - reference > thresholdMs) {
      // Fournisseur injoignable ou en échec : une alerte agrégée, pas des centaines d'alertes par unité (D-249).
      summary.unreachableProviders += 1;
      await this.alerts.raise({
        ...providerKey,
        severity: 'ATTENTION',
        occurrenceKey: PROVIDER_SILENCE_OCCURRENCE,
        title: `Source GPS muette — fournisseur « ${provider.name} »`,
        message: `${lastSuccess ? `Aucune synchronisation réussie depuis le ${formatLocal(lastSuccess.startedAt, tz)}` : 'Aucune synchronisation réussie depuis la mise en service des associations'} (seuil ${silentHours} h) : ${active.length} véhicule(s) repassent au relevé manuel. ${kindLabel(provider.kind)}. La saisie manuelle reste possible ; aucun suivi en direct n’est affiché.`,
        condition: { providerId: provider.id, lastSuccessAt: lastSuccess?.startedAt.toISOString() ?? null, silentAfterHours: silentHours, units: active.length },
        actionPath: '/telematique',
      });
      for (const m of active) summary.resolved += await this.alerts.resolve({ organizationId: org, type: 'GPS_SOURCE_MUETTE', objectType: MAPPING_ALERT_OBJECT, objectId: m.id }, 'Remplacée par l’alerte agrégée du fournisseur.');
      return;
    }
    summary.resolved += await this.alerts.resolve(providerKey, 'Synchronisation rétablie.');

    for (const m of mappings) {
      const key = { organizationId: org, companyId, type: 'GPS_SOURCE_MUETTE' as const, objectType: MAPPING_ALERT_OBJECT, objectId: m.id };
      if (m.vehicle.lifecycleStatus !== 'ACTIF') {
        summary.resolved += await this.alerts.resolve(key, 'Véhicule non actif.');
        continue;
      }
      const observed = [m.unit.state?.lastOdometerObservedAt, m.unit.state?.lastFuelObservedAt].filter((d): d is Date => d instanceof Date);
      const lastObserved = observed.length > 0 ? new Date(Math.max(...observed.map((d) => d.getTime()))) : null;
      const since = Math.max(lastObserved?.getTime() ?? 0, (m.decidedAt ?? m.validFrom ?? m.proposedAt).getTime());
      if (now.getTime() - since <= thresholdMs) {
        summary.resolved += await this.alerts.resolve(key, 'Donnée reçue de l’unité.');
        continue;
      }
      summary.silentMappings += 1;
      const occurrenceKey = `depuis:${lastObserved ? lastObserved.toISOString() : 'jamais'}`;
      summary.resolved += await this.alerts.resolveOtherOccurrences(key, occurrenceKey, 'Nouvelle observation reçue.');
      await this.alerts.raise({
        ...key,
        severity: 'ATTENTION',
        vehicleId: m.vehicleId,
        occurrenceKey,
        title: `Source GPS muette — ${m.vehicle.code}`,
        message: `${lastObserved ? `Aucune donnée reçue de l’unité « ${m.unit.label} » depuis le ${formatLocal(lastObserved, tz)}` : `Aucune donnée reçue de l’unité « ${m.unit.label} » depuis son association`} (seuil ${silentHours} h) : boîtier débranché, hors couverture ou abonnement suspendu. Le véhicule repasse au relevé manuel.`,
        condition: { mappingId: m.id, unitExternalId: m.unit.externalId, lastObservedAt: lastObserved?.toISOString() ?? null, silentAfterHours: silentHours },
        actionPath: `/vehicules/${m.vehicleId}?onglet=kilometrage`,
      });
    }
  }
}

function formatLocal(at: Date, timezone: string): string {
  return DateTime.fromJSDate(at, { zone: timezone }).toFormat("dd/LL/yyyy 'à' HH:mm");
}
