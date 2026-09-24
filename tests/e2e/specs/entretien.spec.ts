import { expect, test } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { civilDate, frenchDate, km, openVehicle, sameDayNextYear } from '../support/lot-c-helpers.js';
import { E2E } from '../support/seed-e2e.js';

test.describe('Entretien préventif (6.1 à 6.4, T15, T17)', () => {
  test('le chef applique un modèle à un véhicule, clôture une intervention avec relevé et coût : seule la vidange réalisée est recalculée', async ({ page }) => {
    test.setTimeout(150_000);
    const today = civilDate(0);
    await loginAs(page, E2E.chefA);

    // 1. Modèle paramétré par l'administrateur, copié vers E2E-ENT1 (instantané, résultat détaillé par véhicule).
    await page.goto('/entretiens?onglet=modeles');
    await expect(page.getByRole('heading', { level: 1, name: 'Entretiens' })).toBeVisible();
    const templateCard = page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: 'Entretien courant E2E' }) });
    await expect(templateCard.getByRole('row').filter({ hasText: 'Vidange moteur' })).toContainText(`tous les ${km(10_000)} ou tous les 12 mois`);
    await expect(templateCard.getByRole('row').filter({ hasText: 'Remplacement batterie' })).toContainText('tous les 48 mois');
    await templateCard.getByRole('button', { name: 'Appliquer à des véhicules' }).click();
    const apply = page.getByRole('dialog', { name: 'Appliquer le modèle « Entretien courant E2E »' });
    await apply.getByRole('button', { name: 'Appliquer à 0 véhicule' }).click();
    await expect(apply.getByText('Sélectionnez au moins un véhicule.')).toBeVisible();
    await apply.getByLabel('Rechercher un véhicule').fill('E2E-ENT1');
    await apply.getByRole('checkbox', { name: /^E2E-ENT1 · 601 TU 2026/ }).click();
    await expect(apply.getByText('Véhicules (1 sélectionné)')).toBeVisible();
    await apply.getByRole('button', { name: 'Appliquer à 1 véhicule' }).click();
    const applied = apply.getByRole('row').filter({ hasText: 'E2E-ENT1' });
    await expect(applied).toContainText('Remplacement batterie, Vidange moteur');
    await expect(apply.getByText('Les nouveaux plans prennent pour base la dernière opération de ce type sur le véhicule ; à défaut, ils sont INCOMPLETS avec une alerte.')).toBeVisible();
    await apply.getByRole('button', { name: 'Terminer' }).click();
    await expect(apply).toBeHidden();

    // 2. Fiche véhicule, onglet Entretien : plans copiés sans historique, donc incomplets ; kilométrage connu (89 500 km).
    await openVehicle(page, 'E2E-ENT1');
    await page.getByRole('tab', { name: 'Entretien' }).click();
    const plansCard = page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: 'Plans d’entretien' }) });
    const oilPlan = plansCard.getByRole('row').filter({ hasText: 'Vidange moteur' });
    const batteryPlan = plansCard.getByRole('row').filter({ hasText: 'Remplacement batterie' });
    await expect(oilPlan).toContainText('Non calculable');
    await expect(oilPlan).toContainText(km(89_500));
    await expect(oilPlan).toContainText('Incomplet');
    await expect(oilPlan).toContainText('Échéance km non initialisée (base km manquante)');
    await expect(batteryPlan).toContainText('Non calculable');
    await expect(batteryPlan).toContainText('Incomplet');

    // 3. Intervention préventive depuis la fiche : garage de la société, deux lignes liées aux plans du véhicule.
    await page.getByRole('link', { name: 'Nouvelle intervention' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Nouvelle intervention' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Véhicule *' })).toContainText('E2E-ENT1 · 601 TU 2026');
    await page.getByRole('combobox', { name: 'Garage / fournisseur' }).click();
    await page.getByRole('option', { name: /Lafayette Auto Services E2E/ }).click();
    await page.getByLabel('Diagnostic').fill('Vidange à faire ; batterie faible au démarrage à froid');
    await page.getByRole('button', { name: 'Plan du véhicule', exact: true }).click();
    await page.getByRole('button', { name: 'Plan du véhicule', exact: true }).click();
    const firstTask = page.getByRole('listitem').filter({ hasText: 'Ligne 1 : nature' });
    await firstTask.getByRole('combobox', { name: 'Plan du véhicule *' }).click();
    await page.getByRole('option', { name: 'Vidange moteur · Incomplet' }).click();
    await expect(firstTask).toContainText(`Intervalle : ${km(10_000)} ou 12 mois · prochaine échéance : non déterminée`);
    const secondTask = page.getByRole('listitem').filter({ hasText: 'Ligne 2 : nature' });
    await secondTask.getByRole('combobox', { name: 'Plan du véhicule *' }).click();
    await expect(page.getByRole('option', { name: 'Vidange moteur · Incomplet' })).toBeDisabled();
    await page.getByRole('option', { name: 'Remplacement batterie · Incomplet' }).click();
    await page.getByRole('button', { name: 'Créer l’intervention' }).click();

    const heading = page.getByRole('heading', { level: 1, name: /^Intervention INT-\d{4}-\d{6}$/ });
    await expect(heading).toBeVisible();
    const reference = ((await heading.textContent()) ?? '').replace('Intervention ', '').trim();
    const main = page.getByRole('main');
    await expect(main.getByText('Brouillon', { exact: true })).toBeVisible();
    await expect(main.getByText('Planifier ne signifie pas exécuter')).toBeVisible();
    await expect(main).toContainText('Lafayette Auto Services E2E');

    // 4. Clôture : batterie non réalisée, relevé lu au compteur (90 300 km), lignes pièce et main-d'œuvre.
    await page.getByRole('button', { name: 'Terminer', exact: true }).click();
    const closure = page.locator('#cloture');
    await expect(closure.getByRole('heading', { name: `Terminer l’intervention ${reference}` })).toBeVisible();
    await expect(closure.getByLabel('Date effective de réalisation *')).toHaveValue(today);
    await closure.getByRole('checkbox', { name: /^Remplacement batterie/ }).click();
    await expect(closure.getByRole('checkbox', { name: /^Remplacement batterie/ })).not.toBeChecked();
    await expect(closure.getByRole('checkbox', { name: /^Vidange moteur/ })).toBeChecked();
    await closure.getByLabel('Valeur affichée au compteur (km) *').fill('90300');
    await closure.getByRole('radio', { name: 'Lignes pièces / main-d’œuvre' }).click();
    await closure.getByRole('button', { name: 'Pièce', exact: true }).click();
    await closure.getByRole('button', { name: 'Main-d’œuvre', exact: true }).click();
    const partLine = closure.getByRole('listitem').filter({ hasText: 'Ligne 1 : nature' });
    await partLine.getByLabel('Libellé *').fill('Huile moteur 5W30 et filtre');
    await partLine.getByLabel('Quantité *').fill('1');
    await partLine.getByLabel(/^Prix unitaire TTC/).fill('62,500');
    const labourLine = closure.getByRole('listitem').filter({ hasText: 'Ligne 2 : nature' });
    await labourLine.getByLabel('Libellé *').fill('Main-d’œuvre vidange');
    await labourLine.getByLabel('Quantité *').fill('1,5');
    await labourLine.getByLabel(/^Prix unitaire TTC/).fill('30,000');
    await closure.getByLabel('Travaux effectués').fill('Vidange réalisée ; batterie contrôlée, remplacement reporté');
    await closure.getByRole('button', { name: 'Terminer l’intervention' }).click();
    const confirm = page.getByRole('alertdialog', { name: `Terminer l’intervention ${reference} ?` });
    await expect(confirm).toContainText('Lignes réalisées (1/2) : Vidange moteur');
    await expect(confirm).toContainText(`Relevé d’exécution : nouveau relevé de ${km(90_300)}`);
    await expect(confirm).toContainText('Coût : lignes pièces / main-d’œuvre (total calculé par le serveur)');
    await confirm.getByRole('button', { name: 'Confirmer la clôture' }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByText(`Intervention ${reference} terminée le ${frenchDate(today)} : plans des lignes réalisées recalculés.`)).toBeVisible();

    // 5. Fiche de l'intervention terminée : relevé d'exécution, montants calculés par l'API, dépense unique liée.
    await expect(closure).toBeHidden();
    await expect(main.getByText('Terminée', { exact: true }).first()).toBeVisible();
    await expect(main.getByText('Coût saisi', { exact: true }).first()).toBeVisible();
    await expect(main).toContainText(`${km(90_300)} lu le`);
    const tasks = main.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: 'Lignes de travail' }) });
    await expect(tasks.getByRole('row').filter({ hasText: 'Vidange moteur' })).toContainText('Réalisée');
    await expect(tasks.getByRole('row').filter({ hasText: 'Vidange moteur' })).not.toContainText('Non réalisée');
    await expect(tasks.getByRole('row').filter({ hasText: 'Remplacement batterie' })).toContainText('Non réalisée');
    const costLines = main.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: 'Lignes pièces et main-d’œuvre' }) });
    await expect(costLines.getByRole('row').filter({ hasText: 'Huile moteur 5W30 et filtre' })).toContainText('62,500 TND');
    await expect(costLines.getByRole('row').filter({ hasText: 'Main-d’œuvre vidange' })).toContainText('45,000 TND');
    await expect(costLines.getByRole('row').filter({ hasText: 'Total TTC' })).toContainText('107,500 TND');
    await expect(main.getByText('Dépense liée enregistrée (entretien / réparation).')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Saisir le coût' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Terminer', exact: true })).toHaveCount(0);

    // 6. Échéance recalculée par l'API : vidange suivante à 100 300 km (90 300 + 10 000) et dans 12 mois ;
    //    la batterie, non réalisée, reste incomplète (une ligne ne met à jour que son propre plan).
    await main.getByRole('link', { name: 'E2E-ENT1 · 601 TU 2026' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /^E2E-ENT1 · / })).toBeVisible();
    await page.getByRole('tab', { name: 'Entretien' }).click();
    const nextDue = sameDayNextYear(today);
    await expect(oilPlan).toContainText(`${km(100_300)} · reste ${km(10_000)}`);
    await expect(oilPlan).toContainText(frenchDate(nextDue));
    await expect(oilPlan).toContainText(km(90_300));
    await expect(oilPlan).toContainText('À jour');
    await expect(oilPlan).not.toContainText('Incomplet');
    await expect(batteryPlan).toContainText('Non calculable');
    await expect(batteryPlan).toContainText('Incomplet');
    const interventionsCard = page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: 'Interventions' }) });
    const done = interventionsCard.getByRole('row').filter({ hasText: reference });
    await expect(done).toContainText('Terminée');
    await expect(done).toContainText(`réalisée le ${frenchDate(today)}`);
    await expect(done).toContainText(km(90_300));
    await expect(done).toContainText('Lafayette Auto Services E2E');
    await expect(done).toContainText('107,500 TND');

    // 7. Détail du plan : base = opération effective la plus récente, origine = modèle copié.
    await oilPlan.getByRole('link', { name: 'Détail du plan Vidange moteur' }).click();
    const sheet = page.getByRole('dialog', { name: 'Vidange moteur · E2E-ENT1' });
    await expect(sheet).toContainText(`Dernière opération connue · ${km(90_300)} · ${frenchDate(today)}`);
    await expect(sheet).toContainText('Copié du modèle « Entretien courant E2E »');
    await expect(sheet).toContainText(`${km(100_300)} · reste ${km(10_000)}`);
    await expect(sheet.getByText('Km : À jour', { exact: true })).toBeVisible();
    await expect(sheet.getByText('Date : À jour', { exact: true })).toBeVisible();
  });
});
