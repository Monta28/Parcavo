-- Lot F — Unités télématiques ignorées (CDC 9.1, 14.5 ; D-249) : une unité volontairement sans véhicule
-- (remorque, boîtier de rechange) peut être ignorée par l'administrateur ou le chef de parc d'une société
-- couverte. Elle ne reçoit alors ni proposition d'association ni alerte GPS_UNITE_NON_MAPPEE. L'état est
-- porté par l'unité : une association (TelemetryVehicleMapping) exige un véhicule.

-- AlterTable
ALTER TABLE "TelemetryUnit" ADD COLUMN     "ignoredAt" TIMESTAMPTZ(3),
ADD COLUMN     "ignoredById" UUID,
ADD COLUMN     "ignoredReason" TEXT;

-- Cohérence : soit les trois champs sont nuls (unité suivie), soit la date et un motif non vide sont
-- renseignés (unité ignorée ; l'auteur est nul pour une action système).
ALTER TABLE "TelemetryUnit"
  ADD CONSTRAINT "telemetry_unit_ignored_consistent" CHECK (
    ("ignoredAt" IS NULL AND "ignoredById" IS NULL AND "ignoredReason" IS NULL)
    OR ("ignoredAt" IS NOT NULL AND "ignoredReason" IS NOT NULL AND length(btrim("ignoredReason")) > 0)
  );
