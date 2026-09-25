import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Prisma, TelemetryCredentialKind, TelemetryProviderKind, TelemetryProviderStatus } from '@parc-auto/db';
import { Clock } from '../../common/clock.js';
import { AppError, BusinessRuleError, ConflictError, ForbiddenActionError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import { assertExpectedVersion } from '../../common/optimistic-lock.js';
import { type Page, pageOf, skipTake } from '../../common/pagination.js';
import type { RequestContext } from '../../common/request-context.js';
import { describeErrorSafely, redactSensitiveText } from '../../common/secret-redaction.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, isUniqueViolation } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';
import { READ_ROLES } from '../access-control/permissions.js';
import { SettingsService } from '../settings/settings.service.js';
import { parseSimulatorScenario } from './adapters/simulator.adapter.js';
import type {
  CompanyTelemetryDto,
  CompanyTelemetryViewDto,
  CreateProviderDto,
  CredentialStatusDto,
  ProviderHealthDto,
  ProviderKindDto,
  ProviderTransitionDto,
  ProviderViewDto,
  ProvidersQueryDto,
  UpdateProviderDto,
} from './dto/telemetry.dto.js';
import { TelemetryAdapterRegistry, validateProviderConfiguration } from './telemetry-adapter.registry.js';
import { MAPPING_ALERT_OBJECT, PROVIDER_ALERT_OBJECT, TelemetryAlertsService } from './telemetry-alerts.service.js';
import { TelemetryCredentialsService } from './telemetry-credentials.service.js';
import { ProviderError } from './telemetry-provider.interface.js';
import { WEBHOOK_SECRET_PATTERN, effectiveWebhookSettings } from './webhook/telemetry-webhook-format.js';
import {
  CHANNEL_BY_KIND,
  CREDENTIAL_KINDS,
  PROVIDER_TIMEOUT_MS,
  SIMULATOR_LABEL,
  activationProblems,
  assertCredentialKindAllowed,
  assertNonSecretSettings,
  invalid,
  kindLabel,
  normalizeBaseUrl,
} from './telemetry-settings.js';

const providerInclude = { companies: { select: { companyId: true } } } satisfies Prisma.TelemetryProviderInclude;
type ProviderRow = Prisma.TelemetryProviderGetPayload<{ include: typeof providerInclude }>;

/** Transitions de statut admises (BROUILLON → ACTIF → SUSPENDU/DESACTIVE ; DESACTIVE est terminal). */
const TRANSITIONS: Readonly<Record<'ACTIF' | 'SUSPENDU' | 'DESACTIVE', readonly TelemetryProviderStatus[]>> = {
  ACTIF: ['BROUILLON', 'SUSPENDU'],
  SUSPENDU: ['ACTIF'],
  DESACTIVE: ['BROUILLON', 'ACTIF', 'SUSPENDU'],
};

const MODULE_DISABLED_REASON = 'Module télématique désactivé pour la société (D-101).';

/**
 * Configuration des fournisseurs télématiques (CDC 14.3, 14.6 ; D-101, D-112, D-292, D-295, D-303, D-304).
 * Seul l'administrateur configure (création, paramètres, secrets en écriture seule, statut, test de
 * connexion, activation par société) ; chef, opérateur et lecteur consultent l'état des fournisseurs
 * couvrant leurs sociétés, sans configuration ni secret.
 */
@Injectable()
export class TelemetryProvidersService {
  private readonly logger = new Logger('Telemetrie');

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly registry: TelemetryAdapterRegistry,
    private readonly credentials: TelemetryCredentialsService,
    private readonly telemetryAlerts: TelemetryAlertsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  kinds(ctx: RequestContext): ProviderKindDto[] {
    this.access.requireAdmin(ctx);
    return this.registry.kinds();
  }

  async list(ctx: RequestContext, query: ProvidersQueryDto): Promise<Page<ProviderViewDto>> {
    const scope = this.readScope(ctx, query.companyId);
    const where: Prisma.TelemetryProviderWhereInput = {
      organizationId: ctx.organizationId,
      ...(query.status ? { status: query.status } : {}),
      ...(scope ? { companies: { some: { companyId: { in: scope } } } } : {}),
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.client.telemetryProvider.findMany({ where, include: providerInclude, orderBy: [{ name: 'asc' }], ...skipTake(query) }),
      this.prisma.client.telemetryProvider.count({ where }),
    ]);
    const items: ProviderViewDto[] = [];
    for (const row of rows) items.push(await this.view(ctx, row));
    return pageOf(items, total, query);
  }

  async get(ctx: RequestContext, id: string): Promise<ProviderViewDto> {
    return this.view(ctx, await this.loadVisible(ctx, id));
  }

  async create(ctx: RequestContext, dto: CreateProviderDto): Promise<ProviderViewDto> {
    this.access.requireAdmin(ctx);
    const kind = dto.kind;
    this.registry.factoryFor(kind);
    const name = dto.name.trim();
    const baseUrl = normalizeBaseUrl(dto.baseUrl);
    const settings = this.validateConfiguration(kind, baseUrl, dto.settings ?? {}, true);
    const companyIds = await this.validateCompanies(ctx, dto.companyIds);
    const syncIntervalMinutes = dto.syncIntervalMinutes ?? (await this.settings.get(ctx.organizationId, 'telemetry.syncIntervalMinutes'));
    try {
      const created = await this.prisma.client.$transaction(async (tx) => {
        const provider = await tx.telemetryProvider.create({
          data: {
            organizationId: ctx.organizationId,
            name,
            kind,
            channel: CHANNEL_BY_KIND[kind],
            status: 'BROUILLON',
            baseUrl,
            settings: settings as Prisma.InputJsonValue,
            syncIntervalMinutes,
            // Sans valeur saisie : défaut du schéma (TelemetryProvider.backfillDays), jamais recopié ici.
            ...(dto.backfillDays !== undefined ? { backfillDays: dto.backfillDays } : {}),
            createdById: ctx.userId,
            companies: { create: companyIds.map((companyId) => ({ companyId })) },
          },
          include: providerInclude,
        });
        await this.audit.record(ctx, { action: 'telemetrie.fournisseur.creation', objectType: 'TelemetryProvider', objectId: provider.id, after: auditSnapshot(provider) }, tx);
        return provider;
      });
      return this.view(ctx, created);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('NOM_FOURNISSEUR_EXISTANT', 'Un fournisseur porte déjà ce nom.');
      throw error;
    }
  }

  async update(ctx: RequestContext, id: string, dto: UpdateProviderDto): Promise<ProviderViewDto> {
    this.access.requireAdmin(ctx);
    const current = await this.loadForAdmin(ctx, id);
    assertExpectedVersion(current, dto.expectedVersion, 'fournisseur');
    if (current.status === 'DESACTIVE') throw new BusinessRuleError('FOURNISSEUR_DESACTIVE', 'Un fournisseur désactivé n’est plus modifiable.');
    const baseUrl = dto.baseUrl !== undefined ? normalizeBaseUrl(dto.baseUrl) : undefined;
    const settings =
      dto.settings !== undefined || baseUrl !== undefined
        ? this.validateConfiguration(current.kind, baseUrl !== undefined ? baseUrl : current.baseUrl, dto.settings ?? asObject(current.settings), current.status === 'BROUILLON')
        : undefined;
    const companyIds = dto.companyIds !== undefined ? await this.validateCompanies(ctx, dto.companyIds) : undefined;
    if (current.status === 'ACTIF') {
      if (companyIds !== undefined && companyIds.length === 0) throw invalid('companyIds', 'Un fournisseur actif couvre au moins une société.');
      if (baseUrl === null && ['TRACCAR', 'WIALON'].includes(current.kind)) throw invalid('baseUrl', 'L’URL de base est obligatoire pour un fournisseur actif.');
    }
    if (companyIds !== undefined) {
      const removed = current.companies.map((c) => c.companyId).filter((c) => !companyIds.includes(c));
      if (removed.length > 0) {
        const open = await this.prisma.client.telemetryVehicleMapping.count({
          where: { providerId: id, vehicle: { companyId: { in: removed } }, OR: [{ status: 'PROPOSE' }, { status: 'CONFIRME', validTo: null }] },
        });
        if (open > 0) {
          throw new ConflictError('ASSOCIATIONS_OUVERTES', `Des associations d’unités sont ouvertes pour les sociétés retirées (${open}) : clôturez-les ou rejetez-les d’abord.`, { openMappings: open });
        }
      }
    }
    try {
      const updated = await this.prisma.client.$transaction(async (tx) => {
        const row = await tx.telemetryProvider.update({
          where: { id, version: dto.expectedVersion },
          data: {
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(baseUrl !== undefined ? { baseUrl } : {}),
            ...(dto.settings !== undefined && settings !== undefined ? { settings: settings as Prisma.InputJsonValue } : {}),
            ...(dto.syncIntervalMinutes !== undefined ? { syncIntervalMinutes: dto.syncIntervalMinutes } : {}),
            ...(dto.backfillDays !== undefined ? { backfillDays: dto.backfillDays } : {}),
            version: { increment: 1 },
          },
        });
        if (companyIds !== undefined) {
          await tx.telemetryProviderCompany.deleteMany({ where: { providerId: id, companyId: { notIn: companyIds } } });
          const existing = new Set(current.companies.map((c) => c.companyId));
          const added = companyIds.filter((c) => !existing.has(c));
          if (added.length > 0) await tx.telemetryProviderCompany.createMany({ data: added.map((companyId) => ({ providerId: id, companyId, organizationId: ctx.organizationId })) });
        }
        const after = await tx.telemetryProvider.findUniqueOrThrow({ where: { id: row.id }, include: providerInclude });
        await this.audit.record(ctx, { action: 'telemetrie.fournisseur.modification', objectType: 'TelemetryProvider', objectId: id, before: auditSnapshot(current), after: auditSnapshot(after) }, tx);
        return after;
      });
      await this.telemetryAlerts.refreshUnmappedUnitAlerts(ctx.organizationId, id);
      return this.view(ctx, updated);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('NOM_FOURNISSEUR_EXISTANT', 'Un fournisseur porte déjà ce nom.');
      throw error;
    }
  }

  /** Suppression d'un brouillon jamais utilisé (aucune unité découverte ni exécution). */
  async remove(ctx: RequestContext, id: string, expectedVersion: number): Promise<void> {
    this.access.requireAdmin(ctx);
    const current = await this.loadForAdmin(ctx, id);
    assertExpectedVersion(current, expectedVersion, 'fournisseur');
    const [units, runs] = await Promise.all([this.prisma.client.telemetryUnit.count({ where: { providerId: id } }), this.prisma.client.telemetrySyncRun.count({ where: { providerId: id } })]);
    if (current.status !== 'BROUILLON' || units > 0 || runs > 0) {
      throw new ConflictError('FOURNISSEUR_UTILISE', 'Seul un fournisseur en brouillon jamais synchronisé peut être supprimé ; désactivez-le sinon (l’historique est conservé).');
    }
    await this.prisma.client.$transaction(async (tx) => {
      await tx.telemetryProvider.delete({ where: { id, version: expectedVersion } });
      await this.audit.record(ctx, { action: 'telemetrie.fournisseur.suppression', objectType: 'TelemetryProvider', objectId: id, before: auditSnapshot(current) }, tx);
    });
  }

  async transition(ctx: RequestContext, id: string, target: 'ACTIF' | 'SUSPENDU' | 'DESACTIVE', dto: ProviderTransitionDto): Promise<ProviderViewDto> {
    this.access.requireAdmin(ctx);
    const current = await this.loadForAdmin(ctx, id);
    assertExpectedVersion(current, dto.expectedVersion, 'fournisseur');
    if (!TRANSITIONS[target].includes(current.status)) {
      throw new BusinessRuleError('TRANSITION_INVALIDE', `Passage de ${current.status} à ${target} impossible.`, { details: { from: current.status, to: target } });
    }
    const reason = dto.reason?.trim() ?? null;
    if (target !== 'ACTIF' && !reason) throw invalid('reason', 'Motif obligatoire pour suspendre ou désactiver un fournisseur.');
    if (target === 'ACTIF') {
      // Garde D-303 (simulateur hors production) et D-292 (RPA) : l'adaptateur doit exister ici et maintenant.
      this.registry.factoryFor(current.kind);
      validateProviderConfiguration(current.kind, current.baseUrl, asObject(current.settings));
      const configured = await this.credentials.configuredKinds(id);
      const problems = activationProblems({
        kind: current.kind,
        baseUrl: current.baseUrl,
        coveredCompanies: current.companies.length,
        configuredCredentials: configured,
        simulatorRequiresToken: current.kind === 'SIMULATEUR' && parseSimulatorScenario(asObject(current.settings)).authRequired,
      });
      if (problems.length > 0) {
        throw new BusinessRuleError('CONFIGURATION_INCOMPLETE', `Activation impossible : ${problems.join(' ')}`, { details: { problems } });
      }
    }
    const updated = await this.prisma.client.$transaction(async (tx) => {
      const row = await tx.telemetryProvider.update({
        where: { id, version: dto.expectedVersion },
        data: { status: target, version: { increment: 1 }, ...(target === 'ACTIF' ? { consecutiveFailures: 0, circuitOpenUntil: null } : {}) },
        include: providerInclude,
      });
      await this.audit.record(ctx, { action: `telemetrie.fournisseur.${target === 'ACTIF' ? 'activation' : target === 'SUSPENDU' ? 'suspension' : 'desactivation'}`, objectType: 'TelemetryProvider', objectId: id, reason, before: { status: current.status }, after: { status: target } }, tx);
      if (target !== 'ACTIF') {
        await this.telemetryAlerts.resolveObjectAlerts(ctx.organizationId, PROVIDER_ALERT_OBJECT, id, target === 'SUSPENDU' ? 'Fournisseur suspendu.' : 'Fournisseur désactivé.', tx);
        if (target === 'DESACTIVE') {
          // DESACTIVE est terminal : les associations en cours sont clôturées à cet instant (historique et
          // relevés conservés) et les propositions rejetées, pour que les véhicules redeviennent « sans
          // unité » et puissent être associés à un autre fournisseur sans clôture manuelle une à une.
          const closedAt = this.clock.now();
          const closedReason = `Fournisseur désactivé : ${reason}`;
          const mappings = await tx.telemetryVehicleMapping.findMany({ where: { providerId: id, status: 'CONFIRME', validTo: null }, select: { id: true, companyId: true, validFrom: true } });
          for (const m of mappings) {
            await tx.telemetryVehicleMapping.update({ where: { id: m.id }, data: { status: 'CLOTURE', validTo: closedAt, closedReason, version: { increment: 1 } } });
            await this.audit.record(ctx, { action: 'telemetrie.association.cloture', objectType: 'TelemetryVehicleMapping', objectId: m.id, companyId: m.companyId, reason: closedReason, before: { status: 'CONFIRME', validTo: null }, after: { status: 'CLOTURE', validTo: closedAt } }, tx);
            await this.telemetryAlerts.resolveObjectAlerts(ctx.organizationId, MAPPING_ALERT_OBJECT, m.id, 'Fournisseur désactivé.', tx);
          }
          await tx.telemetryVehicleMapping.updateMany({
            where: { providerId: id, status: 'PROPOSE' },
            data: { status: 'REJETE', decidedAt: closedAt, decidedById: ctx.userId, closedReason, version: { increment: 1 } },
          });
        }
      }
      return row;
    });
    await this.telemetryAlerts.refreshUnmappedUnitAlerts(ctx.organizationId, id);
    return this.view(ctx, updated);
  }

  async putCredential(ctx: RequestContext, id: string, kind: string, secret: string): Promise<CredentialStatusDto> {
    this.access.requireAdmin(ctx);
    const credentialKind = parseCredentialKind(kind);
    const provider = await this.loadForAdmin(ctx, id);
    if (provider.status === 'DESACTIVE') throw new BusinessRuleError('FOURNISSEUR_DESACTIVE', 'Un fournisseur désactivé n’accepte plus de secret.');
    assertCredentialKindAllowed(provider.kind, credentialKind);
    if (secret.trim().length < 4) throw invalid('secret', 'Secret trop court.');
    if (credentialKind === 'IDENTIFIANTS_API' || credentialKind === 'IMAP' || credentialKind === 'SFTP') {
      const colon = secret.indexOf(':');
      if (colon <= 0 || colon === secret.length - 1) {
        throw invalid('secret', 'Format attendu « identifiant:motdepasse » (pour SFTP, « identifiant:clé privée PEM » est aussi accepté).');
      }
    }
    if (credentialKind === 'SIGNATURE_WEBHOOK' && !WEBHOOK_SECRET_PATTERN.test(secret)) {
      throw invalid('secret', 'Secret de signature : 32 à 256 caractères imprimables, sans espace (utilisez « Générer un secret » de l’écran d’administration).');
    }
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        // Secret de signature webhook : rotation avec période de recouvrement (l'ancien reste accepté, D-298).
        const status =
          credentialKind === 'SIGNATURE_WEBHOOK'
            ? await this.credentials.rotateSigningSecret(tx, provider, secret, ctx.userId, effectiveWebhookSettings(provider.settings).rotationOverlapHours * 3_600_000)
            : await this.credentials.store(tx, provider, credentialKind, secret, ctx.userId);
        await this.audit.record(
          ctx,
          { action: 'telemetrie.secret.depot', objectType: 'TelemetryProvider', objectId: id, after: { kind: credentialKind, configured: true, rotatedAt: status.rotatedAt, ...(status.previousValidUntil !== undefined ? { previousValidUntil: status.previousValidUntil } : {}) } },
          tx,
        );
        return status;
      });
    } catch (error) {
      // Deux premiers dépôts simultanés de la même nature : un seul secret actif (index unique partiel).
      if (isUniqueViolation(error)) throw new ConflictError('DEPOT_SECRET_CONCURRENT', 'Un autre dépôt de ce secret vient d’aboutir : rechargez la fiche puis recommencez si nécessaire.');
      throw error;
    }
  }

  async removeCredential(ctx: RequestContext, id: string, kind: string): Promise<CredentialStatusDto> {
    this.access.requireAdmin(ctx);
    const credentialKind = parseCredentialKind(kind);
    await this.loadForAdmin(ctx, id);
    return this.prisma.client.$transaction(async (tx) => {
      const removed = await this.credentials.remove(tx, id, credentialKind);
      if (!removed) throw new NotFoundOrOutOfScopeError('Secret');
      await this.audit.record(ctx, { action: 'telemetrie.secret.suppression', objectType: 'TelemetryProvider', objectId: id, after: { kind: credentialKind, configured: false } }, tx);
      return { kind: credentialKind, configured: false, rotatedAt: null };
    });
  }

  /** Test de connexion réel (healthCheck de l'adaptateur) ; message toujours expurgé. */
  async health(ctx: RequestContext, id: string): Promise<ProviderHealthDto> {
    this.access.requireAdmin(ctx);
    const provider = await this.loadForAdmin(ctx, id);
    if (provider.status === 'DESACTIVE') throw new BusinessRuleError('FOURNISSEUR_DESACTIVE', 'Fournisseur désactivé.');
    let result: ProviderHealthDto;
    try {
      // Message expurgé pendant l'appel, tant que les secrets déchiffrés sont suivis (trackSensitiveValues) :
      // un message d'adaptateur citant un secret brut ne sort jamais de withAdapter.
      const health = await this.registry.withAdapter(provider, async (adapter) => {
        const checked = await withDeadline(adapter.healthCheck(), PROVIDER_TIMEOUT_MS * 2);
        return { ...checked, message: redactSensitiveText(checked.message) };
      });
      result = { ok: health.ok, message: health.message, latencyMs: health.latencyMs, checkedAt: health.checkedAt.toISOString() };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      result = { ok: false, message: providerErrorMessage(error), latencyMs: null, checkedAt: this.clock.now().toISOString() };
    }
    if (provider.kind === 'SIMULATEUR' && !result.message.startsWith(SIMULATOR_LABEL)) result.message = `${SIMULATOR_LABEL} : ${result.message}`;
    if (!result.ok) this.logger.warn(`Test de connexion en échec — fournisseur ${provider.id} (${provider.kind}) : ${result.message}`);
    await this.audit.record(ctx, { action: 'telemetrie.fournisseur.test_connexion', objectType: 'TelemetryProvider', objectId: id, after: { ok: result.ok, message: result.message, latencyMs: result.latencyMs } });
    return result;
  }

  // ------------------------------------------------------------------------------------------
  // Activation par société (D-101, D-295)
  // ------------------------------------------------------------------------------------------

  async companies(ctx: RequestContext): Promise<CompanyTelemetryViewDto[]> {
    const scope = this.readScope(ctx);
    const rows = await this.prisma.client.company.findMany({
      where: { organizationId: ctx.organizationId, ...(scope ? { id: { in: scope } } : {}) },
      orderBy: [{ code: 'asc' }],
    });
    const links = await this.prisma.client.telemetryProviderCompany.findMany({
      where: { organizationId: ctx.organizationId, companyId: { in: rows.map((r) => r.id) } },
      include: { provider: { select: { id: true, name: true, kind: true, status: true } } },
    });
    return rows.map((c) => companyView(c, links.filter((l) => l.companyId === c.id).map((l) => l.provider)));
  }

  async setCompanyEnabled(ctx: RequestContext, companyId: string, enabled: boolean, dto: CompanyTelemetryDto): Promise<CompanyTelemetryViewDto> {
    this.access.requireAdmin(ctx);
    const company = await this.prisma.client.company.findFirst({ where: { id: companyId, organizationId: ctx.organizationId } });
    if (!company) throw new NotFoundOrOutOfScopeError('Société');
    if (dto.expectedVersion !== undefined) assertExpectedVersion(company, dto.expectedVersion, 'société');
    if (enabled && company.status !== 'ACTIF') throw new BusinessRuleError('SOCIETE_ARCHIVEE', 'Le module télématique ne peut pas être activé pour une société archivée.');
    const providersOf = async () =>
      (await this.prisma.client.telemetryProviderCompany.findMany({ where: { companyId }, include: { provider: { select: { id: true, name: true, kind: true, status: true } } } })).map((l) => l.provider);
    if (company.telemetryEnabled === enabled) return companyView(company, await providersOf());
    const reason = dto.reason.trim();
    const { updated, resolvedAlerts } = await this.prisma.client.$transaction(async (tx) => {
      const row = await tx.company.update({ where: { id: companyId, version: company.version }, data: { telemetryEnabled: enabled, version: { increment: 1 } } });
      const resolved = enabled ? 0 : await this.telemetryAlerts.resolveCompanyAlerts(ctx.organizationId, companyId, MODULE_DISABLED_REASON, tx);
      await this.audit.record(
        ctx,
        {
          action: enabled ? 'telemetrie.societe.activation' : 'telemetrie.societe.desactivation',
          objectType: 'Company',
          objectId: companyId,
          companyId,
          reason,
          before: { telemetryEnabled: company.telemetryEnabled },
          after: { telemetryEnabled: enabled, ...(enabled ? {} : { resolvedAlerts: resolved, effets: 'Synchronisation arrêtée, associations conservées (suspendues), relevés historiques conservés.' }) },
        },
        tx,
      );
      return { updated: row, resolvedAlerts: resolved };
    });
    const providers = await providersOf();
    for (const p of providers) await this.telemetryAlerts.refreshUnmappedUnitAlerts(ctx.organizationId, p.id);
    return { ...companyView(updated, providers), ...(enabled ? {} : { resolvedAlerts }) };
  }

  // ------------------------------------------------------------------------------------------
  // Chargement, périmètre et vues
  // ------------------------------------------------------------------------------------------

  /**
   * Sociétés lisibles pour la télématique (D-112) : null = toutes (administrateur). Le conducteur n'a
   * aucun accès ; un filtre de société est recoupé avec les habilitations (404 hors périmètre).
   */
  readScope(ctx: RequestContext, companyId?: string | null): string[] | null {
    this.access.requireStaff(ctx);
    if (companyId) {
      this.access.requireReader(ctx, companyId);
      return [companyId];
    }
    if (ctx.isAdmin) return null;
    const scope = [...this.access.companiesWithRole(ctx, READ_ROLES)];
    if (scope.length === 0) throw new ForbiddenActionError('Accès réservé au personnel de gestion du parc.');
    return scope;
  }

  /** Fournisseur visible (administrateur, ou couvrant une société lisible) ; 404 sinon. */
  async loadVisible(ctx: RequestContext, id: string): Promise<ProviderRow> {
    const scope = this.readScope(ctx);
    const row = await this.prisma.client.telemetryProvider.findFirst({ where: { id, organizationId: ctx.organizationId }, include: providerInclude });
    if (!row) throw new NotFoundOrOutOfScopeError('Fournisseur');
    if (scope && !row.companies.some((c) => scope.includes(c.companyId))) throw new NotFoundOrOutOfScopeError('Fournisseur');
    return row;
  }

  private async loadForAdmin(ctx: RequestContext, id: string): Promise<ProviderRow> {
    const row = await this.prisma.client.telemetryProvider.findFirst({ where: { id, organizationId: ctx.organizationId }, include: providerInclude });
    if (!row) throw new NotFoundOrOutOfScopeError('Fournisseur');
    return row;
  }

  /**
   * Paramètres non secrets validés par type (analyseurs des adaptateurs). Un brouillon peut être
   * enregistré sans paramètres ; ils sont alors exigés, complets, à l'activation.
   */
  private validateConfiguration(kind: TelemetryProviderKind, baseUrl: string | null, raw: Record<string, unknown>, draft: boolean): Record<string, unknown> {
    const settings = assertNonSecretSettings(raw);
    if (draft && Object.keys(settings).length === 0) {
      if (baseUrl && (kind === 'RAPPORT_GENERIQUE' || kind === 'WEBHOOK_GENERIQUE')) validateProviderConfiguration(kind, baseUrl, settings);
      return settings;
    }
    validateProviderConfiguration(kind, baseUrl, settings);
    return settings;
  }

  private async validateCompanies(ctx: RequestContext, companyIds: readonly string[]): Promise<string[]> {
    const unique = [...new Set(companyIds)];
    if (unique.length === 0) return [];
    const rows = await this.prisma.client.company.findMany({ where: { organizationId: ctx.organizationId, id: { in: unique } }, select: { id: true, status: true } });
    const missing = unique.filter((id) => !rows.some((r) => r.id === id));
    if (missing.length > 0) throw invalid('companyIds', 'Société inconnue.');
    if (rows.some((r) => r.status !== 'ACTIF')) throw invalid('companyIds', 'Une société archivée ne peut pas être couverte.');
    return unique;
  }

  private async view(ctx: RequestContext, row: ProviderRow): Promise<ProviderViewDto> {
    const scope = ctx.isAdmin ? null : this.access.companiesWithRole(ctx, READ_ROLES);
    const base: ProviderViewDto = {
      id: row.id,
      name: row.name,
      kind: row.kind,
      kindLabel: kindLabel(row.kind),
      channel: row.channel,
      status: row.status,
      isSimulator: row.kind === 'SIMULATEUR',
      notice: row.kind === 'SIMULATEUR' ? `${SIMULATOR_LABEL} : aucune donnée issue de ce fournisseur ne correspond à un véhicule réel.` : null,
      syncIntervalMinutes: row.syncIntervalMinutes,
      lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      consecutiveFailures: row.consecutiveFailures,
      circuitOpenUntil: row.circuitOpenUntil?.toISOString() ?? null,
      lastErrorSummary: row.lastErrorSummary ? redactSensitiveText(row.lastErrorSummary) : null,
      companyIds: row.companies.map((c) => c.companyId).filter((c) => scope === null || scope.includes(c)),
      version: row.version,
      configurationVisible: ctx.isAdmin,
    };
    if (!ctx.isAdmin) return base;
    return {
      ...base,
      baseUrl: row.baseUrl,
      settings: asObject(row.settings),
      backfillDays: row.backfillDays,
      credentials: await this.credentials.statuses(row.id, row.kind),
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/** Message d'erreur fournisseur présentable (nature + message expurgé). */
export function providerErrorMessage(error: ProviderError): string {
  const nature: Record<ProviderError['kind'], string> = {
    AUTHENTIFICATION: 'Authentification refusée par le fournisseur',
    QUOTA: 'Quota du fournisseur atteint',
    INJOIGNABLE: 'Fournisseur injoignable',
    REPONSE_INVALIDE: 'Réponse du fournisseur invalide',
    CONFIGURATION: 'Configuration du fournisseur incomplète',
  };
  const retry = error.retryAfterSeconds !== null ? ` (nouvel essai possible dans ${error.retryAfterSeconds} s)` : '';
  return `${nature[error.kind]}${retry} : ${describeErrorSafely(error)}`;
}

/** Erreur HTTP 502 pour un appel fournisseur en échec pendant une requête utilisateur. */
export function providerFailure(error: ProviderError, action: string, details: Record<string, unknown> = {}): AppError {
  return new AppError(HttpStatus.BAD_GATEWAY, 'FOURNISSEUR_EN_ECHEC', `${action} : ${providerErrorMessage(error)}`, {
    details: { errorKind: error.kind, retryAfterSeconds: error.retryAfterSeconds, ...details },
  });
}

function parseCredentialKind(kind: string): TelemetryCredentialKind {
  if (!(CREDENTIAL_KINDS as readonly string[]).includes(kind)) {
    throw new BusinessRuleError('NATURE_SECRET_INCONNUE', `Nature de secret inconnue : ${CREDENTIAL_KINDS.join(', ')} attendu.`);
  }
  return kind as TelemetryCredentialKind;
}

function asObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** Instantané audité : jamais les paramètres complets (scénario volumineux) ni un secret. */
function auditSnapshot(row: ProviderRow): Record<string, unknown> {
  return {
    name: row.name,
    kind: row.kind,
    channel: row.channel,
    status: row.status,
    baseUrl: row.baseUrl,
    settingsKeys: Object.keys(asObject(row.settings)),
    syncIntervalMinutes: row.syncIntervalMinutes,
    backfillDays: row.backfillDays,
    companyIds: row.companies.map((c) => c.companyId),
  };
}

function companyView(
  c: { id: string; code: string; legalName: string; telemetryEnabled: boolean; version: number },
  providers: Array<{ id: string; name: string; kind: TelemetryProviderKind; status: TelemetryProviderStatus }>,
): CompanyTelemetryViewDto {
  return {
    companyId: c.id,
    code: c.code,
    legalName: c.legalName,
    telemetryEnabled: c.telemetryEnabled,
    providers: providers.map((p) => ({ id: p.id, name: p.name, kind: p.kind, kindLabel: kindLabel(p.kind), status: p.status })),
    version: c.version,
  };
}

/** Borne la durée d'un appel fournisseur (l'adaptateur applique déjà son propre délai réseau). */
export async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProviderError('INJOIGNABLE', `Aucune réponse du fournisseur après ${Math.round(ms / 1000)} s.`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
