import { describe, expect, it } from 'vitest';
import { computeDocumentStatus, type DocumentTypeRule } from './document-status.js';

const insurance: DocumentTypeRule = { hasExpiry: true, required: true, blocksCheckout: true, noticeDays: [30, 15, 7] };

describe('statut documentaire (CDC 7.1, T21)', () => {
  it('T21 — fin de validité aujourd’hui : valable jusqu’à la fin du jour, puis expiré le lendemain local', () => {
    const versions = [{ id: 'v1', validFrom: '2025-09-25', validTo: '2026-09-24' }];
    const today = computeDocumentStatus(insurance, versions, '2026-09-24');
    expect(today.status).toBe('A_RENOUVELER');
    expect(today.blocksCheckout).toBe(false);
    expect(today.daysRemaining).toBe(0);
    const tomorrow = computeDocumentStatus(insurance, versions, '2026-09-25');
    expect(tomorrow.status).toBe('EXPIRE');
    expect(tomorrow.blocksCheckout).toBe(true);
  });

  it('T21 — un renouvellement futur ne remplace pas la version valide mais évite une fausse alerte', () => {
    const versions = [
      { id: 'v1', validFrom: '2025-09-25', validTo: '2026-09-30' },
      { id: 'v2', validFrom: '2026-10-01', validTo: '2027-09-30' },
    ];
    const before = computeDocumentStatus(insurance, versions, '2026-09-24');
    expect(before).toMatchObject({ status: 'VALIDE', currentVersionId: 'v1', renewed: true, upcomingVersionId: 'v2' });
    const after = computeDocumentStatus(insurance, versions, '2026-10-01');
    expect(after).toMatchObject({ status: 'VALIDE', currentVersionId: 'v2' });
  });

  it('T21 — une version future seule ne rend pas le véhicule conforme avant sa date de début', () => {
    const versions = [
      { id: 'v1', validFrom: '2025-01-01', validTo: '2026-09-20' },
      { id: 'v2', validFrom: '2026-10-01', validTo: '2027-09-30' },
    ];
    const gap = computeDocumentStatus(insurance, versions, '2026-09-24');
    expect(gap).toMatchObject({ status: 'EXPIRE', blocksCheckout: true, upcomingVersionId: 'v2' });
  });

  it('applique les préavis 30, 15 et 7 jours', () => {
    const versions = [{ id: 'v1', validFrom: null, validTo: '2026-10-24' }];
    expect(computeDocumentStatus(insurance, versions, '2026-09-23')).toMatchObject({ status: 'VALIDE', noticeThreshold: null });
    expect(computeDocumentStatus(insurance, versions, '2026-09-24')).toMatchObject({ status: 'A_RENOUVELER', noticeThreshold: 30 });
    expect(computeDocumentStatus(insurance, versions, '2026-10-09')).toMatchObject({ status: 'A_RENOUVELER', noticeThreshold: 15 });
    expect(computeDocumentStatus(insurance, versions, '2026-10-17')).toMatchObject({ status: 'A_RENOUVELER', noticeThreshold: 7 });
  });

  it('document manquant : exigé et bloquant, ou non applicable s’il n’est pas exigé', () => {
    expect(computeDocumentStatus(insurance, [], '2026-09-24')).toMatchObject({ status: 'MANQUANT', blocksCheckout: true });
    expect(computeDocumentStatus({ ...insurance, required: false }, [], '2026-09-24')).toMatchObject({ status: null, blocksCheckout: false });
  });

  it('détail rédigé en JJ/MM/AAAA (aucune date ISO brute) et dates exposées dans des champs séparés', () => {
    const iso = /\d{4}-\d{2}-\d{2}/;
    const gap = computeDocumentStatus(
      insurance,
      [
        { id: 'v1', validFrom: '2025-01-01', validTo: '2026-09-20' },
        { id: 'v2', validFrom: '2026-10-01', validTo: '2027-09-30' },
      ],
      '2026-09-24',
    );
    expect(gap).toMatchObject({ status: 'EXPIRE', validFrom: '2025-01-01', validTo: '2026-09-20', nextValidFrom: '2026-10-01', nextValidTo: '2027-09-30' });
    expect(gap.detail).toBe('Expiré depuis le 20/09/2026 ; nouvelle version valable à partir du 01/10/2026.');
    const soon = computeDocumentStatus(insurance, [{ id: 'v1', validFrom: '2025-10-05', validTo: '2026-10-04' }], '2026-09-24');
    expect(soon).toMatchObject({ status: 'A_RENOUVELER', validFrom: '2025-10-05', validTo: '2026-10-04', nextValidFrom: null, nextValidTo: null });
    expect(soon.detail).toBe('Expire le 04/10/2026 (dans 10 jours).');
    const lastDay = computeDocumentStatus(insurance, [{ id: 'v1', validFrom: null, validTo: '2026-09-24' }], '2026-09-24');
    expect(lastDay.detail).toBe('Valable jusqu’à ce soir (fin de journée du 24/09/2026).');
    const renewed = computeDocumentStatus(
      insurance,
      [
        { id: 'v1', validFrom: '2025-09-25', validTo: '2026-09-30' },
        { id: 'v2', validFrom: '2026-10-01', validTo: '2027-09-30' },
      ],
      '2026-09-24',
    );
    expect(renewed.detail).toBe('Valide jusqu’au 30/09/2026 ; renouvellement déjà enregistré.');
    expect(renewed).toMatchObject({ nextValidFrom: '2026-10-01', nextValidTo: '2027-09-30' });
    const onlyFuture = computeDocumentStatus(insurance, [{ id: 'v2', validFrom: '2026-10-01', validTo: '2027-09-30' }], '2026-09-24');
    expect(onlyFuture).toMatchObject({ status: 'MANQUANT', validFrom: null, validTo: null, upcomingVersionId: 'v2', nextValidFrom: '2026-10-01' });
    expect(onlyFuture.detail).toBe('Aucune version en vigueur ; version future à partir du 01/10/2026.');
    for (const r of [gap, soon, lastDay, renewed, onlyFuture]) expect(r.detail).not.toMatch(iso);
  });

  it('un type sans expiration ne produit pas de fausse échéance', () => {
    const registration: DocumentTypeRule = { hasExpiry: false, required: true, blocksCheckout: true, noticeDays: [30, 15, 7] };
    expect(computeDocumentStatus(registration, [{ id: 'cg', validFrom: '2020-01-01', validTo: '2021-01-01' }], '2026-09-24')).toMatchObject({ status: 'VALIDE', noticeThreshold: null });
  });
});
