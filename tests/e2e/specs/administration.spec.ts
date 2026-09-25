import { expect, test } from '@playwright/test';
import { loginAs } from '../support/auth.js';
import { E2E } from '../support/seed-e2e.js';

/** Suffixe unique par test : la base n'est réinitialisée qu'une fois (setup global). */
const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

test.describe('Administration des comptes', () => {
  test('invite un chef de parc sans e-mail via un lien d’accès à usage unique limité à sa société', async ({ page }) => {
    const suffix = unique();
    const email = `chef.invite.${suffix}@parc-auto.test`;
    const firstName = 'Ines';
    const lastName = `Invitee${suffix}`;
    const fullName = `${firstName} ${lastName}`;
    const newPassword = `Acces-Chef-${suffix}-2026`;

    // Création du compte par l'administrateur, sans mot de passe initial (SMTP non configuré en e2e).
    await loginAs(page, E2E.admin);
    await page.goto('/administration/utilisateurs/nouveau');
    await expect(page.getByRole('heading', { name: 'Nouvel utilisateur' })).toBeVisible();
    await expect(page.getByText(/Sans mot de passe initial, aucun e-mail n’est envoyé \(canal e-mail non configuré\)/)).toBeVisible();
    await page.getByLabel('Prénom *', { exact: true }).fill(firstName);
    await page.getByLabel('Nom *', { exact: true }).fill(lastName);
    await page.getByLabel('E-mail *', { exact: true }).fill(email);
    await expect(page.getByLabel('Mot de passe initial')).toHaveValue('');
    await page.getByRole('button', { name: 'Ajouter une habilitation' }).click();
    await page.getByRole('combobox', { name: 'Rôle' }).click();
    await page.getByRole('option', { name: 'Chef de parc' }).click();
    const company = page.getByRole('combobox', { name: 'Société', exact: true });
    await company.click();
    await page.getByRole('option', { name: /E2E-A/ }).click();
    await expect(company).toHaveText(/E2E-A/);
    await page.getByRole('button', { name: 'Créer l’utilisateur' }).click();

    // Fiche du compte : invitation en attente, pas de renvoi par e-mail possible sans canal e-mail.
    await expect(page.getByRole('heading', { level: 1, name: fullName })).toBeVisible();
    await expect(page).toHaveURL(/\/administration\/utilisateurs\/[0-9a-f-]{36}$/);
    const main = page.getByRole('main');
    await expect(main.getByText('Invitation en attente', { exact: true })).toBeVisible();
    await expect(main.getByText('Non défini (invitation en attente)')).toBeVisible();
    await expect(main.getByText(`${E2E.companyA} · Chef de parc`, { exact: true })).toBeVisible();
    await expect(main.getByText('Canal e-mail non configuré : aucune invitation n’est envoyée par e-mail.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Renvoyer l’invitation par e-mail' })).toHaveCount(0);

    // Lien d'accès « invitation » affiché une seule fois dans un champ en lecture seule.
    await page.getByRole('button', { name: 'Générer un lien d’accès' }).click();
    const dialog = page.getByRole('dialog', { name: `Lien d’accès pour ${fullName}` });
    const invitation = dialog.getByRole('radio', { name: 'Invitation' });
    await expect(invitation).toBeChecked();
    await invitation.check();
    await dialog.getByRole('button', { name: 'Générer le lien' }).click();
    const linkField = dialog.getByLabel('Lien à transmettre');
    await expect(linkField).toHaveAttribute('readonly', '');
    await expect(linkField).toHaveValue(/\/reinitialisation\?token=[A-Za-z0-9_-]{20,}$/);
    const link = await linkField.inputValue();
    await dialog.getByRole('button', { name: 'Fermer' }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await expect(page).toHaveURL(/\/login/);

    // Définition du mot de passe via le lien : un mot de passe faible est refusé sans consommer le lien.
    await page.goto(link);
    const resetMain = page.getByRole('main');
    await page.getByLabel('Nouveau mot de passe').fill('motdepassefaible');
    await page.getByLabel('Confirmation').fill('motdepassefaible');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(resetMain.getByRole('alert')).toContainText('Le mot de passe doit contenir des minuscules, des majuscules et des chiffres.');
    await page.getByLabel('Nouveau mot de passe').fill(newPassword);
    await page.getByLabel('Confirmation').fill(newPassword);
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(resetMain.getByRole('status')).toContainText('Mot de passe enregistré.');

    // Le lien est à usage unique.
    await page.goto(link);
    await page.getByLabel('Nouveau mot de passe').fill(`${newPassword}-bis`);
    await page.getByLabel('Confirmation').fill(`${newPassword}-bis`);
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(resetMain.getByRole('alert')).toContainText('Ce lien de réinitialisation est invalide ou expiré.');

    // Connexion avec le nouveau compte : périmètre limité à la société A.
    await loginAs(page, email, newPassword);
    await page.goto('/vehicules');
    await expect(page.getByRole('heading', { name: 'Véhicules' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'E2E-VA1' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'E2E-VA2' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'E2E-VB1' })).toHaveCount(0);
    await page.goto('/administration/utilisateurs');
    await expect(page.getByRole('main').getByRole('alert')).toContainText('Cette rubrique est réservée à l’administrateur groupe.');
  });
});
