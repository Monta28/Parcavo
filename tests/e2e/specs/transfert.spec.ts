import { expect, test } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { openVehicle } from '../support/lot-b-helpers.js';
import { E2E } from '../support/seed-e2e.js';

test.describe('Transfert de véhicule (T26)', () => {
  test('aperçu bloqué par une réservation future, puis transfert après son annulation ; véhicule visible dans la société cible', async ({ page }) => {
    await loginAs(page, E2E.admin);
    await openVehicle(page, 'E2E-TR1');
    await expect(page.getByText(new RegExp(`Véhicule particulier · Société ${E2E.companyA}$`))).toBeVisible();

    // 1. Aperçu : la réservation confirmée future bloque le transfert, avec son motif et un lien de traitement.
    await page.getByRole('button', { name: 'Transférer' }).click();
    let dialog = page.getByRole('dialog', { name: /Transférer le véhicule E2E-TR1/ });
    await expect(dialog.getByText('Transfert impossible pour l’instant')).toBeVisible();
    await expect(dialog).toContainText('Réservation future non traitée : annulez-la avec un motif ou attendez sa fin.');
    await expect(dialog).toContainText(/Réservation du .+ au .+/);
    await expect(dialog.getByText('Confirmée', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Transférer vers|Confirmer le transfert/ })).toHaveCount(0);

    // 2. Traitement de l'objet bloquant depuis le lien de l'aperçu : annulation motivée de la réservation.
    await dialog.getByRole('link', { name: /^Traiter/ }).click();
    await expect(page).toHaveURL(/\/planning\?reservation=[0-9a-f-]{36}/);
    const reservation = page.getByRole('dialog', { name: /Réservation E2E-TR1/ });
    await reservation.getByRole('button', { name: 'Annuler la réservation' }).click();
    const cancel = page.getByRole('dialog', { name: 'Annuler la réservation' });
    await cancel.getByLabel('Motif de l’annulation *').fill('Véhicule transféré à la société B');
    await cancel.getByRole('button', { name: 'Confirmer l’annulation' }).click();
    await expect(page.getByText('Réservation annulée.')).toBeVisible();

    // 3. Nouvel aperçu sans blocage : décisions explicites puis transfert (clé d'idempotence, version attendue).
    await openVehicle(page, 'E2E-TR1');
    await page.getByRole('button', { name: 'Transférer' }).click();
    dialog = page.getByRole('dialog', { name: /Transférer le véhicule E2E-TR1/ });
    await expect(dialog.getByText('Aucune opération bloquante')).toBeVisible();
    await dialog.getByRole('button', { name: 'Confirmer le transfert' }).click();
    await expect(dialog.getByText('Choisissez la société destinataire.')).toBeVisible();
    await expect(dialog.getByText('Saisissez le relevé de transfert, ou transférez sans relevé avec un motif.')).toBeVisible();

    await dialog.getByRole('combobox', { name: 'Société destinataire *', exact: true }).click();
    await page.getByRole('option', { name: `${E2E.companyB} · Société E2E B` }).click();
    await dialog.getByRole('combobox', { name: 'Site dans la société destinataire *', exact: true }).click();
    await page.getByRole('option', { name: 'Aucun site' }).click();
    await dialog.getByRole('combobox', { name: 'Service dans la société destinataire *', exact: true }).click();
    await page.getByRole('option', { name: 'Aucun service' }).click();
    await dialog.getByRole('radio', { name: /Transférer sans relevé/ }).click();
    await dialog.getByLabel('Motif de l’absence de relevé *').fill('Compteur non relevé, véhicule déjà au dépôt de la société B');
    await dialog.getByLabel('Motif du transfert *').fill('Réorganisation du parc entre sociétés');
    await dialog.getByRole('button', { name: `Transférer vers ${E2E.companyB}` }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/Véhicule E2E-TR1 transféré vers la société E2E-B/)).toBeVisible();
    await expect(page.getByText(new RegExp(`Véhicule particulier · Société ${E2E.companyB}$`))).toBeVisible();

    // 4. Le véhicule est listé dans la société cible et n'est plus dans la société d'origine ; sa dépense
    // antérieure au transfert reste imputée à la société d'origine (T26 : coûts historiques inchangés).
    await page.getByRole('combobox', { name: 'Société courante' }).click();
    await page.getByRole('option', { name: `${E2E.companyB} · Société E2E B` }).click();
    await page.goto('/vehicules');
    await expect(page.getByRole('link', { name: 'E2E-TR1', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'E2E-VB1', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'E2E-VA1', exact: true })).toHaveCount(0);
    await page.goto('/depenses?q=ASSUR-E2E-TR1');
    await expect(page.getByRole('heading', { level: 1, name: 'Dépenses' })).toBeVisible();
    await expect(page.getByText('Aucune dépense', { exact: true })).toBeVisible();

    await page.getByRole('combobox', { name: 'Société courante' }).click();
    await page.getByRole('option', { name: `${E2E.companyA} · Société E2E A` }).click();
    await page.goto('/vehicules?q=E2E-VA1');
    await expect(page.getByRole('link', { name: 'E2E-VA1', exact: true })).toBeVisible();
    await page.goto('/vehicules?q=E2E-TR1');
    await expect(page.getByText('Aucun véhicule', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'E2E-TR1', exact: true })).toHaveCount(0);
    await page.goto('/depenses?q=ASSUR-E2E-TR1');
    const historical = page.getByRole('table', { name: 'Registre des dépenses' }).getByRole('row').filter({ hasText: 'ASSUR-E2E-TR1' });
    await expect(historical).toHaveCount(1);
    await expect(historical).toContainText('E2E-TR1 — 403 TU 2026');
    await expect(historical).toContainText('Assurance');
    await expect(historical).toContainText('300,000 TND');
    await expect(historical).toContainText('Validée');
  });

  test('le chef de parc ne voit pas l’action de transfert (réservée à l’administrateur)', async ({ page }) => {
    await loginAs(page, E2E.chefA);
    await openVehicle(page, 'E2E-VA2');
    await expect(page.getByRole('button', { name: 'Changer le cycle de vie' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Transférer' })).toHaveCount(0);
  });
});
