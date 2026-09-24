import { expect, test, type Page } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { civilDate, frenchDate, km, openVehicle, wallTime } from '../support/lot-b-helpers.js';
import { E2E } from '../support/seed-e2e.js';

const HOUR = 3600_000;

/** Remplit le formulaire de remise (/utilisations/nouvelle) jusqu'au dialogue de confirmation, sans confirmer. */
async function fillCheckout(page: Page, input: { vehicle: string; driverSearch: string; driver: RegExp; checkedOutAt?: string; expectedReturnAt: string; purpose: string; km: string }): Promise<void> {
  await page.goto('/utilisations/nouvelle');
  await expect(page.getByRole('heading', { level: 1, name: 'Nouvelle remise' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Véhicule disponible *' }).click();
  await page.getByRole('combobox', { name: 'Code, immatriculation, marque…' }).fill(input.vehicle);
  await page.getByRole('option', { name: new RegExp(input.vehicle) }).click();
  await page.getByRole('combobox', { name: 'Conducteur actif *' }).click();
  await page.getByRole('combobox', { name: 'Code, nom ou prénom…' }).fill(input.driverSearch);
  await page.getByRole('option', { name: input.driver }).click();
  // Contrôles préalables calculés par l'API pour ce couple véhicule / conducteur.
  await expect(page.getByText('Aucun blocage détecté')).toBeVisible();
  if (input.checkedOutAt) await page.getByLabel('Date et heure réelles de la remise *').fill(input.checkedOutAt);
  await page.getByLabel('Retour prévu *').fill(input.expectedReturnAt);
  await page.getByLabel('Motif *').fill(input.purpose);
  await page.getByLabel('Compteur affiché (km) *').fill(input.km);
  await page.getByRole('combobox', { name: 'Site *' }).click();
  await page.getByRole('option', { name: 'Dépôt Tunis' }).click();
}

/**
 * T04 côté navigateur : deux formulaires ouverts sur le même véhicule, le second confirmé après la première
 * remise ; l'API refuse et l'interface affiche son message. Les requêtes réellement simultanées (T04, T05)
 * restent couvertes par les tests d'intégration de l'API.
 */
test.describe('Utilisations : remise et restitution (T04)', () => {
  test('remise avec relevé, seconde remise concurrente du même véhicule refusée par l’API, retour avec relevé, fiche imprimable et localisation', async ({ page, context }) => {
    await loginAs(page, E2E.chefA);

    // Contrôles de présence avant tout envoi, attachés aux champs.
    await page.goto('/utilisations/nouvelle');
    await page.getByRole('button', { name: 'Vérifier et enregistrer la remise' }).click();
    await expect(page.getByText('Choisissez le véhicule.')).toBeVisible();
    await expect(page.getByText('Choisissez le conducteur.')).toBeVisible();
    await expect(page.getByText('Indiquez le motif de l’utilisation.')).toBeVisible();

    // 1. Remise à Ines Remise, saisie après coup (il y a 3 h), avec relevé, lieu, carburant, checklist et réserves.
    await fillCheckout(page, { vehicle: 'E2E-UT1', driverSearch: 'D-E2E-UT1', driver: /Ines Remise/, checkedOutAt: wallTime(-3 * HOUR), expectedReturnAt: wallTime(24 * HOUR), purpose: 'Mission client à Nabeul', km: '12500' });
    await expect(page.getByText('Kilométrage inconnu : aucun relevé accepté pour ce véhicule.')).toBeVisible();
    await expect(page.getByText('Aucune réservation confirmée pour ce véhicule et ce conducteur.')).toBeVisible();
    await page.getByRole('combobox', { name: 'Niveau de carburant approximatif' }).click();
    await page.getByRole('option', { name: '3/4' }).click();
    await page.getByRole('checkbox', { name: 'Clés', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Carte grise', exact: true }).check();
    await page.getByLabel('Observations (réserves à la remise)').fill('Rayure légère sur la portière avant droite');
    await page.getByLabel('Confirmation nominative (facultative)').fill('Ines Remise');
    await page.getByRole('button', { name: 'Vérifier et enregistrer la remise' }).click();
    const confirmFirst = page.getByRole('alertdialog', { name: 'Confirmer la remise' });
    await expect(confirmFirst).toContainText('E2E-UT1 · 501 TU 2026 remis à Ines Remise');
    await expect(confirmFirst).toContainText('12500 km (valeur saisie)');

    // 2. Second onglet : même véhicule, encore disponible, remis à Omar Relais ; confirmation ouverte avant la première remise.
    const second = await context.newPage();
    await fillCheckout(second, { vehicle: 'E2E-UT1', driverSearch: 'D-E2E-UT2', driver: /Omar Relais/, expectedReturnAt: wallTime(48 * HOUR), purpose: 'Livraison urgente à Sfax', km: '12500' });
    await second.getByRole('button', { name: 'Vérifier et enregistrer la remise' }).click();
    const confirmSecond = second.getByRole('alertdialog', { name: 'Confirmer la remise' });
    await expect(confirmSecond).toContainText('E2E-UT1 · 501 TU 2026 remis à Omar Relais');

    // 3. La première remise est enregistrée : fiche de l'utilisation en cours.
    await confirmFirst.getByRole('button', { name: 'Confirmer la remise' }).click();
    await expect(page).toHaveURL(/\/utilisations\/[0-9a-f-]{36}$/);
    const usageUrl = page.url();
    await expect(page.getByRole('heading', { level: 1, name: 'E2E-UT1 · 501 TU 2026' })).toBeVisible();
    const main = page.getByRole('main');
    await expect(main.getByText('En cours', { exact: true })).toBeVisible();
    await expect(main).toContainText('Utilisation par Ines Remise · Société E2E-A · Motif : Mission client à Nabeul');
    const checkoutCard = main.locator('[data-slot="card"]').filter({ has: page.getByRole('heading', { name: 'Remise', exact: true }) });
    await expect(checkoutCard).toContainText(km(12_500));
    await expect(checkoutCard).toContainText('Accepté');
    await expect(checkoutCard).toContainText('Dépôt Tunis');
    await expect(checkoutCard).toContainText('3/4');
    await expect(checkoutCard).toContainText('Ines Remise (non certifiée)');

    // 4. La seconde remise du même véhicule est refusée par l'API avec son message ; les contrôles sont relus.
    await confirmSecond.getByRole('button', { name: 'Confirmer la remise' }).click();
    const refusal = second.getByRole('alert').filter({ hasText: 'La remise n’a pas été enregistrée' });
    await expect(refusal).toContainText('Le véhicule est déjà en utilisation.');
    await expect(second).toHaveURL(/\/utilisations\/nouvelle$/);
    await expect(second.getByText('Bloquant', { exact: true })).toBeVisible();
    await expect(second.getByText('Aucun blocage détecté')).toHaveCount(0);
    await second.close();

    // Une seule utilisation ouverte pour ce véhicule, celle d'Ines Remise.
    await page.goto('/utilisations');
    const rows = page.getByRole('row').filter({ has: page.getByRole('link', { name: 'E2E-UT1', exact: true }) });
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('Ines Remise');
    await expect(rows).toContainText('En cours');
    await expect(page.getByRole('row').filter({ hasText: 'Omar Relais' })).toHaveCount(0);

    // 5. Restitution : relevé de retour, lieu libre, carburant, checklist comparée au départ.
    await page.goto(usageUrl);
    await page.getByRole('button', { name: 'Enregistrer le retour' }).first().click();
    const returnForm = page.locator('#retour');
    await expect(returnForm.getByRole('heading', { name: 'Enregistrer le retour' })).toBeVisible();
    await expect(returnForm).toContainText(`Relevé de départ : ${km(12_500)} (Accepté)`);
    await returnForm.getByLabel('Compteur affiché (km) *').fill('12640');
    await returnForm.getByRole('radio', { name: 'Lieu libre' }).click();
    await returnForm.getByLabel('Lieu *').fill('Parking client, La Marsa');
    await returnForm.getByRole('combobox', { name: 'Niveau de carburant approximatif' }).click();
    await page.getByRole('option', { name: '1/2' }).click();
    await expect(returnForm.getByText('(au départ : remis)')).toHaveCount(2);
    await returnForm.getByRole('checkbox', { name: 'Clés', exact: true }).check();
    await returnForm.getByRole('checkbox', { name: 'Carte grise', exact: true }).check();
    await returnForm.getByLabel('Observations (réserves au retour)').fill('Véhicule restitué propre, rayure déjà signalée au départ');
    await returnForm.getByRole('button', { name: 'Enregistrer le retour' }).click();
    const confirmReturn = page.getByRole('alertdialog', { name: 'Confirmer le retour' });
    await expect(confirmReturn).toContainText('E2E-UT1 restitué par Ines Remise');
    await confirmReturn.getByRole('button', { name: 'Confirmer le retour' }).click();
    await expect(confirmReturn).toBeHidden();
    await expect(page.getByText('Retour enregistré : E2E-UT1 restitué.')).toBeVisible();
    await expect(main.getByText('Terminée', { exact: true })).toBeVisible();
    await expect(main.getByText('Distance validée', { exact: true }).first()).toBeVisible();
    const distanceCard = main.locator('[data-slot="card"]').filter({ has: page.getByRole('heading', { name: 'Distance', exact: true }) });
    await expect(distanceCard).toContainText(km(140));
    const returnCard = main.locator('[data-slot="card"]').filter({ has: page.getByRole('heading', { name: 'Restitution', exact: true }) });
    await expect(returnCard).toContainText(km(12_640));
    await expect(returnCard).toContainText('Parking client, La Marsa');
    await expect(returnCard).toContainText('Aucun dommage déclaré au retour');
    await expect(page.getByRole('button', { name: 'Enregistrer le retour' })).toHaveCount(0);

    // 6. Fiche de remise et de restitution imprimable.
    await page.getByRole('link', { name: 'Fiche imprimable' }).click();
    await expect(page).toHaveURL(/\/utilisations\/[0-9a-f-]{36}\/fiche$/);
    const sheet = page.getByRole('article');
    await expect(sheet.getByRole('heading', { level: 1, name: 'Fiche de remise et de restitution' })).toBeVisible();
    await expect(sheet).toContainText('Statut : Terminée');
    await expect(sheet).toContainText(/Motif :\s*Mission client à Nabeul/);
    await expect(sheet.getByRole('row', { name: /^Relevé du compteur/ })).toContainText(`${km(12_500)} (Accepté`);
    await expect(sheet.getByRole('row', { name: /^Relevé du compteur/ })).toContainText(`${km(12_640)} (Accepté`);
    await expect(sheet.getByRole('row', { name: /^Lieu/ })).toContainText('Dépôt Tunis');
    await expect(sheet.getByRole('row', { name: /^Lieu/ })).toContainText('Parking client, La Marsa');
    await expect(sheet.getByRole('row', { name: /^Carburant/ })).toContainText('3/4');
    await expect(sheet.getByRole('row', { name: /^Observations et réserves/ })).toContainText('Rayure légère sur la portière avant droite');
    await expect(sheet.getByRole('row', { name: /^Clés/ })).toHaveText(/Clés\s*Présent\s*Présent/);
    await expect(sheet.getByRole('row', { name: /^Triangle/ })).toHaveText(/Triangle\s*Absent\s*Absent/);
    await expect(sheet).toContainText(new RegExp(`Distance :\\s*${km(140)} · Distance validée`));
    await expect(sheet).toContainText('Ceci n’est pas une signature certifiée.');
    await expect(sheet.getByRole('heading', { name: 'Signatures manuscrites' })).toBeVisible();
    // Rendu d'impression : actions et navigation masquées, fiche conservée.
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByRole('button', { name: 'Imprimer' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Se déconnecter' })).toBeHidden();
    await expect(sheet.getByRole('heading', { level: 1, name: 'Fiche de remise et de restitution' })).toBeVisible();
    await page.emulateMedia({ media: 'screen' });
    await expect(page.getByRole('button', { name: 'Imprimer' })).toBeVisible();

    // 7. Dossier véhicule : disponible, dernière localisation déclarée = lieu de restitution, compteur à jour.
    await openVehicle(page, 'E2E-UT1');
    await expect(main.getByText('Disponible', { exact: true })).toBeVisible();
    const lastLocation = main.locator('[data-slot="card"]').filter({ hasText: 'Dernière localisation déclarée' });
    await expect(lastLocation).toContainText('Parking client, La Marsa');
    await expect(main.locator('[data-slot="card"]').filter({ hasText: 'Utilisateur actuel' })).toContainText('Aucune utilisation en cours.');
    await expect(main.locator('[data-slot="card"]').filter({ hasText: 'Dernier relevé validé' })).toContainText(km(12_640));
    await page.getByRole('tab', { name: 'Localisation' }).click();
    await expect(page.getByRole('cell', { name: 'Parking client, La Marsa' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Dépôt Tunis' })).toBeVisible();
  });
});

test.describe('Localisation déclarative', () => {
  // Navigateur hors du fuseau du groupe (Europe/Paris, UTC+2 en été ; Africa/Tunis, UTC+1) : les heures
  // saisies et affichées restent celles du fuseau de l'organisation.
  test.use({ timezoneId: 'Europe/Paris' });

  test('une localisation déclarée depuis un navigateur d’un autre fuseau est datée à l’heure saisie, dans le fuseau du groupe', async ({ page }) => {
    const day = civilDate(-1);
    await loginAs(page, E2E.chefA);
    await openVehicle(page, 'E2E-LOC1');
    const main = page.getByRole('main');
    await expect(main.locator('[data-slot="card"]').filter({ hasText: 'Dernière localisation déclarée' })).toContainText('Aucune localisation déclarée.');

    await page.getByRole('tab', { name: 'Localisation' }).click();
    await expect(page.getByText('Aucune localisation déclarée', { exact: true })).toBeVisible();
    // Valeur proposée : maintenant, à l'heure du groupe (et non à celle du navigateur).
    await expect(page.getByLabel('Date d’observation')).toHaveValue(new RegExp(`^(${wallTime(-60_000)}|${wallTime()}|${wallTime(60_000)})$`));
    await page.getByLabel('Lieu', { exact: true }).fill('Garage partenaire, Ben Arous');
    await page.getByLabel('Date d’observation').fill(`${day}T10:00`);
    await page.getByLabel('Commentaire').fill('Déposé pour carrosserie');
    await page.getByRole('button', { name: 'Déclarer' }).click();
    await expect(page.getByText('Localisation déclarée.')).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: 'Garage partenaire, Ben Arous' });
    await expect(row).toContainText(`${frenchDate(day)} 10:00`);
    await expect(row).toContainText('Déposé pour carrosserie');
    await expect(row).toContainText('Chaima Chef');

    await page.getByRole('tab', { name: 'Synthèse' }).click();
    const lastLocation = main.locator('[data-slot="card"]').filter({ hasText: 'Dernière localisation déclarée' });
    await expect(lastLocation).toContainText('Garage partenaire, Ben Arous');
    await expect(lastLocation).toContainText(`observée le ${frenchDate(day)} 10:00 par Chaima Chef`);
  });
});
