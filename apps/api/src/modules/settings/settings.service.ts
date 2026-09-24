import { Injectable } from '@nestjs/common';
import type { Prisma } from '@parc-auto/db';
import { SETTING_DEFAULTS, SETTING_DESCRIPTORS, type SettingKey } from '@parc-auto/contracts';
import { BusinessRuleError, NotFoundOrOutOfScopeError } from '../../common/errors.js';
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
      const company = companyId ? rows.find((r) => r.key === key && r.companyId === companyId) : undefined;
      const group = rows.find((r) => r.key === key && r.companyId === null);
      const chosen = company ?? group;
      return {
        key,
        label: d.label,
        unit: d.unit ?? null,
        value: chosen?.value ?? SETTING_DEFAULTS[key],
        source: company ? 'societe' : group ? 'groupe' : 'defaut',
        settingVersion: chosen?.settingVersion ?? null,
        companyOverride: d.companyOverride,
      };
    });
  }

  async history(ctx: RequestContext, key: SettingKey): Promise<Array<{ companyId: string | null; value: unknown; settingVersion: number; isCurrent: boolean; reason: string | null; createdAt: string; createdById: string | null }>> {
    this.access.requireAdmin(ctx);
    const rows = await this.prisma.client.settingValue.findMany({ where: { organizationId: ctx.organizationId, key }, orderBy: [{ companyId: 'asc' }, { settingVersion: 'desc' }] });
    return rows.map((r) => ({ companyId: r.companyId, value: r.value, settingVersion: r.settingVersion, isCurrent: r.isCurrent, reason: r.reason, createdAt: r.createdAt.toISOString(), createdById: r.createdById }));
  }

  /** Nouvelle version d'un paramètre (administrateur ; motif obligatoire ; audit avant/après). */
  async set(ctx: RequestContext, key: string, value: unknown, companyId: string | null, reason: string): Promise<EffectiveSetting> {
    this.access.requireAdmin(ctx);
    if (!(key in SETTING_DEFAULTS)) throw new NotFoundOrOutOfScopeError('Paramètre');
    const k = key as SettingKey;
    const descriptor = SETTING_DESCRIPTORS[k];
    if (companyId) {
      if (!descriptor.companyOverride) throw new BusinessRuleError('SURCHARGE_INTERDITE', 'Ce paramètre ne se surcharge pas par société.');
      const company = await this.prisma.client.company.findFirst({ where: { id: companyId, organizationId: ctx.organizationId } });
      if (!company) throw new NotFoundOrOutOfScopeError('Société');
    }
    const normalized = validateSettingValue(k, value);
    await this.prisma.client.$transaction(async (tx) => {
      const previous = await tx.settingValue.findFirst({ where: { organizationId: ctx.organizationId, companyId, key: k, isCurrent: true } });
      if (previous) await tx.settingValue.update({ where: { id: previous.id }, data: { isCurrent: false } });
      const last = await tx.settingValue.findFirst({ where: { organizationId: ctx.organizationId, companyId, key: k }, orderBy: { settingVersion: 'desc' } });
      await tx.settingValue.create({
        data: { organizationId: ctx.organizationId, companyId, key: k, value: normalized as Prisma.InputJsonValue, settingVersion: (last?.settingVersion ?? 0) + 1, isCurrent: true, reason, createdById: ctx.userId },
      });
      await this.audit.record(ctx, { action: 'parametre.modification', objectType: 'Setting', objectId: null, companyId, reason, before: { key: k, value: previous?.value ?? SETTING_DEFAULTS[k] }, after: { key: k, value: normalized } }, tx);
    });
    return (await this.list(ctx, companyId)).find((s) => s.key === k) as EffectiveSetting;
  }

  /** Retire une surcharge société (retour à la valeur groupe), avec trace. */
  async clearCompanyOverride(ctx: RequestContext, key: string, companyId: string, reason: string): Promise<void> {
    this.access.requireAdmin(ctx);
    if (!(key in SETTING_DEFAULTS)) throw new NotFoundOrOutOfScopeError('Paramètre');
    await this.prisma.client.$transaction(async (tx) => {
      const current = await tx.settingValue.findFirst({ where: { organizationId: ctx.organizationId, companyId, key, isCurrent: true } });
      if (!current) return;
      await tx.settingValue.update({ where: { id: current.id }, data: { isCurrent: false } });
      await this.audit.record(ctx, { action: 'parametre.surcharge_retiree', objectType: 'Setting', companyId, reason, before: { key, value: current.value } }, tx);
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
