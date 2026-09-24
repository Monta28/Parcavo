import { expect, test } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { SAMPLE_PDF, civilDate, frenchDate, km, logout, openVehicle } from '../support/lot-c-helpers.js';
import { E2E } from '../support/seed-e2e.js';

/** Photo fictive (PNG 16 × 16), réduite en JPEG par le navigateur avant le téléversement. */
const DAMAGE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGM406FEEmIY1TCqYfhqAAB+o3YQ4nn/XQAAAABJRU5ErkJggg==', 'base64');
const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 720 };

test.describe('Documents du véhicule (7.1, 7.2, T21)', () => {
  test('le chef enregistre l’attestation manquante valable jusqu’à ce soir, puis la renouvelle : conformité calculée par l’API', async ({ page }) => {
    test.setTimeout(120_000);
    const today = civilDate(0);
    const tomorrow = civilDate(1);
    const nextYear = civilDate(365);
    await loginAs(page, E2E.chefA);
    await openVehicle(page, 'E2E-DOC1');
    await page.getByRole('tab', { name: 'Documents' }).click();

    // 1. Type requis et bloquant, restreint à la catégorie du véhicule : aucun document, départ bloqué.
    const compliance = page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: 'Conformité documentaire' }) });
    const row = compliance.getByRole('row').filter({ hasText: 'Attestation d’assurance' });
    await expect(row).toContainText('Manquant');
    await expect(row).toContainText('Aucun document enregistré.');
    await expect(row).toContainText('Bloque un départ');

    // 2. Enregistrement de la première version, avec justificatif privé, fin de validité aujourd'hui.
    await row.getByRole('button', { name: /^Enregistrer : Attestation d’assurance/ }).click();
    const create = page.getByRole('dialog', { name: 'Enregistrer un document' });
    await expect(create).toContainText('Attestation d’assurance · Véhicule');
    await expect(create).toContainText('E2E-DOC1 · 602 TU 2026');
    await expect(create).toContainText('Son absence ou son expiration bloque un nouveau départ.');
    await create.getByLabel('Numéro').fill('ASS-E2E-2025-001');
    await create.getByLabel('Organisme émetteur').fill('Mutuelle fictive des transporteurs');
    await create.getByLabel('Début de validité').fill(civilDate(-364));
    await create.getByLabel(/^Fin de validité/).fill(today);
    const chooser = page.waitForEvent('filechooser');
    await create.getByRole('button', { name: /^Justificatif/ }).click();
    await (await chooser).setFiles({ name: 'attestation-2025.pdf', mimeType: 'application/pdf', buffer: SAMPLE_PDF });
    await expect(create.getByText('Fichier prêt : attestation-2025.pdf (rattaché à l’enregistrement).')).toBeVisible();
    await create.getByRole('button', { name: 'Enregistrer le document' }).click();
    await expect(create).toBeHidden();
    await expect(page.getByText('Attestation d’assurance enregistré pour E2E-DOC1 · 602 TU 2026.')).toBeVisible();

    // Valable jusqu'à la fin du jour local : à renouveler, dernier jour, plus de blocage.
    await expect(row).toContainText('À renouveler');
    await expect(row).toContainText(`Valable jusqu’à ce soir (fin de journée du ${frenchDate(today)}).`);
    await expect(row).toContainText('0 j (dernier jour)');
    await expect(row).toContainText('Aucun blocage');
    await expect(row).toContainText('Aucune');
    const versions = page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: 'Versions enregistrées' }) });
    const first = versions.getByRole('row').filter({ hasText: 'ASS-E2E-2025-001' });
    await expect(first).toContainText('Première version');
    await expect(first).toContainText(frenchDate(today));
    const download = first.getByRole('link', { name: 'Télécharger le justificatif Attestation d’assurance' });
    const file = await page.request.get((await download.getAttribute('href')) ?? '');
    expect(file.status()).toBe(200);
    expect(file.headers()['content-type']).toContain('application/pdf');

    // 3. Renouvellement futur (à partir de demain) : la version en cours reste retenue jusqu'à ce soir.
    await row.getByRole('button', { name: /^Renouveler : Attestation d’assurance/ }).click();
    const renew = page.getByRole('dialog', { name: 'Renouveler : Attestation d’assurance · E2E-DOC1 · 602 TU 2026' });
    await renew.getByLabel('Numéro').fill('ASS-E2E-2026-002');
    await renew.getByLabel('Organisme émetteur').fill('Mutuelle fictive des transporteurs');
    await renew.getByLabel('Début de validité').fill(tomorrow);
    await renew.getByLabel(/^Fin de validité/).fill(nextYear);
    const renewChooser = page.waitForEvent('filechooser');
    await renew.getByRole('button', { name: /^Justificatif/ }).click();
    await (await renewChooser).setFiles({ name: 'attestation-2026.pdf', mimeType: 'application/pdf', buffer: SAMPLE_PDF });
    await expect(renew.getByText('Fichier prêt : attestation-2026.pdf (rattaché à l’enregistrement).')).toBeVisible();
    await renew.getByRole('button', { name: 'Enregistrer la nouvelle version' }).click();
    await expect(renew).toBeHidden();
    await expect(page.getByText('Nouvelle version de Attestation d’assurance enregistrée.')).toBeVisible();

    await expect(row).toContainText('Valide');
    await expect(row).not.toContainText('À renouveler');
    await expect(row).toContainText(`Valide jusqu’au ${frenchDate(today)} ; renouvellement déjà enregistré.`);
    await expect(row).toContainText(`Du ${frenchDate(tomorrow)}`);
    await expect(row).toContainText(`au ${frenchDate(nextYear)}`);
    await expect(row).toContainText('Aucun blocage');
    await expect(versions.getByRole('row').filter({ hasText: 'ASS-E2E-2026-002' })).toContainText('Renouvellement');
    await expect(first).toContainText('Première version');
  });
});

test.describe('Incident et immobilisation (7.3, 7.4, T23)', () => {
  test('la conductrice signale une panne depuis Mon véhicule ; le chef la prend en charge, immobilise le véhicule pendant l’utilisation, enregistre le retour, lève l’immobilisation et clôture l’incident', async ({ page }) => {
    test.setTimeout(180_000);

    // 1. Conductrice, sur mobile : signalement rattaché par le serveur à son utilisation en cours.
    await page.setViewportSize(MOBILE);
    await loginAs(page, E2E.conducteurIncidents);
    await page.goto('/mon-vehicule');
    await expect(page.getByRole('heading', { name: 'E2E-INC1 · 603 TU 2026' })).toBeVisible();
    await page.getByRole('button', { name: 'Signaler un problème' }).click();
    await expect(page.getByText('Dernière utilisation : E2E-INC1 · 603 TU 2026 — en cours.')).toBeVisible();
    await page.getByRole('button', { name: 'Envoyer le signalement' }).click();
    await expect(page.getByText('Choisissez le type de problème.')).toBeVisible();
    await expect(page.getByText('Décrivez le problème (5 caractères au moins).')).toBeVisible();
    await page.getByRole('combobox', { name: 'Type de problème *' }).click();
    await page.getByRole('option', { name: 'Panne', exact: true }).click();
    await page.getByRole('combobox', { name: 'Gravité proposée' }).click();
    await page.getByRole('option', { name: 'Élevée', exact: true }).click();
    await page.getByLabel('Que se passe-t-il ? *').fill('Voyant moteur allumé et perte de puissance en côte');
    await page.getByLabel('Lieu', { exact: true }).fill('Route de Bizerte, sortie Ariana');
    const photoChooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /Prendre ou choisir une photo/ }).click();
    await (await photoChooser).setFiles({ name: 'voyant.png', mimeType: 'image/png', buffer: DAMAGE_PNG });
    await expect(page.getByRole('img', { name: 'Photo jointe 1' })).toBeVisible();
    await page.getByRole('button', { name: 'Envoyer le signalement' }).click();
    await expect(page.getByRole('heading', { name: 'Signalement enregistré' })).toBeVisible();
    const receipt = page.getByText(/^INC-\d{4}-\d{6} · Panne$/);
    await expect(receipt).toBeVisible();
    const reference = ((await receipt.textContent()) ?? '').replace(' · Panne', '').trim();
    await expect(page.getByText('Gravité : Élevée', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    // Suivi « Mes signalements » (et non le toast de confirmation, qui cite aussi la référence).
    const report = page.getByRole('region', { name: 'Mes signalements' }).getByRole('listitem').filter({ hasText: reference });
    await expect(report).toContainText('Ouvert');
    await logout(page);

    // 2. Chef de parc : prise en charge avec note interne, puis commentaire partagé avec la conductrice.
    await page.setViewportSize(DESKTOP);
    await loginAs(page, E2E.chefA);
    await page.goto('/incidents');
    await page.getByLabel('Recherche').fill(reference);
    await expect(page).toHaveURL(new RegExp(`q=${reference}`));
    const listed = page.getByRole('row').filter({ hasText: reference });
    await expect(listed).toContainText('E2E-INC1 · 603 TU 2026');
    await expect(listed).toContainText('Ouvert');
    await expect(listed).toContainText('Nadia Signalement');
    await listed.getByRole('link', { name: reference }).click();
    await expect(page.getByRole('heading', { level: 1, name: `Incident ${reference}` })).toBeVisible();
    const incidentUrl = page.url();
    const main = page.getByRole('main');
    await expect(main).toContainText('Route de Bizerte, sortie Ariana');
    await expect(main.getByRole('img', { name: 'Photo 1 de l’incident (ouvrir en grand)' })).toBeVisible();
    await expect(main.getByRole('link', { name: 'Voir l’utilisation' })).toBeVisible();

    await page.getByRole('button', { name: 'Prendre en charge' }).click();
    const take = page.getByRole('dialog', { name: 'Prendre en charge l’incident' });
    await take.getByLabel('Commentaire interne (facultatif)').fill('Diagnostic demandé au garage Lafayette');
    await take.getByRole('button', { name: 'Prendre en charge' }).click();
    await expect(take).toBeHidden();
    await expect(page.getByText('Incident pris en charge.')).toBeVisible();
    await expect(main.getByText('En traitement', { exact: true })).toBeVisible();
    await expect(main).toContainText('[OUVERT → EN_TRAITEMENT] Diagnostic demandé au garage Lafayette');

    await main.getByLabel('Nouveau commentaire').fill('Ne reprenez pas la route : le véhicule part au garage.');
    await main.getByRole('radio', { name: 'Partagé avec le conducteur' }).click();
    await main.getByRole('button', { name: 'Publier le commentaire' }).click();
    await expect(page.getByText('Commentaire ajouté (partagé avec le conducteur).')).toBeVisible();

    // 3. Immobilisation au garage pendant l'utilisation en cours (cause « incident »).
    await page.getByRole('button', { name: 'Immobiliser le véhicule' }).click();
    const immobilize = page.getByRole('dialog', { name: 'Immobiliser le véhicule E2E-INC1' });
    await expect(immobilize.getByLabel('Motif *')).toHaveValue(`Incident ${reference}`);
    await immobilize.getByRole('radio', { name: 'Garage (fournisseur)' }).click();
    await immobilize.getByRole('combobox', { name: 'Garage *' }).click();
    await page.getByRole('option', { name: 'Lafayette Auto Services E2E · Garage' }).click();
    await immobilize.getByRole('button', { name: 'Immobiliser' }).click();
    await expect(immobilize).toBeHidden();
    await expect(page.getByText(`Véhicule E2E-INC1 immobilisé pour l’incident ${reference}.`)).toBeVisible();
    await expect(main.getByText('Véhicule immobilisé pour cet incident', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Immobiliser le véhicule' })).toHaveCount(0);

    // 4. Résolution technique, puis clôture refusée par l'API tant que la cause d'immobilisation est ouverte.
    await page.getByRole('button', { name: 'Résoudre' }).click();
    const resolve = page.getByRole('dialog', { name: 'Résoudre l’incident' });
    await resolve.getByRole('button', { name: 'Résoudre' }).click();
    await expect(resolve.getByText('Saisissez au moins 3 caractères.')).toBeVisible();
    await resolve.getByLabel('Note de résolution *').fill('Capteur de pression turbo remplacé par le garage');
    await resolve.getByRole('button', { name: 'Résoudre' }).click();
    await expect(resolve).toBeHidden();
    await expect(main.getByText('Résolu', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Clôturer', exact: true }).click();
    const refusedClosure = page.getByRole('dialog', { name: 'Clôture administrative' });
    await refusedClosure.getByRole('button', { name: 'Clôturer' }).click();
    await expect(refusedClosure.getByRole('alert')).toContainText('Des interventions ou une immobilisation liées sont encore ouvertes.');
    await expect(refusedClosure.getByRole('alert')).toContainText('Causes d’immobilisation encore ouvertes : 1');
    await refusedClosure.getByRole('button', { name: 'Annuler' }).click();
    await expect(main.getByText('Résolu', { exact: true })).toBeVisible();

    // 5. T23 : immobilisation active pendant l'utilisation ; l'utilisation est conservée et sa restitution possible.
    await main.getByRole('link', { name: /^Depuis le / }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Immobilisation E2E-INC1' })).toBeVisible();
    const immobilizationUrl = page.url();
    await expect(main.getByText('Active', { exact: true })).toBeVisible();
    await expect(main.getByText('1 cause ouverte', { exact: true })).toBeVisible();
    await expect(main).toContainText('Garage Lafayette Auto Services E2E');
    const cause = main.getByRole('row').filter({ hasText: `Incident ${reference}` }).first();
    await expect(cause).toContainText('Ouverte');
    const openUsage = main.getByRole('alert').filter({ hasText: 'Utilisation en cours pendant l’immobilisation' });
    await expect(openUsage).toContainText('L’utilisation est conservée et sa restitution reste possible.');
    await openUsage.getByRole('link', { name: 'Ouvrir l’utilisation' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'E2E-INC1 · 603 TU 2026' })).toBeVisible();
    await page.getByRole('button', { name: 'Enregistrer le retour' }).first().click();
    const returnForm = page.locator('#retour');
    await expect(returnForm.getByRole('heading', { name: 'Enregistrer le retour' })).toBeVisible();
    await returnForm.getByLabel('Compteur affiché (km) *').fill('30085');
    await returnForm.getByRole('radio', { name: 'Lieu libre' }).click();
    await returnForm.getByLabel('Lieu *').fill('Lafayette Auto Services E2E, Ariana');
    await returnForm.getByRole('button', { name: 'Enregistrer le retour' }).click();
    const confirmReturn = page.getByRole('alertdialog', { name: 'Confirmer le retour' });
    await expect(confirmReturn).toContainText('E2E-INC1 restitué par Nadia Signalement');
    await confirmReturn.getByRole('button', { name: 'Confirmer le retour' }).click();
    await expect(confirmReturn).toBeHidden();
    await expect(page.getByText('Retour enregistré : E2E-INC1 restitué.')).toBeVisible();
    await expect(main.getByText('Terminée', { exact: true }).first()).toBeVisible();
    await expect(main).toContainText(km(30_085));

    // Le retour ne lève pas l'immobilisation : le véhicule reste immobilisé.
    await page.goto(immobilizationUrl);
    await expect(main.getByText('Active', { exact: true })).toBeVisible();
    await expect(main.getByText('Utilisation en cours pendant l’immobilisation')).toHaveCount(0);
    await main.getByRole('link', { name: 'E2E-INC1 · 603 TU 2026' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /^E2E-INC1 · / })).toBeVisible();
    await expect(main.getByText('Immobilisé', { exact: true }).first()).toBeVisible();

    // 6. Fin de l'immobilisation (toutes les causes), motif obligatoire : le véhicule redevient disponible.
    await page.goto(immobilizationUrl);
    await page.getByRole('button', { name: 'Fin d’immobilisation' }).click();
    const end = page.getByRole('dialog', { name: 'Fin d’immobilisation' });
    await end.getByRole('button', { name: 'Terminer l’immobilisation' }).click();
    await expect(end.getByText('Indiquez le motif (3 caractères au moins).')).toBeVisible();
    await end.getByLabel('Motif *').fill('Réparation terminée, véhicule récupéré au garage');
    await end.getByRole('button', { name: 'Terminer l’immobilisation' }).click();
    await expect(end).toBeHidden();
    await expect(page.getByText('Immobilisation terminée : E2E-INC1 est remis en disponibilité.')).toBeVisible();
    await expect(main.getByText('Terminée', { exact: true }).first()).toBeVisible();
    await expect(cause).toContainText('Réparation terminée, véhicule récupéré au garage');
    await expect(page.getByRole('button', { name: 'Fin d’immobilisation' })).toHaveCount(0);
    await main.getByRole('link', { name: 'E2E-INC1 · 603 TU 2026' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /^E2E-INC1 · / })).toBeVisible();
    await expect(main.getByText('Disponible', { exact: true }).first()).toBeVisible();

    // 7. Clôture administrative désormais acceptée.
    await page.goto(incidentUrl);
    await expect(main.getByText('Cause terminée le', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Clôturer', exact: true }).click();
    const closure = page.getByRole('dialog', { name: 'Clôture administrative' });
    await closure.getByRole('button', { name: 'Clôturer' }).click();
    await expect(closure).toBeHidden();
    await expect(page.getByText('Incident clôturé.')).toBeVisible();
    await expect(main.getByText('Clôturé', { exact: true })).toBeVisible();
    await expect(main.getByText('Incident clôturé : les commentaires sont fermés.')).toBeVisible();
    await logout(page);

    // 8. La conductrice suit son signalement : statut clôturé et seul le commentaire partagé lui est visible.
    await page.setViewportSize(MOBILE);
    await loginAs(page, E2E.conducteurIncidents);
    await page.goto('/mon-vehicule');
    await expect(page.getByText('Aucun véhicule remis')).toBeVisible();
    await expect(report).toContainText('Clôturé');
    await report.getByRole('button', { name: 'Voir les échanges et commenter' }).click();
    await expect(report).toContainText('Ne reprenez pas la route : le véhicule part au garage.');
    await expect(report).not.toContainText('Diagnostic demandé au garage Lafayette');
    await expect(report).toContainText('Incident clôturé : les commentaires sont fermés.');
  });
});
