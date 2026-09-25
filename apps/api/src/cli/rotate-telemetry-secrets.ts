/**
 * Rotation de la clé de chiffrement des secrets télématiques (CDC 14.6, D-304).
 *
 * Procédure :
 *  1. générer une nouvelle clé : `openssl rand -base64 32` ;
 *  2. déclarer la nouvelle clé active (SECRETS_ENCRYPTION_KEY, SECRETS_ENCRYPTION_KEY_ID=nouvel identifiant)
 *     et déplacer l'ancienne dans SECRETS_ENCRYPTION_PREVIOUS_KEYS (« ancien_kid:base64 ») ; redémarrer
 *     l'API et le worker (les secrets restent lisibles grâce au trousseau) ;
 *  3. simulation (par défaut, aucune écriture) : `pnpm --filter @parc-auto/api telemetry:rotate-secrets`, ou en
 *     production `docker compose -f docker-compose.prod.yml run --rm api node apps/api/dist/cli/rotate-telemetry-secrets.js` ;
 *  4. rechiffrement : même commande suivie de `--apply` ;
 *  5. relancer la simulation : 0 secret à rechiffrer ; retirer alors l'ancienne clé du trousseau.
 *
 * Le script n'affiche jamais un secret : seulement des identifiants, des natures et des compteurs.
 * Code de sortie 1 si un secret ne peut pas être déchiffré (clé absente du trousseau ou chiffré altéré).
 */
import { pathToFileURL } from 'node:url';
import type { TelemetryCredentialKind } from '@parc-auto/db';
import { AuditService } from '../infra/audit.service.js';
import { loadEnv } from '../infra/env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { SecretsCryptoService } from '../infra/secrets-crypto.service.js';
import { encryptedToColumns } from '../modules/telemetry/telemetry-credentials.service.js';

export interface RotationReport {
  activeKeyId: string;
  dryRun: boolean;
  total: number;
  /** Nombre de secrets par identifiant de clé avant l'opération. */
  byKeyId: Record<string, number>;
  alreadyOnActiveKey: number;
  toReencrypt: number;
  reencrypted: number;
  undecryptable: Array<{ credentialId: string; providerId: string; kind: TelemetryCredentialKind; keyId: string; reason: string }>;
}

/** Rechiffre sous la clé active tous les secrets chiffrés avec une ancienne clé du trousseau. */
export async function rotateTelemetrySecrets(deps: { prisma: PrismaService; crypto: SecretsCryptoService; audit: AuditService }, options: { apply: boolean }): Promise<RotationReport> {
  const { prisma, crypto, audit } = deps;
  if (!crypto.isConfigured()) throw new Error('SECRETS_ENCRYPTION_KEY n’est pas configurée : rotation impossible.');
  const activeKeyId = crypto.activeKeyId();
  const rows = await prisma.client.telemetryCredential.findMany({ orderBy: { createdAt: 'asc' } });
  const report: RotationReport = { activeKeyId, dryRun: !options.apply, total: rows.length, byKeyId: {}, alreadyOnActiveKey: 0, toReencrypt: 0, reencrypted: 0, undecryptable: [] };
  const perOrganization = new Map<string, number>();
  for (const row of rows) {
    report.byKeyId[row.keyId] = (report.byKeyId[row.keyId] ?? 0) + 1;
    if (row.keyId === activeKeyId) {
      report.alreadyOnActiveKey += 1;
      continue;
    }
    const failure = (reason: string) => report.undecryptable.push({ credentialId: row.id, providerId: row.providerId, kind: row.kind, keyId: row.keyId, reason });
    if (!crypto.canDecrypt(row.keyId)) {
      failure('Clé absente du trousseau (SECRETS_ENCRYPTION_PREVIOUS_KEYS).');
      continue;
    }
    const stored = { keyId: row.keyId, iv: Buffer.from(row.iv), authTag: Buffer.from(row.authTag), ciphertext: Buffer.from(row.ciphertext) };
    let next: ReturnType<SecretsCryptoService['reencrypt']>;
    try {
      next = crypto.reencrypt(stored);
    } catch {
      failure('Déchiffrement impossible : clé erronée pour cet identifiant ou chiffré altéré.');
      continue;
    }
    report.toReencrypt += 1;
    if (!options.apply) continue;
    const updated = await prisma.client.telemetryCredential.updateMany({
      where: { id: row.id, keyId: row.keyId },
      data: encryptedToColumns(next),
    });
    if (updated.count === 1) {
      report.reencrypted += 1;
      perOrganization.set(row.organizationId, (perOrganization.get(row.organizationId) ?? 0) + 1);
    }
  }
  for (const [organizationId, count] of perOrganization) {
    await audit.recordSystem(organizationId, {
      action: 'telemetrie.secrets.rechiffrement',
      objectType: 'TelemetryCredential',
      reason: 'Rotation de la clé de chiffrement des secrets fournisseur (D-304).',
      after: { activeKeyId, reencrypted: count },
    });
  }
  return report;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage : rotate-telemetry-secrets [--apply]\nSans --apply : simulation, aucune écriture.\n');
    return;
  }
  const unknown = args.filter((a) => a !== '--apply');
  if (unknown.length > 0) throw new Error(`Argument inconnu : ${unknown.join(' ')}`);
  const env = loadEnv();
  const prisma = new PrismaService(env);
  try {
    const report = await rotateTelemetrySecrets({ prisma, crypto: new SecretsCryptoService(env), audit: new AuditService(prisma) }, { apply: args.includes('--apply') });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.dryRun && report.toReencrypt > 0) process.stdout.write(`Simulation : ${report.toReencrypt} secret(s) à rechiffrer sous « ${report.activeKeyId} ». Relancez avec --apply.\n`);
    if (report.undecryptable.length > 0) process.exitCode = 1;
  } finally {
    await prisma.client.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`Rotation interrompue : ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
