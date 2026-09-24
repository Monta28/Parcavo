'use client';

import { useMemo } from 'react';
import { useAppScope } from '@/components/layout/session-context';
import type { InterventionCostStatus, InterventionStatus } from '@/lib/interventions-types';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
export type FieldErrors = Record<string, string[]>;

export const ALL = '__all__';
export const NONE = '__none__';

const OPERATIONAL_ROLES = new Set(['CHEF_PARC', 'OPERATEUR']);

export interface InterventionRights {
  /** Opérateur, chef de parc ou administrateur sur la société : création, modification, planification, démarrage, annulation. */
  operational: boolean;
  /** Chef de parc ou administrateur : réouverture. */
  manager: boolean;
  can: (permission: string) => boolean;
}

/**
 * Droits d'affichage évalués sur la société de l'intervention (et non sur la société sélectionnée) :
 * ils ne font que masquer des actions, l'API reste seule juge de l'autorisation.
 */
export function useInterventionRights(companyId: string | null): InterventionRights {
  const { session } = useAppScope();
  return useMemo(() => {
    if (session.isAdmin) return { operational: true, manager: true, can: () => true };
    if (session.isDriverOnly) return { operational: false, manager: false, can: () => false };
    const grants = companyId ? session.grants.filter((g) => g.companyId === companyId) : session.grants;
    return {
      operational: grants.some((g) => OPERATIONAL_ROLES.has(g.role)),
      manager: grants.some((g) => g.role === 'CHEF_PARC'),
      can: (permission: string) => grants.some((g) => g.permissions.includes(permission)),
    };
  }, [session, companyId]);
}

/** Sociétés sur lesquelles l'utilisateur peut créer une intervention (rôle opérationnel). */
export function useOperationalCompanyIds(): string[] {
  const { session } = useAppScope();
  return useMemo(() => {
    if (session.isAdmin) return session.companies.map((c) => c.id);
    return session.grants.filter((g) => OPERATIONAL_ROLES.has(g.role)).map((g) => g.companyId);
  }, [session]);
}

export function toneForInterventionStatus(status: InterventionStatus): Tone {
  switch (status) {
    case 'PLANIFIEE':
      return 'info';
    case 'EN_COURS':
      return 'warning';
    case 'TERMINEE':
      return 'success';
    default:
      return 'neutral';
  }
}

export function toneForCostStatus(status: InterventionCostStatus): Tone {
  switch (status) {
    case 'A_SAISIR':
      return 'warning';
    case 'SAISI':
      return 'success';
    default:
      return 'neutral';
  }
}

/**
 * Regroupe sous une même clé les erreurs d'un champ et de ses sous-chemins renvoyés par l'API
 * (ex. « tasks.0.label » sous « tasks »), pour un affichage près du bloc concerné.
 */
export function collectErrors(errors: FieldErrors, prefix: string): FieldErrors {
  const messages = Object.entries(errors)
    .filter(([key]) => key === prefix || key.startsWith(`${prefix}.`))
    .flatMap(([, list]) => list);
  return messages.length > 0 ? { [prefix]: [...new Set(messages)] } : {};
}

/** Identifiants aria-describedby d'un champ : message d'erreur éventuel (convention de FieldError) puis aides. */
export function describedBy(errors: FieldErrors, name: string, ...others: Array<string | undefined>): string | undefined {
  const ids = [errors[name]?.length ? `${name}-error` : undefined, ...others].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}

/** Saisie numérique : espaces retirés et virgule décimale acceptée (aucun arrondi, l'API applique ses règles). */
export function normalizeDecimalInput(value: string): string {
  return value.replace(/[\s  ]/g, '').replace(',', '.');
}

/** Contrôle de format uniquement (nombre décimal positif ou nul). */
export function isDecimalFormat(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value);
}
