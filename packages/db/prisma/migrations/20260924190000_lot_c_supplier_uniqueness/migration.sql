-- Lot C — Fournisseurs (CDC 8.1, D-221) : unicité du nom par société parmi les fournisseurs ACTIF,
-- sur le nom normalisé (minuscules, sans accents, espaces compactés). Un fournisseur archivé ne bloque
-- plus un homonyme actif ; « Garage Élan » et « garage   elan » désignent le même fournisseur actif.

-- Nom normalisé calculé par PostgreSQL (règle unique, jamais écrite par l'application) :
-- décomposition NFD, suppression des diacritiques combinants U+0300 à U+036F, minuscules, suites
-- d'espaces réduites à un seul espace, espaces de bord supprimés.
ALTER TABLE "Supplier" ADD COLUMN "normalizedName" TEXT NOT NULL
  GENERATED ALWAYS AS (btrim(regexp_replace(lower(regexp_replace(normalize("name", NFD), '[' || chr(768) || '-' || chr(879) || ']', '', 'g')), '[[:space:]]+', ' ', 'g'))) STORED;

-- Données existantes : des fournisseurs actifs homonymes après normalisation doivent être renommés ou
-- archivés avant la migration ; aucune donnée n'est modifiée en silence.
DO $$
DECLARE
  duplicates text;
BEGIN
  SELECT string_agg(format('« %s » (société %s, %s fiches actives)', d."normalizedName", d."companyId", d.n), ' ; ')
    INTO duplicates
    FROM (
      SELECT "companyId", "normalizedName", count(*) AS n
        FROM "Supplier"
       WHERE "status" = 'ACTIF'
       GROUP BY "companyId", "normalizedName"
      HAVING count(*) > 1
    ) d;
  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION 'Fournisseurs actifs homonymes (nom normalisé) à renommer ou archiver avant la migration : %', duplicates;
  END IF;
END $$;

-- L'ancienne unicité (companyId, name) comptait aussi les archivés et distinguait majuscules et accents.
DROP INDEX "Supplier_companyId_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "supplier_active_normalized_name" ON "Supplier"("companyId", "normalizedName") WHERE ("status" = 'ACTIF');
