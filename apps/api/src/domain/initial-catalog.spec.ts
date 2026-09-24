import { describe, expect, it } from 'vitest';
import { INITIAL_DOCUMENT_TYPES, INITIAL_MAINTENANCE_TYPES, comparableLabel, planCatalogInstall } from './initial-catalog.js';

const CODE = /^[A-Z0-9][A-Z0-9_-]{0,29}$/;

describe('catalogue initial livré (CDC 6.1, 7.1)', () => {
  it('opérations du CDC 6.1 : vidange moteur, filtres, freins, pneus, courroie, batterie, contrôle technique interne, autres', () => {
    expect(INITIAL_MAINTENANCE_TYPES.map((t) => t.label)).toEqual(['Vidange moteur', 'Filtres', 'Freins', 'Pneus', 'Courroie', 'Batterie', 'Contrôle technique interne', 'Autre opération']);
    for (const t of INITIAL_MAINTENANCE_TYPES) expect(t.code).toMatch(CODE);
    expect(new Set(INITIAL_MAINTENANCE_TYPES.map((t) => t.code)).size).toBe(INITIAL_MAINTENANCE_TYPES.length);
  });

  it('types de documents usuels par objet (véhicule et conducteur), codes valides et uniques ; pas de type « permis » (DriverPermit, D-133)', () => {
    const vehicle = INITIAL_DOCUMENT_TYPES.filter((t) => t.ownerType === 'VEHICULE').map((t) => t.code);
    const driver = INITIAL_DOCUMENT_TYPES.filter((t) => t.ownerType === 'CONDUCTEUR').map((t) => t.code);
    expect(vehicle).toEqual(expect.arrayContaining(['ASSURANCE', 'VISITE_TECHNIQUE', 'VIGNETTE_TAXE', 'CARTE_GRISE', 'LICENCE_VEHICULE', 'AUTORISATION_VEHICULE', 'CONTRAT_LOCATION', 'DOCUMENT_LIBRE_VEHICULE']));
    expect(driver).toEqual(expect.arrayContaining(['LICENCE_CONDUCTEUR', 'AUTORISATION_CONDUCTEUR', 'DOCUMENT_LIBRE_CONDUCTEUR']));
    for (const t of INITIAL_DOCUMENT_TYPES) expect(t.code).toMatch(CODE);
    expect(new Set(INITIAL_DOCUMENT_TYPES.map((t) => t.code)).size).toBe(INITIAL_DOCUMENT_TYPES.length);
    expect(INITIAL_DOCUMENT_TYPES.some((t) => /PERMIS/.test(t.code))).toBe(false);
    // Nature du document : la carte grise et les documents libres n'expirent pas.
    expect(INITIAL_DOCUMENT_TYPES.find((t) => t.code === 'CARTE_GRISE')?.hasExpiry).toBe(false);
    expect(INITIAL_DOCUMENT_TYPES.find((t) => t.code === 'ASSURANCE')?.hasExpiry).toBe(true);
  });

  it('libellés comparés sans accents, casse ni espaces superflus', () => {
    expect(comparableLabel('  Contrôle   technique INTERNE ')).toBe('controle technique interne');
    expect(comparableLabel('Vidange moteur')).toBe(comparableLabel('VIDANGE MOTEUR'));
  });

  it('n’ajoute que les éléments absents : même code ou même libellé (dans la même portée) → ignoré, jamais modifié', () => {
    const initial = [
      { code: 'VIDANGE_MOTEUR', label: 'Vidange moteur' },
      { code: 'PNEUS', label: 'Pneus' },
      { code: 'FREINS', label: 'Freins' },
    ];
    const plan = planCatalogInstall(initial, [
      { code: 'VIDANGE', label: 'vidange  MOTEUR' },
      { code: 'PNEUS', label: 'Pneumatiques' },
    ]);
    expect(plan.toCreate.map((t) => t.code)).toEqual(['FREINS']);
    expect(plan.skipped).toEqual([
      { code: 'VIDANGE_MOTEUR', label: 'Vidange moteur', reason: 'LIBELLE_EXISTANT' },
      { code: 'PNEUS', label: 'Pneus', reason: 'CODE_EXISTANT' },
    ]);
    // Idempotence : une fois installé, plus rien à créer.
    expect(planCatalogInstall(initial, initial).toCreate).toEqual([]);
  });

  it('portée : un même libellé pour un autre objet propriétaire n’empêche pas l’installation', () => {
    const plan = planCatalogInstall([{ code: 'AUTORISATION_CONDUCTEUR', label: 'Autorisation', scope: 'CONDUCTEUR' }], [{ code: 'AUTORISATION_VEHICULE', label: 'Autorisation', scope: 'VEHICULE' }]);
    expect(plan.toCreate).toHaveLength(1);
  });
});
