import { Injectable } from '@nestjs/common';
import type { TelemetryCredentialKind, TelemetryProviderKind } from '@parc-auto/db';
import { Clock } from '../../common/clock.js';
import { AppError, BusinessRuleError } from '../../common/errors.js';
import { PrismaService, type Tx } from '../../infra/prisma.service.js';
import { type EncryptedSecret, SecretsCryptoService } from '../../infra/secrets-crypto.service.js';
import { ADAPTER_SECRET_KINDS, type AdapterSecretKind, CREDENTIAL_KINDS_BY_PROVIDER } from './telemetry-settings.js';

/** État d'un secret tel que l'API peut le montrer : jamais la valeur ni un fragment (D-304, T44). */
export interface CredentialStatus {
  kind: TelemetryCredentialKind;
  configured: boolean;
  /** Date du dernier dépôt de ce secret (création ou remplacement). */
  rotatedAt: string | null;
  /**
   * Secret de signature webhook uniquement : l'ancien secret, remplacé lors de la dernière rotation, reste
   * accepté jusqu'à cette date (période de recouvrement) ; null s'il n'y en a plus.
   */
  previousValidUntil?: string | null;
}

/**
 * Secrets fournisseur en écriture seule (CDC 14.6, D-304) : chiffrés AES-256-GCM au dépôt, un seul
 * secret actif par nature ; seul le registre des adaptateurs les déchiffre, en mémoire, le temps d'un
 * appel. Aucune méthode ne renvoie un secret vers l'API.
 */
@Injectable()
export class TelemetryCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretsCryptoService,
    private readonly clock: Clock,
  ) {}

  /** État des secrets attendus pour ce type de fournisseur (et de tout secret actif déposé). */
  async statuses(providerId: string, providerKind: TelemetryProviderKind, tx?: Tx): Promise<CredentialStatus[]> {
    const client = tx ?? this.prisma.client;
    const rows = await client.telemetryCredential.findMany({ where: { providerId, active: true }, select: { kind: true, rotatedAt: true, createdAt: true } });
    const kinds = new Set<TelemetryCredentialKind>([...CREDENTIAL_KINDS_BY_PROVIDER[providerKind], ...rows.map((r) => r.kind)]);
    const previous = kinds.has('SIGNATURE_WEBHOOK') ? await this.previousSigningSecretExpiry(providerId, tx) : null;
    return [...kinds].map((kind) => {
      const row = rows.find((r) => r.kind === kind);
      const status: CredentialStatus = { kind, configured: row !== undefined, rotatedAt: row ? (row.rotatedAt ?? row.createdAt).toISOString() : null };
      if (kind === 'SIGNATURE_WEBHOOK') status.previousValidUntil = previous?.toISOString() ?? null;
      return status;
    });
  }

  /**
   * Rotation du secret de signature webhook (D-298) : le secret actif devient « remplacé » et reste
   * accepté pendant la période de recouvrement (overlapMs, 0 : supprimé aussitôt) ; un secret remplacé
   * plus ancien est supprimé. Le nouveau secret est chiffré au dépôt ; le clair n'est ni stocké ni renvoyé.
   */
  async rotateSigningSecret(tx: Tx, provider: { id: string; organizationId: string }, secret: string, userId: string | null, overlapMs: number): Promise<CredentialStatus> {
    const encrypted = this.crypto.encrypt(secret);
    const now = this.clock.now();
    // Dépôts concurrents sérialisés sur le fournisseur : un seul secret actif, un seul secret remplacé.
    await tx.$queryRaw`SELECT id FROM "TelemetryProvider" WHERE id = ${provider.id}::uuid FOR NO KEY UPDATE`;
    await tx.telemetryCredential.deleteMany({ where: { providerId: provider.id, kind: 'SIGNATURE_WEBHOOK', active: false } });
    const current = await tx.telemetryCredential.findFirst({ where: { providerId: provider.id, kind: 'SIGNATURE_WEBHOOK', active: true }, select: { id: true } });
    let previousValidUntil: Date | null = null;
    if (current && overlapMs > 0) {
      previousValidUntil = new Date(now.getTime() + overlapMs);
      await tx.telemetryCredential.update({ where: { id: current.id }, data: { active: false, expiresAt: previousValidUntil } });
    } else if (current) {
      await tx.telemetryCredential.delete({ where: { id: current.id } });
    }
    await tx.telemetryCredential.create({
      data: { organizationId: provider.organizationId, providerId: provider.id, kind: 'SIGNATURE_WEBHOOK', active: true, createdById: userId, ...encryptedToColumns(encrypted), rotatedAt: now },
    });
    return { kind: 'SIGNATURE_WEBHOOK', configured: true, rotatedAt: now.toISOString(), previousValidUntil: previousValidUntil?.toISOString() ?? null };
  }

  /**
   * Secrets de signature admis à l'instant donné, déchiffrés : l'actif puis l'ancien encore dans sa
   * période de recouvrement. Réservé à la vérification des lots webhook ; jamais journalisés ni renvoyés.
   */
  async signingSecrets(providerId: string, now: Date): Promise<string[]> {
    const rows = await this.prisma.client.telemetryCredential.findMany({
      where: { providerId, kind: 'SIGNATURE_WEBHOOK', OR: [{ active: true }, { active: false, expiresAt: { gt: now } }] },
      orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
    });
    const secrets: string[] = [];
    for (const row of rows) {
      try {
        secrets.push(this.crypto.decrypt({ keyId: row.keyId, iv: Buffer.from(row.iv), authTag: Buffer.from(row.authTag), ciphertext: Buffer.from(row.ciphertext) }));
      } catch {
        // Secret illisible (clé retirée ou donnée altérée) : il n'authentifie rien ; jamais de détail.
      }
    }
    return secrets;
  }

  /** Supprime les secrets de signature remplacés dont la période de recouvrement est échue. */
  async purgeExpiredSigningSecrets(now: Date): Promise<number> {
    const result = await this.prisma.client.telemetryCredential.deleteMany({ where: { kind: 'SIGNATURE_WEBHOOK', active: false, expiresAt: { lte: now } } });
    return result.count;
  }

  private async previousSigningSecretExpiry(providerId: string, tx?: Tx): Promise<Date | null> {
    const client = tx ?? this.prisma.client;
    const row = await client.telemetryCredential.findFirst({
      where: { providerId, kind: 'SIGNATURE_WEBHOOK', active: false, expiresAt: { gt: this.clock.now() } },
      orderBy: { expiresAt: 'desc' },
      select: { expiresAt: true },
    });
    return row?.expiresAt ?? null;
  }

  async configuredKinds(providerId: string, tx?: Tx): Promise<Set<TelemetryCredentialKind>> {
    const client = tx ?? this.prisma.client;
    const rows = await client.telemetryCredential.findMany({ where: { providerId, active: true }, select: { kind: true } });
    return new Set(rows.map((r) => r.kind));
  }

  /** Dépose (ou remplace) le secret d'une nature ; le clair n'est ni stocké ni renvoyé. */
  async store(tx: Tx, provider: { id: string; organizationId: string }, kind: TelemetryCredentialKind, secret: string, userId: string | null): Promise<CredentialStatus> {
    const encrypted = this.crypto.encrypt(secret);
    const now = this.clock.now();
    const existing = await tx.telemetryCredential.findFirst({ where: { providerId: provider.id, kind, active: true }, select: { id: true } });
    const data = { ...encryptedToColumns(encrypted), rotatedAt: now };
    if (existing) {
      await tx.telemetryCredential.update({ where: { id: existing.id }, data });
    } else {
      await tx.telemetryCredential.create({ data: { organizationId: provider.organizationId, providerId: provider.id, kind, active: true, createdById: userId, ...data } });
    }
    return { kind, configured: true, rotatedAt: now.toISOString() };
  }

  /** Supprime définitivement le secret d'une nature (révocation). */
  async remove(tx: Tx, providerId: string, kind: TelemetryCredentialKind): Promise<boolean> {
    const result = await tx.telemetryCredential.deleteMany({ where: { providerId, kind } });
    return result.count > 0;
  }

  /**
   * Secrets déchiffrés pour l'adaptateur (natures du contrat AdapterConfig uniquement). Réservé au
   * registre des adaptateurs : la valeur ne doit jamais être journalisée ni renvoyée.
   */
  async decryptForAdapter(providerId: string): Promise<Partial<Record<AdapterSecretKind, string>>> {
    const rows = await this.prisma.client.telemetryCredential.findMany({ where: { providerId, active: true, kind: { in: [...ADAPTER_SECRET_KINDS] } } });
    const secrets: Partial<Record<AdapterSecretKind, string>> = {};
    for (const row of rows) {
      try {
        secrets[row.kind as AdapterSecretKind] = this.crypto.decrypt({ keyId: row.keyId, iv: Buffer.from(row.iv), authTag: Buffer.from(row.authTag), ciphertext: Buffer.from(row.ciphertext) });
      } catch (error) {
        if (error instanceof AppError) throw error;
        // Échec d'authentification GCM : mauvaise clé pour cet identifiant ou chiffré altéré (jamais de détail).
        throw new BusinessRuleError('SECRET_ILLISIBLE', `Le secret ${row.kind} de ce fournisseur est illisible (clé incorrecte ou donnée altérée) : déposez-le de nouveau.`);
      }
    }
    return secrets;
  }
}

/** Colonnes d'un secret chiffré (octets copiés dans des Uint8Array autonomes, format attendu par Prisma). */
export function encryptedToColumns(secret: EncryptedSecret): { keyId: string; iv: Uint8Array<ArrayBuffer>; authTag: Uint8Array<ArrayBuffer>; ciphertext: Uint8Array<ArrayBuffer> } {
  return { keyId: secret.keyId, iv: new Uint8Array(secret.iv), authTag: new Uint8Array(secret.authTag), ciphertext: new Uint8Array(secret.ciphertext) };
}
