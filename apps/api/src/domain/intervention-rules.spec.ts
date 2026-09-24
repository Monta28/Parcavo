import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { checkPlannedDates, costLineAmount, incidentAcceptsIntervention, resolveCost, statusAtCreation, type CostEntry } from './intervention-rules.js';

const d = (v: string) => new Decimal(v);
const at = (iso: string) => new Date(iso);
const entry = (overrides: Partial<CostEntry>): CostEntry => ({ lineAmounts: [], noCost: false, invoice: false, required: false, ...overrides });

describe('statut et dates prévues (6.3, D-204)', () => {
  it('création : planifiée seulement avec un début prévu', () => {
    expect(statusAtCreation(at('2026-10-01T08:00:00Z'))).toBe('PLANIFIEE');
    expect(statusAtCreation(null)).toBe('BROUILLON');
  });

  it('une intervention planifiée ne peut pas perdre son début prévu', () => {
    expect(checkPlannedDates('PLANIFIEE', null, null)).toMatchObject({ code: 'DATE_PREVUE_REQUISE', field: 'plannedStartAt' });
    expect(checkPlannedDates('PLANIFIEE', at('2026-10-01T08:00:00Z'), null)).toBeNull();
  });

  it('un brouillon garde des dates indicatives ou aucune ; en cours, les dates prévues restent facultatives', () => {
    expect(checkPlannedDates('BROUILLON', at('2026-10-01T08:00:00Z'), at('2026-10-01T12:00:00Z'))).toBeNull();
    expect(checkPlannedDates('BROUILLON', null, null)).toBeNull();
    expect(checkPlannedDates('EN_COURS', null, null)).toBeNull();
  });

  it('fin prévue avant le début : refusée, égalité admise', () => {
    expect(checkPlannedDates('BROUILLON', at('2026-10-02T08:00:00Z'), at('2026-10-01T08:00:00Z'))).toMatchObject({ code: 'DATES_INCOHERENTES', field: 'plannedEndAt' });
    expect(checkPlannedDates('PLANIFIEE', at('2026-10-01T08:00:00Z'), at('2026-10-01T08:00:00Z'))).toBeNull();
  });
});

describe('coût (D-203, D-206, D-233)', () => {
  it('montant de ligne : quantité × prix unitaire, arrondi demi vers le haut à 3 décimales', () => {
    expect(costLineAmount(d('4.5'), d('32.500')).toFixed(3)).toBe('146.250');
    expect(costLineAmount(d('3'), d('0.3335')).toFixed(3)).toBe('1.001');
  });

  it('total = somme des lignes ; total saisi sans lignes ; rien à la clôture → à saisir', () => {
    expect(resolveCost(entry({ lineAmounts: [d('146.250'), d('45.000')] }))).toMatchObject({ ok: true, costStatus: 'SAISI' });
    const withLines = resolveCost(entry({ lineAmounts: [d('146.250'), d('45.000')] }));
    expect(withLines.ok && withLines.total?.toFixed(3)).toBe('191.250');
    const typed = resolveCost(entry({ totalAmount: '150.0004' }));
    expect(typed.ok && typed.total?.toFixed(3)).toBe('150.000');
    expect(resolveCost(entry({}))).toEqual({ ok: true, total: null, costStatus: 'A_SAISIR' });
  });

  it('total nul ou « sans coût » → SANS_COUT', () => {
    expect(resolveCost(entry({ totalAmount: '0' }))).toMatchObject({ ok: true, costStatus: 'SANS_COUT' });
    expect(resolveCost(entry({ lineAmounts: [d('0')] }))).toMatchObject({ ok: true, costStatus: 'SANS_COUT' });
    expect(resolveCost(entry({ noCost: true, required: true }))).toEqual({ ok: true, total: null, costStatus: 'SANS_COUT' });
  });

  it('saisies contradictoires, manquantes ou négatives refusées', () => {
    expect(resolveCost(entry({ noCost: true, totalAmount: '10' }))).toMatchObject({ ok: false, violation: { code: 'COUT_CONTRADICTOIRE' } });
    expect(resolveCost(entry({ required: true }))).toMatchObject({ ok: false, violation: { code: 'COUT_REQUIS' } });
    expect(resolveCost(entry({ lineAmounts: [d('1')], totalAmount: '1' }))).toMatchObject({ ok: false, violation: { code: 'TOTAL_CALCULE' } });
    expect(resolveCost(entry({ totalAmount: '-1' }))).toMatchObject({ ok: false, violation: { code: 'MONTANT_NEGATIF' } });
  });

  it('une facture exige un coût non nul : jamais ignorée silencieusement', () => {
    expect(resolveCost(entry({ totalAmount: '0', invoice: true, required: true }))).toMatchObject({ ok: false, violation: { code: 'FACTURE_SANS_COUT', field: 'invoiceAttachmentId' } });
    expect(resolveCost(entry({ lineAmounts: [d('0'), d('0')], invoice: true, required: true }))).toMatchObject({ ok: false, violation: { code: 'FACTURE_SANS_COUT' } });
    expect(resolveCost(entry({ noCost: true, invoice: true, required: true }))).toMatchObject({ ok: false, violation: { code: 'FACTURE_SANS_COUT' } });
    expect(resolveCost(entry({ totalAmount: '12.5', invoice: true, required: true }))).toMatchObject({ ok: true, costStatus: 'SAISI' });
  });
});

describe('incident source (6.3, D-215)', () => {
  it('toute intervention est refusée sur un incident clôturé, admise sinon', () => {
    expect(incidentAcceptsIntervention('OUVERT')).toBe(true);
    expect(incidentAcceptsIntervention('EN_TRAITEMENT')).toBe(true);
    expect(incidentAcceptsIntervention('RESOLU')).toBe(true);
    expect(incidentAcceptsIntervention('CLOTURE')).toBe(false);
  });
});
