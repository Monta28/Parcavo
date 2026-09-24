import { expect, test, type Locator, type Page } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { civilDate, frenchDate, openVehicle } from '../support/lot-b-helpers.js';
import { E2E } from '../support/seed-e2e.js';

/** Choisit un conducteur actif de la société du véhicule dans un sélecteur à recherche locale. */
async function pickDriver(page: Page, combobox: Locator, name: string): Promise<void> {
  await combobox.click();
  await page.getByRole('combobox', { name: 'Code ou nom…' }).fill(name);
  await page.getByRole('option', { name: new RegExp(`^${name}`) }).click();
  await expect(combobox).toHaveText(name);
}

test.describe('Réservations et responsable habituel', () => {
  test('réservation créée au planning, créneau chevauchant refusé avec le message de l’API, créneau consécutif accepté (T06)', async ({ page }) => {
    const day = civilDate(7);
    const slot = (start: string, end: string) => `${frenchDate(day)} ${start} → ${end}`;
    await loginAs(page, E2E.chefA);

    // Du dossier véhicule vers son planning, positionné sur le jour de la mission.
    await openVehicle(page, 'E2E-RS1');
    await page.getByRole('tab', { name: 'Réservations' }).click();
    await expect(page.getByText('Aucune réservation à venir')).toBeVisible();
    await page.getByRole('link', { name: 'Ouvrir le planning du véhicule' }).click();
    await expect(page).toHaveURL(/\/planning\?vehicule=[0-9a-f-]{36}/);
    await expect(page.getByRole('heading', { level: 1, name: 'Planning' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Véhicule', exact: true })).toHaveText(/E2E-RS1 · 504 TU 2026/);
    await page.getByLabel('Aller à la date').fill(day);
    await expect(page).toHaveURL(new RegExp(`date=${day}`));

    // 1. Nouvelle réservation depuis la ligne du véhicule : contrôles de présence, puis confirmation par l'API.
    await page.getByRole('button', { name: 'Réserver E2E-RS1' }).click();
    let dialog = page.getByRole('dialog', { name: 'Nouvelle réservation' });
    await expect(dialog.getByRole('combobox', { name: 'Véhicule *' })).toHaveText(/E2E-RS1 · 504 TU 2026/);
    await dialog.getByRole('button', { name: 'Confirmer la réservation' }).click();
    await expect(dialog.getByText('Choisissez un conducteur.')).toBeVisible();
    await expect(dialog.getByText('Date et heure de début requises.')).toBeVisible();
    await expect(dialog.getByText('Motif requis (2 caractères minimum).')).toBeVisible();
    await pickDriver(page, dialog.getByRole('combobox', { name: 'Conducteur *' }), 'Walid Reserve');
    await dialog.getByLabel('Début prévu (inclus) *').fill(`${day}T09:00`);
    await dialog.getByLabel('Fin prévue (exclue) *').fill(`${day}T12:00`);
    await dialog.getByLabel('Motif *').fill('Audit client à Bizerte');
    await dialog.getByLabel('Destination', { exact: true }).fill('Bizerte');
    await dialog.getByRole('button', { name: 'Confirmer la réservation' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Réservation confirmée : E2E-RS1 pour Walid Reserve.')).toBeVisible();

    await page.getByRole('group', { name: 'Affichage' }).getByRole('button', { name: 'Liste' }).click();
    const reservationRows = page.getByRole('row').filter({ hasText: 'Réservation' }).filter({ hasText: 'E2E-RS1' });
    await expect(reservationRows).toHaveCount(1);
    await expect(reservationRows).toContainText('Confirmée');
    await expect(reservationRows).toContainText('Walid Reserve');
    await expect(reservationRows).toContainText(slot('09:00', '12:00'));

    // 2. Créneau chevauchant [11 h, 14 h[ pour une autre conductrice : refusé par l'API, message affiché, rien d'enregistré.
    await page.getByRole('button', { name: 'Nouvelle réservation' }).click();
    dialog = page.getByRole('dialog', { name: 'Nouvelle réservation' });
    await expect(dialog.getByRole('combobox', { name: 'Véhicule *' })).toHaveText(/E2E-RS1 · 504 TU 2026/);
    await pickDriver(page, dialog.getByRole('combobox', { name: 'Conducteur *' }), 'Leila Creneau');
    await dialog.getByLabel('Début prévu (inclus) *').fill(`${day}T11:00`);
    await dialog.getByLabel('Fin prévue (exclue) *').fill(`${day}T14:00`);
    await dialog.getByLabel('Motif *').fill('Formation régionale à Sfax');
    await dialog.getByRole('button', { name: 'Confirmer la réservation' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Ce créneau chevauche une réservation confirmée du véhicule.');
    await expect(dialog).toBeVisible();

    // 3. Même demande sur le créneau exactement consécutif [12 h, 15 h[ : acceptée (fin exclue).
    await dialog.getByLabel('Début prévu (inclus) *').fill(`${day}T12:00`);
    await dialog.getByLabel('Fin prévue (exclue) *').fill(`${day}T15:00`);
    await dialog.getByRole('button', { name: 'Confirmer la réservation' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Réservation confirmée : E2E-RS1 pour Leila Creneau.')).toBeVisible();
    await expect(reservationRows).toHaveCount(2);
    const leila = reservationRows.filter({ hasText: 'Leila Creneau' });
    await expect(leila).toContainText(slot('12:00', '15:00'));
    await expect(leila).toContainText('Confirmée');
    await expect(reservationRows.filter({ hasText: slot('11:00', '14:00') })).toHaveCount(0);

    // Détail de la première réservation depuis le planning : statut et motif enregistrés par l'API.
    await reservationRows.filter({ hasText: 'Walid Reserve' }).getByRole('button', { name: /^Gérer la réservation E2E-RS1/ }).click();
    const detail = page.getByRole('dialog', { name: 'Réservation E2E-RS1 · Walid Reserve' });
    await expect(detail).toContainText('Confirmée');
    await expect(detail).toContainText('Audit client à Bizerte');
    await expect(detail).toContainText('Bizerte');
  });

  test('responsable habituel nommé sans remplacer l’utilisation ponctuelle en cours ; chevauchement refusé puis remplacement explicite, historique conservé (T08)', async ({ page }) => {
    await loginAs(page, E2E.chefA);
    await openVehicle(page, 'E2E-RH1');
    const main = page.getByRole('main');
    const responsibleCard = main.locator('[data-slot="card"]').filter({ has: page.getByText('Responsable habituel', { exact: true }) });
    const currentUserCard = main.locator('[data-slot="card"]').filter({ has: page.getByText('Utilisateur actuel', { exact: true }) });
    await expect(responsibleCard).toContainText('Aucun responsable habituel enregistré.');
    await expect(currentUserCard).toContainText('Mouna Ponctuelle');

    // 1. Nomination de Hedi Habituel, responsable depuis hier 8 h, sans fin prévue.
    await page.getByRole('tab', { name: 'Affectations' }).click();
    await expect(page.getByRole('note')).toContainText('Le responsable habituel n’est pas une preuve de conduite.');
    await expect(main).toContainText('Aucun responsable habituel en cours.');
    await page.getByRole('button', { name: 'Nommer un responsable habituel' }).click();
    let dialog = page.getByRole('dialog', { name: 'Nommer un responsable habituel' });
    await dialog.getByRole('button', { name: 'Nommer le responsable' }).click();
    await expect(dialog.getByText('Choisissez le conducteur responsable.')).toBeVisible();
    await pickDriver(page, dialog.getByRole('combobox', { name: 'Conducteur *' }), 'Hedi Habituel');
    await dialog.getByLabel('Début de la responsabilité *').fill(`${civilDate(-1)}T08:00`);
    await dialog.getByLabel('Notes', { exact: true }).fill('Véhicule de service du commercial secteur Nord');
    await dialog.getByRole('button', { name: 'Nommer le responsable' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Responsable habituel enregistré : Hedi Habituel.')).toBeVisible();
    const history = page.getByRole('region', { name: 'Historique des affectations habituelles' });
    const hedi = history.getByRole('row').filter({ hasText: 'Hedi Habituel' });
    await expect(hedi).toContainText('En cours');
    await expect(hedi).toContainText('Sans fin prévue');
    await expect(hedi).toContainText('Véhicule de service du commercial secteur Nord');

    // Responsable habituel et utilisateur réel restent deux informations distinctes (T08).
    await page.getByRole('tab', { name: 'Synthèse' }).click();
    await expect(responsibleCard).toContainText('Hedi Habituel');
    await expect(responsibleCard).toContainText(`depuis le ${frenchDate(civilDate(-1))}`);
    await expect(currentUserCard).toContainText('Mouna Ponctuelle');

    // 2. Nouvelle nomination sans demande de remplacement : chevauchement refusé par l'API, message affiché.
    await page.getByRole('tab', { name: 'Affectations' }).click();
    await page.getByRole('button', { name: 'Nommer un responsable habituel' }).click();
    dialog = page.getByRole('dialog', { name: 'Nommer un responsable habituel' });
    await pickDriver(page, dialog.getByRole('combobox', { name: 'Conducteur *' }), 'Slim Suppleant');
    await dialog.getByRole('button', { name: 'Nommer le responsable' }).click();
    const refusal = dialog.getByRole('alert');
    await expect(refusal).toContainText('Un responsable habituel est déjà affecté sur cette période ; clôturez-le ou demandez son remplacement explicite.');
    await expect(refusal).toContainText('Pour remplacer explicitement Hedi Habituel, cochez la case de remplacement puis validez de nouveau.');

    // 3. Remplacement explicite : l'affectation de Hedi est clôturée, l'historique est conservé.
    await dialog.getByRole('checkbox', { name: /^Remplacer Hedi Habituel/ }).check();
    await dialog.getByRole('button', { name: 'Nommer le responsable' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Responsable habituel enregistré : Slim Suppleant.')).toBeVisible();
    await expect(hedi).toContainText('Terminée');
    await expect(hedi).toContainText('Motif de fin : Remplacé par un nouveau responsable habituel');
    const slim = history.getByRole('row').filter({ hasText: 'Slim Suppleant' });
    await expect(slim).toContainText('En cours');
    await expect(main.locator('[data-slot="card"]').filter({ hasText: 'Responsable habituel actuel' })).toContainText('Slim Suppleant');

    await page.getByRole('tab', { name: 'Synthèse' }).click();
    await expect(responsibleCard).toContainText('Slim Suppleant');
    await expect(currentUserCard).toContainText('Mouna Ponctuelle');
  });
});
