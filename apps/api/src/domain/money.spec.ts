import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { checkAmountConsistency, isPositiveDecimalString, toleranceOf } from './money.js';

const d = (v: string) => new Decimal(v);
/** Valeurs initiales des paramètres fuel.amountToleranceTnd (0,1 TND) et fuel.amountToleranceRatio (1 %). */
const tolerance = toleranceOf(0.1, 0.01);

describe('valeurs positives en décimal exact (CDC 8.2, R-8.2-02, R-8.2-03)', () => {
  it('accepte un décimal strictement positif à trois décimales au plus', () => {
    expect(isPositiveDecimalString('40')).toBe(true);
    expect(isPositiveDecimalString('40.125')).toBe(true);
    expect(isPositiveDecimalString('0.001')).toBe(true);
  });
  it('refuse zéro, les négatifs, plus de trois décimales, les nombres JSON et les écritures exotiques', () => {
    expect(isPositiveDecimalString('0')).toBe(false);
    expect(isPositiveDecimalString('0.000')).toBe(false);
    expect(isPositiveDecimalString('-5')).toBe(false);
    expect(isPositiveDecimalString('1.0001')).toBe(false);
    expect(isPositiveDecimalString('1e3')).toBe(false);
    expect(isPositiveDecimalString(' 12')).toBe(false);
    expect(isPositiveDecimalString(12)).toBe(false);
    expect(isPositiveDecimalString(null)).toBe(false);
  });
  it('respecte un nombre de décimales explicite', () => {
    expect(isPositiveDecimalString('10.5', 0)).toBe(false);
    expect(isPositiveDecimalString('10', 0)).toBe(true);
  });
});

describe('contrôle litres × prix unitaire / total (CDC 8.2, D-224, R-8.2-04)', () => {
  it('sans prix unitaire : aucun contrôle', () => {
    expect(checkAmountConsistency({ liters: d('40'), unitPrice: null, total: d('150'), tolerance })).toEqual({ checked: false, gap: null, threshold: null, mismatch: false, reportedGap: null });
  });
  it('produit exact sans arrondi intermédiaire : 40,125 L × 2,525 = 101,315625', () => {
    const r = checkAmountConsistency({ liters: d('40.125'), unitPrice: d('2.525'), total: d('101.316'), tolerance });
    expect(r.checked).toBe(true);
    expect(r.gap?.toString()).toBe('0.000375');
    expect(r.mismatch).toBe(false);
    expect(r.reportedGap).toBeNull();
  });
  it('petit montant : la part fixe (0,100 TND) l’emporte sur 1 % du total', () => {
    // 2 × 2,525 = 5,05 ; 1 % de 5,15 = 0,0515 < 0,100.
    const r = checkAmountConsistency({ liters: d('2'), unitPrice: d('2.525'), total: d('5.15'), tolerance });
    expect(r.threshold?.toString()).toBe('0.1');
    expect(r.gap?.toString()).toBe('0.1');
    // Un écart égal au seuil n'est pas « au-delà » : pas de signalement.
    expect(r.mismatch).toBe(false);
    const over = checkAmountConsistency({ liters: d('2'), unitPrice: d('2.525'), total: d('5.151'), tolerance });
    expect(over.mismatch).toBe(true);
    expect(over.reportedGap?.toFixed(3)).toBe('0.101');
  });
  it('gros montant : la part relative (1 % du total) l’emporte', () => {
    const r = checkAmountConsistency({ liters: d('40'), unitPrice: d('2.525'), total: d('102'), tolerance });
    expect(r.threshold?.toString()).toBe('1.02');
    expect(r.gap?.toString()).toBe('1');
    expect(r.mismatch).toBe(false);
    const wrong = checkAmountConsistency({ liters: d('40'), unitPrice: d('2.525'), total: d('110'), tolerance });
    expect(wrong.mismatch).toBe(true);
    expect(wrong.reportedGap?.toFixed(3)).toBe('9.000');
  });
  it('l’écart est une valeur absolue et le total saisi n’est jamais modifié', () => {
    const total = d('90');
    const r = checkAmountConsistency({ liters: d('40'), unitPrice: d('2.525'), total, tolerance });
    expect(r.gap?.toString()).toBe('11');
    expect(total.toString()).toBe('90');
  });
  it('l’écart signalé est arrondi à trois décimales, demi vers le haut, pour l’enregistrement', () => {
    const r = checkAmountConsistency({ liters: d('33.333'), unitPrice: d('2.345'), total: d('70'), tolerance });
    // 33,333 × 2,345 = 78,165885 → écart 8,165885 → 8,166
    expect(r.gap?.toString()).toBe('8.165885');
    expect(r.reportedGap?.toFixed(3)).toBe('8.166');
  });
  it('reste exact au-delà de 20 chiffres significatifs (produit de deux DECIMAL(18,3))', () => {
    // 999 999 999 999 999,999² − 1 = 999 999 999 999 999 997 999 999 999 999,000001 : le constructeur
    // global de decimal.js (20 chiffres) perdrait la partie décimale.
    const r = checkAmountConsistency({ liters: d('999999999999999.999'), unitPrice: d('999999999999999.999'), total: d('1'), tolerance });
    expect(r.gap?.toFixed()).toBe('999999999999999997999999999999.000001');
    expect(r.gap).toBeInstanceOf(Decimal);
    expect(r.mismatch).toBe(true);
    // 123 456 789,123 × 987 654,321 = 121 932 631 234 116,750483 (21 chiffres) : écart exact de 0,000483.
    const fine = checkAmountConsistency({ liters: d('123456789.123'), unitPrice: d('987654.321'), total: d('121932631234116.750'), tolerance: toleranceOf(0, 0) });
    expect(fine.gap?.toFixed()).toBe('0.000483');
    expect(fine.mismatch).toBe(true);
  });
  it('une tolérance paramétrée différemment est appliquée telle quelle', () => {
    const strict = toleranceOf(0, 0);
    expect(checkAmountConsistency({ liters: d('10'), unitPrice: d('2.5'), total: d('25.001'), tolerance: strict }).mismatch).toBe(true);
    expect(checkAmountConsistency({ liters: d('10'), unitPrice: d('2.5'), total: d('25'), tolerance: strict }).mismatch).toBe(false);
  });
});
