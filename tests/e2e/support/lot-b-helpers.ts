import { expect, type Page } from '@playwright/test';

/** Fuseau du groupe e2e (Organization.timezone par défaut) : les saisies datetime-local y sont exprimées. */
const TIMEZONE = 'Africa/Tunis';

function zonedParts(at: Date): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return Object.fromEntries(formatter.formatToParts(at).map((p) => [p.type, p.value]));
}

/** Heure murale du fuseau du groupe, décalée de `offsetMs`, au format d'un champ datetime-local (AAAA-MM-JJTHH:mm). */
export function wallTime(offsetMs = 0): string {
  const p = zonedParts(new Date(Date.now() + offsetMs));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Date civile du jour + n dans le fuseau du groupe (AAAA-MM-JJ). */
export function civilDate(daysAhead: number): string {
  const p = zonedParts(new Date(Date.now() + daysAhead * 24 * 3600_000));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Date civile affichée par l'interface (JJ/MM/AAAA). */
export function frenchDate(civil: string): string {
  const [y, m, d] = civil.split('-');
  return `${d}/${m}/${y}`;
}

/** Kilométrage tel que l'API et l'interface le formatent (fr-FR, kilomètre entier) : « 12 500 km ». */
export function km(value: number): string {
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(value)} km`;
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect(page).toHaveURL(/\/login/);
}

/**
 * Ouvre le dossier d'un véhicule depuis la liste, par la recherche (parcours réel, sans identifiant connu à
 * l'avance ; indépendant de la pagination quand d'autres parcours ajoutent des véhicules).
 */
export async function openVehicle(page: Page, code: string): Promise<void> {
  await page.goto('/vehicules');
  await page.getByLabel('Rechercher').fill(code);
  await expect(page).toHaveURL(new RegExp(`q=${code}`));
  await page.getByRole('link', { name: code, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(`^${code} · `) })).toBeVisible();
}
