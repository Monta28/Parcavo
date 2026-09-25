import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Prisma, SyncRunStatus, SyncTrigger } from '@parc-auto/db';
import { Clock } from '../../../common/clock.js';
import { BusinessRuleError, ForbiddenActionError, NotFoundOrOutOfScopeError } from '../../../common/errors.js';
import type { RequestContext } from '../../../common/request-context.js';
import { describeErrorSafely, redactSensitiveText } from '../../../common/secret-redaction.js';
import { AuditService } from '../../../infra/audit.service.js';
import { PrismaService } from '../../../infra/prisma.service.js';
import { AccessControlService } from '../../access-control/access-control.service.js';
import { MANAGER_ROLES } from '../../access-control/permissions.js';
import { AlertsService } from '../../alerts/alerts.service.js';
import { createWebhookBatchAdapter } from '../adapters/webhook.adapter.js';
import { TelemetryAdapterRegistry } from '../telemetry-adapter.registry.js';
import { TelemetryCredentialsService } from '../telemetry-credentials.service.js';
import { PROVIDER_ALERT_OBJECT } from '../telemetry-alerts.service.js';
import { type AdapterDiagnostics, ProviderError, type TelemetryProvider } from '../telemetry-provider.interface.js';
import { TelemetryProvidersService, providerErrorMessage, withDeadline } from '../telemetry-providers.service.js';
import { PROVIDER_TIMEOUT_MS, SIMULATOR_LABEL, kindLabel } from '../telemetry-settings.js';
import { TelemetryUnitsService } from '../telemetry-units.service.js';
import { type WebhookBatch, batchUnits, storedBatch } from '../webhook/telemetry-webhook-format.js';
import type { ManualSyncDto, ManualSyncResultDto, ManualSyncRunDto } from './dto/telemetry-sync.dto.js';
import { TelemetryFuelService } from './telemetry-fuel.service.js';
import { TelemetryLeaseService, discoveryLeaseName, syncLeaseName } from './telemetry-lease.service.js';
import { TelemetryOdometerSyncService, sampleKey } from './telemetry-odometer-sync.service.js';
import { DEFAULT_SYNC_POLICY, type Sleep, callWithRetries, failureTransition, realSleep, scheduleDecision } from './telemetry-resilience.js';
import { mergeCounts, normalizeFuelSamples, normalizeOdometerSamples, summarizeCounts } from './telemetry-samples.js';
import { type SilenceSummary, TelemetrySilenceService } from './telemetry-silence.service.js';
import { TelemetryPurgeService } from './telemetry-purge.service.js';
import { type MappedUnit, type RunCounters, type RunScope, countError, countIssue, newCounters, syncMappingInclude } from './telemetry-sync.types.js';

const DAY_MS = 86_400_000;
const REPRISE_MARKER = 'telemetrie.association.reprise_initiale';
const CIRCUIT_OCCURRENCE = 'coupe-circuit';
const SUMMARY_MAX = 2000;
/** Exécution de découverte restée EN_COURS au-delà de ce délai : interrompue. */
const STALE_DISCOVERY_MS = 60 * 60_000;
/** Lots webhook réservés au plus par fournisseur et par passage du worker (D-298). */
const WEBHOOK_BATCH_SIZE = 20;
/** Tentatives de traitement d'un lot webhook avant l'échec définitif (ECHEC). */
export const WEBHOOK_MAX_ATTEMPTS = 5;
/** Verrou d'un lot en cours de traitement : au-delà, un autre passage le reprend (worker arrêté). */
const WEBHOOK_LOCK_MS = 10 * 60_000;
const WEBHOOK_RETRY_BASE_MS = 30_000;
const WEBHOOK_RETRY_MAX_MS = 30 * 60_000;
/** Report d'un lot dont un couple fournisseur-société est déjà en cours de synchronisation. */
const WEBHOOK_DEFER_MS = 15_000;
/** Conservation des lots terminés (traités, ignorés, en échec) avant suppression. */
export const WEBHOOK_RETENTION_DAYS = 7;

const providerInclude = { companies: { select: { companyId: true } } } satisfies Prisma.TelemetryProviderInclude;
type ProviderRow = Prisma.TelemetryProviderGetPayload<{ include: typeof providerInclude }>;

export interface RunDueOptions {
  /** Titulaire des baux (identifiant du worker) ; défaut : hôte et processus. */
  holder?: string;
  /** Attente entre deux reprises d'un appel (injectable : attente simulée en test). */
  sleep?: Sleep;
  /** Limiter le passage à une organisation. */
  organizationId?: string;
}

export interface SyncRunOutcome {
  runId: string;
  providerId: string;
  companyId: string;
  trigger: SyncTrigger;
  status: SyncRunStatus;
}

export interface RunDueResult {
  runs: SyncRunOutcome[];
  /** Couples échus dont le bail était détenu par une autre exécution. */
  lockedPairs: number;
  /** Listes d'unités demandées (au plus une par heure et par fournisseur). */
  discoveries: number;
  /** Exécutions interrompues (processus arrêté, bail expiré) clôturées en échec. */
  interrupted: number;
  silence: SilenceSummary;
}

export interface RunWebhooksResult {
  /** Lots ingérés (TRAITE). */
  processed: number;
  /** Lots non ingérés : fournisseur non actif ou module non activé pour les sociétés couvertes. */
  ignored: number;
  /** Lots remis en file après un traitement en échec (nouvel essai différé). */
  retried: number;
  /** Lots en échec définitif (tentatives épuisées, contenu illisible). */
  failed: number;
  /** Lots reportés : un couple fournisseur-société était déjà en cours de synchronisation. */
  deferred: number;
  /** Lots repris après l'arrêt d'un worker pendant leur traitement. */
  recovered: number;
  /** Lots terminés supprimés au-delà de la conservation. */
  purged: number;
  /** Anciens secrets de signature supprimés à la fin de leur période de recouvrement. */
  secretsPurged: number;
  runs: SyncRunOutcome[];
}

interface ClaimedDelivery {
  id: string;
  attempts: number;
  payload: Prisma.JsonValue;
}

interface PairPlan {
  companyId: string;
  trigger: SyncTrigger;
  requestedById: string | null;
  /** EXPLICITE : reprise demandée par l'administrateur sur toutes les associations ouvertes. */
  explicitReprise: boolean;
}

interface LeasedPair extends PairPlan {
  runId: string;
  startedAt: Date;
  lease: string;
}

interface SessionOptions {
  holder: string;
  sleep: Sleep;
  /** Essai unique après ouverture du coupe-circuit : aucune reprise dans le run. */
  halfOpen: boolean;
  now: Date;
  /**
   * Quota du fournisseur atteint pendant la session (429 persistant malgré les reprises, ou Retry-After
   * au-delà du plafond) : plus aucun appel jusqu'à la fin de la session, toutes sociétés confondues (D-297).
   */
  quotaExhausted?: boolean;
}

interface CompanyRunResult {
  runId: string;
  companyId: string;
  trigger: SyncTrigger;
  status: SyncRunStatus;
  callsAttempted: number;
  callsSucceeded: number;
  lastError: ProviderError | null;
}

class LeaseLostError extends Error {
  constructor() {
    super('Bail d’exécution perdu (autre exécution ou délai dépassé) : run interrompu.');
    this.name = 'LeaseLostError';
  }
}

/**
 * Moteur de synchronisation télématique (CDC 14.3, 14.4 ; D-100, D-101, D-112, D-186, D-294 à D-297) :
 *  - runDue(now) pour le worker : couples fournisseur ACTIF × société couverte où le module est activé,
 *    un bail telemetry-sync:<fournisseur>:<société> de 5 min renouvelé, un run tracé par couple
 *    (PLANIFIE, REPRISE_INITIALE ou IGNORE sous coupe-circuit), liste des unités au plus une fois par
 *    heure et par fournisseur, reprises 1-4-16 s dans le run, délai exponentiel entre runs,
 *    coupe-circuit (5 échecs, 60 min, essai unique), alerte GPS_SYNCHRO_EN_ECHEC à l'ouverture résolue
 *    au premier succès, puis évaluation « source muette » ;
 *  - requestSync : synchronisation manuelle (administrateur ; chef de parc pour ses sociétés) lancée en
 *    arrière-plan, réponse immédiate avec l'identifiant du run (ou du run déjà en cours) ;
 *  - aucune société sans activation n'est jamais synchronisée (aucun appel externe) ; une panne du
 *    fournisseur n'affecte aucun parcours manuel (les saisies ne dépendent d'aucun appel externe).
 */
@Injectable()
export class TelemetrySyncService implements OnModuleDestroy {
  private readonly logger = new Logger('TelemetrieSynchro');
  private readonly defaultHolder = `${hostname()}:${process.pid}`;
  private readonly policy = DEFAULT_SYNC_POLICY;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly sleep: Sleep = realSleep;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly providers: TelemetryProvidersService,
    private readonly units: TelemetryUnitsService,
    private readonly registry: TelemetryAdapterRegistry,
    private readonly credentials: TelemetryCredentialsService,
    private readonly leases: TelemetryLeaseService,
    private readonly odometer: TelemetryOdometerSyncService,
    private readonly fuel: TelemetryFuelService,
    private readonly silence: TelemetrySilenceService,
    private readonly purge: TelemetryPurgeService,
    private readonly alerts: AlertsService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** Arrêt propre : les synchronisations manuelles en arrière-plan se terminent avant la fermeture. */
  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  // ------------------------------------------------------------------------------------------
  // Worker
  // ------------------------------------------------------------------------------------------

  /** Passage planifié (worker) : runs échus, reprises initiales, puis évaluation « source muette ». */
  async runDue(now: Date = this.clock.now(), options: RunDueOptions = {}): Promise<RunDueResult> {
    const opts = { holder: options.holder ?? this.defaultHolder, sleep: options.sleep ?? this.sleep };
    const result: RunDueResult = { runs: [], lockedPairs: 0, discoveries: 0, interrupted: 0, silence: { silentMappings: 0, unreachableProviders: 0, resolved: 0 } };
    result.interrupted = await this.recoverInterrupted(now, options.organizationId);
    const providers = await this.prisma.client.telemetryProvider.findMany({
      where: { status: 'ACTIF', ...(options.organizationId ? { organizationId: options.organizationId } : {}) },
      include: providerInclude,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const provider of providers) {
      try {
        await this.runProvider(provider, now, opts, result);
      } catch (error) {
        this.logger.error(`Synchronisation du fournisseur ${provider.id} en échec : ${describeErrorSafely(error)}`);
      }
    }
    result.silence = await this.silence.evaluate(now, options.organizationId ? { organizationId: options.organizationId } : {});
    return result;
  }

  /** Purges des échantillons (rétention) : exposée pour le worker. */
  purgeSamples(now: Date = this.clock.now()): ReturnType<TelemetryPurgeService['purgeSamples']> {
    return this.purge.purgeSamples(now);
  }

  private async runProvider(provider: ProviderRow, now: Date, opts: { holder: string; sleep: Sleep }, result: RunDueResult): Promise<void> {
    // Canal WEBHOOK : rien à interroger, les lots poussés sont ingérés par runWebhooks dès leur réception.
    if (provider.channel === 'WEBHOOK') return;
    const companies = await this.enabledCompanies(provider);
    if (companies.length === 0) return; // Aucun appel externe sans activation (17.1, D-101).
    try {
      this.registry.factoryFor(provider.kind);
    } catch (error) {
      this.logger.warn(`Fournisseur ${provider.id} (${provider.kind}) non synchronisable : ${describeErrorSafely(error)}`);
      return;
    }
    const circuitOpen = provider.circuitOpenUntil !== null && provider.circuitOpenUntil.getTime() > now.getTime();
    if (!circuitOpen && provider.consecutiveFailures < this.policy.circuitThreshold) result.discoveries += await this.maybeDiscover(provider, now, opts.holder);

    const plans: PairPlan[] = [];
    let halfOpen = false;
    for (const companyId of companies) {
      const last = await this.prisma.client.telemetrySyncRun.findFirst({ where: { providerId: provider.id, companyId }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], select: { startedAt: true } });
      const pending = await this.mappingsNeedingReprise(provider.organizationId, provider.id, companyId);
      const decision = scheduleDecision(
        { now, lastRunAt: last?.startedAt ?? null, intervalMinutes: provider.syncIntervalMinutes, consecutiveFailures: provider.consecutiveFailures, circuitOpenUntil: provider.circuitOpenUntil, backfillPending: pending.length > 0 },
        this.policy,
      );
      if (decision.kind === 'NOT_DUE') continue;
      if (decision.kind === 'IGNORE') {
        result.runs.push(await this.recordIgnored(provider, companyId, pending.length > 0 ? 'REPRISE_INITIALE' : 'PLANIFIE', null, now));
        continue;
      }
      halfOpen ||= decision.halfOpen;
      plans.push({ companyId, trigger: pending.length > 0 ? 'REPRISE_INITIALE' : 'PLANIFIE', requestedById: null, explicitReprise: false });
    }
    if (plans.length === 0) return;
    // Canal RAPPORT : le lot de fichiers est commun aux sociétés couvertes, traitées ensemble (acquittement unique).
    if (provider.channel === 'RAPPORT') {
      for (const companyId of companies) if (!plans.some((p) => p.companyId === companyId)) plans.push({ companyId, trigger: 'PLANIFIE', requestedById: null, explicitReprise: false });
    }
    const session = { ...opts, halfOpen, now };
    const { leased, locked } = await this.leasePairs(provider, plans, session);
    result.lockedPairs += locked.length;
    if (leased.length === 0) return;
    const outcomes = await this.runLeased(provider, leased, session);
    result.runs.push(...outcomes.map((o) => ({ runId: o.runId, providerId: provider.id, companyId: o.companyId, trigger: o.trigger, status: o.status })));
  }

  // ------------------------------------------------------------------------------------------
  // Lots poussés par webhook (canal WEBHOOK, D-298) — worker uniquement
  // ------------------------------------------------------------------------------------------

  /**
   * Traitement de la file des lots webhook (worker, R-14.4-02, R-14.4-X01) : pour chaque fournisseur ACTIF
   * de canal WEBHOOK, réserve les lots en attente (FOR UPDATE SKIP LOCKED + verrou temporel), puis les
   * ingère par la même exécution que la synchronisation : un run WEBHOOK par société activée couverte,
   * sous le bail du couple, avec les mêmes contrôles (associations confirmées couvrant l'instant,
   * normalisation, idempotence par échantillon, carburant, alertes). Un lot rejoué ne crée donc aucun
   * doublon. Fournisseur non actif ou module non activé : le lot est ignoré, jamais ingéré. Un échec
   * technique remet le lot en file (délai croissant) jusqu'à WEBHOOK_MAX_ATTEMPTS.
   */
  async runWebhooks(now: Date = this.clock.now(), options: RunDueOptions = {}): Promise<RunWebhooksResult> {
    const opts = { holder: options.holder ?? this.defaultHolder, sleep: options.sleep ?? this.sleep };
    const org = options.organizationId ? { organizationId: options.organizationId } : {};
    const result: RunWebhooksResult = { processed: 0, ignored: 0, retried: 0, failed: 0, deferred: 0, recovered: 0, purged: 0, secretsPurged: 0, runs: [] };
    // Verrou échu (worker arrêté ou erreur imprévue pendant le traitement) : reprise bornée comme les
    // autres échecs — tentatives épuisées → échec définitif, sinon remise en file.
    const abandoned = await this.prisma.client.telemetryWebhookDelivery.updateMany({
      where: { ...org, status: 'EN_COURS', lockedUntil: { lt: now }, attempts: { gte: WEBHOOK_MAX_ATTEMPTS } },
      data: { status: 'ECHEC', processedAt: now, lockedBy: null, lockedUntil: null, lastError: `Traitement interrompu à chacune des ${WEBHOOK_MAX_ATTEMPTS} tentatives (worker arrêté ou erreur imprévue) : lot abandonné.` },
    });
    result.failed += abandoned.count;
    const recovered = await this.prisma.client.telemetryWebhookDelivery.updateMany({
      where: { ...org, status: 'EN_COURS', lockedUntil: { lt: now }, attempts: { lt: WEBHOOK_MAX_ATTEMPTS } },
      data: { status: 'EN_ATTENTE', lockedBy: null, lockedUntil: null, nextAttemptAt: now },
    });
    result.recovered = recovered.count;
    const inactive = await this.prisma.client.telemetryWebhookDelivery.updateMany({
      where: { ...org, status: 'EN_ATTENTE', provider: { OR: [{ status: { not: 'ACTIF' } }, { channel: { not: 'WEBHOOK' } }] } },
      data: { status: 'IGNORE', processedAt: now, lastError: 'Fournisseur non actif au moment du traitement : lot non ingéré.' },
    });
    result.ignored += inactive.count;
    const providers = await this.prisma.client.telemetryProvider.findMany({
      where: { ...org, status: 'ACTIF', channel: 'WEBHOOK', webhookDeliveries: { some: { status: 'EN_ATTENTE', nextAttemptAt: { lte: now } } } },
      include: providerInclude,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const provider of providers) {
      try {
        await this.runWebhookProvider(provider, now, opts, result);
      } catch (error) {
        this.logger.error(`Traitement des lots webhook du fournisseur ${provider.id} en échec : ${describeErrorSafely(error)}`);
      }
    }
    const purged = await this.prisma.client.telemetryWebhookDelivery.deleteMany({
      where: { ...org, status: { in: ['TRAITE', 'IGNORE', 'ECHEC'] }, processedAt: { lt: new Date(now.getTime() - WEBHOOK_RETENTION_DAYS * DAY_MS) } },
    });
    result.purged = purged.count;
    result.secretsPurged = await this.credentials.purgeExpiredSigningSecrets(now);
    return result;
  }

  private async runWebhookProvider(provider: ProviderRow, now: Date, opts: { holder: string; sleep: Sleep }, result: RunWebhooksResult): Promise<void> {
    const claimed = await this.claimWebhookDeliveries(provider.id, opts.holder, now);
    if (claimed.length === 0) return;
    const companies = await this.enabledCompanies(provider);
    if (companies.length === 0) {
      result.ignored += await this.finishDeliveries(claimed, opts.holder, 'IGNORE', now, null, 'Module télématique non activé pour les sociétés couvertes : lot non ingéré (D-101).');
      return;
    }
    const readable: Array<{ delivery: ClaimedDelivery; batch: WebhookBatch }> = [];
    const unreadable: ClaimedDelivery[] = [];
    for (const delivery of claimed) {
      const batch = storedBatch(delivery.payload);
      if (batch) readable.push({ delivery, batch });
      else unreadable.push(delivery);
    }
    if (unreadable.length > 0) result.failed += await this.finishDeliveries(unreadable, opts.holder, 'ECHEC', now, null, 'Lot illisible (format non reconnu) : non ingéré.');
    if (readable.length === 0) return;
    const deliveries = readable.map((r) => r.delivery);

    // Le lot est commun aux sociétés couvertes : tous les baux des couples, ou report du lot.
    const leases: string[] = [];
    for (const companyId of companies) {
      const lease = syncLeaseName(provider.id, companyId);
      if (!(await this.leases.acquire(lease, opts.holder, this.policy.leaseTtlMs, this.clock.now()))) {
        for (const held of leases) await this.leases.release(held, opts.holder, this.clock.now());
        await this.prisma.client.telemetryWebhookDelivery.updateMany({
          where: { id: { in: deliveries.map((d) => d.id) }, lockedBy: opts.holder, status: 'EN_COURS' },
          data: { status: 'EN_ATTENTE', lockedBy: null, lockedUntil: null, attempts: { decrement: 1 }, nextAttemptAt: new Date(now.getTime() + WEBHOOK_DEFER_MS) },
        });
        result.deferred += deliveries.length;
        return;
      }
      leases.push(lease);
    }
    const session: SessionOptions = { holder: opts.holder, sleep: opts.sleep, halfOpen: false, now };
    const batches = readable.map((r) => r.batch);
    const adapter = createWebhookBatchAdapter(batches, this.clock);
    const results: CompanyRunResult[] = [];
    try {
      const pairs: LeasedPair[] = [];
      for (const companyId of companies) {
        const startedAt = this.clock.now();
        const run = await this.prisma.client.telemetrySyncRun.create({
          data: { organizationId: provider.organizationId, providerId: provider.id, companyId, trigger: 'WEBHOOK', status: 'EN_COURS', startedAt },
          select: { id: true },
        });
        pairs.push({ companyId, trigger: 'WEBHOOK', requestedById: null, explicitReprise: false, runId: run.id, startedAt, lease: syncLeaseName(provider.id, companyId) });
      }
      for (const pair of pairs) results.push(await this.executeCompanyRun(adapter, provider, pair, session));
      await this.recordWebhookUnits(provider, adapter, batches, now);
    } finally {
      // Baux libérés quoi qu'il arrive ; un lot resté EN_COURS après une erreur imprévue est repris à l'échéance de son verrou.
      for (const lease of leases) await this.leases.release(lease, opts.holder, this.clock.now());
    }
    await this.updateProviderHealth(provider, results, now);
    result.runs.push(...results.map((o) => ({ runId: o.runId, providerId: provider.id, companyId: o.companyId, trigger: o.trigger, status: o.status })));
    const summary = { runs: results.map((o) => ({ runId: o.runId, companyId: o.companyId, status: o.status })) } satisfies Prisma.InputJsonValue;
    const failedRuns = results.filter((o) => o.status === 'ECHEC');
    if (failedRuns.length === 0) {
      result.processed += await this.finishDeliveries(deliveries, opts.holder, 'TRAITE', now, summary, null);
      return;
    }
    // Échec technique : nouvel essai du lot entier (ingestion idempotente), puis échec définitif.
    const message = `Traitement en échec pour ${failedRuns.length} société(s) (voir les exécutions ${failedRuns.map((o) => o.runId).join(', ')}).`;
    const exhausted = deliveries.filter((d) => d.attempts >= WEBHOOK_MAX_ATTEMPTS);
    const again = deliveries.filter((d) => d.attempts < WEBHOOK_MAX_ATTEMPTS);
    if (exhausted.length > 0) result.failed += await this.finishDeliveries(exhausted, opts.holder, 'ECHEC', now, summary, `${message} Tentatives épuisées.`);
    for (const d of again) {
      const delay = Math.min(WEBHOOK_RETRY_MAX_MS, WEBHOOK_RETRY_BASE_MS * 2 ** Math.max(0, d.attempts - 1));
      const updated = await this.prisma.client.telemetryWebhookDelivery.updateMany({
        where: { id: d.id, lockedBy: opts.holder, status: 'EN_COURS' },
        data: { status: 'EN_ATTENTE', lockedBy: null, lockedUntil: null, nextAttemptAt: new Date(now.getTime() + delay), result: summary, lastError: `${message} Nouvel essai prévu.` },
      });
      result.retried += updated.count;
    }
  }

  /** Réserve les lots échus d'un fournisseur (deux workers ne réservent jamais le même lot). */
  private async claimWebhookDeliveries(providerId: string, holder: string, now: Date): Promise<ClaimedDelivery[]> {
    const lockedUntil = new Date(now.getTime() + WEBHOOK_LOCK_MS);
    const claimed = await this.prisma.client.$queryRaw<Array<{ id: string }>>`
      UPDATE "TelemetryWebhookDelivery"
      SET "status" = 'EN_COURS', "lockedBy" = ${holder}, "lockedUntil" = ${lockedUntil}, "attempts" = "attempts" + 1
      WHERE "id" IN (
        SELECT "id" FROM "TelemetryWebhookDelivery"
        WHERE "providerId" = ${providerId}::uuid AND "status" = 'EN_ATTENTE' AND "nextAttemptAt" <= ${now}
        ORDER BY "receivedAt" ASC, "id" ASC
        LIMIT ${WEBHOOK_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id"`;
    if (claimed.length === 0) return [];
    return this.prisma.client.telemetryWebhookDelivery.findMany({
      where: { id: { in: claimed.map((c) => c.id) } },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, attempts: true, payload: true },
    });
  }

  private async finishDeliveries(
    deliveries: readonly ClaimedDelivery[],
    holder: string,
    status: 'TRAITE' | 'IGNORE' | 'ECHEC',
    now: Date,
    summary: Prisma.InputJsonValue | null,
    lastError: string | null,
  ): Promise<number> {
    const updated = await this.prisma.client.telemetryWebhookDelivery.updateMany({
      where: { id: { in: deliveries.map((d) => d.id) }, lockedBy: holder, status: 'EN_COURS' },
      data: { status, processedAt: now, lockedBy: null, lockedUntil: null, lastError, ...(summary !== null ? { result: summary } : {}) },
    });
    return updated.count;
  }

  /**
   * Unités vues dans les lots (liste partielle, comme le canal RAPPORT) : enregistrées et proposées à
   * l'association si l'une est nouvelle ou n'a pas été vue depuis l'intervalle de découverte (D-296).
   */
  private async recordWebhookUnits(provider: ProviderRow, adapter: TelemetryProvider, batches: readonly WebhookBatch[], now: Date): Promise<void> {
    const ids = batchUnits(batches).map((u) => u.externalId);
    if (ids.length === 0) return;
    const known = await this.prisma.client.telemetryUnit.findMany({ where: { providerId: provider.id, externalId: { in: ids } }, select: { lastSeenAt: true } });
    const stale = known.length < ids.length || known.some((u) => now.getTime() - u.lastSeenAt.getTime() >= this.policy.discoveryEveryMs);
    if (stale) await this.units.recordListingFromAdapter(provider, adapter);
  }

  // ------------------------------------------------------------------------------------------
  // Synchronisation manuelle (POST /telemetry/providers/:id/sync)
  // ------------------------------------------------------------------------------------------

  async requestSync(ctx: RequestContext, providerId: string, dto: ManualSyncDto): Promise<ManualSyncResultDto> {
    const provider = await this.providers.loadVisible(ctx, providerId);
    const covered = provider.companies.map((c) => c.companyId);
    const managed = ctx.isAdmin ? covered : this.access.companiesWithRole(ctx, MANAGER_ROLES).filter((c) => covered.includes(c));
    if (managed.length === 0) throw new ForbiddenActionError('Synchronisation réservée à l’administrateur ou au chef de parc d’une société couverte.');
    if (dto.reprise && !ctx.isAdmin) throw new ForbiddenActionError('La reprise d’historique est réservée à l’administrateur (D-101).');
    if (dto.companyId) {
      if (!covered.includes(dto.companyId) || !this.access.canReadCompany(ctx, dto.companyId)) throw new NotFoundOrOutOfScopeError('Société');
      if (!managed.includes(dto.companyId)) throw new ForbiddenActionError('Synchronisation réservée au chef de parc de cette société ou à l’administrateur.');
    }
    if (provider.status !== 'ACTIF') throw new BusinessRuleError('FOURNISSEUR_INACTIF', 'Synchronisation impossible : le fournisseur n’est pas actif.');
    if (provider.channel === 'WEBHOOK') {
      throw new BusinessRuleError('SYNCHRO_PAR_WEBHOOK', 'Ce fournisseur pousse ses données par webhook : chaque lot reçu est ingéré automatiquement, sans synchronisation manuelle.');
    }
    this.registry.factoryFor(provider.kind);
    const wanted = dto.companyId ? [dto.companyId] : managed;
    const enabled = (await this.enabledCompanies(provider)).filter((c) => wanted.includes(c));
    if (enabled.length === 0) throw new BusinessRuleError('TELEMETRIE_DESACTIVEE', 'Le module télématique n’est activé pour aucune des sociétés demandées.');

    const now = this.clock.now();
    const trigger: SyncTrigger = dto.reprise ? 'REPRISE_INITIALE' : 'MANUEL';
    await this.audit.record(ctx, { action: 'telemetrie.synchronisation.demande', objectType: 'TelemetryProvider', objectId: provider.id, after: { companyIds: enabled, trigger } });

    if (provider.circuitOpenUntil && provider.circuitOpenUntil.getTime() > now.getTime()) {
      const runs: ManualSyncRunDto[] = [];
      for (const companyId of enabled) {
        const ignored = await this.recordIgnored(provider, companyId, trigger, ctx.userId, now);
        runs.push({ syncRunId: ignored.runId, companyId, trigger, status: 'IGNORE', alreadyRunning: false, message: this.ignoreMessage(provider, provider.circuitOpenUntil) });
      }
      return { providerId: provider.id, runs };
    }

    const plans: PairPlan[] = enabled.map((companyId) => ({ companyId, trigger, requestedById: ctx.userId, explicitReprise: dto.reprise === true }));
    if (provider.channel === 'RAPPORT') {
      // Lot de fichiers commun : toutes les sociétés activées couvertes sont traitées ensemble (réponse limitée au périmètre).
      for (const companyId of await this.enabledCompanies(provider)) if (!plans.some((p) => p.companyId === companyId)) plans.push({ companyId, trigger: 'MANUEL', requestedById: ctx.userId, explicitReprise: false });
    }
    const session: SessionOptions = { holder: `manuel:${randomUUID()}`, sleep: this.sleep, halfOpen: provider.consecutiveFailures >= this.policy.circuitThreshold, now };
    const { leased, locked } = await this.leasePairs(provider, plans, session);
    const runs: ManualSyncRunDto[] = [];
    for (const pair of leased) {
      if (enabled.includes(pair.companyId)) runs.push({ syncRunId: pair.runId, companyId: pair.companyId, trigger: pair.trigger, status: 'EN_COURS', alreadyRunning: false, message: 'Synchronisation lancée : suivez son résultat dans les exécutions.' });
    }
    for (const companyId of locked) {
      if (!enabled.includes(companyId)) continue;
      const running = await this.prisma.client.telemetrySyncRun.findFirst({ where: { providerId: provider.id, companyId, status: 'EN_COURS' }, orderBy: { startedAt: 'desc' }, select: { id: true, trigger: true } });
      runs.push({ syncRunId: running?.id ?? null, companyId, trigger: running?.trigger ?? trigger, status: 'EN_COURS', alreadyRunning: true, message: 'Une synchronisation est déjà en cours pour cette société.' });
    }
    if (leased.length > 0) {
      const task = this.runLeased(provider, leased, session)
        .then(() => undefined)
        .catch((error: unknown) => this.logger.error(`Synchronisation manuelle du fournisseur ${provider.id} en échec : ${describeErrorSafely(error)}`));
      this.inFlight.add(task);
      void task.finally(() => this.inFlight.delete(task));
    }
    return { providerId: provider.id, runs };
  }

  // ------------------------------------------------------------------------------------------
  // Exécution d'une session fournisseur (un adaptateur, un run par société)
  // ------------------------------------------------------------------------------------------

  /** Prend les baux et crée les runs EN_COURS ; renvoie les sociétés dont le bail est détenu ailleurs. */
  private async leasePairs(provider: ProviderRow, plans: PairPlan[], session: SessionOptions): Promise<{ leased: LeasedPair[]; locked: string[] }> {
    const leased: LeasedPair[] = [];
    const locked: string[] = [];
    for (const plan of plans) {
      const lease = syncLeaseName(provider.id, plan.companyId);
      if (!(await this.leases.acquire(lease, session.holder, this.policy.leaseTtlMs, this.clock.now()))) {
        locked.push(plan.companyId);
        continue;
      }
      const startedAt = this.clock.now();
      const run = await this.prisma.client.telemetrySyncRun.create({
        data: { organizationId: provider.organizationId, providerId: provider.id, companyId: plan.companyId, trigger: plan.trigger, status: 'EN_COURS', startedAt, requestedById: plan.requestedById },
        select: { id: true },
      });
      leased.push({ ...plan, runId: run.id, startedAt, lease });
    }
    return { leased, locked };
  }

  private async runLeased(provider: ProviderRow, pairs: LeasedPair[], session: SessionOptions): Promise<CompanyRunResult[]> {
    const results: CompanyRunResult[] = [];
    try {
      await this.registry.withAdapter(
        provider,
        async (adapter) => {
          for (const pair of pairs) results.push(await this.executeCompanyRun(adapter, provider, pair, session));
          const readOk = results.some((r) => r.callsSucceeded > 0) && results.every((r) => r.status === 'SUCCES' || r.status === 'PARTIEL' || r.callsAttempted === 0);
          // Liste partielle (RAPPORT) : les unités des fichiers lus sont enregistrées avant leur acquittement,
          // sinon la découverte horaire ne les verrait jamais (fichiers déjà marqués lus ou déplacés).
          if (adapter.partialUnitList === true && readOk) await this.units.recordListingFromAdapter(provider, adapter);
          if (adapter.acknowledge && readOk) {
            try {
              await adapter.acknowledge();
            } catch (error) {
              this.logger.warn(`Acquittement des fichiers du fournisseur ${provider.id} en échec (relus au prochain run, idempotence ligne par ligne) : ${describeErrorSafely(error)}`);
            }
          }
        },
        { syncRunId: pairs[0]?.runId ?? null },
      );
    } catch (error) {
      // Adaptateur impossible à ouvrir (secret illisible, configuration invalide) ou erreur imprévue.
      const providerError = error instanceof ProviderError ? error : new ProviderError('CONFIGURATION', describeErrorSafely(error));
      const message = providerErrorMessage(providerError);
      for (const pair of pairs) {
        if (results.some((r) => r.runId === pair.runId)) continue;
        await this.finishRun(pair, 'ECHEC', newCounters(), 0, message, 1);
        results.push({ runId: pair.runId, companyId: pair.companyId, trigger: pair.trigger, status: 'ECHEC', callsAttempted: 1, callsSucceeded: 0, lastError: providerError });
      }
      this.logger.warn(`Synchronisation du fournisseur ${provider.id} (${provider.kind}) en échec : ${message}`);
    } finally {
      for (const pair of pairs) await this.leases.release(pair.lease, session.holder, this.clock.now());
    }
    await this.updateProviderHealth(provider, results, session.now);
    return results;
  }

  private async executeCompanyRun(adapter: TelemetryProvider, provider: ProviderRow, pair: LeasedPair, session: SessionOptions): Promise<CompanyRunResult> {
    const counters = newCounters();
    // D-303 : une exécution du simulateur est libellée comme telle partout où elle est consultée.
    if (provider.kind === 'SIMULATEUR') counters.notes.push(`${SIMULATOR_LABEL} : exécution sur des données simulées.`);
    const outcome: CompanyRunResult = { runId: pair.runId, companyId: pair.companyId, trigger: pair.trigger, status: 'ECHEC', callsAttempted: 0, callsSucceeded: 0, lastError: null };
    const diagnosticsBefore = adapter.diagnostics?.() ?? null;
    let unitsSeen = 0;
    try {
      const company = await this.prisma.client.company.findFirst({ where: { id: pair.companyId, organizationId: provider.organizationId }, select: { telemetryEnabled: true, status: true } });
      if (!company?.telemetryEnabled || company.status !== 'ACTIF') {
        outcome.status = 'IGNORE';
        await this.finishRun(pair, 'IGNORE', counters, 0, 'Module télématique désactivé pour la société : aucun appel au fournisseur (D-101).');
        return outcome;
      }
      const org = await this.prisma.client.organization.findUniqueOrThrow({ where: { id: provider.organizationId }, select: { timezone: true } });
      const units = await this.loadMappedUnits(provider, pair.companyId, counters);
      unitsSeen = units.size;
      if (units.size === 0) {
        counters.notes.push('Aucune unité associée et confirmée pour cette société : aucun appel au fournisseur.');
        outcome.status = 'SUCCES';
        await this.finishRun(pair, 'SUCCES', counters, 0);
        return outcome;
      }
      const reprise = await this.repriseWindows(provider, pair, units, session.now);
      const scope: RunScope = {
        runId: pair.runId,
        trigger: pair.trigger,
        organizationId: provider.organizationId,
        companyId: pair.companyId,
        provider: { id: provider.id, kind: provider.kind, channel: provider.channel, backfillDays: provider.backfillDays },
        now: session.now,
        timezone: org.timezone,
        backfillMappingIds: new Set(reprise.keys()),
      };
      // Aucune reprise dans le run pour un lot déjà reçu (RAPPORT, WEBHOOK) : il est lu une seule fois.
      const retries = !session.halfOpen && provider.channel !== 'RAPPORT' && provider.channel !== 'WEBHOOK';
      let callsSkipped = 0;
      const call = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
        if (session.quotaExhausted) {
          // Respect du quota (14.4, D-297) : aucun nouvel appel après un 429 non résorbé dans la session.
          callsSkipped += 1;
          countIssue(counters, `${label} non tenté : quota du fournisseur atteint pendant cette synchronisation`);
          return null;
        }
        outcome.callsAttempted += 1;
        try {
          const { value } = await callWithRetries(fn, {
            // Bail renouvelé avant chaque attente : reprises et Retry-After ne le laissent jamais expirer.
            sleep: async (ms) => {
              await this.renewLease(pair, session);
              await session.sleep(ms);
            },
            retries,
            policy: this.policy,
            onRetry: (error, waitMs, index) => this.logger.warn(`${label} — fournisseur ${provider.id}, reprise ${index + 1} dans ${waitMs} ms : ${describeErrorSafely(error)}`),
          });
          outcome.callsSucceeded += 1;
          return value;
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          // Assaini pendant l'appel (secrets déchiffrés encore suivis) : l'erreur sert ensuite hors de ce périmètre.
          const safe = new ProviderError(error.kind, describeErrorSafely(error, [], 1000), error.retryAfterSeconds);
          outcome.lastError = safe;
          if (safe.kind === 'QUOTA') session.quotaExhausted = true;
          countError(counters, `${label} en échec : ${providerErrorMessage(safe)}`);
          return null;
        } finally {
          await this.renewLease(pair, session);
        }
      };

      const all = [...units.values()];
      const odometerUnits = all.filter((u) => u.mappings.some((m) => m.odometerKind !== 'AUCUN')).map((u) => u.externalId);
      const fuelUnits = all.filter((u) => u.mappings.some((m) => m.fuelKinds.length > 0));
      const current = odometerUnits.length > 0 ? ((await call('Relevés kilométriques', () => withDeadline(adapter.getOdometers(odometerUnits), PROVIDER_TIMEOUT_MS * 2))) ?? []) : [];

      // Reprise initiale (14.4, D-294) : historique sur la période de reprise si le canal le permet.
      const repriseUnits = all.filter((u) => u.mappings.some((m) => reprise.has(m.id) && m.odometerKind !== 'AUCUN'));
      let history: typeof current = [];
      let repriseDone = reprise.size > 0;
      if (repriseUnits.length > 0) {
        if (adapter.getOdometerHistory) {
          const from = new Date(Math.min(...[...reprise.values()].map((d) => d.getTime())));
          const fetched = await call('Historique kilométrique (reprise initiale)', () => withDeadline((adapter.getOdometerHistory as NonNullable<TelemetryProvider['getOdometerHistory']>)(repriseUnits.map((u) => u.externalId), from, session.now), PROVIDER_TIMEOUT_MS * 4));
          repriseDone = fetched !== null;
          history = (fetched ?? []).filter((s) => {
            const unit = units.get(s.unitExternalId);
            const start = unit ? Math.min(...unit.mappings.filter((m) => reprise.has(m.id)).map((m) => (reprise.get(m.id) as Date).getTime())) : Number.POSITIVE_INFINITY;
            return s.observedAt instanceof Date && s.observedAt.getTime() >= start;
          });
          if (repriseDone) counters.notes.push(`Reprise initiale : historique récupéré depuis le ${from.toISOString()}.`);
        } else {
          counters.notes.push('Reprise initiale : historique non disponible chez ce fournisseur, état courant seulement (D-294).');
        }
      }

      const fuelFrom = this.fuelWindowStart(fuelUnits, reprise, provider.backfillDays, session.now);
      const fuelRaw = fuelUnits.length > 0 ? ((await call('Carburant', () => withDeadline(adapter.getFuel(fuelUnits.map((u) => u.externalId), fuelFrom, session.now), PROVIDER_TIMEOUT_MS * 2))) ?? []) : [];

      if (outcome.callsSucceeded === 0 && (outcome.callsAttempted > 0 || callsSkipped > 0)) {
        // Aucun appel abouti : échec, ou IGNORE si tous les appels ont été retenus par le quota du fournisseur.
        outcome.status = outcome.callsAttempted > 0 ? 'ECHEC' : 'IGNORE';
        await this.finishRun(pair, outcome.status, counters, unitsSeen);
        return outcome;
      }

      // Kilométrage : état courant et historique fusionnés (idempotence par échantillon).
      const odometer = normalizeOdometerSamples([...history, ...current], { providerId: provider.id, unitExternalIds: new Set(odometerUnits), now: session.now });
      mergeCounts(counters.issues, odometer.rejected);
      counters.errors += Object.values(odometer.rejected).reduce((a, b) => a + b, 0);
      counters.duplicatesIgnored += odometer.duplicates;
      countError(counters, 'échantillon reçu deux fois avec des valeurs différentes (premier conservé)', odometer.conflicts);
      const currentKeys = new Set(current.filter((s) => s.observedAt instanceof Date).map((s) => sampleKey(s)));
      const historyKeys = new Set(history.filter((s) => s.observedAt instanceof Date).map((s) => sampleKey(s)).filter((k) => !currentKeys.has(k)));
      await this.odometer.process(scope, units, odometer.samples, historyKeys, counters);
      await this.renewLease(pair, session);

      // Carburant : échantillons, événements dérivés, rapprochement des tickets.
      const fuel = normalizeFuelSamples(fuelRaw, { unitExternalIds: new Set(fuelUnits.map((u) => u.externalId)), now: session.now });
      mergeCounts(counters.issues, fuel.rejected);
      counters.errors += Object.values(fuel.rejected).reduce((a, b) => a + b, 0);
      counters.duplicatesIgnored += fuel.duplicates;
      countError(counters, 'échantillon carburant reçu deux fois avec des valeurs différentes (premier conservé)', fuel.conflicts);
      await this.fuel.process(scope, units, fuel.samples, counters);
      const justified = await this.fuel.rematchPendingFills(provider.organizationId, pair.companyId, session.now);
      if (justified > 0) counters.notes.push(`${justified} remplissage(s) rapproché(s) d’un plein saisi depuis la détection.`);

      if (reprise.size > 0 && repriseDone) {
        for (const [mappingId, from] of reprise) {
          await this.audit.recordSystem(provider.organizationId, {
            action: REPRISE_MARKER,
            objectType: 'TelemetryVehicleMapping',
            objectId: mappingId,
            companyId: pair.companyId,
            after: { syncRunId: pair.runId, from: from.toISOString(), to: session.now.toISOString(), historique: Boolean(adapter.getOdometerHistory) },
          });
        }
      }
      mergeCounts(counters.issues, diagnosticsDelta(diagnosticsBefore, adapter.diagnostics?.() ?? null, counters));
      outcome.status = outcome.callsSucceeded < outcome.callsAttempted || callsSkipped > 0 || counters.errors > 0 ? 'PARTIEL' : 'SUCCES';
      await this.finishRun(pair, outcome.status, counters, unitsSeen);
      return outcome;
    } catch (error) {
      outcome.status = 'ECHEC';
      const message = error instanceof LeaseLostError ? error.message : `Erreur technique : ${describeErrorSafely(error)}`;
      if (!(error instanceof LeaseLostError)) this.logger.error(`Run ${pair.runId} (fournisseur ${provider.id}) en échec : ${describeErrorSafely(error)}`);
      await this.finishRun(pair, 'ECHEC', counters, unitsSeen, message, 1);
      return outcome;
    }
  }

  /** Renouvelle le bail du couple ; un bail perdu interrompt le run (une autre exécution a la main). */
  private async renewLease(pair: LeasedPair, session: SessionOptions): Promise<void> {
    if (!(await this.leases.acquire(pair.lease, session.holder, this.policy.leaseTtlMs, this.clock.now()))) throw new LeaseLostError();
  }

  private async finishRun(pair: LeasedPair, status: SyncRunStatus, counters: RunCounters, unitsSeen: number, extra?: string, extraErrors = 0): Promise<void> {
    const finishedAt = this.clock.now();
    const summary = [extra, ...counters.notes, summarizeCounts(counters.issues)].filter((s): s is string => typeof s === 'string' && s.length > 0).join(' ');
    await this.prisma.client.telemetrySyncRun.update({
      where: { id: pair.runId },
      data: {
        status,
        finishedAt,
        durationMs: Math.max(0, finishedAt.getTime() - pair.startedAt.getTime()),
        unitsSeen,
        odometerSamples: counters.odometerSamples,
        readingsCreated: counters.readingsCreated,
        readingsPending: counters.readingsPending,
        duplicatesIgnored: counters.duplicatesIgnored,
        fuelSamples: counters.fuelSamples,
        fuelEventsCreated: counters.fuelEventsCreated,
        errorCount: counters.errors + extraErrors,
        errorSummary: summary.length > 0 ? truncate(redactSensitiveText(summary), SUMMARY_MAX) : null,
      },
    });
  }

  /**
   * État du fournisseur après une session (D-297) : un appel réussi remet les échecs à zéro, ferme le
   * coupe-circuit et résout GPS_SYNCHRO_EN_ECHEC ; une session sans aucun appel réussi compte un échec,
   * ouvre le coupe-circuit au seuil (alerte par société activée couverte) ou diffère l'appel suivant
   * selon le Retry-After d'un quota.
   */
  private async updateProviderHealth(provider: ProviderRow, results: CompanyRunResult[], now: Date): Promise<void> {
    const attempted = results.filter((r) => r.callsAttempted > 0);
    if (attempted.length === 0) {
      await this.prisma.client.telemetryProvider.update({ where: { id: provider.id }, data: { lastSyncAt: now } });
      return;
    }
    if (attempted.some((r) => r.callsSucceeded > 0)) {
      const partial = attempted.find((r) => r.lastError)?.lastError ?? null;
      await this.prisma.client.telemetryProvider.update({
        where: { id: provider.id },
        data: { consecutiveFailures: 0, circuitOpenUntil: null, lastSyncAt: now, lastSuccessAt: now, lastErrorSummary: partial ? truncate(providerErrorMessage(partial), 500) : null },
      });
      await this.alerts.resolve({ organizationId: provider.organizationId, type: 'GPS_SYNCHRO_EN_ECHEC', objectType: PROVIDER_ALERT_OBJECT, objectId: provider.id }, 'Synchronisation réussie.');
      return;
    }
    const lastError = attempted.map((r) => r.lastError).find((e): e is ProviderError => e !== null) ?? new ProviderError('INJOIGNABLE', 'Échec de la synchronisation.');
    const message = truncate(providerErrorMessage(lastError), 500);
    const updated = await this.prisma.client.telemetryProvider.update({ where: { id: provider.id }, data: { consecutiveFailures: { increment: 1 }, lastSyncAt: now, lastErrorSummary: message } });
    const transition = failureTransition({ consecutiveFailures: updated.consecutiveFailures - 1, now, retryAfterSeconds: lastError.retryAfterSeconds }, this.policy);
    if (transition.circuitOpenUntil) await this.prisma.client.telemetryProvider.update({ where: { id: provider.id }, data: { circuitOpenUntil: transition.circuitOpenUntil } });
    this.logger.warn(`Synchronisation en échec — fournisseur ${provider.id} (${provider.kind}), ${updated.consecutiveFailures} échec(s) consécutif(s) : ${message}`);
    if (!transition.circuitOpened || !transition.circuitOpenUntil) return;
    const until = transition.circuitOpenUntil;
    const org = await this.prisma.client.organization.findUniqueOrThrow({ where: { id: provider.organizationId }, select: { timezone: true } });
    for (const companyId of await this.enabledCompanies(provider)) {
      await this.alerts.raise({
        organizationId: provider.organizationId,
        companyId,
        type: 'GPS_SYNCHRO_EN_ECHEC',
        severity: 'URGENT',
        objectType: PROVIDER_ALERT_OBJECT,
        objectId: provider.id,
        occurrenceKey: CIRCUIT_OCCURRENCE,
        title: `Synchronisation télématique en échec — ${provider.name}`,
        message: `${updated.consecutiveFailures} échecs consécutifs (${kindLabel(provider.kind)}) : coupe-circuit ouvert jusqu’au ${formatLocal(until, org.timezone)}, puis un essai unique. Dernière erreur : ${message}. Les saisies manuelles restent possibles.`,
        condition: { providerId: provider.id, consecutiveFailures: updated.consecutiveFailures, circuitOpenUntil: until.toISOString(), errorKind: lastError.kind },
        actionPath: '/telematique',
      });
    }
  }

  // ------------------------------------------------------------------------------------------
  // Chargements et règles de planification
  // ------------------------------------------------------------------------------------------

  /** Sociétés couvertes, actives et où le module est activé (relu à chaque exécution, D-101). */
  private async enabledCompanies(provider: ProviderRow): Promise<string[]> {
    const covered = provider.companies.map((c) => c.companyId);
    if (covered.length === 0) return [];
    const rows = await this.prisma.client.company.findMany({ where: { organizationId: provider.organizationId, id: { in: covered }, telemetryEnabled: true, status: 'ACTIF' }, select: { id: true }, orderBy: { code: 'asc' } });
    return rows.map((r) => r.id);
  }

  /**
   * Unités associées et confirmées du couple (association ouverte), avec toutes leurs associations dans
   * la société (couverture à l'instant d'observation) et leur dernier état.
   */
  private async loadMappedUnits(provider: ProviderRow, companyId: string, counters: RunCounters): Promise<Map<string, MappedUnit>> {
    const mappings = await this.prisma.client.telemetryVehicleMapping.findMany({
      where: { providerId: provider.id, companyId, status: { in: ['CONFIRME', 'CLOTURE'] }, validFrom: { not: null }, unit: { mappings: { some: { providerId: provider.id, companyId, status: 'CONFIRME', validTo: null } } } },
      include: syncMappingInclude,
      orderBy: [{ validFrom: 'asc' }],
    });
    const unitIds = [...new Set(mappings.map((m) => m.unitId))];
    const rows = unitIds.length ? await this.prisma.client.telemetryUnit.findMany({ where: { id: { in: unitIds } }, include: { state: true } }) : [];
    const units = new Map<string, MappedUnit>();
    for (const unit of rows) {
      const own = mappings.filter((m) => m.unitId === unit.id);
      const open = own.find((m) => m.status === 'CONFIRME' && m.validTo === null);
      if (!open) continue;
      if (open.vehicle.companyId !== companyId) {
        countError(counters, 'véhicule rattaché à une autre société : association à clôturer (unité ignorée)');
        continue;
      }
      units.set(unit.externalId, {
        unitId: unit.id,
        externalId: unit.externalId,
        label: unit.label,
        mappings: own,
        open,
        state: unit.state
          ? {
              lastOdometerValueKm: unit.state.lastOdometerValueKm,
              lastOdometerObservedAt: unit.state.lastOdometerObservedAt,
              lastFuelObservedAt: unit.state.lastFuelObservedAt,
              lastHistorizedAt: unit.state.lastHistorizedAt,
              lastHistorizedValueKm: unit.state.lastHistorizedValueKm,
            }
          : null,
      });
    }
    return units;
  }

  /** Associations ouvertes dont la reprise initiale n'a pas encore été faite (marqueur d'audit par association). */
  private async mappingsNeedingReprise(organizationId: string, providerId: string, companyId: string): Promise<Array<{ id: string; validFrom: Date }>> {
    const open = await this.prisma.client.telemetryVehicleMapping.findMany({ where: { providerId, companyId, status: 'CONFIRME', validTo: null, validFrom: { not: null } }, select: { id: true, validFrom: true } });
    if (open.length === 0) return [];
    const done = await this.prisma.client.auditEvent.findMany({ where: { organizationId, action: REPRISE_MARKER, objectType: 'TelemetryVehicleMapping', objectId: { in: open.map((m) => m.id) } }, select: { objectId: true } });
    const doneIds = new Set(done.map((d) => d.objectId));
    return open.filter((m) => !doneIds.has(m.id)).map((m) => ({ id: m.id, validFrom: m.validFrom as Date }));
  }

  /**
   * Fenêtres de reprise par association : reprise initiale d'une association nouvellement confirmée
   * [max(validFrom, maintenant − backfillDays), maintenant] ; reprise explicite de l'administrateur sur
   * toutes les associations ouvertes, bornée en plus à la dernière désactivation du module (D-295).
   */
  private async repriseWindows(provider: ProviderRow, pair: LeasedPair, units: ReadonlyMap<string, MappedUnit>, now: Date): Promise<Map<string, Date>> {
    const floor = now.getTime() - provider.backfillDays * DAY_MS;
    const windows = new Map<string, Date>();
    const openIds = new Set([...units.values()].map((u) => u.open.id));
    for (const m of await this.mappingsNeedingReprise(provider.organizationId, provider.id, pair.companyId)) {
      if (openIds.has(m.id)) windows.set(m.id, new Date(Math.max(m.validFrom.getTime(), floor)));
    }
    if (pair.explicitReprise) {
      const lastDisable = await this.prisma.client.auditEvent.findFirst({
        where: { organizationId: provider.organizationId, action: 'telemetrie.societe.desactivation', objectType: 'Company', objectId: pair.companyId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const bound = Math.max(floor, lastDisable && lastDisable.createdAt.getTime() <= now.getTime() ? lastDisable.createdAt.getTime() : floor);
      for (const unit of units.values()) windows.set(unit.open.id, new Date(Math.max((unit.open.validFrom as Date).getTime(), bound)));
    }
    return windows;
  }

  /** Début de la fenêtre carburant : dernier échantillon reçu par unité, sinon date d'effet ; borné à la reprise. */
  private fuelWindowStart(units: MappedUnit[], reprise: ReadonlyMap<string, Date>, backfillDays: number, now: Date): Date {
    const floor = now.getTime() - backfillDays * DAY_MS;
    let from = now.getTime();
    for (const u of units) {
      const repriseStart = u.mappings.filter((m) => reprise.has(m.id)).map((m) => (reprise.get(m.id) as Date).getTime());
      const start = repriseStart.length > 0 ? Math.min(...repriseStart) : (u.state?.lastFuelObservedAt?.getTime() ?? (u.open.validFrom as Date).getTime());
      from = Math.min(from, start);
    }
    return new Date(Math.max(from, floor));
  }

  /** Liste des unités au plus une fois par heure et par fournisseur (D-296) ; échec sans effet sur le coupe-circuit. */
  private async maybeDiscover(provider: ProviderRow, now: Date, holder: string): Promise<number> {
    const last = await this.prisma.client.telemetrySyncRun.findFirst({ where: { providerId: provider.id, companyId: null }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } });
    if (last && now.getTime() - last.startedAt.getTime() < this.policy.discoveryEveryMs) return 0;
    const lease = discoveryLeaseName(provider.id);
    if (!(await this.leases.acquire(lease, holder, this.policy.leaseTtlMs, this.clock.now()))) return 0;
    try {
      await this.units.runDiscovery(provider, { ctx: null, scopeCompanyIds: null, trigger: 'PLANIFIE' });
    } catch (error) {
      this.logger.warn(`Liste des unités du fournisseur ${provider.id} en échec : ${describeErrorSafely(error)}`);
    } finally {
      await this.leases.release(lease, holder, this.clock.now());
    }
    return 1;
  }

  /** Run IGNORE tracé : créneau échu pendant l'ouverture du coupe-circuit (ou un report de quota). */
  private async recordIgnored(provider: ProviderRow, companyId: string, trigger: SyncTrigger, requestedById: string | null, now: Date): Promise<SyncRunOutcome> {
    const until = provider.circuitOpenUntil ?? now;
    const run = await this.prisma.client.telemetrySyncRun.create({
      data: { organizationId: provider.organizationId, providerId: provider.id, companyId, trigger, status: 'IGNORE', startedAt: now, finishedAt: now, durationMs: 0, errorSummary: this.ignoreMessage(provider, until), requestedById },
      select: { id: true },
    });
    return { runId: run.id, providerId: provider.id, companyId, trigger, status: 'IGNORE' };
  }

  private ignoreMessage(provider: ProviderRow, until: Date): string {
    return provider.consecutiveFailures >= this.policy.circuitThreshold
      ? `Coupe-circuit ouvert jusqu’au ${until.toISOString()} après ${provider.consecutiveFailures} échecs consécutifs : aucun appel au fournisseur.`
      : `Quota du fournisseur : aucun appel avant le ${until.toISOString()} (Retry-After).`;
  }

  /** Runs restés EN_COURS sans bail vivant (processus arrêté) : clôturés en échec. */
  private async recoverInterrupted(now: Date, organizationId?: string): Promise<number> {
    const stale = await this.prisma.client.telemetrySyncRun.findMany({
      where: {
        status: 'EN_COURS',
        ...(organizationId ? { organizationId } : {}),
        OR: [
          { companyId: { not: null }, startedAt: { lt: new Date(now.getTime() - this.policy.leaseTtlMs) } },
          { companyId: null, startedAt: { lt: new Date(now.getTime() - STALE_DISCOVERY_MS) } },
        ],
      },
      select: { id: true, providerId: true, companyId: true },
    });
    let count = 0;
    for (const run of stale) {
      const lease = run.companyId ? syncLeaseName(run.providerId, run.companyId) : discoveryLeaseName(run.providerId);
      if (await this.leases.isHeld(lease, now)) continue;
      const res = await this.prisma.client.telemetrySyncRun.updateMany({
        where: { id: run.id, status: 'EN_COURS' },
        data: { status: 'ECHEC', finishedAt: now, errorCount: 1, errorSummary: 'Exécution interrompue avant son terme (arrêt du processus ou bail expiré) : reprise au prochain créneau.' },
      });
      count += res.count;
    }
    return count;
  }
}

/** Valeurs écartées par l'adaptateur pendant ce run (différence de ses compteurs cumulés). */
function diagnosticsDelta(before: AdapterDiagnostics | null, after: AdapterDiagnostics | null, counters: RunCounters): Record<string, number> {
  if (!after) return {};
  const delta: Record<string, number> = {};
  for (const [reason, n] of Object.entries(after.rejected)) {
    const d = n - (before?.rejected[reason] ?? 0);
    if (d > 0) delta[`écarté par l’adaptateur : ${reason}`] = d;
  }
  const errors = Object.values(delta).reduce((a, b) => a + b, 0);
  counters.errors += errors;
  if (after.files) {
    const read = after.files.read - (before?.files?.read ?? 0);
    const already = after.files.alreadyProcessed - (before?.files?.alreadyProcessed ?? 0);
    const unreadable = after.files.unreadable - (before?.files?.unreadable ?? 0);
    if (read > 0 || already > 0 || unreadable > 0) counters.notes.push(`Fichiers de rapport : ${read} lu(s), ${already} déjà traité(s), ${unreadable} illisible(s).`);
  }
  return delta;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatLocal(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: timezone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(at);
}

