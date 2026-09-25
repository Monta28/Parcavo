import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@parc-auto/db';
import { Clock } from '../../../common/clock.js';
import { AppError, BusinessRuleError, ConflictError, NotFoundOrOutOfScopeError } from '../../../common/errors.js';
import type { RequestContext } from '../../../common/request-context.js';
import { redactSensitiveText, trackSensitiveValues } from '../../../common/secret-redaction.js';
import { APP_ENV, type AppEnv } from '../../../infra/env.js';
import { PrismaService, isUniqueViolation } from '../../../infra/prisma.service.js';
import { AccessControlService } from '../../access-control/access-control.service.js';
import type { WebhookAcceptedDto, WebhookDeliveryViewDto, WebhookViewDto } from '../dto/telemetry-webhook.dto.js';
import { TelemetryCredentialsService } from '../telemetry-credentials.service.js';
import { WEBHOOK_FORMAT_VERSION, WEBHOOK_MAX_BODY_BYTES, WEBHOOK_MAX_PENDING, WEBHOOK_MAX_SAMPLES, effectiveWebhookSettings, parseWebhookBatch } from './telemetry-webhook-format.js';
import { type SignatureFailure, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER, checkSignedHeaders, matchesAnySecret, sha256Hex } from './telemetry-webhook-signature.js';

const DAY_MS = 86_400_000;
const RATE_WINDOW_MS = 60_000;
const RECENT_DELIVERIES = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

const SIGNATURE_MESSAGES: Record<SignatureFailure, string> = {
  SIGNATURE_ABSENTE: `Signature absente : en-têtes ${WEBHOOK_TIMESTAMP_HEADER} et ${WEBHOOK_SIGNATURE_HEADER} obligatoires.`,
  HORODATAGE_INVALIDE: `Horodatage invalide : secondes Unix (UTC) attendues dans ${WEBHOOK_TIMESTAMP_HEADER}.`,
  SIGNATURE_EXPIREE: 'Horodatage signé hors de la fenêtre de tolérance : lot refusé (rejeu ou horloge décalée).',
  SIGNATURE_INVALIDE: 'Signature invalide.',
};

/** 401 d'un lot non authentifié (jamais de détail sur le secret ni sur la signature attendue). */
export class WebhookAuthenticationError extends AppError {
  constructor(reason: SignatureFailure) {
    super(HttpStatus.UNAUTHORIZED, reason, SIGNATURE_MESSAGES[reason]);
  }
}

/** 429 : débit du fournisseur dépassé ou file pleine ; retryAfterSeconds alimente l'en-tête Retry-After. */
export class WebhookThrottledError extends AppError {
  constructor(
    code: 'LIMITE_DEBIT' | 'FILE_WEBHOOK_PLEINE',
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(HttpStatus.TOO_MANY_REQUESTS, code, message, { details: { retryAfterSeconds } });
  }
}

export interface WebhookReception {
  providerId: string;
  rawBody: Buffer | undefined;
  contentType: string | undefined;
  contentEncoding: string | undefined;
  timestampHeader: string | string[] | undefined;
  signatureHeader: string | string[] | undefined;
}

/**
 * Réception des lots poussés par un fournisseur (CDC 14.4 ; D-298 ; R-14.4-02, R-14.4-X01). Point de
 * réception distinct des routes utilisateur, sans session : l'émetteur est authentifié par une signature
 * HMAC-SHA256 du corps brut et d'un horodatage signé, avec le secret propre au fournisseur (chiffré au
 * repos, rotation avec recouvrement). La réception ne fait que contrôler puis déposer le lot normalisé
 * dans la file persistante (TelemetryWebhookDelivery) et répondre 202 : aucune ingestion synchrone,
 * aucun relevé créé ici. Seul le worker ingère les lots (TelemetrySyncService.runWebhooks), par la même
 * ingestion idempotente que la synchronisation.
 */
@Injectable()
export class TelemetryWebhookService {
  private readonly logger = new Logger('TelemetrieWebhook');

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: TelemetryCredentialsService,
    private readonly access: AccessControlService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly clock: Clock,
  ) {}

  async receive(input: WebhookReception): Promise<WebhookAcceptedDto> {
    const rawBody = input.rawBody;
    if (!rawBody || rawBody.length === 0) throw new AppError(HttpStatus.BAD_REQUEST, 'CORPS_ABSENT', 'Corps de requête absent : un lot JSON est attendu.');
    if (!input.contentType || !JSON_CONTENT_TYPE.test(input.contentType)) {
      throw new AppError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'TYPE_NON_SUPPORTE', 'Type de contenu non supporté : application/json attendu.');
    }
    if (input.contentEncoding && input.contentEncoding.trim().toLowerCase() !== 'identity') {
      throw new AppError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'ENCODAGE_NON_SUPPORTE', 'Corps compressé non supporté : envoyez le JSON non compressé (la signature porte sur les octets reçus).');
    }
    const now = this.clock.now();
    const provider = UUID.test(input.providerId)
      ? await this.prisma.client.telemetryProvider.findUnique({
          where: { id: input.providerId },
          select: { id: true, organizationId: true, status: true, channel: true, settings: true, companies: { select: { companyId: true } } },
        })
      : null;
    const webhook = provider?.channel === 'WEBHOOK' ? provider : null;
    const settings = effectiveWebhookSettings(webhook?.settings ?? {});

    // 1. En-têtes (présence, format, fenêtre de tolérance) puis signature, en temps constant. Un
    //    fournisseur inconnu ou d'un autre canal reçoit la même réponse qu'une signature fausse.
    const checked = checkSignedHeaders(input.timestampHeader, input.signatureHeader, now, settings.toleranceSeconds);
    if (!checked.ok) return this.reject(input.providerId, checked.reason);
    const secrets = webhook ? await this.credentials.signingSecrets(webhook.id, now) : [];
    const release = trackSensitiveValues(secrets);
    let authentic: boolean;
    try {
      authentic = webhook !== null && secrets.length > 0 && matchesAnySecret(secrets, checked.headers, rawBody);
    } finally {
      secrets.length = 0;
      release();
    }
    if (!authentic || !webhook) return this.reject(input.providerId, 'SIGNATURE_INVALIDE');

    // 2. Émetteur authentifié : état du fournisseur et activation des sociétés (aucune ingestion sinon).
    if (webhook.status !== 'ACTIF') throw new BusinessRuleError('FOURNISSEUR_INACTIF', 'Fournisseur non actif : lot refusé, rien n’est ingéré.');
    const enabled = await this.prisma.client.company.count({
      where: { organizationId: webhook.organizationId, id: { in: webhook.companies.map((c) => c.companyId) }, telemetryEnabled: true, status: 'ACTIF' },
    });
    if (enabled === 0) throw new BusinessRuleError('TELEMETRIE_DESACTIVEE', 'Module télématique non activé pour les sociétés couvertes : lot refusé, rien n’est ingéré.');

    // 3. Contenu : JSON au format documenté ; seuls les champs prévus sont conservés.
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      throw new AppError(HttpStatus.BAD_REQUEST, 'JSON_INVALIDE', 'Corps illisible : JSON valide attendu.');
    }
    const parsed = parseWebhookBatch(decoded);
    if (!parsed.ok) throw new BusinessRuleError('LOT_INVALIDE', 'Lot non conforme au format documenté : rien n’a été déposé.', { fieldErrors: parsed.fieldErrors });
    const batch = parsed.batch;

    // 4. Débit par fournisseur, capacité de la file, rejeu et dépôt : une transaction sous verrou de la
    //    ligne du fournisseur (plusieurs instances de l'API comptent les mêmes lots, sans course).
    const bodySha256 = sha256Hex(rawBody);
    try {
      const created = await this.prisma.transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "TelemetryProvider" WHERE id = ${webhook.id}::uuid FOR NO KEY UPDATE`;
        const windowStart = new Date(now.getTime() - RATE_WINDOW_MS);
        const recent = await tx.telemetryWebhookDelivery.findMany({
          where: { providerId: webhook.id, receivedAt: { gt: windowStart } },
          orderBy: { receivedAt: 'asc' },
          take: settings.maxRequestsPerMinute,
          select: { receivedAt: true },
        });
        if (recent.length >= settings.maxRequestsPerMinute) {
          const oldest = recent[0]?.receivedAt.getTime() ?? now.getTime();
          const retryAfter = Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now.getTime()) / 1000));
          throw new WebhookThrottledError('LIMITE_DEBIT', `Débit dépassé : ${settings.maxRequestsPerMinute} lot(s) par minute au plus pour ce fournisseur.`, retryAfter);
        }
        const pending = await tx.telemetryWebhookDelivery.count({ where: { providerId: webhook.id, status: { in: ['EN_ATTENTE', 'EN_COURS'] } } });
        if (pending >= WEBHOOK_MAX_PENDING) {
          throw new WebhookThrottledError('FILE_WEBHOOK_PLEINE', `File de traitement pleine (${WEBHOOK_MAX_PENDING} lots en attente) : renvoyez le lot plus tard.`, 60);
        }
        return tx.telemetryWebhookDelivery.create({
          data: {
            organizationId: webhook.organizationId,
            providerId: webhook.id,
            status: 'EN_ATTENTE',
            signedAt: checked.headers.signedAt,
            receivedAt: now,
            bodySha256,
            sizeBytes: rawBody.length,
            payload: batch as unknown as Prisma.InputJsonValue,
            unitCount: new Set([...batch.units.map((u) => u.externalId), ...batch.odometers.map((s) => s.unitExternalId), ...batch.fuel.map((s) => s.unitExternalId)]).size,
            odometerCount: batch.odometers.length,
            fuelCount: batch.fuel.length,
            nextAttemptAt: now,
          },
          select: { id: true, receivedAt: true, unitCount: true, odometerCount: true, fuelCount: true },
        });
      });
      return { deliveryId: created.id, status: 'EN_ATTENTE', receivedAt: created.receivedAt.toISOString(), units: created.unitCount, odometers: created.odometerCount, fuel: created.fuelCount };
    } catch (error) {
      if (isUniqueViolation(error, 'telemetry_webhook_no_replay')) {
        throw new ConflictError('WEBHOOK_REJOUE', 'Lot déjà reçu avec le même horodatage signé et le même contenu : rejeu refusé (le lot initial est conservé).');
      }
      throw error;
    }
  }

  /** Configuration de réception à communiquer au fournisseur et état de la file (administrateur). */
  async view(ctx: RequestContext, providerId: string): Promise<WebhookViewDto> {
    this.access.requireAdmin(ctx);
    const provider = await this.prisma.client.telemetryProvider.findFirst({ where: { id: providerId, organizationId: ctx.organizationId }, select: { id: true, kind: true, channel: true, status: true, settings: true } });
    if (!provider) throw new NotFoundOrOutOfScopeError('Fournisseur');
    if (provider.channel !== 'WEBHOOK') throw new BusinessRuleError('CANAL_NON_WEBHOOK', 'Ce fournisseur ne reçoit pas de lots par webhook.');
    const settings = effectiveWebhookSettings(provider.settings);
    const now = this.clock.now();
    const since = new Date(now.getTime() - DAY_MS);
    const [statuses, pending, received, processed, ignored, failed, recent] = await Promise.all([
      this.credentials.statuses(provider.id, provider.kind),
      this.prisma.client.telemetryWebhookDelivery.count({ where: { providerId, status: { in: ['EN_ATTENTE', 'EN_COURS'] } } }),
      this.prisma.client.telemetryWebhookDelivery.count({ where: { providerId, receivedAt: { gte: since } } }),
      this.prisma.client.telemetryWebhookDelivery.count({ where: { providerId, status: 'TRAITE', processedAt: { gte: since } } }),
      this.prisma.client.telemetryWebhookDelivery.count({ where: { providerId, status: 'IGNORE', processedAt: { gte: since } } }),
      this.prisma.client.telemetryWebhookDelivery.count({ where: { providerId, status: 'ECHEC', processedAt: { gte: since } } }),
      this.prisma.client.telemetryWebhookDelivery.findMany({
        where: { providerId },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        take: RECENT_DELIVERIES,
        select: { id: true, status: true, signedAt: true, receivedAt: true, sizeBytes: true, unitCount: true, odometerCount: true, fuelCount: true, attempts: true, processedAt: true, lastError: true, result: true },
      }),
    ]);
    const secret = statuses.find((s) => s.kind === 'SIGNATURE_WEBHOOK') ?? { kind: 'SIGNATURE_WEBHOOK' as const, configured: false, rotatedAt: null, previousValidUntil: null };
    const notices: string[] = [];
    if (!secret.configured) notices.push('Aucun secret de signature : tout lot est refusé (401) tant qu’un secret n’est pas généré et communiqué au fournisseur.');
    if (provider.status !== 'ACTIF') notices.push('Fournisseur non actif : les lots sont refusés (422) et rien n’est ingéré.');
    return {
      providerId: provider.id,
      url: `${this.env.appOrigin.replace(/\/+$/, '')}/api/v1/telemetry/webhooks/${provider.id}`,
      method: 'POST',
      timestampHeader: 'X-Webhook-Timestamp',
      signatureHeader: 'X-Webhook-Signature',
      signedContent: '<horodatage>.<corps brut>',
      formatVersion: WEBHOOK_FORMAT_VERSION,
      maxBodyBytes: WEBHOOK_MAX_BODY_BYTES,
      maxSamplesPerList: WEBHOOK_MAX_SAMPLES,
      maxRequestsPerMinute: settings.maxRequestsPerMinute,
      toleranceSeconds: settings.toleranceSeconds,
      rotationOverlapHours: settings.rotationOverlapHours,
      secret,
      counts: { pending, receivedLast24h: received, processedLast24h: processed, ignoredLast24h: ignored, failedLast24h: failed, lastReceivedAt: recent[0]?.receivedAt.toISOString() ?? null },
      recent: recent.map((d): WebhookDeliveryViewDto => ({
        id: d.id,
        status: d.status,
        signedAt: d.signedAt.toISOString(),
        receivedAt: d.receivedAt.toISOString(),
        sizeBytes: d.sizeBytes,
        units: d.unitCount,
        odometers: d.odometerCount,
        fuel: d.fuelCount,
        attempts: d.attempts,
        processedAt: d.processedAt?.toISOString() ?? null,
        lastError: d.lastError ? redactSensitiveText(d.lastError) : null,
        syncRunIds: runIdsOf(d.result),
      })),
      notice: notices.length > 0 ? notices.join(' ') : null,
    };
  }

  private reject(providerId: string, reason: SignatureFailure): never {
    // Journal expurgé : ni en-tête, ni corps, ni secret ; identifiant tronqué s'il n'est pas un UUID.
    this.logger.warn(`Lot webhook refusé (${reason}) — fournisseur ${UUID.test(providerId) ? providerId : 'identifiant invalide'}.`);
    throw new WebhookAuthenticationError(reason);
  }
}

function runIdsOf(result: Prisma.JsonValue | null): string[] {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return [];
  const runs = (result as Record<string, unknown>)['runs'];
  if (!Array.isArray(runs)) return [];
  return runs.map((r) => (r !== null && typeof r === 'object' ? (r as Record<string, unknown>)['runId'] : null)).filter((id): id is string => typeof id === 'string');
}
