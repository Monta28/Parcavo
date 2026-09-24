'use client';

import { useMemo } from 'react';
import { useAppScope } from '@/components/layout/session-context';
import type { SessionInfo } from '@/lib/api-types';
import { isApiError } from '@/lib/api-error';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
export type FieldErrors = Record<string, string[]>;

/** Valeurs sentinelles des listes déroulantes (Radix n'accepte pas la chaîne vide). */
export const ALL = '__all__';
export const NONE = '__aucun__';

const OPERATIONAL_ROLES = new Set(['ADMIN', 'CHEF_PARC', 'OPERATEUR']);
const MANAGER_ROLES = new Set(['ADMIN', 'CHEF_PARC']);

export interface OpsRights {
  /** Personnel de gestion (compte non conducteur seul). */
  staff: boolean;
  /** Opérateur, chef de parc ou administrateur : déclaration, traitement jusqu'à « Résolu », immobilisations. */
  operational: boolean;
  /** Chef de parc ou administrateur : clôture, réouverture, requalification, archivage. */
  manager: boolean;
  /** Administrateur de l'organisation (réouverture d'un incident clôturé). */
  admin: boolean;
  can: (permission: string) => boolean;
}

/**
 * Droits d'affichage sur une société (celle de l'objet, ou « au moins une société » si null). Ils ne
 * font que masquer des boutons : l'API reste seule juge de l'autorisation.
 */
export function rightsIn(session: SessionInfo, companyId: string | null): OpsRights {
  if (session.isAdmin) return { staff: true, operational: true, manager: true, admin: true, can: () => true };
  if (session.isDriverOnly) return { staff: false, operational: false, manager: false, admin: false, can: () => false };
  const grants = session.grants.filter((g) => companyId === null || g.companyId === companyId);
  return {
    staff: true,
    operational: grants.some((g) => OPERATIONAL_ROLES.has(g.role)),
    manager: grants.some((g) => MANAGER_ROLES.has(g.role)),
    admin: false,
    can: (permission) => grants.some((g) => g.permissions.includes(permission)),
  };
}

export function useOpsRights(companyId: string | null): OpsRights {
  const { session } = useAppScope();
  return useMemo(() => rightsIn(session, companyId), [session, companyId]);
}

/** Sociétés où l'utilisateur peut créer (opérateur, chef, administrateur). */
export function useOperationalCompanies(): Array<{ id: string; code: string; name: string }> {
  const { session } = useAppScope();
  return useMemo(() => {
    const active = session.companies.filter((c) => c.status !== 'ARCHIVE');
    if (session.isAdmin) return active;
    const ids = new Set(session.grants.filter((g) => OPERATIONAL_ROLES.has(g.role)).map((g) => g.companyId));
    return active.filter((c) => ids.has(c.id));
  }, [session]);
}

export function toneForIncidentStatus(status: string): Tone {
  switch (status) {
    case 'OUVERT':
      return 'warning';
    case 'EN_TRAITEMENT':
      return 'info';
    case 'RESOLU':
      return 'success';
    default:
      return 'neutral';
  }
}

export function toneForSeverity(severity: string): Tone {
  switch (severity) {
    case 'CRITIQUE':
      return 'danger';
    case 'ELEVEE':
      return 'warning';
    case 'MOYENNE':
      return 'info';
    default:
      return 'neutral';
  }
}

export function toneForImmobilization(status: string): Tone {
  return status === 'ACTIVE' ? 'danger' : 'neutral';
}

export function describedBy(errors: FieldErrors, name: string, ...others: Array<string | undefined>): string | undefined {
  const ids = [errors[name]?.length ? `${name}-error` : undefined, ...others].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}

export function invalid(errors: FieldErrors, name: string): true | undefined {
  return errors[name]?.length ? true : undefined;
}

/** Erreurs par champ renvoyées par l'API (regroupées sur le premier segment : « tasks.0.label » → « tasks »). */
export function errorsOf(error: unknown): FieldErrors {
  if (!isApiError(error)) return {};
  const out: FieldErrors = {};
  for (const [key, messages] of Object.entries(error.fieldErrors)) {
    const root = key.split('.')[0] ?? key;
    out[root] = [...(out[root] ?? []), ...messages];
  }
  return out;
}

/** Durée fournie par l'API (heures, une décimale). */
export function formatHours(hours: number): string {
  return `${new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(hours)} h`;
}

/** Durée fournie par l'API (jours, une décimale). */
export function formatDays(days: number): string {
  return `${new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(days)} j`;
}
