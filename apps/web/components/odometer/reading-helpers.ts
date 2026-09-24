'use client';

import { useMemo } from 'react';
import { useAppScope } from '@/components/layout/session-context';
import { formatKm } from '@/lib/format';
import type { BatchResultItem, ReadingView } from '@/lib/odometer-types';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
export type FieldErrors = Record<string, string[]>;

/** Rôles autorisés à saisir des relevés (contrôle réel côté API ; initialisation explicite du compteur : chef et administrateur, D-167). */
const OPERATIONAL_ROLES = new Set(['ADMIN', 'CHEF_PARC', 'OPERATEUR']);

/**
 * Contrôles d'affichage par société de l'objet (et non par société sélectionnée) : ils ne font que
 * masquer des boutons, l'API reste seule juge de l'autorisation.
 */
export function useScopeChecks() {
  const { session } = useAppScope();
  return useMemo(
    () => ({
      can: (companyId: string | null, permission: string): boolean => {
        if (session.isAdmin) return true;
        if (!companyId) return session.grants.some((g) => g.permissions.includes(permission));
        return session.grants.some((g) => g.companyId === companyId && g.permissions.includes(permission));
      },
      operational: (companyId: string | null): boolean => {
        if (session.isAdmin) return true;
        if (session.isDriverOnly) return false;
        return session.grants.some((g) => (companyId === null || g.companyId === companyId) && OPERATIONAL_ROLES.has(g.role));
      },
    }),
    [session],
  );
}

/** Saisie du compteur : espaces retirés et virgule décimale acceptée (la valeur transmise reste celle lue). */
export function normalizeKmInput(value: string): string {
  return value.replace(/[\s  ]/g, '').replace(',', '.');
}

/** Contrôle de format uniquement (nombre décimal positif) ; toutes les règles de cohérence sont appliquées par l'API. */
export function isKmFormat(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value);
}

/** Valeur affichée d'un relevé : compteur lu, ou estimation GPS explicitement signalée. */
export function readingKmLabel(r: Pick<ReadingView, 'isEstimate' | 'physicalKm' | 'cumulativeKm'>): string {
  return r.isEstimate ? formatKm(r.cumulativeKm, { estimate: true }) : formatKm(r.physicalKm);
}

export function toneForReading(status: string): Tone {
  switch (status) {
    case 'ACCEPTE':
      return 'success';
    case 'EN_ATTENTE':
      return 'warning';
    case 'REJETE':
      return 'danger';
    default:
      return 'neutral';
  }
}

/** Libellés du résultat par ligne de la saisie rapide (BatchResultItemDto.outcome). */
export const BATCH_OUTCOME_LABELS: Record<BatchResultItem['outcome'], string> = {
  ACCEPTE: 'Accepté',
  EN_ATTENTE: 'En attente de validation',
  IDEMPOTENT: 'Déjà enregistré (relevé identique)',
  REFUSE: 'Refusé',
};

export function toneForBatchOutcome(outcome: BatchResultItem['outcome']): Tone {
  switch (outcome) {
    case 'ACCEPTE':
      return 'success';
    case 'EN_ATTENTE':
      return 'warning';
    case 'REFUSE':
      return 'danger';
    default:
      return 'info';
  }
}

/** Identifiants aria-describedby d'un champ : message d'erreur éventuel (convention de FieldError) puis aides. */
export function describedBy(errors: FieldErrors, name: string, ...others: Array<string | undefined>): string | undefined {
  const ids = [errors[name]?.length ? `${name}-error` : undefined, ...others].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}

/** Objets dépendants renvoyés par l'API quand une correction est bloquée (details.dependents). */
export function dependentsFromDetails(details: Record<string, unknown> | undefined): Array<{ type: string; id: string }> {
  const raw = details?.dependents;
  if (!Array.isArray(raw)) return [];
  return raw.filter((d): d is { type: string; id: string } => typeof d === 'object' && d !== null && typeof (d as { id?: unknown }).id === 'string' && typeof (d as { type?: unknown }).type === 'string');
}
