'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { DOCUMENT_STATUS_LABELS, type DocumentStatus } from '@parc-auto/contracts';
import { useAppScope } from '@/components/layout/session-context';
import { StatusBadge } from '@/components/status-badge';

export type FieldErrors = Record<string, string[]>;

/** Racine des clés react-query du module documents : ['documents', 'compliance' | 'list' | 'version', …]. */
export const DOCUMENTS_KEY = 'documents';
export const DOCUMENT_TYPES_KEY = 'document-types';

/**
 * Contrôle d'affichage de la permission documents.manage sur la société de l'objet (et non sur la société
 * sélectionnée) : il ne fait que masquer des boutons, l'API reste seule juge de l'autorisation.
 */
export function useDocumentsAccess() {
  const { session } = useAppScope();
  return useMemo(
    () => ({
      canManageIn: (companyId: string): boolean => {
        if (session.isDriverOnly) return false;
        if (session.isAdmin) return true;
        return session.grants.some((g) => g.companyId === companyId && g.permissions.includes('documents.manage'));
      },
      companyCode: (companyId: string): string => session.companies.find((c) => c.id === companyId)?.code ?? '—',
    }),
    [session],
  );
}

/** Recharge tout ce qui dépend des documents d'un objet : conformité, versions, fiche véhicule (synthèse) et alertes. */
export function useInvalidateDocuments() {
  const queryClient = useQueryClient();
  return useCallback(
    (owner?: { vehicleId?: string | null; driverId?: string | null }) => {
      void queryClient.invalidateQueries({ queryKey: [DOCUMENTS_KEY] });
      void queryClient.invalidateQueries({ queryKey: ['alerts'] });
      if (owner?.vehicleId) void queryClient.invalidateQueries({ queryKey: ['vehicle', owner.vehicleId] });
      if (owner?.driverId) void queryClient.invalidateQueries({ queryKey: ['driver', owner.driverId] });
    },
    [queryClient],
  );
}

function toneForDocument(status: DocumentStatus): 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'VALIDE':
      return 'success';
    case 'A_RENOUVELER':
      return 'warning';
    default:
      return 'danger';
  }
}

/** Statut documentaire calculé par l'API, toujours affiché avec son libellé. */
export function DocumentStatusBadge({ status }: { status: DocumentStatus }) {
  return <StatusBadge label={DOCUMENT_STATUS_LABELS[status]} tone={toneForDocument(status)} />;
}

/** Jours restants tels que renvoyés par l'API (négatifs une fois la fin de validité dépassée). */
export function daysRemainingLabel(days: number | null): string {
  if (days === null) return '—';
  if (days < 0) return `Dépassée de ${-days} j`;
  if (days === 0) return '0 j (dernier jour)';
  return `${days} j`;
}

/** Regroupe sous une clé les erreurs d'un champ et de ses sous-chemins (ex. « noticeDays.0 »). */
export function collectErrors(errors: FieldErrors, prefix: string): string[] {
  return [...new Set(Object.entries(errors).filter(([key]) => key === prefix || key.startsWith(`${prefix}.`)).flatMap(([, list]) => list))];
}

/** Identifiants aria-describedby d'un champ : message d'erreur éventuel (convention de FieldError) puis aides. */
export function describedBy(errors: FieldErrors, name: string, ...others: Array<string | undefined>): string | undefined {
  const ids = [errors[name]?.length ? `${name}-error` : undefined, ...others].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}
