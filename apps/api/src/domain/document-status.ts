import type { DocumentStatus } from '@parc-auto/contracts';
import { addDays, compareCivil, diffDays, type CivilDate } from './civil-date.js';

/**
 * Statut documentaire (CDC 7.1, 7.2) — implémentation unique.
 *  - La version valable à une date donnée est retenue ; une version future ne remplace pas une version
 *    encore valide.
 *  - Une date de fin reste valable jusqu'à la fin de ce jour dans le fuseau du groupe : la comparaison se
 *    fait sur des dates civiles locales.
 *  - Préavis (30, 15, 7 jours par défaut) : A_RENOUVELER, sauf si un renouvellement est déjà enregistré.
 *  - Un type sans expiration ne produit jamais d'échéance.
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
  validTo: CivilDate | null;
  daysRemaining: number | null;
  /** Palier de préavis atteint (ex. 30, 15, 7) ou null. */
  noticeThreshold: number | null;
  /** Renouvellement déjà enregistré (version suivante qui prend le relais). */
  renewed: boolean;
  /** Version future enregistrée mais pas encore en vigueur. */
  upcomingVersionId: string | null;
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

  if (!current) {
    const expired = versions.filter((v) => type.hasExpiry && v.validTo && compareCivil(v.validTo, today) < 0).sort((a, b) => compareCivil(b.validTo as string, a.validTo as string))[0];
    if (expired) {
      return {
        status: 'EXPIRE',
        currentVersionId: expired.id,
        validTo: expired.validTo,
        daysRemaining: diffDays(today, expired.validTo as string),
        noticeThreshold: null,
        renewed: false,
        upcomingVersionId: future?.id ?? null,
        blocksCheckout: type.blocksCheckout,
        detail: `Expiré depuis le ${expired.validTo}${future ? ` ; nouvelle version valable à partir du ${future.validFrom}` : ''}.`,
      };
    }
    if (versions.length === 0 && !type.required) {
      return { status: null, currentVersionId: null, validTo: null, daysRemaining: null, noticeThreshold: null, renewed: false, upcomingVersionId: null, blocksCheckout: false, detail: 'Non applicable.' };
    }
    return {
      status: 'MANQUANT',
      currentVersionId: null,
      validTo: null,
      daysRemaining: null,
      noticeThreshold: null,
      renewed: false,
      upcomingVersionId: future?.id ?? null,
      blocksCheckout: type.blocksCheckout,
      detail: future ? `Aucune version en vigueur ; version future à partir du ${future.validFrom}.` : 'Aucun document enregistré.',
    };
  }

  if (!type.hasExpiry || !current.validTo) {
    return { status: 'VALIDE', currentVersionId: current.id, validTo: null, daysRemaining: null, noticeThreshold: null, renewed: false, upcomingVersionId: future?.id ?? null, blocksCheckout: false, detail: 'Valide, sans date d’expiration.' };
  }

  const daysRemaining = diffDays(today, current.validTo);
  const successorStart = addDays(current.validTo, 1);
  const renewed = versions.some((v) => v.id !== current.id && v.validFrom !== null && compareCivil(v.validFrom, successorStart) <= 0 && (!v.validTo || compareCivil(v.validTo, current.validTo as string) > 0));
  const thresholds = [...type.noticeDays].filter((n) => n >= 0).sort((a, b) => a - b);
  const noticeThreshold = thresholds.find((n) => daysRemaining <= n) ?? null;
  if (noticeThreshold !== null && !renewed) {
    return {
      status: 'A_RENOUVELER',
      currentVersionId: current.id,
      validTo: current.validTo,
      daysRemaining,
      noticeThreshold,
      renewed,
      upcomingVersionId: future?.id ?? null,
      blocksCheckout: false,
      detail: daysRemaining === 0 ? `Valable jusqu’à ce soir (fin de journée du ${current.validTo}).` : `Expire le ${current.validTo} (dans ${daysRemaining} jour${daysRemaining > 1 ? 's' : ''}).`,
    };
  }
  return {
    status: 'VALIDE',
    currentVersionId: current.id,
    validTo: current.validTo,
    daysRemaining,
    noticeThreshold: null,
    renewed,
    upcomingVersionId: future?.id ?? null,
    blocksCheckout: false,
    detail: renewed ? `Valide jusqu’au ${current.validTo} ; renouvellement déjà enregistré.` : `Valide jusqu’au ${current.validTo}.`,
  };
}
