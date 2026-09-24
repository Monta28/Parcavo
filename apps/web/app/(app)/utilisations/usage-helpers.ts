'use client';

import { useAppScope } from '@/components/layout/session-context';
import type { UsageChecklistEntry } from '@/lib/usages-types';
import {
  addDays,
  civilStart,
  isCivilDate,
  isoToLocalInput as zonedIsoToLocalInput,
  localInputToIso as zonedLocalInputToIso,
  nowLocalInput as zonedNowLocalInput,
} from '@/lib/zoned-time';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/** Rôles autorisés à effectuer remises, restitutions et prolongations (D-106). */
const OPERATIONAL_ROLES = new Set(['ADMIN', 'CHEF_PARC', 'OPERATEUR']);

/** Rôle opérationnel sur une société précise (ou sur au moins une société si `companyId` est null). */
export function useOperationalIn(companyId: string | null): boolean {
  const { session } = useAppScope();
  if (session.isAdmin) return true;
  if (companyId === null) return session.grants.some((g) => OPERATIONAL_ROLES.has(g.role));
  return session.grants.some((g) => g.companyId === companyId && OPERATIONAL_ROLES.has(g.role));
}

/** Permission détenue sur la société de l'objet (et non sur la société affichée dans le sélecteur). */
export function useCanIn(companyId: string | null, permission: string): boolean {
  const { session } = useAppScope();
  if (session.isAdmin) return true;
  if (!companyId) return false;
  return session.grants.some((g) => g.companyId === companyId && g.permissions.includes(permission));
}

/** Valeur par défaut d'un champ date/heure : maintenant, à la minute, dans le fuseau de l'organisation. */
export function nowLocalInput(timezone: string): string {
  return zonedNowLocalInput(timezone);
}

/** Convertit une date ISO de l'API en valeur de champ `datetime-local` (fuseau de l'organisation). */
export function isoToLocalInput(iso: string | null | undefined, timezone: string): string {
  return zonedIsoToLocalInput(iso, timezone);
}

/** Convertit une valeur `datetime-local` saisie dans le fuseau de l'organisation en ISO 8601 (undefined si vide ou invalide). */
export function localInputToIso(value: string, timezone: string): string | undefined {
  if (!value) return undefined;
  return zonedLocalInputToIso(value, timezone) ?? undefined;
}

/** Bornes de période (champs `date`) : début du premier jour et fin du dernier jour dans le fuseau de l'organisation. */
export function dayStartIso(day: string, timezone: string): string | undefined {
  if (!day || !isCivilDate(day)) return undefined;
  return civilStart(day, timezone).toISOString();
}

export function dayEndIso(day: string, timezone: string): string | undefined {
  if (!day || !isCivilDate(day)) return undefined;
  return new Date(civilStart(addDays(day, 1), timezone).getTime() - 1).toISOString();
}

/** Saisie du compteur : espaces (y compris insécables) retirés et virgule décimale acceptée (la valeur reste celle lue). */
export function normalizeKmInput(value: string): string {
  return value.replace(/\s/g, '').replace(',', '.');
}

type FieldErrors = Record<string, string[]>;

/**
 * Contrôles de saisie avant la confirmation (présence et format du nombre lu uniquement) : évite de
 * confirmer un envoi incomplet. Toutes les règles métier (cohérence du compteur, blocages, dates)
 * restent appliquées par l'API.
 */
export function readingInputErrors(withReading: boolean, km: string, exceptionReason: string): FieldErrors {
  if (withReading) {
    const value = normalizeKmInput(km);
    if (!value) return { 'reading.physicalKm': ['Saisissez la valeur lue sur le compteur.'] };
    if (!/^\d+(\.\d+)?$/.test(value)) return { 'reading.physicalKm': ['Nombre attendu (valeur lue, sans unité).'] };
    return {};
  }
  return exceptionReason.trim() ? {} : { 'readingException.reason': ['Motif de l’exception obligatoire.'] };
}

/** Lieu obligatoire à la remise et à la restitution : un site ou un lieu libre. */
export function locationInputErrors(mode: 'site' | 'libre', siteId: string, placeLabel: string): FieldErrors {
  if (mode === 'site') return siteId ? {} : { 'location.siteId': ['Choisissez le site, ou indiquez un lieu libre.'] };
  return placeLabel.trim() ? {} : { 'location.placeLabel': ['Indiquez le lieu.'] };
}

/** Checklist enregistrée par l'API (JSON) : lecture défensive des éléments. */
export function parseChecklist(value: unknown): UsageChecklistEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && typeof (item as { label?: unknown }).label === 'string')
    .map((item) => ({ label: String(item.label), present: item.present === true, comment: typeof item.comment === 'string' && item.comment ? item.comment : null }));
}

/** Liste de la checklist paramétrée (`usage.checklistItems`) dans la réponse GET /settings. */
export function checklistItemsFromSettings(settings: Array<{ key: string; value: unknown }> | undefined): string[] {
  const entry = settings?.find((s) => s.key === 'usage.checklistItems');
  return Array.isArray(entry?.value) ? entry.value.filter((v): v is string => typeof v === 'string') : [];
}

export function toneForDistance(status: string): Tone {
  return status === 'VALIDEE' ? 'success' : status === 'NON_VALIDEE' ? 'warning' : 'neutral';
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

/** Blocages ou réservations en conflit joints à une erreur 409/422 de l'API (details). */
export function blockersFromDetails(details: Record<string, unknown> | undefined): Array<{ code: string; message: string }> {
  const raw = details?.blockers;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((b): b is { code: string; message: string } => typeof b === 'object' && b !== null && typeof (b as { message?: unknown }).message === 'string')
    .map((b) => ({ code: String(b.code), message: b.message }));
}

export function reservationsFromDetails(details: Record<string, unknown> | undefined): Array<{ id: string; startAt: string; endAt: string; driverName: string }> {
  const raw = details?.reservations;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is { id: string; startAt: string; endAt: string; driverName: string } =>
      typeof r === 'object' && r !== null && typeof (r as { startAt?: unknown }).startAt === 'string' && typeof (r as { endAt?: unknown }).endAt === 'string',
  );
}
