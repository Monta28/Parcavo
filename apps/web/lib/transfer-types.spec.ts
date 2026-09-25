import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api-error';
import { transferBlockersOf, transferFieldErrors, transferIssueStatusLabel } from './transfer-types';

const blocker = { type: 'RESERVATION_A_TRAITER', id: 'r1', label: 'Réservation du 1 octobre', action: 'Réservation future non traitée : annulez-la avec un motif ou attendez sa fin.', status: 'CONFIRMEE', link: '/planning?reservation=r1' };

describe('Refus de transfert (CDC 2.4, D-119)', () => {
  it('lit la liste typée des objets bloquants d’un 409 TRANSFERT_BLOQUE', () => {
    const error = new ApiRequestError(409, { code: 'TRANSFERT_BLOQUE', message: 'Transfert refusé : 1 opération(s) ouverte(s).', details: { blockers: [blocker, { type: 'X' }] } });
    expect(transferBlockersOf(error)).toEqual([blocker]);
  });

  it('ignore les autres erreurs', () => {
    expect(transferBlockersOf(new ApiRequestError(409, { code: 'VERSION_OBSOLETE', message: 'Version obsolète.', details: { blockers: [blocker] } }))).toEqual([]);
    expect(transferBlockersOf(new ApiRequestError(422, { code: 'DECISIONS_TRANSFERT', message: 'Décisions incomplètes.' }))).toEqual([]);
    expect(transferBlockersOf(new Error('réseau'))).toEqual([]);
  });

  it('conserve le chemin complet des erreurs par champ', () => {
    const error = new ApiRequestError(422, { code: 'REFERENCE_INVALIDE', message: 'Références invalides.', fieldErrors: { 'plans.0.responsibleUserId': ['Compte attendu.'], 'transferReading.physicalKm': ['Diminution.'] } });
    expect(transferFieldErrors(error)).toEqual({ 'plans.0.responsibleUserId': ['Compte attendu.'], 'transferReading.physicalKm': ['Diminution.'] });
    expect(transferFieldErrors(null)).toEqual({});
  });

  it('affiche le statut de l’objet bloquant ou de l’avertissement en français, selon son type', () => {
    expect(transferIssueStatusLabel(blocker)).toBe('Confirmée');
    expect(transferIssueStatusLabel({ type: 'UTILISATION_EN_COURS', status: 'EN_COURS' })).toBe('En cours');
    expect(transferIssueStatusLabel({ type: 'IMMOBILISATION_ACTIVE', status: 'ACTIVE' })).toBe('Active');
    expect(transferIssueStatusLabel({ type: 'INTERVENTION_OUVERTE', status: 'PLANIFIEE' })).toBe('Planifiée');
    expect(transferIssueStatusLabel({ type: 'RELEVE_EN_ATTENTE', status: 'EN_ATTENTE' })).toBe('En attente');
    expect(transferIssueStatusLabel({ type: 'PLEIN_SOUMIS', status: 'SOUMIS' })).toBe('Soumis (à valider)');
    expect(transferIssueStatusLabel({ type: 'INCIDENT_OUVERT', status: 'EN_TRAITEMENT' })).toBe('En traitement');
  });

  it('laisse tel quel un statut ou un type inconnu', () => {
    expect(transferIssueStatusLabel({ type: 'RESERVATION_A_TRAITER', status: 'NOUVEAU_STATUT' })).toBe('NOUVEAU_STATUT');
    expect(transferIssueStatusLabel({ type: 'TYPE_INCONNU', status: 'EN_COURS' })).toBe('EN_COURS');
  });
});
