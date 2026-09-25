-- Lot D : carburant (remplacement, capacité), dépenses (avoirs, dépenses sans véhicule), achats incomplets.
-- Partie générée par prisma migrate diff, puis contraintes non exprimables dans Prisma.

-- AlterEnum
ALTER TYPE "FuelEntryStatus" ADD VALUE 'REMPLACE';

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "relatedExpenseId" UUID;

-- AlterTable
ALTER TABLE "FuelEntry" ADD COLUMN     "capacityConfirmedAt" TIMESTAMPTZ(3),
ADD COLUMN     "capacityConfirmedById" UUID,
ADD COLUMN     "replacesFuelEntryId" UUID,
ADD COLUMN     "tankCapacityExceeded" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "FuelPurchaseGap" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "FuelPurchaseGap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FuelPurchaseGap_vehicleId_startsAt_idx" ON "FuelPurchaseGap"("vehicleId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "FuelEntry_replacesFuelEntryId_key" ON "FuelEntry"("replacesFuelEntryId");

-- AddForeignKey
ALTER TABLE "FuelPurchaseGap" ADD CONSTRAINT "FuelPurchaseGap_vehicleId_organizationId_fkey" FOREIGN KEY ("vehicleId", "organizationId") REFERENCES "Vehicle"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Contraintes SQL complémentaires
-- ---------------------------------------------------------------------------

-- Dépense sans véhicule : réservée aux coûts de flotte (assurance, taxes, location, autre) (D-230).
ALTER TABLE "Expense"
  ADD CONSTRAINT "expense_vehicle_required_by_category" CHECK ("vehicleId" IS NOT NULL OR "category" IN ('ASSURANCE', 'TAXES', 'LOCATION', 'AUTRE'));

-- Période d'achats incomplets : intervalle non vide.
ALTER TABLE "FuelPurchaseGap"
  ADD CONSTRAINT "fuel_purchase_gap_interval_valid" CHECK ("startsAt" < "endsAt");

-- Un plein ne se remplace pas lui-même.
ALTER TABLE "FuelEntry"
  ADD CONSTRAINT "fuel_entry_not_self_replacement" CHECK ("replacesFuelEntryId" IS NULL OR "replacesFuelEntryId" <> "id");
