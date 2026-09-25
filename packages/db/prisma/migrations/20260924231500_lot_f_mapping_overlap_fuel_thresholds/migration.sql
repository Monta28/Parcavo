-- Lot F — compléments (CDC 8.5, 14.5, 17.1 ; D-238, D-240 ; R-14.5-X01, R-8.5-07, R-17.1-14).
--  1. Associations unité ↔ véhicule : les périodes [validFrom, validTo[ des associations CONFIRME et CLOTURE
--     ne se chevauchent ni pour une même unité ni pour un même véhicule (contraintes d'exclusion, en plus
--     des index uniques partiels « une association ouverte ») ; validFrom obligatoire et validFrom ≤ validTo.
--  2. Seuils carburant propres à un véhicule (groupe > société > véhicule) : table VehicleFuelThresholds,
--     bornes identiques aux paramètres telemetry.fuel* correspondants.

-- CreateTable
CREATE TABLE "VehicleFuelThresholds" (
    "vehicleId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "dropLiters" DECIMAL(9,3),
    "dropPercent" DECIMAL(9,3),
    "dropWindowMinutes" INTEGER,
    "fillLiters" DECIMAL(9,3),
    "fillPercent" DECIMAL(9,3),
    "fillWindowMinutes" INTEGER,
    "reason" TEXT NOT NULL,
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "VehicleFuelThresholds_pkey" PRIMARY KEY ("vehicleId")
);

-- CreateIndex
CREATE UNIQUE INDEX "VehicleFuelThresholds_vehicleId_organizationId_key" ON "VehicleFuelThresholds"("vehicleId", "organizationId");

-- AddForeignKey
ALTER TABLE "VehicleFuelThresholds" ADD CONSTRAINT "VehicleFuelThresholds_vehicleId_organizationId_fkey" FOREIGN KEY ("vehicleId", "organizationId") REFERENCES "Vehicle"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =============================================================================
-- SQL manuel
-- =============================================================================

-- Seuils par véhicule : au moins une surcharge, motif renseigné, bornes des paramètres telemetry.fuel*.
ALTER TABLE "VehicleFuelThresholds"
  ADD CONSTRAINT "vehicle_fuel_thresholds_not_empty" CHECK (
    "dropLiters" IS NOT NULL OR "dropPercent" IS NOT NULL OR "dropWindowMinutes" IS NOT NULL
    OR "fillLiters" IS NOT NULL OR "fillPercent" IS NOT NULL OR "fillWindowMinutes" IS NOT NULL
  );
ALTER TABLE "VehicleFuelThresholds"
  ADD CONSTRAINT "vehicle_fuel_thresholds_reason" CHECK (char_length(btrim("reason")) >= 3);
ALTER TABLE "VehicleFuelThresholds"
  ADD CONSTRAINT "vehicle_fuel_thresholds_bounds" CHECK (
    ("dropLiters" IS NULL OR "dropLiters" BETWEEN 0.5 AND 500)
    AND ("dropPercent" IS NULL OR "dropPercent" BETWEEN 0.5 AND 100)
    AND ("dropWindowMinutes" IS NULL OR "dropWindowMinutes" BETWEEN 5 AND 1440)
    AND ("fillLiters" IS NULL OR "fillLiters" BETWEEN 1 AND 1000)
    AND ("fillPercent" IS NULL OR "fillPercent" BETWEEN 1 AND 100)
    AND ("fillWindowMinutes" IS NULL OR "fillWindowMinutes" BETWEEN 5 AND 1440)
  );

-- 14.5 (R-14.5-X01) : une association confirmée ou clôturée a une date d'effet, et sa fin ne la précède pas
-- (validTo = validFrom : période vide, clôture à l'instant même de la confirmation).
ALTER TABLE "TelemetryVehicleMapping"
  ADD CONSTRAINT "telemetry_mapping_period_valid" CHECK (
    "status" NOT IN ('CONFIRME', 'CLOTURE')
    OR ("validFrom" IS NOT NULL AND ("validTo" IS NULL OR "validFrom" <= "validTo"))
  );

-- 14.5 (R-14.5-X01) : à une date donnée, une unité n'est associée qu'à un véhicule et un véhicule n'a qu'une
-- unité : périodes [validFrom, validTo[ sans chevauchement (validTo NULL = association en cours). Deux
-- associations consécutives (fin de l'une = début de l'autre, changement de boîtier) sont admises.
-- btree_gist est créée par la migration initiale.
ALTER TABLE "TelemetryVehicleMapping"
  ADD CONSTRAINT "telemetry_mapping_no_overlap_unit"
  EXCLUDE USING gist ("unitId" WITH =, tstzrange("validFrom", "validTo", '[)') WITH &&)
  WHERE ("status" IN ('CONFIRME', 'CLOTURE'));
ALTER TABLE "TelemetryVehicleMapping"
  ADD CONSTRAINT "telemetry_mapping_no_overlap_vehicle"
  EXCLUDE USING gist ("vehicleId" WITH =, tstzrange("validFrom", "validTo", '[)') WITH &&)
  WHERE ("status" IN ('CONFIRME', 'CLOTURE'));
