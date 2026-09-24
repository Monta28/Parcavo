import type { DocumentStatus } from '@parc-auto/contracts';
import { addDays, compareCivil, diffDays, formatCivilDate, type CivilDate } from './civil-date.js';

/**
 * Statut documentaire (CDC 7.1, 7.2) — implémentation unique.
 *  - La version valable à une date donnée est retenue ; une version future ne remplace pas une version
 *    encore valide.
 *  - Une date de fin reste valable jusqu'à la fin de ce jour dans le fuseau du groupe : la comparaison se
 *    fait sur des dates civiles locales.
 *  - Préavis (30, 15, 7 jours par défaut) : A_RENOUVELER, sauf si un renouvellement est déjà enregistré.
 *  - Un type sans expiration ne produit jamais d'échéance.
 *  - Le détail rédigé présente les dates au format JJ/MM/AAAA (formatCivilDate) ; les dates elles-mêmes
 *    sont exposées dans des champs séparés (validFrom, validTo, nextValidFrom, nextValidTo).
 */
export interface DocumentTypeRule {
  hasExpiry: boolean;
  required: boolean;
  blocksCheckout: boolean;
  noticeDays: readonly number[];
}

export interface DocumentVersionDates {
  id: string;
  validFrom: CivilDate | null;
  validTo: CivilDate | null;
}

export interface DocumentStatusResult {
  /** null : aucun document et type non exigé (non applicable). */
  status: DocumentStatus | null;
  currentVersionId: string | null;
  /** Début de validité de la version retenue (en vigueur, ou dernière expirée). */
  validFrom: CivilDate | null;
  /** Fin de validité de la version retenue (null : sans expiration ou aucune version). */
  validTo: CivilDate | null;
  daysRemaining: number | null;
  /** Palier de préavis atteint (ex. 30, 15, 7) ou null. */
  noticeThreshold: number | null;
  /** Renouvellement déjà enregistré (version suivante qui prend le relais). */
  renewed: boolean;
  /** Version future enregistrée mais pas encore en vigueur. */
  upcomingVersionId: string | null;
  /** Début et fin de validité de la version future (null sans version future). */
  nextValidFrom: CivilDate | null;
  nextValidTo: CivilDate | null;
  blocksCheckout: boolean;
  detail: string;
}

function coversDate(v: DocumentVersionDates, date: CivilDate, hasExpiry: boolean): boolean {
  if (v.validFrom && compareCivil(v.validFrom, date) > 0) return false;
  if (!hasExpiry || !v.validTo) return true;
  return compareCivil(v.validTo, date) >= 0;
}

export function computeDocumentStatus(type: DocumentTypeRule, versions: readonly DocumentVersionDates[], today: CivilDate): DocumentStatusResult {
  const covering = versions.filter((v) => coversDate(v, today, type.hasExpiry));
  // Parmi les versions en vigueur, on retient celle qui court le plus loin.
  const current = covering.sort((a, b) => compareCivil(b.validTo ?? '9999-12-31', a.validTo ?? '9999-12-31'))[0] ?? null;
  const future = versions
    .filter((v) => v.validFrom && compareCivil(v.validFrom, today) > 0)
    .sort((a, b) => compareCivil(a.validFrom as string, b.validFrom as string))[0] ?? null;
  const upcoming = { upcomingVersionId: future?.id ?? null, nextValidFrom: future?.validFrom ?? null, nextValidTo: type.hasExpiry ? (future?.validTo ?? null) : null };

  if (!current) {
    const expired = versions.filter((v) => type.hasExpiry && v.validTo && compareCivil(v.validTo, today) < 0).sort((a, b) => compareCivil(b.validTo as string, a.validTo as string))[0];
    if (expired) {
      const expiredOn = expired.validTo as string;
      return {
        status: 'EXPIRE',
        currentVersionId: expired.id,
        validFrom: expired.validFrom,
        validTo: expiredOn,
        daysRemaining: diffDays(today, expiredOn),
        noticeThreshold: null,
        renewed: false,
        ...upcoming,
        blocksCheckout: type.blocksCheckout,
        detail: `Expiré depuis le ${formatCivilDate(expiredOn)}${upcoming.nextValidFrom ? ` ; nouvelle version valable à partir du ${formatCivilDate(upcoming.nextValidFrom)}` : ''}.`,
      };
    }
    if (versions.length === 0 && !type.required) {
      return { status: null, currentVersionId: null, validFrom: null, validTo: null, daysRemaining: null, noticeThreshold: null, renewed: false, upcomingVersionId: null, nextValidFrom: null, nextValidTo: null, blocksCheckout: false, detail: 'Non applicable.' };
    }
    return {
      status: 'MANQUANT',
      currentVersionId: null,
      validFrom: null,
      validTo: null,
      daysRemaining: null,
      noticeThreshold: null,
      renewed: false,
      ...upcoming,
      blocksCheckout: type.blocksCheckout,
      detail: upcoming.nextValidFrom ? `Aucune version en vigueur ; version future à partir du ${formatCivilDate(upcoming.nextValidFrom)}.` : 'Aucun document enregistré.',
    };
  }

  if (!type.hasExpiry || !current.validTo) {
    return { status: 'VALIDE', currentVersionId: current.id, validFrom: current.validFrom, validTo: null, daysRemaining: null, noticeThreshold: null, renewed: false, ...upcoming, blocksCheckout: false, detail: 'Valide, sans date d’expiration.' };
  }

  const validTo = current.validTo;
  const daysRemaining = diffDays(today, validTo);
  const successorStart = addDays(validTo, 1);
  const renewed = versions.some((v) => v.id !== current.id && v.validFrom !== null && compareCivil(v.validFrom, successorStart) <= 0 && (!v.validTo || compareCivil(v.validTo, validTo) > 0));
  const thresholds = [...type.noticeDays].filter((n) => n >= 0).sort((a, b) => a - b);
  const noticeThreshold = thresholds.find((n) => daysRemaining <= n) ?? null;
  if (noticeThreshold !== null && !renewed) {
    return {
      status: 'A_RENOUVELER',
      currentVersionId: current.id,
      validFrom: current.validFrom,
      validTo,
      daysRemaining,
      noticeThreshold,
      renewed,
      ...upcoming,
      blocksCheckout: false,
      detail: daysRemaining === 0 ? `Valable jusqu’à ce soir (fin de journée du ${formatCivilDate(validTo)}).` : `Expire le ${formatCivilDate(validTo)} (dans ${daysRemaining} jour${daysRemaining > 1 ? 's' : ''}).`,
    };
  }
  return {
    status: 'VALIDE',
    currentVersionId: current.id,
    validFrom: current.validFrom,
    validTo,
    daysRemaining,
    noticeThreshold: null,
    renewed,
    ...upcoming,
    blocksCheckout: false,
    detail: renewed ? `Valide jusqu’au ${formatCivilDate(validTo)} ; renouvellement déjà enregistré.` : `Valide jusqu’au ${formatCivilDate(validTo)}.`,
  };
}
