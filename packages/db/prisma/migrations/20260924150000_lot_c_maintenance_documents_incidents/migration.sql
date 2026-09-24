-- Lot C : entretien, interventions, documents, incidents, immobilisations.
-- Partie générée par prisma migrate diff, puis contraintes non exprimables dans Prisma.

-- CreateEnum
CREATE TYPE "InterventionCostStatus" AS ENUM ('A_SAISIR', 'SAISI', 'SANS_COUT');

-- CreateEnum
CREATE TYPE "CommentVisibility" AS ENUM ('INTERNE', 'PARTAGE_CONDUCTEUR');

-- AlterTable
ALTER TABLE "DocumentType" ADD COLUMN     "companyIds" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "vehicleCategoryIds" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "visibleToDriver" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "relatedIncidentId" UUID;

-- AlterTable
ALTER TABLE "Incident" DROP COLUMN "expenseId";

-- AlterTable
ALTER TABLE "IncidentComment" ADD COLUMN     "visibility" "CommentVisibility" NOT NULL DEFAULT 'INTERNE';

-- AlterTable
ALTER TABLE "Intervention" ADD COLUMN     "costStatus" "InterventionCostStatus" NOT NULL DEFAULT 'A_SAISIR';

-- CreateIndex
CREATE INDEX "Expense_relatedIncidentId_idx" ON "Expense"("relatedIncidentId");

-- CreateIndex
CREATE UNIQUE INDEX "immobilization_cause_one_open_per_incident" ON "ImmobilizationCause"("incidentId") WHERE ("endedAt" IS NULL AND "incidentId" IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "immobilization_cause_one_open_per_intervention" ON "ImmobilizationCause"("interventionId") WHERE ("endedAt" IS NULL AND "interventionId" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Contraintes SQL complémentaires (non exprimables dans le schéma Prisma)
-- ---------------------------------------------------------------------------

-- Une intervention terminée porte sa date effective de réalisation (6.4).
ALTER TABLE "Intervention"
  ADD CONSTRAINT "intervention_completed_has_date" CHECK ("status" <> 'TERMINEE' OR ("performedOn" IS NOT NULL AND "completedAt" IS NOT NULL));
ALTER TABLE "Intervention"
  ADD CONSTRAINT "intervention_cancelled_has_reason" CHECK ("status" <> 'ANNULEE' OR ("cancelledAt" IS NOT NULL AND "cancelReason" IS NOT NULL));
ALTER TABLE "Intervention"
  ADD CONSTRAINT "intervention_planned_interval_valid" CHECK ("plannedStartAt" IS NULL OR "plannedEndAt" IS NULL OR "plannedStartAt" <= "plannedEndAt");
ALTER TABLE "Intervention"
  ADD CONSTRAINT "intervention_total_non_negative" CHECK ("totalAmount" IS NULL OR "totalAmount" >= 0);

-- Un document bloquant est nécessairement requis (D-210) ; sans expiration, pas de date de fin (D-212).
ALTER TABLE "DocumentType"
  ADD CONSTRAINT "document_type_blocking_is_required" CHECK ("blocksCheckout" = false OR "required" = true);

-- Immobilisations d'un même véhicule : périodes [début, fin[ sans chevauchement (D-220) ;
-- une immobilisation active a une fin ouverte (borne supérieure infinie).
ALTER TABLE "Immobilization"
  ADD CONSTRAINT "immobilization_no_overlap"
  EXCLUDE USING gist ("vehicleId" WITH =, tstzrange("startedAt", "endedAt", '[)') WITH &&);
ALTER TABLE "Immobilization"
  ADD CONSTRAINT "immobilization_status_matches_end" CHECK (("status" = 'ACTIVE') = ("endedAt" IS NULL));

-- Cause d'immobilisation : la source correspond à la nature déclarée.
ALTER TABLE "ImmobilizationCause"
  ADD CONSTRAINT "immobilization_cause_source_matches_kind" CHECK (
    ("kind" = 'INCIDENT' AND "incidentId" IS NOT NULL) OR
    ("kind" = 'INTERVENTION' AND "interventionId" IS NOT NULL) OR
    ("kind" = 'AUTRE' AND "incidentId" IS NULL AND "interventionId" IS NULL)
  );
