import { Injectable } from '@nestjs/common';
import { Prisma } from '@parc-auto/db';
import { SETTING_DEFAULTS, SETTING_DESCRIPTORS, type SettingKey } from '@parc-auto/contracts';
import { BusinessRuleError, ConflictError, ErrorCodes, NotFoundOrOutOfScopeError } from '../../common/errors.js';
import type { RequestContext } from '../../common/request-context.js';
import { AuditService } from '../../infra/audit.service.js';
import { PrismaService, type Tx } from '../../infra/prisma.service.js';
import { AccessControlService } from '../access-control/access-control.service.js';

export type SettingValueOf<K extends SettingKey> = (typeof SETTING_DEFAULTS)[K] extends readonly (infer U)[] ? U[] : (typeof SETTING_DEFAULTS)[K] extends number ? number : (typeof SETTING_DEFAULTS)[K] extends boolean ? boolean : string;

export interface EffectiveSetting {
  key: SettingKey;
  label: string;
  unit: string | null;
  value: unknown;
  source: 'defaut' | 'groupe' | 'societe';
  settingVersion: number | null;
  companyOverride: boolean;
  /** Faux pour une valeur fixe du produit (descripteur `fixed`) : affichée, jamais modifiable. */
  editable: boolean;
}

export interface SettingVersionView {
  companyId: string | null;
  value: unknown;
  settingVersion: number;
  isCurrent: boolean;
  reason: string | null;
  createdAt: string;
  createdById: string | null;
  /** Prénom et nom de l'auteur de la version (null si le compte n'existe plus). */
  createdByName: string | null;
}

/**
 * Paramètres versionnés (CDC 17.1) : défaut du produit < valeur groupe < surcharge explicite par société.
 * Chaque modification crée une nouvelle version, conserve l'ancienne et est auditée.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly audit: AuditService,
  ) {}

  /** Valeur effective pour une organisation et, si fournie, une société (surcharge explicite). */
  async get<K extends SettingKey>(organizationId: string, key: K, companyId?: string | null, tx?: Tx): Promise<SettingValueOf<K>> {
    // Valeur fixe du produit : une ligne enregistrée avant qu'elle ne le devienne n'a aucun effet.
    if (SETTING_DESCRIPTORS[key].fixed !== undefined) return SETTING_DEFAULTS[key] as unknown as SettingValueOf<K>;
    const client = tx ?? this.prisma.client;
    const rows = await client.settingValue.findMany({
      where: { organizationId, key, isCurrent: true, OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])] },
    });
    const company = companyId ? rows.find((r) => r.companyId === companyId) : undefined;
    const group = rows.find((r) => r.companyId === null);
    const raw = (company ?? group)?.value ?? SETTING_DEFAULTS[key];
    return raw as SettingValueOf<K>;
  }

  async list(ctx: RequestContext, companyId: string | null): Promise<EffectiveSetting[]> {
    this.access.requireStaff(ctx);
    if (companyId) this.access.assertCompanyReadable(ctx, companyId);
    const rows = await this.prisma.client.settingValue.findMany({ where: { organizationId: ctx.organizationId, isCurrent: true, OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])] } });
    return (Object.keys(SETTING_DEFAULTS) as SettingKey[]).map((key) => {
      const d = SETTING_DESCRIPTORS[key];
      const editable = d.fixed === undefined;
      const company = editable && companyId ? rows.find((r) => r.key === key && r.companyId === companyId) : undefined;
      const group = editable ? rows.find((r) => r.key === key && r.companyId === null) : undefined;
      const chosen = company ?? group;
      return {
        key,
        label: d.label,
        unit: d.unit ?? null,
        value: chosen?.value ?? SETTING_DEFAULTS[key],
        source: company ? 'societe' : group ? 'groupe' : 'defaut',
        settingVersion: chosen?.settingVersion ?? null,
        companyOverride: d.companyOverride,
        editable,
      };
    });
  }

  async history(ctx: RequestContext, key: string): Promise<SettingVersionView[]> {
    this.access.requireAdmin(ctx);
    if (!(key in SETTING_DEFAULTS)) throw new NotFoundOrOutOfScopeError('Paramètre');
    const rows = await this.prisma.client.settingValue.findMany({ where: { organizationId: ctx.organizationId, key }, orderBy: [{ companyId: 'asc' }, { settingVersion: 'desc' }] });
    const authorIds = [...new Set(rows.map((r) => r.createdById).filter((id): id is string => id !== null))];
    const authors = authorIds.length > 0 ? await this.prisma.client.user.findMany({ where: { organizationId: ctx.organizationId, id: { in: authorIds } }, select: { id: true, firstName: true, lastName: true } }) : [];
    const names = new Map(authors.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
    return rows.map((r) => ({
      companyId: r.companyId,
      value: r.value,
      settingVersion: r.settingVersion,
      isCurrent: r.isCurrent,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
      createdById: r.createdById,
      createdByName: r.createdById ? (names.get(r.createdById) ?? null) : null,
    }));
  }

  /**
   * Nouvelle version d'un paramètre (administrateur ; motif obligatoire ; audit avant/après). `expectedVersion`
   * (facultatif) est la version courante du niveau modifié, 0 quand ce niveau n'a aucune valeur : une
   * modification concurrente est refusée en 409 au lieu d'être écrasée.
   */
  async set(ctx: RequestContext, key: string, value: unknown, companyId: string | null, reason: string, expectedVersion?: number): Promise<EffectiveSetting> {
    this.access.requireAdmin(ctx);
    const k = this.editableKey(key);
    const descriptor = SETTING_DESCRIPTORS[k];
    if (companyId) {
      if (!descriptor.companyOverride) throw new BusinessRuleError('SURCHARGE_INTERDITE', 'Ce paramètre ne se surcharge pas par société.');
      await this.assertCompany(ctx, companyId);
    }
    const normalized = validateSettingValue(k, value);
    await this.withConcurrencyGuard(() =>
      this.prisma.client.$transaction(async (tx) => {
        const previous = await tx.settingValue.findFirst({ where: { organizationId: ctx.organizationId, companyId, key: k, isCurrent: true } });
        assertSettingVersion(previous?.settingVersion ?? 0, expectedVersion);
        // Valeur remplacée : la version courante de ce niveau, sinon celle qui s'appliquait (groupe ou défaut).
        const replaced = previous ? previous.value : companyId ? await this.get(ctx.organizationId, k, null, tx) : SETTING_DEFAULTS[k];
        if (previous) await tx.settingValue.update({ where: { id: previous.id }, data: { isCurrent: false } });
        const last = await tx.settingValue.findFirst({ where: { organizationId: ctx.organizationId, companyId, key: k }, orderBy: { settingVersion: 'desc' } });
        const settingVersion = (last?.settingVersion ?? 0) + 1;
        await tx.settingValue.create({
          data: { organizationId: ctx.organizationId, companyId, key: k, value: normalized as Prisma.InputJsonValue, settingVersion, isCurrent: true, reason, createdById: ctx.userId },
        });
        await this.audit.record(
          ctx,
          { action: 'parametre.modification', objectType: 'Setting', objectId: null, companyId, reason, before: { key: k, value: replaced, settingVersion: previous?.settingVersion ?? null }, after: { key: k, value: normalized, settingVersion } },
          tx,
        );
      }),
    );
    return (await this.list(ctx, companyId)).find((s) => s.key === k) as EffectiveSetting;
  }

  /**
   * Retire une surcharge société (retour à la valeur groupe), avec trace : l'audit porte la surcharge
   * retirée (avant) et la valeur qui s'applique désormais à la société, avec son origine (après).
   * Sans surcharge en vigueur : 404 (rien n'est retiré, rien n'est tracé).
   */
  async clearCompanyOverride(ctx: RequestContext, key: string, companyId: string, reason: string, expectedVersion?: number): Promise<void> {
    this.access.requireAdmin(ctx);
    const k = this.editableKey(key);
    if (!SETTING_DESCRIPTORS[k].companyOverride) throw new BusinessRuleError('SURCHARGE_INTERDITE', 'Ce paramètre ne se surcharge pas par société.');
    await this.assertCompany(ctx, companyId);
    await this.withConcurrencyGuard(() =>
      this.prisma.client.$transaction(async (tx) => {
        const current = await tx.settingValue.findFirst({ where: { organizationId: ctx.organizationId, companyId, key: k, isCurrent: true } });
        if (!current) throw new NotFoundOrOutOfScopeError('Surcharge société');
        assertSettingVersion(current.settingVersion, expectedVersion);
        await tx.settingValue.update({ where: { id: current.id }, data: { isCurrent: false } });
        const group = await tx.settingValue.findFirst({ where: { organizationId: ctx.organizationId, companyId: null, key: k, isCurrent: true } });
        await this.audit.record(
          ctx,
          {
            action: 'parametre.surcharge_retiree',
            objectType: 'Setting',
            companyId,
            reason,
            before: { key: k, value: current.value, source: 'societe', settingVersion: current.settingVersion },
            after: { key: k, value: group ? group.value : SETTING_DEFAULTS[k], source: group ? 'groupe' : 'defaut', settingVersion: group?.settingVersion ?? null },
          },
          tx,
        );
      }),
    );
  }

  /** Clé connue et modifiable : inconnue → 404 ; valeur fixe du produit → 422 PARAMETRE_NON_MODIFIABLE. */
  private editableKey(key: string): SettingKey {
    if (!(key in SETTING_DEFAULTS)) throw new NotFoundOrOutOfScopeError('Paramètre');
    const k = key as SettingKey;
    const fixed = SETTING_DESCRIPTORS[k].fixed;
    if (fixed !== undefined) throw new BusinessRuleError('PARAMETRE_NON_MODIFIABLE', `${SETTING_DESCRIPTORS[k].label} : valeur fixe, non modifiable. ${fixed}`);
    return k;
  }

  private async assertCompany(ctx: RequestContext, companyId: string): Promise<void> {
    const company = await this.prisma.client.company.findFirst({ where: { id: companyId, organizationId: ctx.organizationId }, select: { id: true } });
    if (!company) throw new NotFoundOrOutOfScopeError('Société');
  }

  /** Deux écritures simultanées du même niveau se heurtent à l'index « une version courante » : 409, jamais 500. */
  private async withConcurrencyGuard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError(ErrorCodes.VERSION_OBSOLETE, 'Ce paramètre vient d’être modifié par ailleurs. Rechargez puis réessayez.');
      }
      throw error;
    }
  }
}

/** Verrou optimiste d'un niveau de paramètre (groupe ou société) : version courante, 0 sans valeur. */
function assertSettingVersion(current: number, expected: number | undefined): void {
  if (expected !== undefined && expected !== current) {
    throw new ConflictError(ErrorCodes.VERSION_OBSOLETE, `Ce paramètre a été modifié entre-temps : version ${current} enregistrée, version ${expected} attendue. Rechargez puis réessayez.`, {
      currentVersion: current,
      expectedVersion: expected,
    });
  }
}

export function validateSettingValue(key: SettingKey, value: unknown): unknown {
  const d = SETTING_DESCRIPTORS[key];
  const fail = (msg: string): never => {
    throw new BusinessRuleError('PARAMETRE_INVALIDE', `${d.label} : ${msg}`, { fieldErrors: { value: [msg] } });
  };
  const inRange = (n: number) => {
    if (d.min !== undefined && n < d.min) fail(`valeur minimale ${d.min}${d.unit ? ` ${d.unit}` : ''}.`);
    if (d.max !== undefined && n > d.max) fail(`valeur maximale ${d.max}${d.unit ? ` ${d.unit}` : ''}.`);
  };
  switch (d.kind) {
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) fail('un entier est attendu.');
      inRange(value as number);
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('un nombre est attendu.');
      inRange(value as number);
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') fail('vrai ou faux attendu.');
      return value;
    case 'time':
      if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('heure HH:MM attendue.');
      return value;
    case 'integer-list': {
      if (!Array.isArray(value) || value.length === 0 || value.length > 10) fail('liste de 1 à 10 entiers attendue.');
      const list = (value as unknown[]).map((v) => {
        if (typeof v !== 'number' || !Number.isInteger(v)) fail('entiers attendus.');
        inRange(v as number);
        return v as number;
      });
      return [...new Set(list)].sort((a, b) => b - a);
    }
    case 'string-list': {
      if (!Array.isArray(value) || value.length > 30) fail('liste de 30 éléments au plus attendue.');
      return (value as unknown[]).map((v) => {
        if (typeof v !== 'string' || v.trim().length === 0 || v.length > 80) fail('libellés de 1 à 80 caractères attendus.');
        return (v as string).trim();
      });
    }
  }
}
