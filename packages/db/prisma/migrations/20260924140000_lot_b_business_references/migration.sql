-- Lot B : références métier lisibles (INC-AAAA-NNNNNN pour les incidents déclarés à la restitution,
-- INT-AAAA-NNNNNN pour les interventions), séquence par organisation, portée et année (D-203).

-- CreateTable
CREATE TABLE "ReferenceSequence" (
    "organizationId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ReferenceSequence_pkey" PRIMARY KEY ("organizationId","scope","year")
);

-- AlterTable
ALTER TABLE "Incident" ADD COLUMN     "reference" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Incident_organizationId_reference_key" ON "Incident"("organizationId", "reference");

-- Références métier : compteur positif.
ALTER TABLE "ReferenceSequence"
  ADD CONSTRAINT "reference_sequence_non_negative" CHECK ("lastValue" >= 0);
