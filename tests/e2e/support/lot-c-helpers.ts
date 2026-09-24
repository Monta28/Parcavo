import { expect, type Page } from '@playwright/test';

/** Fuseau du groupe e2e (Organization.timezone par défaut) : dates civiles et heures murales y sont exprimées. */
const TIMEZONE = 'Africa/Tunis';

/** Justificatif fictif : PDF minimal sans contenu actif (type réel vérifié par l'API). */
export const SAMPLE_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'utf8');

/** Date civile du jour + n dans le fuseau du groupe (AAAA-MM-JJ). */
export function civilDate(daysAhead = 0): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + daysAhead * 24 * 3600_000));
}

/** Même jour de l'année suivante (29 février ramené au 28, comme un intervalle de 12 mois calendaires). */
export function sameDayNextYear(civil: string): string {
  const [y, m, d] = civil.split('-');
  return `${Number(y) + 1}-${m}-${m === '02' && d === '29' ? '28' : d}`;
}

/** Date civile affichée par l'interface (JJ/MM/AAAA). */
export function frenchDate(civil: string): string {
  const [y, m, d] = civil.split('-');
  return `${d}/${m}/${y}`;
}

/** Kilométrage tel que l'interface le formate (fr-FR, kilomètre entier) : « 90 300 km ». */
export function km(value: number): string {
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(value)} km`;
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** Ouvre le dossier d'un véhicule depuis la liste, par la recherche (indépendant de la pagination). */
export async function openVehicle(page: Page, code: string): Promise<void> {
  await page.goto('/vehicules');
  await page.getByLabel('Rechercher').fill(code);
  await expect(page).toHaveURL(new RegExp(`q=${code}`));
  await page.getByRole('link', { name: code, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(`^${code} · `) })).toBeVisible();
}
