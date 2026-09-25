-- Lot F — Réception webhook des fournisseurs télématiques (CDC 14.4, 14.6 ; D-298 ; R-14.4-02, R-14.4-X01).
-- Canal WEBHOOK (type WEBHOOK_GENERIQUE) : le fournisseur pousse des lots signés HMAC-SHA256 ; l'API vérifie
-- la signature (secret SIGNATURE_WEBHOOK chiffré au repos), borne taille et débit puis dépose le lot dans
-- une file persistante (TelemetryWebhookDelivery) ; seul le worker l'ingère, par l'ingestion unique.
-- Les nouvelles valeurs d'énumération ne sont pas utilisées dans cette migration (ALTER TYPE ... ADD VALUE).

-- CreateEnum
CREATE TYPE "TelemetryWebhookStatus" AS ENUM ('EN_ATTENTE', 'EN_COURS', 'TRAITE', 'IGNORE', 'ECHEC');

-- AlterEnum
ALTER TYPE "TelemetryChannel" ADD VALUE 'WEBHOOK';

-- AlterEnum
ALTER TYPE "TelemetryCredentialKind" ADD VALUE 'SIGNATURE_WEBHOOK';

-- AlterEnum
ALTER TYPE "TelemetryProviderKind" ADD VALUE 'WEBHOOK_GENERIQUE';

-- AlterTable
ALTER TABLE "TelemetryCredential" ADD COLUMN     "expiresAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "TelemetryWebhookDelivery" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "status" "TelemetryWebhookStatus" NOT NULL DEFAULT 'EN_ATTENTE',
    "signedAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "bodySha256" CHAR(64) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "unitCount" INTEGER NOT NULL DEFAULT 0,
    "odometerCount" INTEGER NOT NULL DEFAULT 0,
    "fuelCount" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL,
    "lockedBy" TEXT,
    "lockedUntil" TIMESTAMPTZ(3),
    "processedAt" TIMESTAMPTZ(3),
    "result" JSONB,
    "lastError" TEXT,

    CONSTRAINT "TelemetryWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelemetryWebhookDelivery_status_nextAttemptAt_idx" ON "TelemetryWebhookDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "TelemetryWebhookDelivery_providerId_receivedAt_idx" ON "TelemetryWebhookDelivery"("providerId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "telemetry_webhook_no_replay" ON "TelemetryWebhookDelivery"("providerId", "signedAt", "bodySha256");

-- AddForeignKey
ALTER TABLE "TelemetryWebhookDelivery" ADD CONSTRAINT "TelemetryWebhookDelivery_providerId_organizationId_fkey" FOREIGN KEY ("providerId", "organizationId") REFERENCES "TelemetryProvider"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Un secret actif n'a jamais de date de fin ; seul un secret de signature remplacé (rotation) en porte
-- une, pendant la période de recouvrement.
ALTER TABLE "TelemetryCredential"
  ADD CONSTRAINT "telemetry_credential_expiry_inactive_only" CHECK ("active" = false OR "expiresAt" IS NULL);

-- Invariants de la file : compteurs positifs, empreinte SHA-256 hexadécimale, état cohérent avec le
-- verrou de traitement et la date de fin.
ALTER TABLE "TelemetryWebhookDelivery"
  ADD CONSTRAINT "telemetry_webhook_counts" CHECK ("sizeBytes" > 0 AND "unitCount" >= 0 AND "odometerCount" >= 0 AND "fuelCount" >= 0 AND "attempts" >= 0),
  ADD CONSTRAINT "telemetry_webhook_sha256" CHECK ("bodySha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "telemetry_webhook_status_consistent" CHECK (
    ("status" = 'EN_ATTENTE' AND "processedAt" IS NULL AND "lockedBy" IS NULL AND "lockedUntil" IS NULL)
    OR ("status" = 'EN_COURS' AND "processedAt" IS NULL AND "lockedBy" IS NOT NULL AND "lockedUntil" IS NOT NULL)
    OR ("status" IN ('TRAITE', 'IGNORE', 'ECHEC') AND "processedAt" IS NOT NULL AND "lockedBy" IS NULL AND "lockedUntil" IS NULL)
  );
