import { expect, test, type Page } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { civilDate, km, logout, openVehicle } from '../support/lot-b-helpers.js';
import { E2E } from '../support/seed-e2e.js';

/** Espace conducteur mobile d'abord (CDC 10.3) : largeur d'un téléphone. */
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 720 };

/** Aucun défilement horizontal de la page (lisibilité sur téléphone). */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test.describe('Relevés kilométriques', () => {
  test('le conducteur déclare depuis Mon véhicule un kilométrage au-delà du seuil : soumission en attente sans effet sur le compteur, validée par le chef (T11)', async ({ page }) => {
    const pendingReason = `Soumission conducteur. Hausse de ${km(6_000)} depuis le relevé précédent, au-delà du seuil de plausibilité (${km(300)} pour la durée écoulée) : validation requise.`;

    // 1. Conducteur, sur téléphone : utilisation en cours sur E2E-KM1, remise à 20 000 km.
    await page.setViewportSize(PHONE);
    await loginAs(page, E2E.conducteurReleves);
    await page.goto('/mon-vehicule');
    await expect(page.getByRole('heading', { level: 1, name: 'Mon véhicule' })).toBeVisible();
    const current = page.getByRole('region', { name: 'Utilisation en cours' });
    await expect(current.getByRole('heading', { name: 'E2E-KM1 · 502 TU 2026' })).toBeVisible();
    await expect(current).toContainText('Utilisation en cours');
    await expect(current).toContainText(`Dernier kilométrage validé${km(20_000)} le`);
    await expectNoHorizontalScroll(page);

    await page.getByRole('button', { name: 'Ajouter un kilométrage' }).click();
    const form = page.locator('[data-slot="card"]').filter({ has: page.getByRole('heading', { name: 'Ajouter un kilométrage' }) });
    await expect(form).toContainText('Le relevé sera soumis à la validation du gestionnaire du parc.');
    await expect(form.getByLabel('Kilométrage affiché au compteur *')).toBeFocused();
    // Contrôle de saisie local avant l'envoi.
    await form.getByRole('button', { name: 'Envoyer le kilométrage' }).click();
    await expect(form.getByText('Saisissez la valeur affichée au compteur.')).toBeVisible();
    await form.getByLabel('Kilométrage affiché au compteur *').fill('26 000');
    await form.getByLabel('Commentaire (facultatif)').fill('Retour de tournée longue par l’autoroute A1');
    await form.getByRole('button', { name: 'Envoyer le kilométrage' }).click();

    // Réponse du serveur : soumission en attente, motif d'attente calculé par l'API.
    await expect(page.getByRole('heading', { name: 'Kilométrage envoyé' })).toBeFocused();
    const result = page.getByRole('status').filter({ hasText: 'Relevé du' });
    await expect(result).toContainText(km(26_000));
    await expect(result).toContainText('En attente');
    await expect(result).toContainText('Le gestionnaire du parc doit le valider.');
    await expect(result).toContainText(`Motif d’attente : ${pendingReason}`);
    await expectNoHorizontalScroll(page);
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();

    // Aucun compteur officiel modifié tant que la soumission n'est pas validée (T11).
    await expect(current).toContainText(`Dernier kilométrage validé${km(20_000)} le`);
    const submissions = page.getByRole('region', { name: 'Mes soumissions' });
    const submission = submissions.getByRole('listitem').filter({ hasText: km(26_000) });
    await expect(submission).toContainText('E2E-KM1');
    await expect(submission).toContainText('En attente de validation par le gestionnaire du parc.');
    await expect(submission).toContainText(`Motif d’attente : ${pendingReason}`);
    await logout(page);

    // 2. Chef de parc : compteur courant inchangé, soumission signalée dans le dossier du véhicule.
    await page.setViewportSize(DESKTOP);
    await loginAs(page, E2E.chefA);
    await openVehicle(page, 'E2E-KM1');
    await page.getByRole('tab', { name: 'Kilométrage' }).click();
    const counter = page.locator('[data-slot="card"]').filter({ has: page.getByRole('heading', { name: 'Compteur courant' }) });
    await expect(counter).toContainText(km(20_000));
    await expect(counter).toContainText('1 relevé(s) en attente de validation');
    await counter.getByRole('link', { name: 'Ouvrir la file de validation de ce véhicule' }).click();

    // File de validation filtrée sur le véhicule : motif de l'API, validation commentée.
    await expect(page).toHaveURL(/\/kilometrage\?onglet=a-valider&vehicule=[0-9a-f-]{36}/);
    await expect(page.getByRole('tab', { name: /^À valider/, selected: true })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: km(26_000) });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('E2E-KM1');
    await expect(row).toContainText('En attente');
    await expect(row).toContainText('Rania Releve');
    await expect(row).toContainText(`Motif d’attente : ${pendingReason}`);
    await expect(row).toContainText('Code : HAUSSE_IMPLAUSIBLE');
    await row.getByRole('button', { name: /^Valider le relevé E2E-KM1/ }).click();
    const decision = page.getByRole('dialog', { name: 'Valider le relevé' });
    await expect(decision).toContainText(pendingReason);
    await decision.getByLabel('Commentaire de validation (facultatif)').fill('Tournée longue confirmée par le conducteur');
    await decision.getByRole('button', { name: 'Valider le relevé' }).click();
    await expect(decision).toBeHidden();
    await expect(page.getByText('Relevé E2E-KM1 validé : il devient un relevé accepté.')).toBeVisible();
    await expect(page.getByText('Aucun relevé en attente pour ce véhicule.')).toBeVisible();

    // Compteur officiel mis à jour par la validation, relevé accepté avec son commentaire.
    await openVehicle(page, 'E2E-KM1');
    await page.getByRole('tab', { name: 'Kilométrage' }).click();
    await expect(counter).toContainText(km(26_000));
    await expect(counter).not.toContainText('en attente de validation');
    const accepted = page.getByRole('table', { name: 'Relevés du véhicule' }).getByRole('row').filter({ hasText: km(26_000) });
    await expect(accepted).toContainText('Accepté');
    await expect(accepted).toContainText('Commentaire de validation : Tournée longue confirmée par le conducteur');
    await logout(page);

    // 3. Le conducteur voit la décision dans « Mes soumissions ».
    await page.setViewportSize(PHONE);
    await loginAs(page, E2E.conducteurReleves);
    await page.goto('/mon-vehicule');
    await expect(current).toContainText(`Dernier kilométrage validé${km(26_000)} le`);
    await expect(submission).toContainText(/Accepté le \d{2}\/\d{2}\/\d{4}/);
    await expect(submission).toContainText('Commentaire : Tournée longue confirmée par le conducteur');
    await expectNoHorizontalScroll(page);
  });

  test('le chef corrige un relevé accepté avec motif : original conservé « Remplacé », remplacement accepté et chronologie recalculée ; une diminution est refusée (T09, T13)', async ({ page }) => {
    await loginAs(page, E2E.chefA);
    await openVehicle(page, 'E2E-KM2');
    await page.getByRole('tab', { name: 'Kilométrage' }).click();
    const counter = page.locator('[data-slot="card"]').filter({ has: page.getByRole('heading', { name: 'Compteur courant' }) });
    await expect(counter).toContainText('Kilométrage inconnu : aucun relevé accepté.');

    // 1. Relevé erroné saisi hier à 8 h : premier relevé accepté, il initialise le compteur.
    await page.getByRole('button', { name: 'Ajouter un relevé' }).click();
    let dialog = page.getByRole('dialog', { name: 'Ajouter un relevé' });
    await dialog.getByLabel('Valeur affichée (km) *').fill('35000');
    await dialog.getByLabel('Date et heure d’observation *').fill(`${civilDate(-1)}T08:00`);
    await dialog.getByRole('button', { name: 'Enregistrer le relevé' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`Relevé accepté : ${km(35_000)}.`)).toBeVisible();
    await expect(counter).toContainText(km(35_000));

    // 2. Diminution inexpliquée refusée par l'API avec son message (T09), rien n'est enregistré.
    await page.getByRole('button', { name: 'Ajouter un relevé' }).click();
    dialog = page.getByRole('dialog', { name: 'Ajouter un relevé' });
    await dialog.getByLabel('Valeur affichée (km) *').fill('34800');
    await dialog.getByRole('button', { name: 'Enregistrer le relevé' }).click();
    await expect(dialog.getByRole('alert').first()).toContainText(`Diminution inexpliquée : ${km(34_800)} après ${km(35_000)}`);
    await expect(dialog.getByLabel('Valeur affichée (km) *')).toHaveAttribute('aria-invalid', 'true');
    await dialog.getByRole('button', { name: 'Annuler' }).click();
    await expect(dialog).toBeHidden();
    const readings = page.getByRole('table', { name: 'Relevés du véhicule' });
    await expect(readings.getByRole('row').filter({ hasText: km(34_800) })).toHaveCount(0);

    // 3. Correction motivée du relevé accepté (T13) : contrôles locaux puis envoi.
    const original = readings.getByRole('row').filter({ hasText: km(35_000) });
    await original.getByRole('button', { name: /^Corriger le relevé E2E-KM2/ }).click();
    const correction = page.getByRole('dialog', { name: 'Corriger le relevé' });
    await expect(correction).toContainText('l’original est conservé avec le statut « Remplacé »');
    await correction.getByRole('button', { name: 'Enregistrer la correction' }).click();
    await expect(correction.getByText('Valeur de remplacement obligatoire.')).toBeVisible();
    await expect(correction.getByText('Motif obligatoire (3 caractères au moins).')).toBeVisible();
    await correction.getByLabel('Valeur physique corrigée (km) *').fill('30500');
    await correction.getByLabel('Motif de la correction *').fill('Erreur de saisie : 35 000 tapé au lieu de 30 500');
    await correction.getByRole('button', { name: 'Enregistrer la correction' }).click();
    await expect(correction).toBeHidden();
    await expect(page.getByText(`Relevé corrigé : ${km(30_500)}. L’original est conservé avec le statut « Remplacé ».`)).toBeVisible();

    // Original conservé (Remplacé, motif), remplacement accepté, compteur courant recalculé.
    await expect(counter).toContainText(km(30_500));
    await expect(original).toContainText('Remplacé');
    await expect(original).toContainText('Remplacé : corrigé (motif : Erreur de saisie : 35 000 tapé au lieu de 30 500)');
    await expect(original.getByRole('button', { name: /^Corriger/ })).toHaveCount(0);
    const replacement = readings.getByRole('row').filter({ hasText: km(30_500) });
    await expect(replacement).toContainText('Accepté');
    await expect(replacement).toContainText('Relevé corrigé : Erreur de saisie : 35 000 tapé au lieu de 30 500');
    await expect(replacement.getByRole('button', { name: /^Corriger le relevé E2E-KM2/ })).toBeVisible();

    // 4. La chronologie suit la valeur corrigée : 31 000 km, auparavant une diminution, est désormais accepté.
    await page.getByRole('button', { name: 'Ajouter un relevé' }).click();
    dialog = page.getByRole('dialog', { name: 'Ajouter un relevé' });
    await expect(dialog).toContainText(`Compteur courant : ${km(30_500)}`);
    await dialog.getByLabel('Valeur affichée (km) *').fill('31000');
    await dialog.getByRole('button', { name: 'Enregistrer le relevé' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`Relevé accepté : ${km(31_000)}.`)).toBeVisible();
    await expect(counter).toContainText(km(31_000));

    // Historique global du kilométrage : l'original remplacé reste consultable avec son motif.
    await page.goto('/kilometrage?onglet=historique');
    await page.getByRole('combobox', { name: 'Statut' }).click();
    await page.getByRole('option', { name: 'Remplacé' }).click();
    const replaced = page.getByRole('row').filter({ hasText: 'E2E-KM2' });
    await expect(replaced).toHaveCount(1);
    await expect(replaced).toContainText(km(35_000));
    await expect(replaced).toContainText('corrigé (motif : Erreur de saisie : 35 000 tapé au lieu de 30 500)');
  });
});
