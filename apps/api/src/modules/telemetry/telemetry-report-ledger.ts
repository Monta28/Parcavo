import type { ParcAutoPrismaClient } from '@parc-auto/db';
import type { Clock } from '../../common/clock.js';
import { isUniqueViolation } from '../../infra/prisma.service.js';
import type { ReportLedger } from './telemetry-provider.interface.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Registre des fichiers de rapport déjà traités (canal RAPPORT, D-184) adossé à TelemetryReportFile :
 * idempotence par (fournisseur, SHA-256 du fichier). Un second marquage du même fichier est sans effet.
 */
export function createReportLedger(
  client: ParcAutoPrismaClient,
  clock: Clock,
  provider: { id: string; organizationId: string },
  syncRunId: string | null = null,
): ReportLedger {
  const normalize = (sha256: string): string => {
    const value = sha256.trim().toLowerCase();
    if (!SHA256_HEX.test(value)) throw new Error('Empreinte SHA-256 invalide (64 caractères hexadécimaux attendus).');
    return value;
  };
  return {
    async isProcessed(sha256: string): Promise<boolean> {
      const row = await client.telemetryReportFile.findUnique({ where: { providerId_sha256: { providerId: provider.id, sha256: normalize(sha256) } }, select: { id: true } });
      return row !== null;
    },
    async markProcessed(file: { sourceName: string; sha256: string; rowCount: number }): Promise<void> {
      try {
        await client.telemetryReportFile.create({
          data: {
            organizationId: provider.organizationId,
            providerId: provider.id,
            sourceName: file.sourceName.slice(0, 500),
            sha256: normalize(file.sha256),
            rowCount: Math.max(0, Math.trunc(file.rowCount)),
            processedAt: clock.now(),
            syncRunId,
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) return;
        throw error;
      }
    },
  };
}
