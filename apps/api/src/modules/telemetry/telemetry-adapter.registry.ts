import { Inject, Injectable } from '@nestjs/common';
import type { ParcAutoPrismaClient, Prisma, TelemetryChannel, TelemetryProviderKind } from '@parc-auto/db';
import { Clock } from '../../common/clock.js';
import { AppError, BusinessRuleError } from '../../common/errors.js';
import { redactSensitiveText, trackSensitiveValues } from '../../common/secret-redaction.js';
import { APP_ENV, type AppEnv } from '../../infra/env.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { apiBaseUrl } from './adapters/adapter-support.js';
import { createReportGenericAdapter, parseReportSettings } from './adapters/report-generic.adapter.js';
import { createSimulatorAdapter, parseSimulatorScenario } from './adapters/simulator.adapter.js';
import { TRACCAR_PROVIDER, createTraccarAdapter, parseTraccarSettings } from './adapters/traccar.adapter.js';
import { createWebhookInboxAdapter } from './adapters/webhook.adapter.js';
import { WIALON_PROVIDER, createWialonAdapter, parseWialonSettings } from './adapters/wialon.adapter.js';
import { TelemetryCredentialsService } from './telemetry-credentials.service.js';
import { type AdapterConfig, type AdapterFactory, ProviderError, type TelemetryProvider } from './telemetry-provider.interface.js';
import { createReportLedger } from './telemetry-report-ledger.js';
import { CHANNEL_BY_KIND, PROVIDER_KINDS, PROVIDER_TIMEOUT_MS, RPA_REFUSAL_MESSAGE, SIMULATOR_LABEL, kindLabel } from './telemetry-settings.js';
import { parseWebhookSettings } from './webhook/telemetry-webhook-format.js';
import { createWebhookInbox } from './webhook/telemetry-webhook-inbox.js';

/**
 * Registre des adaptateurs télématiques (CDC 14.3 ; D-292, D-303) : type de fournisseur → fabrique.
 *  - TRACCAR, WIALON, RAPPORT_GENERIQUE : adaptateurs réels (API documentée, rapports planifiés) ;
 *  - WEBHOOK_GENERIQUE : lots poussés et signés par le fournisseur (D-298), lus dans la file persistante ;
 *  - SIMULATEUR : enregistré seulement hors production et si TELEMETRY_SIMULATOR_ENABLED est vrai ;
 *  - RPA : jamais enregistré en V1 (interface documentée, accord écrit du fournisseur requis).
 * Le registre construit l'AdapterConfig : secrets déchiffrés en mémoire le temps de l'appel (et
 * expurgés de toute trace), délai réseau, fuseau de l'organisation, registre des rapports traités.
 */

/** Adaptateurs réels livrés, par type. Un type absent de cette table est refusé (422). */
const REAL_ADAPTERS: Partial<Record<TelemetryProviderKind, AdapterFactory>> = {
  TRACCAR: createTraccarAdapter,
  WIALON: createWialonAdapter,
  RAPPORT_GENERIQUE: createReportGenericAdapter,
  WEBHOOK_GENERIQUE: createWebhookInboxAdapter,
};

type RegistryEnv = Pick<AppEnv, 'nodeEnv' | 'telemetrySimulatorEnabled'>;

/** Fabrique d'un type de fournisseur, ou 422 motivé (RPA, simulateur hors test, adaptateur absent). */
export function resolveAdapterFactory(kind: TelemetryProviderKind, env: RegistryEnv): AdapterFactory {
  if (kind === 'RPA') throw new BusinessRuleError('CANAL_RPA_INDISPONIBLE', RPA_REFUSAL_MESSAGE);
  if (kind === 'SIMULATEUR') {
    if (env.nodeEnv === 'production') {
      throw new BusinessRuleError('SIMULATEUR_INTERDIT_EN_PRODUCTION', `Le ${SIMULATOR_LABEL} ne peut pas être utilisé en production (D-303).`);
    }
    if (!env.telemetrySimulatorEnabled) {
      throw new BusinessRuleError('SIMULATEUR_NON_ACTIVE', `Le ${SIMULATOR_LABEL} n’est pas activé sur cette instance (TELEMETRY_SIMULATOR_ENABLED, hors production uniquement).`);
    }
    return createSimulatorAdapter;
  }
  const factory = REAL_ADAPTERS[kind];
  if (!factory) throw new BusinessRuleError('ADAPTATEUR_NON_DISPONIBLE', `Adaptateur non disponible pour le type ${kind}.`);
  return factory;
}

export interface ProviderKindInfo {
  kind: TelemetryProviderKind;
  label: string;
  channel: TelemetryChannel;
  available: boolean;
  /** Motif d'indisponibilité (RPA, simulateur hors test, adaptateur absent). */
  reason: string | null;
}

export function describeProviderKinds(env: RegistryEnv): ProviderKindInfo[] {
  return PROVIDER_KINDS.map((kind) => {
    try {
      resolveAdapterFactory(kind, env);
      return { kind, label: kindLabel(kind), channel: CHANNEL_BY_KIND[kind], available: true, reason: null };
    } catch (error) {
      return { kind, label: kindLabel(kind), channel: CHANNEL_BY_KIND[kind], available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  });
}

/**
 * Garde de démarrage du worker (D-303) : en production, refuse de démarrer si un fournisseur SIMULATEUR
 * est actif ou suspendu en base (base de test restaurée par erreur, configuration forcée en SQL...).
 */
export async function assertNoActiveSimulatorInProduction(prisma: Pick<PrismaService, 'client'> | ParcAutoPrismaClient, env: Pick<AppEnv, 'nodeEnv'>): Promise<void> {
  if (env.nodeEnv !== 'production') return;
  const client: ParcAutoPrismaClient = 'client' in prisma ? prisma.client : prisma;
  const active = await client.telemetryProvider.findMany({ where: { kind: 'SIMULATEUR', status: { in: ['ACTIF', 'SUSPENDU'] } }, select: { id: true, name: true } });
  if (active.length > 0) {
    throw new Error(
      `Démarrage refusé : ${active.length} fournisseur(s) « ${SIMULATOR_LABEL} » actif(s) en production (${active.map((p) => p.id).join(', ')}). Désactivez-les (statut DESACTIVE) avant de relancer le worker (D-303).`,
    );
  }
}

/**
 * Validation de la configuration non secrète par type, avec les analyseurs des adaptateurs eux-mêmes
 * (une seule implémentation) : paramètres, et URL de base pour les API (https sauf serveur interne
 * explicitement autorisé). Une erreur de configuration devient un 422 motivé.
 */
export function validateProviderConfiguration(kind: TelemetryProviderKind, baseUrl: string | null, settings: Record<string, unknown>): void {
  try {
    switch (kind) {
      case 'TRACCAR': {
        const parsed = parseTraccarSettings(settings);
        if (baseUrl) apiBaseUrl(TRACCAR_PROVIDER, baseUrl, parsed.allowPlainHttp);
        return;
      }
      case 'WIALON': {
        const parsed = parseWialonSettings(settings);
        if (baseUrl) apiBaseUrl(WIALON_PROVIDER, baseUrl, parsed.allowPlainHttp);
        return;
      }
      case 'RAPPORT_GENERIQUE':
        if (baseUrl) throw new BusinessRuleError('PARAMETRES_INVALIDES', 'Le canal RAPPORT n’utilise pas d’URL de base : la source (IMAP ou SFTP) se décrit dans les paramètres.', { fieldErrors: { baseUrl: ['Sans objet pour ce canal.'] } });
        parseReportSettings(settings);
        return;
      case 'WEBHOOK_GENERIQUE':
        if (baseUrl) throw new BusinessRuleError('PARAMETRES_INVALIDES', 'Le canal webhook n’utilise pas d’URL de base : l’URL de réception à communiquer au fournisseur est fournie par l’application.', { fieldErrors: { baseUrl: ['Sans objet pour ce canal.'] } });
        parseWebhookSettings(settings);
        return;
      case 'SIMULATEUR':
        parseSimulatorScenario(settings);
        return;
      case 'RPA':
        throw new BusinessRuleError('CANAL_RPA_INDISPONIBLE', RPA_REFUSAL_MESSAGE);
    }
  } catch (error) {
    if (error instanceof ProviderError) {
      throw new BusinessRuleError('PARAMETRES_INVALIDES', error.message, { fieldErrors: { settings: [error.message] } });
    }
    throw error;
  }
}

/** Fournisseur tel que le registre en a besoin pour construire l'adaptateur. */
export interface AdapterProviderRow {
  id: string;
  organizationId: string;
  kind: TelemetryProviderKind;
  baseUrl: string | null;
  settings: Prisma.JsonValue;
}

@Injectable()
export class TelemetryAdapterRegistry {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly prisma: PrismaService,
    private readonly credentials: TelemetryCredentialsService,
    private readonly clock: Clock,
  ) {}

  /** Fabrique du type, ou 422 (RPA, simulateur en production ou non activé, adaptateur absent). */
  factoryFor(kind: TelemetryProviderKind): AdapterFactory {
    return resolveAdapterFactory(kind, this.env);
  }

  kinds(): ProviderKindInfo[] {
    return describeProviderKinds(this.env);
  }

  /**
   * Ouvre l'adaptateur du fournisseur, exécute fn puis libère les ressources. Les secrets déchiffrés ne
   * vivent que pendant l'appel ; toute erreur qui en sort est assainie (aucun secret, jeton ni
   * identifiant de session) : ProviderError typée pour les erreurs fournisseur.
   */
  async withAdapter<T>(provider: AdapterProviderRow, fn: (adapter: TelemetryProvider, config: AdapterConfig) => Promise<T>, options: { syncRunId?: string | null } = {}): Promise<T> {
    const factory = this.factoryFor(provider.kind);
    const org = await this.prisma.client.organization.findUniqueOrThrow({ where: { id: provider.organizationId }, select: { timezone: true } });
    const secrets = await this.credentials.decryptForAdapter(provider.id);
    const secretValues = Object.values(secrets).filter((v): v is string => typeof v === 'string');
    const release = trackSensitiveValues(secretValues);
    let adapter: TelemetryProvider | null = null;
    try {
      const config: AdapterConfig = {
        providerId: provider.id,
        baseUrl: provider.baseUrl,
        settings: isPlainObject(provider.settings) ? provider.settings : {},
        secrets,
        timeoutMs: PROVIDER_TIMEOUT_MS,
        timezone: org.timezone,
        reportLedger: createReportLedger(this.prisma.client, this.clock, provider, options.syncRunId ?? null),
        webhookInbox: createWebhookInbox(this.prisma.client, this.clock, provider),
        clock: this.clock,
      };
      adapter = factory(config);
      return await fn(adapter, config);
    } catch (error) {
      throw sanitizeProviderFailure(error, secretValues);
    } finally {
      if (adapter?.close) {
        try {
          await adapter.close();
        } catch {
          // La libération d'une session fournisseur ne remet pas en cause le résultat de l'appel.
        }
      }
      release();
    }
  }
}

/**
 * Erreur sûre à propager : ProviderError au message expurgé ; erreurs applicatives inchangées ; toute
 * autre erreur voit son message et sa pile assainis (jamais de secret dans un journal).
 */
export function sanitizeProviderFailure(error: unknown, secrets: readonly string[]): Error {
  if (error instanceof ProviderError) {
    const safe = new ProviderError(error.kind, redactSensitiveText(error.message, secrets), error.retryAfterSeconds);
    return safe;
  }
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    const name = error.name;
    const message = redactSensitiveText(error.message, secrets);
    if (name === 'AbortError' || name === 'TimeoutError') return new ProviderError('INJOIGNABLE', `Délai de réponse du fournisseur dépassé : ${message}`);
    const cause = (error as { cause?: unknown }).cause;
    const causeCode = cause instanceof Error ? (cause as { code?: unknown }).code : undefined;
    const causeText = cause instanceof Error ? `${cause.name} ${cause.message} ${typeof causeCode === 'string' ? causeCode : ''}` : '';
    if (name === 'TypeError' && /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(`${message} ${causeText}`)) {
      return new ProviderError('INJOIGNABLE', `Fournisseur injoignable : ${message}`);
    }
    error.message = message;
    if (error.stack) error.stack = redactSensitiveText(error.stack, secrets);
    return error;
  }
  return new Error(redactSensitiveText(String(error), secrets));
}

function isPlainObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
