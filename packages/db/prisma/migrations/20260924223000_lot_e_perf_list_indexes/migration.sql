-- Lot E — dimensionnement (CDC 17.2) : listes paginées sans tri de la table entière.
-- GET /readings (ordre observé puis saisi, périmètre organisation ou sociétés) et GET /usages d'une société
-- (statut puis départ le plus récent) : parcours d'index ordonné borné à la page, au lieu d'un parcours
-- séquentiel suivi d'un tri de 300 000 relevés ou 50 000 utilisations (mesures : docs/performance.md).

-- CreateIndex
CREATE INDEX "OdometerReading_organizationId_observedAt_enteredAt_idx" ON "OdometerReading"("organizationId", "observedAt" DESC, "enteredAt" DESC);

-- CreateIndex
CREATE INDEX "OdometerReading_organizationId_companyId_observedAt_entered_idx" ON "OdometerReading"("organizationId", "companyId", "observedAt" DESC, "enteredAt" DESC);

-- CreateIndex
CREATE INDEX "VehicleUsage_organizationId_companyId_status_checkedOutAt_idx" ON "VehicleUsage"("organizationId", "companyId", "status", "checkedOutAt" DESC);
