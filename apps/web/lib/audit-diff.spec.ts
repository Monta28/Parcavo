import { describe, expect, it } from 'vitest';
import { auditDiff, formatAuditValue, prettyJson } from './audit-diff';
import { objectHref } from './object-links';

const ID = '11111111-2222-4333-8444-555555555555';
const VEHICLE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('Mise en regard avant/après du journal d’audit (affichage seul)', () => {
  it('compare champ par champ, sans tenir compte de l’ordre des clés imbriquées', () => {
    const rows = auditDiff({ statut: 'ACTIF', note: 'a', options: { b: 1, a: 2 } }, { statut: 'ARCHIVE', options: { a: 2, b: 1 }, motif: 'x' });
    expect(rows).toEqual([
      { key: 'statut', before: 'ACTIF', after: 'ARCHIVE', hasBefore: true, hasAfter: true, change: 'MODIFIE' },
      { key: 'note', before: 'a', after: undefined, hasBefore: true, hasAfter: false, change: 'RETIRE' },
      { key: 'options', before: { b: 1, a: 2 }, after: { a: 2, b: 1 }, hasBefore: true, hasAfter: true, change: 'INCHANGE' },
      { key: 'motif', before: undefined, after: 'x', hasBefore: false, hasAfter: true, change: 'AJOUTE' },
    ]);
  });

  it('création (avant absent) : tous les champs sont ajoutés ; valeur explicite null conservée', () => {
    expect(auditDiff(null, { a: null })).toEqual([{ key: 'a', before: undefined, after: null, hasBefore: false, hasAfter: true, change: 'AJOUTE' }]);
    expect(auditDiff(null, null)).toEqual([]);
  });

  it('valeurs non objet : pas de comparaison champ par champ', () => {
    expect(auditDiff([1, 2], { a: 1 })).toBeNull();
    expect(auditDiff('texte', null)).toBeNull();
  });

  it('valeurs lisibles', () => {
    expect(formatAuditValue('[EXPURGÉ]')).toBe('[EXPURGÉ]');
    expect(formatAuditValue(12.5)).toBe('12.5');
    expect(formatAuditValue(false)).toBe('false');
    expect(formatAuditValue(null)).toBe('null');
    expect(formatAuditValue({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(prettyJson(null)).toBeNull();
    expect(prettyJson({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}');
  });
});

describe('Liens vers les pages des objets', () => {
  it('pages existantes seulement', () => {
    expect(objectHref('VehicleUsage', ID)).toBe(`/utilisations/${ID}`);
    expect(objectHref('Intervention', ID)).toBe(`/interventions/${ID}`);
    expect(objectHref('Incident', ID)).toBe(`/incidents/${ID}`);
    expect(objectHref('Immobilization', ID)).toBe(`/immobilisations/${ID}`);
    expect(objectHref('Vehicle', ID)).toBe(`/vehicules/${ID}`);
    expect(objectHref('Driver', ID)).toBe(`/conducteurs/${ID}`);
    expect(objectHref('VehicleMaintenancePlan', ID)).toBe(`/entretiens?plan=${ID}`);
    expect(objectHref('ImportBatch', ID)).toBe(`/imports?lot=${ID}`);
    expect(objectHref('OdometerSegment', ID)).toBeNull();
    expect(objectHref('VehicleResponsibleAssignment', ID)).toBeNull();
  });

  it('documents et réservations pré-filtrés sur le véhicule de contexte', () => {
    expect(objectHref('DocumentVersion', ID, { vehicleId: VEHICLE })).toBe(`/documents?onglet=versions&vehicule=${VEHICLE}&version=${ID}`);
    expect(objectHref('DocumentVersion', ID)).toBe(`/documents?onglet=versions&version=${ID}`);
    expect(objectHref('Reservation', ID, { vehicleId: VEHICLE })).toBe(`/planning/reservations?vehicule=${VEHICLE}&reservation=${ID}`);
  });

  it('fiche utilisateur réservée à l’administrateur ; identifiant non conforme sans lien', () => {
    expect(objectHref('User', ID)).toBeNull();
    expect(objectHref('User', ID, { isAdmin: true })).toBe(`/administration/utilisateurs/${ID}`);
    expect(objectHref('Vehicle', 'organisation.timezone')).toBeNull();
    expect(objectHref('Vehicle', null)).toBeNull();
  });
});
